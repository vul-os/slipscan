//! Secret storage indirection.
//!
//! Credentials (IMAP passwords, LLM API keys, scraper sessions) live in the
//! OS keychain — never in SQLite or config files. The service layer only ever
//! stores a keychain entry *name* in the settings table.
//!
//! `SecretStore` is a trait so tests (and headless environments) can plug in
//! an in-memory fake.

use crate::error::{CoreError, CoreResult};
use std::collections::HashMap;
use std::sync::Mutex;

/// Abstraction over the OS keychain.
pub trait SecretStore: Send {
    fn set_secret(&self, name: &str, value: &str) -> CoreResult<()>;
    fn get_secret(&self, name: &str) -> CoreResult<Option<String>>;
    fn delete_secret(&self, name: &str) -> CoreResult<()>;
}

/// Real keychain-backed store via the `keyring` crate.
#[derive(Debug)]
pub struct KeyringSecretStore {
    service: String,
}

impl KeyringSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, name: &str) -> CoreResult<keyring::Entry> {
        keyring::Entry::new(&self.service, name).map_err(|e| CoreError::Secret(e.to_string()))
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::new("slipscan")
    }
}

impl SecretStore for KeyringSecretStore {
    fn set_secret(&self, name: &str, value: &str) -> CoreResult<()> {
        self.entry(name)?
            .set_password(value)
            .map_err(|e| CoreError::Secret(e.to_string()))
    }

    fn get_secret(&self, name: &str) -> CoreResult<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CoreError::Secret(e.to_string())),
        }
    }

    fn delete_secret(&self, name: &str) -> CoreResult<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CoreError::Secret(e.to_string())),
        }
    }
}

/// In-memory fake for tests. Never use outside tests/dev.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn set_secret(&self, name: &str, value: &str) -> CoreResult<()> {
        self.entries
            .lock()
            .map_err(|_| CoreError::Secret("poisoned lock".into()))?
            .insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn get_secret(&self, name: &str) -> CoreResult<Option<String>> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| CoreError::Secret("poisoned lock".into()))?
            .get(name)
            .cloned())
    }

    fn delete_secret(&self, name: &str) -> CoreResult<()> {
        self.entries
            .lock()
            .map_err(|_| CoreError::Secret("poisoned lock".into()))?
            .remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips() {
        let store = MemorySecretStore::new();
        assert_eq!(store.get_secret("k").unwrap(), None);
        store.set_secret("k", "v").unwrap();
        assert_eq!(store.get_secret("k").unwrap(), Some("v".to_string()));
        store.delete_secret("k").unwrap();
        assert_eq!(store.get_secret("k").unwrap(), None);
    }
}
