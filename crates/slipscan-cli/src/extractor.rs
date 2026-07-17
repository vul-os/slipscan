//! Extraction runner: drive pending documents through an
//! [`ExtractionProvider`] (BYO key / local model — the provider only ever
//! talks to endpoints the user explicitly configured).
//!
//! Status flow per document: pending → processing → extracted, with failures
//! recorded on the document (pending → failed stays retryable via
//! `document_transition`). Documents whose mime type no provider understands
//! are skipped and stay pending.

use anyhow::Result;
use slipscan_core::domain::DocumentStatus;
use slipscan_core::CoreService;
use slipscan_extract::{ExtractionProvider, ExtractionRequest};

/// Mime types worth handing to a provider (images + PDF).
const SUPPORTED_MIME: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
];

#[derive(Debug, serde::Serialize)]
pub struct FailedDocument {
    pub document_id: String,
    pub error: String,
}

/// What one `slipscan extract` run did.
#[derive(Debug, Default, serde::Serialize)]
pub struct ExtractionRun {
    /// Document ids now in `extracted` with a stored slip-v2 payload.
    pub extracted: Vec<String>,
    /// Documents marked failed, with the provider error.
    pub failed: Vec<FailedDocument>,
    /// Unsupported mime type — left pending.
    pub skipped: Vec<String>,
}

/// Run extraction over up to `limit` pending documents in `book_id`.
pub async fn run_extraction(
    svc: &CoreService,
    provider: &dyn ExtractionProvider,
    book_id: &str,
    limit: usize,
) -> Result<ExtractionRun> {
    let pending = svc.document_list(book_id, Some(DocumentStatus::Pending))?;
    let mut run = ExtractionRun::default();

    for doc in pending.into_iter().take(limit) {
        let mime = doc.mime_type.clone().unwrap_or_default();
        if !SUPPORTED_MIME.contains(&mime.as_str()) {
            run.skipped.push(doc.id);
            continue;
        }
        let bytes = match std::fs::read(&doc.file_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                let message = format!("cannot read {}: {e}", doc.file_path);
                svc.document_transition(&doc.id, DocumentStatus::Failed, Some(&message))?;
                run.failed.push(FailedDocument {
                    document_id: doc.id,
                    error: message,
                });
                continue;
            }
        };

        svc.document_transition(&doc.id, DocumentStatus::Processing, None)?;
        match provider.extract(ExtractionRequest::new(mime, bytes)).await {
            Ok(slip) => {
                let payload = serde_json::to_string(&slip)?;
                svc.document_record_extraction(&doc.id, Some(provider.name()), None, &payload)?;
                run.extracted.push(doc.id);
            }
            Err(e) => {
                let message = e.to_string();
                svc.document_transition(&doc.id, DocumentStatus::Failed, Some(&message))?;
                run.failed.push(FailedDocument {
                    document_id: doc.id,
                    error: message,
                });
            }
        }
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use slipscan_core::domain::{BookKind, DocumentKind, DocumentSource, NewBook, NewDocument};
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;
    use slipscan_extract::{ExtractError, SlipExtraction, Totals};

    fn svc_with_book() -> (CoreService, String) {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Test".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
            })
            .unwrap();
        (svc, book.id)
    }

    fn import_doc(
        svc: &CoreService,
        book_id: &str,
        path: &std::path::Path,
        mime: &str,
        sha: &str,
    ) -> String {
        svc.document_import(NewDocument {
            book_id: book_id.to_string(),
            source: DocumentSource::Upload,
            kind: DocumentKind::Slip,
            file_path: path.display().to_string(),
            mime_type: Some(mime.to_string()),
            size_bytes: None,
            original_name: None,
            sha256: Some(sha.to_string()),
        })
        .unwrap()
        .id
    }

    struct MockProvider {
        fail: bool,
    }

    #[async_trait]
    impl ExtractionProvider for MockProvider {
        fn name(&self) -> &str {
            "mock"
        }

        async fn extract(
            &self,
            request: ExtractionRequest,
        ) -> Result<SlipExtraction, ExtractError> {
            if self.fail {
                return Err(ExtractError::Provider("boom".into()));
            }
            assert!(!request.bytes.is_empty());
            Ok(SlipExtraction {
                schema: slipscan_extract::SLIP_SCHEMA_VERSION.to_string(),
                merchant: None,
                purchased_at: None,
                currency: Some("ZAR".into()),
                totals: Totals {
                    total_minor: 4_200,
                    ..Default::default()
                },
                line_items: vec![],
                discounts: vec![],
                vat_breakdown: vec![],
                payment: None,
                confidence: Some(0.9),
                validation: None,
                warnings: vec![],
            })
        }
    }

    #[tokio::test]
    async fn extracts_pending_slips_and_skips_unsupported() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("slip.jpg");
        std::fs::write(&jpg, [0xff, 0xd8, 0xff]).unwrap();
        let html = dir.path().join("mail.html");
        std::fs::write(&html, "<html/>").unwrap();

        let jpg_id = import_doc(&svc, &book_id, &jpg, "image/jpeg", "a1");
        let html_id = import_doc(&svc, &book_id, &html, "text/html", "a2");

        let run = run_extraction(&svc, &MockProvider { fail: false }, &book_id, 10)
            .await
            .unwrap();
        assert_eq!(run.extracted, vec![jpg_id.clone()]);
        assert_eq!(run.skipped, vec![html_id.clone()]);
        assert!(run.failed.is_empty());

        let doc = svc.document_get(&jpg_id).unwrap();
        assert_eq!(doc.status, DocumentStatus::Extracted);
        let extraction = svc.document_current_extraction(&jpg_id).unwrap().unwrap();
        assert_eq!(extraction.provider.as_deref(), Some("mock"));
        let payload: serde_json::Value =
            serde_json::from_str(extraction.payload.as_deref().unwrap()).unwrap();
        assert_eq!(payload["totals"]["total_minor"], 4_200);

        // Skipped document stays pending for a future provider.
        assert_eq!(
            svc.document_get(&html_id).unwrap().status,
            DocumentStatus::Pending
        );
    }

    #[tokio::test]
    async fn provider_failure_marks_document_failed() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("slip.jpg");
        std::fs::write(&jpg, [1, 2, 3]).unwrap();
        let doc_id = import_doc(&svc, &book_id, &jpg, "image/jpeg", "b1");

        let run = run_extraction(&svc, &MockProvider { fail: true }, &book_id, 10)
            .await
            .unwrap();
        assert!(run.extracted.is_empty());
        assert_eq!(run.failed.len(), 1);
        assert_eq!(run.failed[0].document_id, doc_id);

        let doc = svc.document_get(&doc_id).unwrap();
        assert_eq!(doc.status, DocumentStatus::Failed);
        assert!(doc.error.as_deref().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn missing_file_marks_document_failed_without_calling_provider() {
        let (svc, book_id) = svc_with_book();
        let doc_id = import_doc(
            &svc,
            &book_id,
            std::path::Path::new("/nonexistent/slip.jpg"),
            "image/jpeg",
            "c1",
        );
        let run = run_extraction(&svc, &MockProvider { fail: false }, &book_id, 10)
            .await
            .unwrap();
        assert_eq!(run.failed.len(), 1);
        assert_eq!(run.failed[0].document_id, doc_id);
        assert_eq!(
            svc.document_get(&doc_id).unwrap().status,
            DocumentStatus::Failed
        );
    }
}
