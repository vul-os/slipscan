//! File import: turn a file on disk into a core document import.
//!
//! Used by the drop-folder watcher, the email connector (attachments are
//! written to the book's document store first), and the CLI `import` command.

use crate::{IngestError, IngestResult};
use sha2::{Digest, Sha256};
use slipscan_core::domain::{Document, DocumentKind, DocumentSource, NewDocument};
use slipscan_core::{CoreError, CoreService};
use std::fmt::Write as _;
use std::path::Path;

/// File extensions we accept as ingestable documents.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "webp", "heic", "gif", "tif", "tiff", "html", "csv", "ofx",
];

/// Lowercased extension of a path, if any.
pub fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Whether the file looks like something SlipScan can ingest.
pub fn is_supported(path: &Path) -> bool {
    extension_of(path).is_some_and(|ext| SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
}

/// Best-effort MIME type from the file extension.
pub fn mime_for_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "html" => "text/html",
        "csv" => "text/csv",
        "ofx" => "application/x-ofx",
        _ => return None,
    })
}

/// Document kind guessed from the extension. Images are almost always till
/// slips; CSV/OFX are bank statements; PDFs need extraction to tell.
pub fn kind_for_extension(ext: &str) -> DocumentKind {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "heic" | "gif" | "tif" | "tiff" => DocumentKind::Slip,
        "csv" | "ofx" => DocumentKind::BankStatement,
        _ => DocumentKind::Unknown,
    }
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// The result of importing one file.
#[derive(Debug)]
pub enum FileImport {
    /// A new document row was created (boxed: much larger than the
    /// duplicate arm).
    Imported(Box<Document>),
    /// The same content (by SHA-256) already exists in this book.
    Duplicate { existing_id: String },
}

/// Import a file from disk as a document in `book_id`.
///
/// The file stays where it is — `file_path` records its location; core
/// deduplicates by content hash. Unsupported extensions are rejected.
pub fn import_document_file(
    svc: &CoreService,
    book_id: &str,
    path: &Path,
    source: DocumentSource,
) -> IngestResult<FileImport> {
    let ext = extension_of(path)
        .filter(|e| SUPPORTED_EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| IngestError::UnsupportedFile(path.display().to_string()))?;

    let bytes = std::fs::read(path)?;
    let new = NewDocument {
        book_id: book_id.to_string(),
        source,
        kind: kind_for_extension(&ext),
        file_path: path.display().to_string(),
        mime_type: mime_for_extension(&ext).map(str::to_string),
        size_bytes: Some(bytes.len() as i64),
        original_name: path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string),
        sha256: Some(sha256_hex(&bytes)),
    };
    match svc.document_import(new) {
        Ok(doc) => Ok(FileImport::Imported(Box::new(doc))),
        Err(CoreError::DuplicateDocument { existing_id }) => {
            Ok(FileImport::Duplicate { existing_id })
        }
        Err(e) => Err(e.into()),
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
                name: "Test".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        (svc, book.id)
    }

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn kind_and_mime_mapping() {
        assert_eq!(kind_for_extension("jpg"), DocumentKind::Slip);
        assert_eq!(kind_for_extension("ofx"), DocumentKind::BankStatement);
        assert_eq!(kind_for_extension("pdf"), DocumentKind::Unknown);
        assert_eq!(mime_for_extension("pdf"), Some("application/pdf"));
        assert_eq!(mime_for_extension("nope"), None);
    }

    #[test]
    fn imports_file_and_detects_duplicates() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slip.jpg");
        std::fs::write(&path, b"\xff\xd8\xff\xe0 fake jpeg").unwrap();

        let first = import_document_file(&svc, &book_id, &path, DocumentSource::Upload).unwrap();
        let doc = match first {
            FileImport::Imported(d) => d,
            other => panic!("expected import, got {other:?}"),
        };
        assert_eq!(doc.kind, DocumentKind::Slip);
        assert_eq!(doc.mime_type.as_deref(), Some("image/jpeg"));
        assert_eq!(doc.original_name.as_deref(), Some("slip.jpg"));

        // Same bytes under a new name: content-hash duplicate.
        let copy = dir.path().join("copy.jpg");
        std::fs::write(&copy, b"\xff\xd8\xff\xe0 fake jpeg").unwrap();
        match import_document_file(&svc, &book_id, &copy, DocumentSource::Upload).unwrap() {
            FileImport::Duplicate { existing_id } => assert_eq!(existing_id, doc.id),
            other => panic!("expected duplicate, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unsupported_extension() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.docx");
        std::fs::write(&path, b"hi").unwrap();
        let err = import_document_file(&svc, &book_id, &path, DocumentSource::Upload).unwrap_err();
        assert!(matches!(err, IngestError::UnsupportedFile(_)));
    }
}
