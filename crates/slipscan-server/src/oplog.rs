//! The operation log for the CLI: a thin owning handle over
//! slipscan-core's [`slipscan_core::sync::Oplog`], exactly as
//! [`crate::devices::DeviceHandle`] wraps device identity.
//!
//! Core's `Oplog` borrows a SQLite connection and the OS keychain (ops are
//! signed with the device key, which lives in the vault); [`OplogHandle`]
//! owns both so a CLI command has a self-contained way in.
//!
//! # Nothing here is served over HTTP, and that is deliberate
//!
//! Not because the data is secret — a signed op is meant to be handed to a
//! peer, and the log's status carries no key material. Because **there is no
//! transport yet**, and an HTTP route that hands out ops would be the front
//! half of one: it would look like a sync endpoint, invite a client to poll
//! it, and have no authenticated peer on the other side, no replay defence
//! and no admission check against a pinned key. The route belongs with the
//! phase that builds those, not before it.
//!
//! Sealing stays local-only for the same reason `device rotate` does: it
//! uses the device private key, and the machine holding that key is where the
//! command should run. On a headless box that is over ssh, with the CLI.

use std::path::Path;

use slipscan_core::secrets::{KeyringSecretStore, SecretStore};
use slipscan_core::sync::{Oplog, SealReport, StoredOp, SyncStatus, VerifyReport};
use slipscan_core::{CoreResult, Db};

/// An owning handle: one SQLite connection + one keychain, yielding a core
/// [`Oplog`] on demand.
pub struct OplogHandle {
    db: Db,
    keychain: Box<dyn SecretStore>,
}

impl std::fmt::Debug for OplogHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OplogHandle").finish_non_exhaustive()
    }
}

impl OplogHandle {
    /// Open the log inside the database at `path` with the real OS keychain —
    /// the same file and the same keychain the core service, the vault and
    /// device identity all use.
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        Ok(Self::new(
            Db::open(path)?,
            Box::new(KeyringSecretStore::default()),
        ))
    }

    /// Assemble from parts (tests use an in-memory db + mock keychain).
    pub fn new(db: Db, keychain: Box<dyn SecretStore>) -> Self {
        Self { db, keychain }
    }

    fn oplog(&self) -> Oplog<'_> {
        Oplog::new(self.db.conn(), &*self.keychain)
    }

    /// Sign every captured write.
    pub fn seal(&self) -> CoreResult<SealReport> {
        self.oplog().seal()
    }

    /// What the log holds.
    pub fn status(&self) -> CoreResult<SyncStatus> {
        self.oplog().status()
    }

    /// Ops in total order, optionally scoped to one book.
    pub fn ops(&self, ns: Option<&str>, limit: Option<usize>) -> CoreResult<Vec<StoredOp>> {
        self.oplog().ops(ns, limit)
    }

    /// Verify every op independently.
    pub fn verify(&self) -> CoreResult<VerifyReport> {
        self.oplog().verify_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::device::Devices;
    use slipscan_core::secrets::MemorySecretStore;

    fn handle() -> OplogHandle {
        let db = Db::open_in_memory().unwrap();
        db.conn()
            .execute(
                "INSERT INTO books (id, kind, name, currency, locale, timezone,
                                    created_at, updated_at, region)
                 VALUES ('b-1', 'personal', 'Household', 'ZAR', 'en', 'UTC', 't', 't', 'za')",
                [],
            )
            .unwrap();
        let keychain = MemorySecretStore::default();
        Devices::new(db.conn(), &keychain)
            .initialize("laptop")
            .unwrap();
        OplogHandle::new(db, Box::new(keychain))
    }

    #[test]
    fn the_handle_seals_and_then_verifies_what_it_sealed() {
        let handle = handle();
        assert!(handle.status().unwrap().pending > 0);

        let report = handle.seal().unwrap();
        assert!(report.sealed > 0);

        let status = handle.status().unwrap();
        assert_eq!(status.pending, 0);
        assert!(status.ops > 0);
        assert_eq!(status.live_peers, 0, "pairing is a separate thing");

        let verified = handle.verify().unwrap();
        assert_eq!(verified.checked, status.ops);
        assert!(verified.is_sound());
    }

    #[test]
    fn ops_can_be_scoped_and_limited() {
        let handle = handle();
        handle.seal().unwrap();
        assert!(!handle.ops(Some("b-1"), None).unwrap().is_empty());
        assert!(handle.ops(Some("nowhere"), None).unwrap().is_empty());
        assert_eq!(handle.ops(None, Some(1)).unwrap().len(), 1);
    }
}
