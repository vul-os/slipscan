//! Email inbound: the user's own mailbox as a document source.
//!
//! One [`MailboxConnector`] trait, provider implementations behind it:
//! generic IMAP ([`imap`], covers Proton Bridge on `127.0.0.1`), Gmail
//! ([`gmail`]), Microsoft Graph ([`graph`]); [`oauth`] holds the shared BYO
//! OAuth machinery (loopback and device-code flows, refresh). Connectors
//! normalise everything into [`InboundMessage`]s; [`import_message_documents`]
//! then feeds attachments and receipt-like HTML bodies into the core
//! document pipeline, and [`sync_mailbox`] drives one full
//! fetch → import → ack round.
//!
//! Mail carries two different things, and they take two different paths:
//!
//! * a **document** — a PDF/image attachment or a receipt-like HTML body —
//!   goes into the extraction pipeline ([`import_message_documents`]);
//! * a **bank alert** — "your card was used for 184.50 at …" — becomes a
//!   transaction ([`alerts`]), via the statement-import path, when an
//!   installed `mailrules` pack has a rule for it.
//!
//! The two are independent: a message can produce both, either, or neither.

pub mod alerts;
pub mod gmail;
pub mod graph;
pub mod imap;
pub mod oauth;
mod parse;

pub use alerts::{AlertDecline, AlertField, AlertRules, ParsedAlert};
pub use parse::{looks_like_receipt, parse_inbound};

use crate::import::{kind_for_extension, sha256_hex};
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use slipscan_core::domain::{Document, DocumentKind, DocumentSource, NewDocument, Transaction};
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
    /// The body as plain text (a text/plain part when the sender provided
    /// one, otherwise the HTML body with tags stripped and entities decoded).
    /// Kept for **every** message, not only receipt-like ones: bank alerts
    /// are not receipts, and this is what [`alerts`] matches against.
    ///
    /// `#[serde(default)]` so messages serialized before this field existed
    /// still deserialize — they simply carry no body.
    #[serde(default)]
    pub body_text: Option<String>,
}

/// What a push wait produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailboxEvent {
    /// The provider announced new mail — run a sync now.
    NewMail,
    /// Nothing happened within the timeout — re-issue the wait (or poll).
    Timeout,
    /// This connector has no push channel; callers must poll on a timer
    /// (e.g. Microsoft Graph outside self-host server mode).
    Unsupported,
}

/// A mailbox (IMAP, Gmail, Graph) the user connected — the normalized inbox.
///
/// The model is *list new since cursor, fetch, ack*: [`list_new`] returns
/// connector-scoped message ids the cursor has not passed yet,
/// [`fetch_message`] materialises one message (headers, body, attachments),
/// and [`mark_processed`] advances the durable cursor so restarts resume
/// where they left off.
///
/// `?Send`: connectors may hold a [`crate::state::CursorStore`] borrowing the
/// single-threaded core service, so sync runs on the owning thread.
///
/// [`list_new`]: MailboxConnector::list_new
/// [`fetch_message`]: MailboxConnector::fetch_message
/// [`mark_processed`]: MailboxConnector::mark_processed
#[async_trait(?Send)]
pub trait MailboxConnector {
    /// Stable connector id, e.g. `"imap"`, `"gmail"`, `"graph"`.
    fn name(&self) -> &str;

    /// Ids of messages not yet seen by SlipScan, oldest first.
    async fn list_new(&mut self) -> IngestResult<Vec<String>>;

    /// Fetch one message by the id [`Self::list_new`] returned. `None` when
    /// the message vanished between listing and fetching.
    async fn fetch_message(&mut self, message_id: &str) -> IngestResult<Option<InboundMessage>>;

    /// Mark a message as processed so it is not fetched again.
    async fn mark_processed(&mut self, message_id: &str) -> IngestResult<()>;

