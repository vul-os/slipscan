//! Vault access for the server and CLI: a thin handle over slipscan-core's
//! envelope-encryption credential vault (`slipscan_core::secrets::Vault`).
//!
//! The vault is **write-only** (docs/ARCHITECTURE.md): humans can set,
//! replace, revoke and list metadata — never view material. Software
//! consumes secrets via [`VaultHandle::use_with`], which hands the value to
//! a closure inside a redacted, zeroize-on-drop `SecretString`.
//!
//! Core's `Vault` borrows a SQLite connection and the OS keychain;
//! [`VaultHandle`] owns both so the HTTP routes and CLI commands have a
//! self-contained way in. It opens its own connection to the same database
//! file the core service uses — vault rows, audit entries and everything
//! else stay in the one user-visible SQLite file.
//!
//! Over HTTP only metadata ever crosses the wire ([`VaultSecretMeta`]);
//! setting or replacing material happens locally (CLI prompt / desktop
//! IPC), never remotely.

use std::path::Path;

use slipscan_core::secrets::{
    KeyringSecretStore, SecretStore, SecretString, Vault, VaultSecretMeta,
};
use slipscan_core::{CoreResult, Db};

/// An owning handle: one SQLite connection + one keychain, yielding a core
/// `Vault` on demand.
pub struct VaultHandle {
    db: Db,
    keychain: Box<dyn SecretStore>,
}

impl std::fmt::Debug for VaultHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultHandle").finish_non_exhaustive()
    }
}

impl VaultHandle {
    /// Open the vault inside the database at `path` with the real OS
    /// keychain. The database is created/migrated if needed, so this is the
    /// same file the core service uses.
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

    fn vault(&self) -> Vault<'_> {
        Vault::new(self.db.conn(), &*self.keychain)
    }

    /// Store a new credential. Fails if the name is taken — rotation goes
    /// through [`VaultHandle::replace`] so it is always explicit.
    pub fn set(&self, name: &str, secret: SecretString) -> CoreResult<VaultSecretMeta> {
        self.vault().set(name, secret)
    }

    /// Rotate an existing credential; the old ciphertext is destroyed.
    pub fn replace(&self, name: &str, secret: SecretString) -> CoreResult<VaultSecretMeta> {
        self.vault().replace(name, secret)
    }

    /// Destroy a credential.
    pub fn revoke(&self, name: &str) -> CoreResult<()> {
        self.vault().revoke(name)
    }

    /// Metadata for every stored credential — never material.
    pub fn list(&self) -> CoreResult<Vec<VaultSecretMeta>> {
        self.vault().list_metadata()
    }

    /// Hand the decrypted material to `consume` for the shortest possible
    /// scope. The only read path; the access lands in the audit log.
    pub fn use_with<T>(
        &self,
        name: &str,
        consume: impl FnOnce(&SecretString) -> CoreResult<T>,
    ) -> CoreResult<T> {
        self.vault().use_with(name, consume)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::CoreError;

    fn handle() -> VaultHandle {
        VaultHandle::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        )
    }

    #[test]
    fn debug_is_redacted() {
        let vault = handle();
        vault
            .set("imap.main", SecretString::new("hunter2"))
            .unwrap();
        let debug = format!("{vault:?}");
        assert!(!debug.contains("hunter2"));
    }

    #[test]
    fn lifecycle_set_list_replace_use_revoke() {
        let vault = handle();
        let meta = vault
            .set("imap.main", SecretString::new("app-pass-1"))
            .unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.fingerprint.len(), 8);

        // Listing yields metadata only; serialized form carries no material.
        let listed = vault.list().unwrap();
        assert_eq!(listed.len(), 1);
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains("app-pass-1"));

        // Duplicate set refused; rotation is explicit.
        assert!(matches!(
            vault.set("imap.main", SecretString::new("x")),
            Err(CoreError::Validation(_))
        ));
        let rotated = vault
            .replace("imap.main", SecretString::new("app-pass-2"))
            .unwrap();
        assert_eq!(rotated.version, 2);
        assert_ne!(rotated.fingerprint, meta.fingerprint);

        // use_with is the only read path and sees the newest material.
        let len = vault
            .use_with("imap.main", |secret| Ok(secret.expose_secret().len()))
            .unwrap();
        assert_eq!(len, "app-pass-2".len());

        vault.revoke("imap.main").unwrap();
        assert!(vault.list().unwrap().is_empty());
        assert!(matches!(
            vault.use_with("imap.main", |_| Ok(())),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            vault.revoke("imap.main"),
            Err(CoreError::NotFound { .. })
        ));
    }
}
