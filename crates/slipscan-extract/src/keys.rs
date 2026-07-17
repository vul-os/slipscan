//! API-key access for BYO-key providers.
//!
//! Keys come **only** from the core credential vault
//! ([`slipscan_core::secrets::Vault`]) — never from env vars or config
//! files. Providers see the vault through the [`KeySource`] trait, which
//! mirrors `Vault::use_with`: the material is handed to a closure inside a
//! redacted, zeroize-on-drop [`SecretString`] and lives no longer than the
//! call. There is no `get`-for-display anywhere on this path, and the
//! material can never reach logs, `Debug` output, or error messages.
//!
//! The application layer adapts the vault in a few lines:
//!
//! ```ignore
//! impl KeySource for AppVaultHandle {
//!     fn use_key(
//!         &self,
//!         name: &str,
//!         consume: &mut dyn FnMut(&SecretString),
//!     ) -> Result<(), ExtractError> {
//!         let conn = self.open_book_db()?;
//!         let vault = Vault::new(&conn, &self.keychain);
//!         vault
//!             .use_with(name, |secret| {
//!                 consume(secret);
//!                 Ok(())
//!             })
//!             .map_err(slipscan_extract::keys::vault_error)
//!     }
//! }
//! ```

use crate::provider::ExtractError;
use slipscan_core::secrets::SecretString;
use slipscan_core::CoreError;
use std::sync::Arc;

/// The only way providers obtain API keys. Implementations wrap
/// `Vault::use_with`; the closure-callback shape makes it impossible to
/// return the material out of the source.
pub trait KeySource: Send + Sync {
    /// Hand the key stored under `name` to `consume`. Must call `consume`
    /// exactly once on success and must not copy the material elsewhere.
    fn use_key(
        &self,
        name: &str,
        consume: &mut dyn FnMut(&SecretString),
    ) -> Result<(), ExtractError>;
}

/// Shared handle to the vault, as providers hold it.
pub type SharedKeySource = Arc<dyn KeySource>;

/// Map a vault error onto the extraction error space: a missing entry is
/// "provider not configured", everything else is a secret-store failure.
/// `CoreError` messages carry metadata only, never key material.
pub fn vault_error(err: CoreError) -> ExtractError {
    match err {
        CoreError::NotFound { id, .. } => {
            ExtractError::NotConfigured(format!("no API key stored under {id:?}"))
        }
        other => ExtractError::Secret(other.to_string()),
    }
}

/// Fetch the key under `name` and run `f` on it, returning `f`'s result.
/// The borrow ends when `f` returns; the material is zeroized by the source.
pub fn use_api_key<R>(
    source: &dyn KeySource,
    name: &str,
    f: impl FnOnce(&str) -> R,
) -> Result<R, ExtractError> {
    let mut f = Some(f);
    let mut out = None;
    source.use_key(name, &mut |key| {
        if let Some(f) = f.take() {
            out = Some(f(key.expose_secret()));
        }
    })?;
    out.ok_or_else(|| ExtractError::Secret("key source completed without providing the key".into()))
}

#[cfg(test)]
pub(crate) mod test {
    //! Canned in-memory key source for provider unit tests.

    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct StaticKeys(HashMap<String, SecretString>);

    impl StaticKeys {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn with(mut self, name: &str, key: &str) -> Self {
            self.0.insert(name.to_string(), SecretString::new(key));
            self
        }
    }

    impl KeySource for StaticKeys {
        fn use_key(
            &self,
            name: &str,
            consume: &mut dyn FnMut(&SecretString),
        ) -> Result<(), ExtractError> {
            let key = self.0.get(name).ok_or_else(|| {
                ExtractError::NotConfigured(format!("no API key stored under {name:?}"))
            })?;
            consume(key);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test::StaticKeys;
    use super::*;

    #[test]
    fn hands_the_key_to_the_closure() {
        let source = StaticKeys::new().with("llm", "sk-test");
        let len = use_api_key(&source, "llm", |k| k.len()).unwrap();
        assert_eq!(len, 7);
    }

    #[test]
    fn missing_key_is_not_configured() {
        let source = StaticKeys::new();
        let err = use_api_key(&source, "llm", |_| ()).unwrap_err();
        assert!(matches!(err, ExtractError::NotConfigured(_)));
        // The entry name may appear in the message; there is no material.
        assert!(err.to_string().contains("llm"));
    }

    #[test]
    fn vault_not_found_maps_to_not_configured() {
        let err = vault_error(CoreError::NotFound {
            entity: "vault secret",
            id: "anthropic_api_key".into(),
        });
        assert!(matches!(err, ExtractError::NotConfigured(_)));

        let err = vault_error(CoreError::Secret("keychain locked".into()));
        assert!(matches!(err, ExtractError::Secret(_)));
    }
}
