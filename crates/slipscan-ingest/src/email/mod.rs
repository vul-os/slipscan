//! Email inbound: the user's own mailbox as a document source.
//!
//! One [`MailboxConnector`] trait, provider implementations behind it (generic
//! IMAP lives in [`imap`]). Connectors normalise everything into
//! [`InboundMessage`]s; [`import_message_documents`] then feeds attachments
//! and receipt-like HTML bodies into the core document pipeline.

pub mod imap;
mod parse;

pub use parse::{looks_like_receipt, parse_inbound};

use crate::import::{kind_for_extension, sha256_hex};
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use slipscan_core::domain::{Document, DocumentKind, DocumentSource, NewDocument};
use slipscan_core::util::new_id;
use slipscan_core::{CoreError, CoreService};
use std::path::Path;

/// An attachment pulled out of an inbound email.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub mime_type: String,
    #[serde(with = "crate::b64")]
    pub bytes: Vec<u8>,
}

/// One message fetched from the user's mailbox, already narrowed to the parts
/// SlipScan cares about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundMessage {
    /// Connector-scoped id (IMAP UID as a string); pass back to
    /// [`MailboxConnector::mark_processed`].
    pub id: String,
    /// RFC 5322 Message-ID header, when present.
    pub message_id: Option<String>,
    pub from: String,
    pub subject: Option<String>,
    /// RFC 3339.
    pub received_at: String,
    /// PDF / image attachments.
    pub attachments: Vec<Attachment>,
    /// The HTML body, kept only when it looks like a receipt/invoice.
    pub receipt_html: Option<String>,
}

/// A mailbox (IMAP or similar) the user connected.
#[async_trait]
pub trait MailboxConnector: Send {
    /// Stable connector id, e.g. `"imap"`.
    fn name(&self) -> &str;

    /// Fetch messages not yet seen by SlipScan, oldest first.
    async fn fetch_unseen(&mut self) -> IngestResult<Vec<InboundMessage>>;

    /// Mark a message as processed so it is not fetched again.
    async fn mark_processed(&mut self, message_id: &str) -> IngestResult<()>;
}

/// What one email contributed to the document store.
#[derive(Debug, Default)]
pub struct EmailImportOutcome {
    pub documents: Vec<Document>,
    pub duplicates: usize,
}

/// Write a message's attachments (and receipt-like HTML body, if any) into
/// `storage_dir` and import each as a core document with source `email`.
///
/// Content-hash duplicates are counted, not errors — mail gets refetched.
pub fn import_message_documents(
    svc: &CoreService,
    book_id: &str,
    storage_dir: &Path,
    message: &InboundMessage,
) -> IngestResult<EmailImportOutcome> {
    std::fs::create_dir_all(storage_dir)?;
    let mut outcome = EmailImportOutcome::default();

    for attachment in &message.attachments {
        let safe_name = sanitize_filename(&attachment.filename);
        let ext = safe_name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let stored = storage_dir.join(format!("{}-{safe_name}", new_id()));
        import_bytes(
            svc,
            book_id,
            &stored,
            &attachment.bytes,
            kind_for_extension(&ext),
            Some(attachment.mime_type.clone()),
            Some(safe_name),
            &mut outcome,
        )?;
    }

    if let Some(html) = &message.receipt_html {
        let stored = storage_dir.join(format!("{}-body.html", new_id()));
        let original = message
            .subject
            .clone()
            .unwrap_or_else(|| "email-receipt".to_string());
        import_bytes(
            svc,
            book_id,
            &stored,
            html.as_bytes(),
            DocumentKind::Slip,
            Some("text/html".to_string()),
            Some(format!("{original}.html")),
            &mut outcome,
        )?;
    }

    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
fn import_bytes(
    svc: &CoreService,
    book_id: &str,
    stored_path: &Path,
    bytes: &[u8],
    kind: DocumentKind,
    mime_type: Option<String>,
    original_name: Option<String>,
    outcome: &mut EmailImportOutcome,
) -> IngestResult<()> {
    let sha = sha256_hex(bytes);
    let new = NewDocument {
        book_id: book_id.to_string(),
        source: DocumentSource::Email,
        kind,
        file_path: stored_path.display().to_string(),
        mime_type,
        size_bytes: Some(bytes.len() as i64),
        original_name,
        sha256: Some(sha),
    };
    // Check-then-write: only materialise the file for genuinely new content.
    match svc.document_import(new) {
        Ok(doc) => {
            std::fs::write(stored_path, bytes)?;
            outcome.documents.push(doc);
            Ok(())
        }
        Err(CoreError::DuplicateDocument { .. }) => {
            outcome.duplicates += 1;
            Ok(())
        }
        Err(e) => Err(IngestError::Core(e)),
    }
}

/// Keep only the basename and drop path separators / control characters.
fn sanitize_filename(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .trim()
        .to_string();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if c == ':' { '_' } else { c })
        .collect();
    if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::domain::{BookKind, NewBook};
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;

    fn svc_with_book() -> (CoreService, String) {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Inbox".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
            })
            .unwrap();
        (svc, book.id)
    }

    fn message_with(attachments: Vec<Attachment>, receipt_html: Option<String>) -> InboundMessage {
        InboundMessage {
            id: "7".into(),
            message_id: Some("<m1@example>".into()),
            from: "till@shop.example".into(),
            subject: Some("Your slip".into()),
            received_at: "2026-07-01T10:00:00Z".into(),
            attachments,
            receipt_html,
        }
    }

    #[test]
    fn inbound_message_serde_round_trips_with_binary_attachment() {
        let msg = message_with(
            vec![Attachment {
                filename: "slip.jpg".into(),
                mime_type: "image/jpeg".into(),
                bytes: vec![0xff, 0xd8, 0xff, 0xe0, 0x00],
            }],
            None,
        );
        let json = serde_json::to_string(&msg).unwrap();
        let back: InboundMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn sanitize_filename_strips_paths_and_controls() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\x\\slip.pdf"), "slip.pdf");
        assert_eq!(sanitize_filename("a\u{0}b.png"), "ab.png");
        assert_eq!(sanitize_filename(""), "attachment");
    }

    #[test]
    fn imports_attachments_and_receipt_body_as_documents() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let msg = message_with(
            vec![Attachment {
                filename: "slip.pdf".into(),
                mime_type: "application/pdf".into(),
                bytes: b"%PDF-1.4 fake".to_vec(),
            }],
            Some("<html><body>Total R 123.45 VAT incl.</body></html>".into()),
        );

        let outcome = import_message_documents(&svc, &book_id, dir.path(), &msg).unwrap();
        assert_eq!(outcome.documents.len(), 2);
        assert_eq!(outcome.duplicates, 0);
        for doc in &outcome.documents {
            assert_eq!(doc.source, DocumentSource::Email);
            assert!(std::path::Path::new(&doc.file_path).exists(), "file written");
        }

        // Re-ingesting the same message only yields duplicates.
        let again = import_message_documents(&svc, &book_id, dir.path(), &msg).unwrap();
        assert_eq!(again.documents.len(), 0);
        assert_eq!(again.duplicates, 2);
    }
}
