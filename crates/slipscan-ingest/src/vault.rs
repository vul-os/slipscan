//! Credential handoff: how connectors and bank adapters receive secrets.
//!
//! Mirrors the core credential vault's `use_with(name, |secret| ...)`
//! contract (docs/ARCHITECTURE.md): the consumer is *handed* material inside
//! a closure — there is no get-for-display, and connectors never read the OS
//! keychain themselves. [`VaultAccess::store`] exists solely so OAuth token
//! refresh can persist *rotated* material back; nothing in this crate ever
//! returns a secret across an API boundary.
//!
//! Secret material always travels as [`SecretString`] (zeroized on drop,
//! redacted `Debug`/`Display`, no serde) — a log line or IPC payload cannot
//! contain it by construction.

use crate::{IngestError, IngestResult};
use slipscan_core::secrets::SecretString;
use slipscan_core::CoreService;
use std::collections::HashMap;
use std::sync::Mutex;

/// The slice of the credential vault an ingestion adapter is allowed to see.
///
/// Dyn-compatible on purpose: connectors hold `&dyn VaultAccess` so any vault
/// backend (the core envelope vault, keychain-backed settings, an in-memory
/// fake in tests) plugs in without touching connector code.
pub trait VaultAccess {
    /// Hand the named secret to `f` for the duration of the call.
    ///
    /// Errors with [`IngestError::MissingCredential`] when nothing is stored
    /// under `name`.
    fn use_with(
        &self,
        name: &str,
        f: &mut dyn FnMut(&SecretString) -> IngestResult<()>,
    ) -> IngestResult<()>;

    /// Persist new/rotated secret material (e.g. a refreshed OAuth token
    /// set). Write-only: there is no corresponding read-for-display.
    fn store(&self, name: &str, value: &SecretString) -> IngestResult<()>;
}

/// Run `f` with the named secret and return its result.
///
/// Generic convenience over the dyn-compatible [`VaultAccess::use_with`].
pub fn use_secret<R>(
    vault: &dyn VaultAccess,
    name: &str,
    f: impl FnOnce(&SecretString) -> IngestResult<R>,
) -> IngestResult<R> {
    let mut f = Some(f);
    let mut out: Option<IngestResult<R>> = None;
    vault.use_with(name, &mut |secret| {
        if let Some(f) = f.take() {
            out = Some(f(secret));
        }
        Ok(())
    })?;
    out.ok_or_else(|| IngestError::MissingCredential(name.to_string()))?
}

/// Copy the named secret out of the vault for immediate use in an async
/// operation (a login command, an HTTP `Authorization` header).
///
/// `use_with` closures are synchronous; network authentication is not. The
/// returned [`SecretString`] must stay function-local and is zeroized on
/// drop. Crate-private on purpose — adapters outside this crate go through
/// [`VaultAccess::use_with`].
pub(crate) fn read_secret(vault: &dyn VaultAccess, name: &str) -> IngestResult<SecretString> {
    use_secret(vault, name, |s| Ok(s.clone()))
}

/// [`VaultAccess`] over the core service's secret-backed settings: values
/// live in the OS keychain (`settings_set(name, value, secret = true)`),
/// SQLite only ever sees the keychain entry name.
///
/// This is the production bridge until the core envelope vault
/// (`slipscan_core::secrets::Vault`) is wired through `CoreService`; swapping
/// the backend touches only this impl, never the connectors.
pub struct CoreSettingsVault<'a> {
    svc: &'a CoreService,
}

impl<'a> CoreSettingsVault<'a> {
    pub fn new(svc: &'a CoreService) -> Self {
        Self { svc }
    }
}

impl VaultAccess for CoreSettingsVault<'_> {
    fn use_with(
        &self,
        name: &str,
        f: &mut dyn FnMut(&SecretString) -> IngestResult<()>,
    ) -> IngestResult<()> {
        // `settings_use_secret` is the core's closure-only secret path —
        // material is handed to `f` in place and never returned by a getter.
        match self.svc.settings_use_secret(name, |secret| f(secret))? {
            Some(result) => result,
            None => Err(IngestError::MissingCredential(name.to_string())),
        }
    }

    fn store(&self, name: &str, value: &SecretString) -> IngestResult<()> {
        self.svc
            .settings_set(name, value.expose_secret(), true)
            .map_err(IngestError::from)
    }
}

