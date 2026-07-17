//! Cursor persistence: "where did we get to last time?"
//!
//! Every incremental source (IMAP folder UID, bank-scraper cursor, statement
//! high-water mark) stores an opaque string cursor under a stable key.
//! [`SettingsCursorStore`] persists them in the book's SQLite settings table
//! via [`CoreService`] (cursors are not secrets); [`MemoryCursorStore`] backs
//! tests.

use crate::{IngestError, IngestResult};
use slipscan_core::CoreService;
use std::collections::HashMap;

/// Persistence for per-source sync cursors.
pub trait CursorStore: Send {
    fn get_cursor(&self, key: &str) -> IngestResult<Option<String>>;
    fn set_cursor(&mut self, key: &str, value: &str) -> IngestResult<()>;
}

/// In-memory cursor store for tests and one-shot runs.
#[derive(Debug, Default)]
pub struct MemoryCursorStore {
    cursors: HashMap<String, String>,
}

impl MemoryCursorStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CursorStore for MemoryCursorStore {
    fn get_cursor(&self, key: &str) -> IngestResult<Option<String>> {
        Ok(self.cursors.get(key).cloned())
    }

    fn set_cursor(&mut self, key: &str, value: &str) -> IngestResult<()> {
        self.cursors.insert(key.to_string(), value.to_string());
        Ok(())
    }
}

/// Cursor store backed by the core settings table (key prefix
/// `ingest.cursor.`). Cursors are plain values, never secret material.
pub struct SettingsCursorStore<'a> {
    svc: &'a CoreService,
}

impl<'a> SettingsCursorStore<'a> {
    pub fn new(svc: &'a CoreService) -> Self {
        Self { svc }
    }

    fn settings_key(key: &str) -> String {
        format!("ingest.cursor.{key}")
    }
}

impl CursorStore for SettingsCursorStore<'_> {
    fn get_cursor(&self, key: &str) -> IngestResult<Option<String>> {
        self.svc
            .settings_get(&Self::settings_key(key))
            .map_err(IngestError::from)
    }

    fn set_cursor(&mut self, key: &str, value: &str) -> IngestResult<()> {
        self.svc
            .settings_set(&Self::settings_key(key), value, false)
            .map_err(IngestError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;

    #[test]
    fn memory_store_round_trips() {
        let mut store = MemoryCursorStore::new();
        assert_eq!(store.get_cursor("k").unwrap(), None);
        store.set_cursor("k", "42").unwrap();
        assert_eq!(store.get_cursor("k").unwrap(), Some("42".into()));
        store.set_cursor("k", "43").unwrap();
        assert_eq!(store.get_cursor("k").unwrap(), Some("43".into()));
    }

    #[test]
    fn settings_store_persists_via_core() {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let mut store = SettingsCursorStore::new(&svc);
        assert_eq!(store.get_cursor("imap:example:inbox").unwrap(), None);
        store.set_cursor("imap:example:inbox", "17").unwrap();
        assert_eq!(
            store.get_cursor("imap:example:inbox").unwrap(),
            Some("17".into())
        );
        // Stored under the namespaced settings key, as a non-secret.
        assert_eq!(
            svc.settings_get("ingest.cursor.imap:example:inbox").unwrap(),
            Some("17".into())
        );
    }
}