    /// List and fetch in one call. A single unparseable message is skipped
    /// (the cursor only advances when the caller acks), so one broken mail
    /// can never wedge a folder.
    async fn fetch_unseen(&mut self) -> IngestResult<Vec<InboundMessage>> {
        let ids = self.list_new().await?;
        let mut messages = Vec::with_capacity(ids.len());
        for id in ids {
            match self.fetch_message(&id).await {
                Ok(Some(msg)) => messages.push(msg),
                Ok(None) => continue,
                Err(IngestError::Parse(_)) => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(messages)
    }

    /// Block until the provider announces new mail, the timeout passes, or
    /// push is unsupported. Push is always an *outbound* connection (IMAP
    /// IDLE, Pub/Sub pull) — nothing ever connects to the user's machine.
    async fn wait_for_new(&mut self, _timeout: std::time::Duration) -> IngestResult<MailboxEvent> {
        Ok(MailboxEvent::Unsupported)
    }
}

/// Per-mailbox filter, applied before anything is imported (see
/// docs/EMAIL.md). Empty allowlist = allow all senders.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxFilter {
    /// Sender addresses or domains, e.g. `["fnb.co.za", "till@shop.example"]`.
    pub sender_allowlist: Vec<String>,
}

impl MailboxFilter {
    pub fn allows(&self, from: &str) -> bool {
        if self.sender_allowlist.is_empty() {
            return true;
        }
        let from = from.to_ascii_lowercase();
        self.sender_allowlist.iter().any(|entry| {
            let entry = entry.to_ascii_lowercase();
            from == entry || from.ends_with(&format!("@{entry}")) || {
                // Domain entries also match subdomains: "fnb.co.za" allows
                // "alerts@secure.fnb.co.za".
                from.rsplit('@')
                    .next()
                    .is_some_and(|dom| dom == entry || dom.ends_with(&format!(".{entry}")))
            }
        })
    }
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
        let ext = safe_name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
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

/// Turn bank-alert mail into transactions during a sync, using the rules
/// installed in this book and booking them to one account.
///
/// Absent (the default), a sync behaves exactly as it always has: documents
/// only, no transactions.
#[derive(Debug, Clone, Copy)]
pub struct AlertSync<'a> {
    /// Compiled rules from installed `mailrules` packs.
    pub rules: &'a AlertRules,
    /// The account matched alerts are booked to. Alerts whose account hint
    /// contradicts this account are declined, never rehomed.
    pub account_id: &'a str,
}

/// What one sync round contributed.
#[derive(Debug, Default)]
pub struct MailboxSyncOutcome {
    pub messages_seen: usize,
    pub messages_filtered: usize,
    pub documents: Vec<Document>,
    pub duplicates: usize,
    /// Transactions created from bank alerts.
    pub transactions: Vec<Transaction>,
    /// Alerts that matched an existing transaction and were not re-imported.
    pub transaction_duplicates: usize,
    /// Declines worth showing the user: a rule recognised the mail and then
    /// could not read a field. Mail no rule claims, and mail a rule's gates
    /// stood down on (the bank's own statements and marketing), are not in
    /// here — that is almost every message, and none of it is a problem.
    pub alert_declines: Vec<(String, AlertDecline)>,
}

/// One full sync round: fetch unseen mail, run the per-mailbox filter,
/// import documents, ack each message. A message is only acked once its
/// documents are safely in the store — a crash mid-round refetches, and
/// content-hash dedup makes the refetch harmless.
pub async fn sync_mailbox(
    connector: &mut dyn MailboxConnector,
    svc: &CoreService,
    book_id: &str,
    storage_dir: &Path,
    filter: &MailboxFilter,
) -> IngestResult<MailboxSyncOutcome> {
    sync_mailbox_with_alerts(connector, svc, book_id, storage_dir, filter, None).await
}

/// [`sync_mailbox`], plus bank-alert parsing when `alerts` is configured.
///
/// **Ordering is deliberate.** Each message's documents *and* its alert
/// transactions are persisted before that message is acked, so the existing
/// "never ack before it is stored" guarantee covers transactions too: a crash
/// mid-round refetches the message and dedupe absorbs the repeat.
///
/// **One import call per message**, which is what preserves that ordering,
/// carries the dedupe caveat [`import_statement_lines`] already documents for
/// separate batches: two genuinely identical alerts (same date, amount,
/// currency and merchant, no bank reference) are indistinguishable from one
/// alert fetched twice, and the second is counted in
/// [`MailboxSyncOutcome::transaction_duplicates`] rather than imported.
/// A rule whose bank sends a unique reference (`reference.unique = true`)
/// dedupes exactly and is not affected.
pub async fn sync_mailbox_with_alerts(
    connector: &mut dyn MailboxConnector,
    svc: &CoreService,
    book_id: &str,
    storage_dir: &Path,
    filter: &MailboxFilter,
    alerts: Option<AlertSync<'_>>,
) -> IngestResult<MailboxSyncOutcome> {
    let mut outcome = MailboxSyncOutcome::default();
    for message in connector.fetch_unseen().await? {
        outcome.messages_seen += 1;
        if filter.allows(&message.from) {
            let imported = import_message_documents(svc, book_id, storage_dir, &message)?;
            outcome.documents.extend(imported.documents);
            outcome.duplicates += imported.duplicates;

            if let Some(alerts) = &alerts {
                match alerts.rules.parse(&message) {
                    Ok(parsed) => {
                        let result = alerts::import_alerts(
                            svc,
                            book_id,
                            alerts.account_id,
                            std::slice::from_ref(&parsed),
                        )?;
                        outcome.transactions.extend(result.statement.imported);
                        outcome.transaction_duplicates += result.statement.duplicates;
                        for decline in result.declined {
                            outcome.alert_declines.push((message.id.clone(), decline));
                        }
                    }
                    Err(decline) => {
                        if decline.is_actionable() {
                            outcome.alert_declines.push((message.id.clone(), decline));
                        }
                    }
                }
            }
        } else {
            outcome.messages_filtered += 1;
        }
        connector.mark_processed(&message.id).await?;
    }
    Ok(outcome)
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
                region: None,
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
            body_text: None,
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
    fn sender_allowlist_matches_addresses_domains_and_subdomains() {
        let open = MailboxFilter::default();
        assert!(open.allows("anyone@anywhere.example"));

        let filter = MailboxFilter {
            sender_allowlist: vec!["fnb.co.za".into(), "till@shop.example".into()],
        };
        assert!(filter.allows("alerts@fnb.co.za"));
        assert!(filter.allows("alerts@secure.FNB.co.za"));
        assert!(filter.allows("till@shop.example"));
        assert!(!filter.allows("other@shop.example"));
        assert!(!filter.allows("alerts@notfnb.co.za.evil.example"));
    }

    /// Scripted connector for the sync-loop test.
    struct FakeConnector {
        queue: Vec<InboundMessage>,
        acked: Vec<String>,
    }

    #[async_trait(?Send)]
    impl MailboxConnector for FakeConnector {
        fn name(&self) -> &str {
            "fake"
        }

        async fn list_new(&mut self) -> IngestResult<Vec<String>> {
            Ok(self.queue.iter().map(|m| m.id.clone()).collect())
        }

        async fn fetch_message(&mut self, id: &str) -> IngestResult<Option<InboundMessage>> {
            Ok(self.queue.iter().find(|m| m.id == id).cloned())
        }

        async fn mark_processed(&mut self, id: &str) -> IngestResult<()> {
            self.acked.push(id.to_string());
            self.queue.retain(|m| m.id != id);
            Ok(())
        }
    }

    #[tokio::test]
    async fn sync_mailbox_imports_filters_and_acks() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();

        let mut allowed = message_with(
            vec![Attachment {
                filename: "slip.pdf".into(),
                mime_type: "application/pdf".into(),
                bytes: b"%PDF-1.4 sync".to_vec(),
            }],
            None,
        );
        allowed.id = "1".into();
        let mut blocked = message_with(
            vec![Attachment {
                filename: "spam.pdf".into(),
                mime_type: "application/pdf".into(),
                bytes: b"%PDF-1.4 spam".to_vec(),
            }],
            None,
        );
        blocked.id = "2".into();
        blocked.from = "noise@untrusted.example".into();

        let mut conn = FakeConnector {
            queue: vec![allowed, blocked],
            acked: vec![],
        };
        let filter = MailboxFilter {
            sender_allowlist: vec!["shop.example".into()],
        };
        let outcome = sync_mailbox(&mut conn, &svc, &book_id, dir.path(), &filter)
            .await
            .unwrap();
        assert_eq!(outcome.messages_seen, 2);
        assert_eq!(outcome.messages_filtered, 1);
        assert_eq!(outcome.documents.len(), 1);
        // Filtered mail is still acked (we never want to refetch it), but
        // its content is never imported.
        assert_eq!(conn.acked, vec!["1", "2"]);
        assert!(conn.queue.is_empty());
    }

