//! Drop-folder import: point SlipScan at a directory and every PDF, image,
//! or CSV that lands there becomes a document.
//!
//! Two modes over the same import path:
//!
//! * [`scan_folder`] — one-shot: import everything supported that is already
//!   in the folder (used at startup and by the CLI).
//! * [`FolderWatcher`] — continuous: a `notify` filesystem watcher; call
//!   [`FolderWatcher::next_paths`] in a loop and feed the results to
//!   [`import_paths`].
//!
//! Everything funnels through [`crate::import::import_document_file`], so
//! content-hash dedup applies — dropping the same slip twice (or scanning
//! after watching) never double-imports. Purely local; no network.

use crate::import::{import_document_file, is_supported, FileImport};
use crate::{IngestError, IngestResult};
use slipscan_core::domain::{Document, DocumentSource};
use slipscan_core::CoreService;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// What a scan / import round produced.
#[derive(Debug, Default)]
pub struct FolderImportOutcome {
    pub imported: Vec<Document>,
    pub duplicates: usize,
    /// Files skipped because their extension is not ingestable.
    pub skipped: usize,
}

/// Import every supported file in `dir` (recursing into subdirectories).
pub fn scan_folder(
    svc: &CoreService,
    book_id: &str,
    dir: &Path,
) -> IngestResult<FolderImportOutcome> {
    let mut paths = Vec::new();
    collect_files(dir, &mut paths)?;
    paths.sort(); // deterministic import order
    import_paths(svc, book_id, &paths)
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> IngestResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// Import a batch of paths as documents (source `import`). Unsupported
/// files are counted as skipped, never errors — drop folders contain
/// `.DS_Store` and friends.
pub fn import_paths(
    svc: &CoreService,
    book_id: &str,
    paths: &[PathBuf],
) -> IngestResult<FolderImportOutcome> {
    let mut outcome = FolderImportOutcome::default();
    for path in paths {
        if !is_supported(path) {
            outcome.skipped += 1;
            continue;
        }
        match import_document_file(svc, book_id, path, DocumentSource::Import) {
            Ok(FileImport::Imported(doc)) => outcome.imported.push(*doc),
            Ok(FileImport::Duplicate { .. }) => outcome.duplicates += 1,
            // The file vanished between event and import (temp files,
            // atomic-save editors): not an error for a watcher.
            Err(IngestError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                outcome.skipped += 1;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(outcome)
}

/// A filesystem watcher on one drop folder.
pub struct FolderWatcher {
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    // Kept alive; dropping it stops the watch.
    _watcher: notify::RecommendedWatcher,
}

impl FolderWatcher {
    /// Start watching `dir` (recursively).
    pub fn watch(dir: &Path) -> IngestResult<Self> {
        use notify::Watcher as _;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .map_err(|e| IngestError::Watch(e.to_string()))?;
        watcher
            .watch(dir, notify::RecursiveMode::Recursive)
            .map_err(|e| IngestError::Watch(e.to_string()))?;
        Ok(Self {
            rx,
            _watcher: watcher,
        })
    }

    /// Block up to `timeout` for filesystem activity and return the batch of
    /// supported files it touched (deduplicated). Empty = nothing relevant
    /// happened; call again.
    pub fn next_paths(&self, timeout: Duration) -> IngestResult<Vec<PathBuf>> {
        let mut paths: Vec<PathBuf> = Vec::new();
        // Block for the first event…
        match self.rx.recv_timeout(timeout) {
            Ok(event) => collect_event_paths(event, &mut paths)?,
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(paths),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(IngestError::Watch("watcher thread stopped".into()))
            }
        }
        // …then drain whatever arrived with it (editors emit bursts), giving
        // the burst a moment to settle.
        loop {
            match self.rx.recv_timeout(Duration::from_millis(150)) {
                Ok(event) => collect_event_paths(event, &mut paths)?,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}

fn collect_event_paths(
    event: notify::Result<notify::Event>,
    out: &mut Vec<PathBuf>,
) -> IngestResult<()> {
    let event = event.map_err(|e| IngestError::Watch(e.to_string()))?;
    if is_relevant_event(&event.kind) {
        out.extend(event.paths.into_iter().filter(|p| is_supported(p)));
    }
    Ok(())
}

/// Creations, modifications, and renames-into-place matter; removals and
/// pure metadata churn do not.
fn is_relevant_event(kind: &notify::EventKind) -> bool {
    use notify::EventKind::*;
    match kind {
        Create(_) | Modify(_) => true,
        Access(_) | Remove(_) => false,
        // Any/Other: backends that can't classify — check anyway.
        _ => true,
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
                name: "Drop".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        (svc, book.id)
    }

    #[test]
    fn scan_folder_imports_supported_files_and_dedups_on_rescan() {
        let (svc, book_id) = svc_with_book();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("slip.jpg"), b"\xff\xd8 jpeg-1").unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested/statement.csv"), b"date,amount").unwrap();
        std::fs::write(dir.path().join(".DS_Store"), b"junk").unwrap();

        let outcome = scan_folder(&svc, &book_id, dir.path()).unwrap();
        assert_eq!(outcome.imported.len(), 2, "jpg + nested csv");
        assert_eq!(outcome.skipped, 1, ".DS_Store ignored");
        assert_eq!(outcome.duplicates, 0);

        // Re-scanning is idempotent: content-hash dedup.
        let again = scan_folder(&svc, &book_id, dir.path()).unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(again.duplicates, 2);
    }

    #[test]
    fn import_paths_tolerates_vanished_files() {
        let (svc, book_id) = svc_with_book();
        let gone = PathBuf::from("/definitely/not/here/slip.pdf");
        let outcome = import_paths(&svc, &book_id, &[gone]).unwrap();
        assert_eq!(outcome.skipped, 1);
        assert!(outcome.imported.is_empty());
    }

    #[test]
    fn event_relevance_filter() {
        use notify::event::{CreateKind, RemoveKind};
        assert!(is_relevant_event(&notify::EventKind::Create(
            CreateKind::File
        )));
        assert!(!is_relevant_event(&notify::EventKind::Remove(
            RemoveKind::File
        )));
    }

    #[test]
    fn watcher_reports_new_supported_files() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = FolderWatcher::watch(dir.path()).unwrap();

        std::fs::write(dir.path().join("fresh.pdf"), b"%PDF-1.4 watched").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"not ingestable").unwrap();

        // Filesystem watchers deliver asynchronously; poll a few rounds.
        let mut seen: Vec<PathBuf> = Vec::new();
        for _ in 0..20 {
            let batch = watcher.next_paths(Duration::from_millis(500)).unwrap();
            seen.extend(batch);
            if !seen.is_empty() {
                break;
            }
        }
        assert!(
            seen.iter()
                .any(|p| p.file_name().is_some_and(|n| n == "fresh.pdf")),
            "expected fresh.pdf in {seen:?}"
        );
        assert!(
            seen.iter()
                .all(|p| p.extension().is_none_or(|e| e != "txt")),
            "unsupported files filtered: {seen:?}"
        );
    }
}
