//! Credential vault: write-only secret storage per docs/ARCHITECTURE.md.
//!
//! Three layers:
//!
//! * [`store`] — thin trait over the OS keychain (`keyring` crate) with an
//!   in-memory mock for tests. The keychain holds exactly one vault item:
//!   the key-encryption key (KEK). It never touches disk.
//! * [`string`] — [`SecretString`], the only type secret material travels in:
//!   zeroized on drop, redacted `Debug`/`Display`, no serde impls.
//! * [`vault`] — envelope encryption over SQLite. Each secret is sealed with
//!   XChaCha20-Poly1305 under a per-machine data-encryption key (DEK); the
//!   DEK is wrapped by the KEK. Copying the SQLite file off the machine
//!   yields nothing.
//!
//! The vault API is **write-only**: `set`, `replace`, `revoke`,
//! `list_metadata`, and `use_with(name, |secret| ...)`. There is no
//! `get`-for-display, no export, and nothing here may ever be exposed over
//! IPC except [`vault::VaultSecretMeta`]. Every access is recorded in the
//! append-only audit log — metadata only, never material.

mod store;
mod string;
mod vault;

pub use store::{KeyringSecretStore, MemorySecretStore, SecretStore};
pub use string::SecretString;
pub use vault::{Vault, VaultSecretMeta};