    /// The two paths a message can take are independent, and both happen in
    /// one round: a receipt-like body becomes a document, a bank alert
    /// becomes a transaction, and a message can be neither.
    #[tokio::test]
    async fn sync_imports_documents_and_bank_alert_transactions_in_one_round() {
        use slipscan_core::domain::{AccountKind, NewAccount};
        use slipscan_packs::mailrules::{
            AmountSpec, AmountStyle, CurrencySpec, DateSpec, Direction, DirectionSpec, Extractor,
            MailPart, MailRule, MailRuleSet,
        };

        let (svc, book_id) = svc_with_book();
        let account = svc
            .account_create(NewAccount {
                book_id: book_id.clone(),
                name: "Card".into(),
                kind: AccountKind::Card,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        let dir = tempfile::tempdir().unwrap();

        let rule = MailRule {
            id: "card-purchase".into(),
            description: None,
            from_patterns: vec!["meridian.example".into()],
            subject_patterns: vec![r"(?i)card purchase".into()],
            body_patterns: vec![],
            amount: AmountSpec {
                part: MailPart::Body,
                pattern: r"(?i)purchase of ZAR ([\d.,]+) at".into(),
                group: 1,
                style: AmountStyle::Point,
            },
            currency: CurrencySpec::Fixed { code: "ZAR".into() },
            date: DateSpec::Received,
            merchant: Extractor {
                part: MailPart::Body,
                pattern: r"(?i) at (.+?) on your card".into(),
                group: 1,
            },
            reference: None,
            direction: DirectionSpec::Fixed {
                direction: Direction::Debit,
            },
            account_hint: None,
            max_date_drift_days: 30,
        };
        let rules = AlertRules::compile(vec![(
            "fixture-alerts".to_string(),
            MailRuleSet { rules: vec![rule] },
        )])
        .unwrap();

        // 1: a bank alert — becomes a transaction, and no document.
        let mut alert = message_with(vec![], None);
        alert.id = "1".into();
        alert.from = "noreply@alerts.meridian.example".into();
        alert.subject = Some("Card purchase notification".into());
        alert.body_text =
            Some("A purchase of ZAR 249.90 at CLICKS GARDENS on your card was approved.".into());

        // 2: an ordinary receipt with a PDF — becomes a document, no txn.
        let mut receipt = message_with(
            vec![Attachment {
                filename: "slip.pdf".into(),
                mime_type: "application/pdf".into(),
                bytes: b"%PDF-1.4 mixed".to_vec(),
            }],
            None,
        );
        receipt.id = "2".into();

        // 3: mail from the bank that no rule claims — neither, and silent.
        let mut newsletter = message_with(vec![], None);
        newsletter.id = "3".into();
        newsletter.from = "news@alerts.meridian.example".into();
        newsletter.subject = Some("Our new travel card".into());
        newsletter.body_text = Some("Earn more on every trip.".into());

        let mut conn = FakeConnector {
            queue: vec![alert, receipt, newsletter],
            acked: vec![],
        };
        let outcome = sync_mailbox_with_alerts(
            &mut conn,
            &svc,
            &book_id,
            dir.path(),
            &MailboxFilter::default(),
            Some(AlertSync {
                rules: &rules,
                account_id: &account.id,
            }),
        )
        .await
        .unwrap();

        assert_eq!(outcome.messages_seen, 3);
        assert_eq!(
            outcome.documents.len(),
            1,
            "only the receipt has a document"
        );
        assert_eq!(
            outcome.transactions.len(),
            1,
            "only the alert is a transaction"
        );
        assert_eq!(outcome.transactions[0].amount_minor, -24_990);
        assert_eq!(
            outcome.transactions[0].description.as_deref(),
            Some("CLICKS GARDENS")
        );
        // The newsletter no rule claimed is not reported as a problem.
        assert!(
            outcome.alert_declines.is_empty(),
            "{:?}",
            outcome.alert_declines
        );
        assert_eq!(conn.acked, vec!["1", "2", "3"]);

        // The same alert refetched (a crash mid-round, a re-added mailbox)
        // dedupes instead of double-booking the card.
        let mut resent = message_with(vec![], None);
        resent.id = "4".into();
        resent.from = "noreply@alerts.meridian.example".into();
        resent.subject = Some("Card purchase notification".into());
        resent.body_text =
            Some("A purchase of ZAR 249.90 at CLICKS GARDENS on your card was approved.".into());
        let mut conn = FakeConnector {
            queue: vec![resent],
            acked: vec![],
        };
        let repeat = sync_mailbox_with_alerts(
            &mut conn,
            &svc,
            &book_id,
            dir.path(),
            &MailboxFilter::default(),
            Some(AlertSync {
                rules: &rules,
                account_id: &account.id,
            }),
        )
        .await
        .unwrap();
        assert_eq!(repeat.messages_seen, 1);
        assert!(repeat.transactions.is_empty(), "no second transaction");
        assert_eq!(repeat.transaction_duplicates, 1);
    }

    /// Without an [`AlertSync`], a sync is byte-for-byte the behaviour it had
    /// before alerts existed: documents only.
    #[tokio::test]
    async fn a_sync_without_alerts_configured_creates_no_transactions() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let mut alert = message_with(vec![], None);
        alert.body_text = Some("A purchase of ZAR 249.90 at CLICKS GARDENS on your card.".into());

        let mut conn = FakeConnector {
            queue: vec![alert],
            acked: vec![],
        };
        let outcome = sync_mailbox(
            &mut conn,
            &svc,
            &book_id,
            dir.path(),
            &MailboxFilter::default(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.messages_seen, 1);
        assert!(outcome.transactions.is_empty());
        assert!(outcome.alert_declines.is_empty());
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
            assert!(
                std::path::Path::new(&doc.file_path).exists(),
                "file written"
            );
        }

        // Re-ingesting the same message only yields duplicates.
        let again = import_message_documents(&svc, &book_id, dir.path(), &msg).unwrap();
        assert_eq!(again.documents.len(), 0);
        assert_eq!(again.duplicates, 2);
    }
}