/// The core envelope-encryption vault *is* a [`VaultAccess`]: connectors
/// plug straight into `slipscan_core::secrets::Vault` — `use_with` maps
/// one-to-one, and [`VaultAccess::store`] becomes `set`/`replace` so token
/// rotation is audited as rotation.
impl VaultAccess for slipscan_core::secrets::Vault<'_> {
    fn use_with(
        &self,
        name: &str,
        f: &mut dyn FnMut(&SecretString) -> IngestResult<()>,
    ) -> IngestResult<()> {
        let mut out: IngestResult<()> = Ok(());
        let result = slipscan_core::secrets::Vault::use_with(self, name, |secret| {
            out = f(secret);
            Ok(())
        });
        match result {
            Ok(()) => out,
            Err(slipscan_core::CoreError::NotFound {
                entity: "vault_secret",
                ..
            }) => Err(IngestError::MissingCredential(name.to_string())),
            Err(e) => Err(e.into()),
        }
    }

    fn store(&self, name: &str, value: &SecretString) -> IngestResult<()> {
        let exists = self.list_metadata()?.iter().any(|m| m.name == name);
        let result = if exists {
            self.replace(name, value.clone())
        } else {
            self.set(name, value.clone())
        };
        result.map(|_| ()).map_err(IngestError::from)
    }
}

/// In-memory vault for tests and dev. Never use in production.
#[derive(Default)]
pub struct MemoryVault {
    entries: Mutex<HashMap<String, SecretString>>,
}

impl MemoryVault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed a secret (test setup).
    pub fn with(self, name: &str, value: &str) -> Self {
        self.entries
            .lock()
            .expect("vault lock")
            .insert(name.to_string(), SecretString::new(value));
        self
    }

    /// Test-only peek so assertions can verify rotation happened.
    #[cfg(test)]
    pub(crate) fn peek(&self, name: &str) -> Option<String> {
        self.entries
            .lock()
            .expect("vault lock")
            .get(name)
            .map(|s| s.expose_secret().to_string())
    }
}

impl VaultAccess for MemoryVault {
    fn use_with(
        &self,
        name: &str,
        f: &mut dyn FnMut(&SecretString) -> IngestResult<()>,
    ) -> IngestResult<()> {
        let guard = self
            .entries
            .lock()
            .map_err(|_| IngestError::State("poisoned vault lock".into()))?;
        match guard.get(name) {
            Some(secret) => f(secret),
            None => Err(IngestError::MissingCredential(name.to_string())),
        }
    }

    fn store(&self, name: &str, value: &SecretString) -> IngestResult<()> {
        self.entries
            .lock()
            .map_err(|_| IngestError::State("poisoned vault lock".into()))?
            .insert(name.to_string(), value.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;

    #[test]
    fn memory_vault_hands_secrets_to_closures_only() {
        let vault = MemoryVault::new().with("imap.pass", "hunter2");
        let got = use_secret(&vault, "imap.pass", |s| Ok(s.expose_secret().len())).unwrap();
        assert_eq!(got, 7);
        assert!(matches!(
            use_secret(&vault, "absent", |_| Ok(())),
            Err(IngestError::MissingCredential(_))
        ));
    }

    #[test]
    fn store_rotates_material() {
        let vault = MemoryVault::new().with("token", "old");
        vault.store("token", &SecretString::new("new")).unwrap();
        assert_eq!(vault.peek("token").as_deref(), Some("new"));
    }

    #[test]
    fn core_envelope_vault_plugs_in_as_vault_access() {
        let db = Db::open_in_memory().unwrap();
        let keychain = MemorySecretStore::new();
        let vault = slipscan_core::secrets::Vault::new(db.conn(), &keychain);

        let access: &dyn VaultAccess = &vault;
        assert!(matches!(
            use_secret(access, "gmail.tokens", |_| Ok(())),
            Err(IngestError::MissingCredential(_))
        ));
        // First store = set, second = replace (rotation), both via `store`.
        access
            .store("gmail.tokens", &SecretString::new("v1"))
            .unwrap();
        access
            .store("gmail.tokens", &SecretString::new("v2"))
            .unwrap();
        let material = use_secret(access, "gmail.tokens", |s| {
            Ok(s.expose_secret().to_string())
        })
        .unwrap();
        assert_eq!(material, "v2");
        let meta = vault.list_metadata().unwrap();
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].version, 2, "store rotated, not re-created");
    }

    #[test]
    fn core_settings_vault_round_trips_through_keychain_settings() {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let vault = CoreSettingsVault::new(&svc);
        assert!(matches!(
            use_secret(&vault, "mail.pw", |_| Ok(())),
            Err(IngestError::MissingCredential(_))
        ));
        vault
            .store("mail.pw", &SecretString::new("app-password"))
            .unwrap();
        let len = use_secret(&vault, "mail.pw", |s| Ok(s.expose_secret().len())).unwrap();
        assert_eq!(len, "app-password".len());
    }
}
