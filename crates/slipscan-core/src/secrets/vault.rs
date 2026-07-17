//! Envelope-encrypted, write-only credential vault (see docs/ARCHITECTURE.md,
//! "Credential vault").
//!
//! Key hierarchy:
//!
//! ```text
//! OS keychain ──holds── KEK (32 bytes, never on disk)
//!                        │ wraps (XChaCha20-Poly1305)
//! vault_keys   ──holds── DEK ciphertext (per-machine data-encryption key)
//!                        │ seals (XChaCha20-Poly1305, per-secret nonce + AAD)
//! vault_secrets ─holds── secret ciphertext + write-only metadata
//! ```
//!
//! Copying `vault_keys` + `vault_secrets` off the machine yields nothing:
//! without the KEK from that user's unlocked OS session the DEK cannot be
//! unwrapped. Raw SQL lives here rather than in `repo/` because no other
//! module may touch these tables.
//!
//! Semantics:
//! * **write-only** — no `get`-for-display anywhere; software consumes
//!   secrets via [`Vault::use_with`] closures only
//! * **rotation, not editing** — [`Vault::replace`] overwrites the old
//!   ciphertext in place (version bump); [`Vault::revoke`] deletes the row
//! * **audited** — every `set` / `replace` / `revoke` / `use` lands in the
//!   append-only audit log with metadata only, never material

use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, Key, XChaCha20Poly1305, XNonce};
use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::domain::AuditEntry;
use crate::error::{CoreError, CoreResult};
use crate::repo;
use crate::secrets::{SecretStore, SecretString};
use crate::util::{new_id, now_iso};

/// Keychain entry name under which the KEK lives. The keychain *service*
/// name comes from the [`SecretStore`] implementation (default "slipscan").
const KEK_ENTRY: &str = "vault.kek";
/// Single DEK row id in `vault_keys`.
const DEK_ID: &str = "dek";
/// AAD binding the wrapped DEK to its purpose.
const DEK_AAD: &[u8] = b"slipscan.vault.dek.v1";
/// Domain separator for secret fingerprints.
const FINGERPRINT_DOMAIN: &[u8] = b"slipscan.vault.fingerprint.v1";
/// Short, non-reversible fingerprint length (hex chars) shown in metadata.
const FINGERPRINT_HEX_LEN: usize = 8;

/// Public, non-secret view of a vault entry — the only thing the UI/IPC
/// layer may ever see. Contains no key material and no ciphertext.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VaultSecretMeta {
    /// Caller-chosen entry name, e.g. `imap.password:box@example.com`.
    pub name: String,
    /// Rotation counter; starts at 1, bumped by [`Vault::replace`].
    pub version: i64,
    /// First [`FINGERPRINT_HEX_LEN`] hex chars of a domain-separated
    /// SHA-256 over (name, material) — enough to tell "did it change",
    /// never enough to recover anything.
    pub fingerprint: String,
    pub created_at: String,
    pub rotated_at: Option<String>,
    pub last_used_at: Option<String>,
}

/// The credential vault: envelope encryption over one SQLite database plus
/// the OS keychain. Cheap to construct; borrows both handles.
pub struct Vault<'a> {
    conn: &'a Connection,
    keychain: &'a dyn SecretStore,
}

impl std::fmt::Debug for Vault<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault").finish_non_exhaustive()
    }
}

impl<'a> Vault<'a> {
    pub fn new(conn: &'a Connection, keychain: &'a dyn SecretStore) -> Self {
        Self { conn, keychain }
    }

    /// Store a new secret. Fails if `name` already exists — replacing an
    /// existing credential must go through [`Vault::replace`] so rotation is
    /// always explicit and audited as such.
    pub fn set(&self, name: &str, secret: SecretString) -> CoreResult<VaultSecretMeta> {
        validate_name(name)?;
        let tx = self.conn.unchecked_transaction()?;
        if lookup(&tx, name)?.is_some() {
            return Err(CoreError::Validation(format!(
                "vault secret {name:?} already exists; use replace to rotate it"
            )));
        }
        let dek = self.load_or_init_dek(&tx)?;
        let version = 1;
        let (nonce, ciphertext) = seal(
            &dek,
            &secret_aad(name, version),
            secret.expose_secret().as_bytes(),
        )?;
        let fingerprint = fingerprint(name, &secret);
        let now = now_iso();
        tx.execute(
            "INSERT INTO vault_secrets
                 (id, name, version, ciphertext, nonce, fingerprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![new_id(), name, version, ciphertext, nonce, fingerprint, now],
        )?;
        emit_audit(&tx, "vault.set", name, &fingerprint, version)?;
        tx.commit()?;
        drop(secret); // zeroized here
        Ok(VaultSecretMeta {
            name: name.to_string(),
            version,
            fingerprint,
            created_at: now,
            rotated_at: None,
            last_used_at: None,
        })
    }

    /// Rotate an existing secret: the new ciphertext **overwrites** the old
    /// one in place — the previous version is destroyed, there is no history
    /// and no in-place edit path. Fails if `name` does not exist.
    pub fn replace(&self, name: &str, secret: SecretString) -> CoreResult<VaultSecretMeta> {
        validate_name(name)?;
        let tx = self.conn.unchecked_transaction()?;
        let existing = lookup(&tx, name)?.ok_or_else(|| not_found(name))?;
        let dek = self.load_or_init_dek(&tx)?;
        let version = existing.version + 1;
        let (nonce, ciphertext) = seal(
            &dek,
            &secret_aad(name, version),
            secret.expose_secret().as_bytes(),
        )?;
        let fingerprint = fingerprint(name, &secret);
        let now = now_iso();
        tx.execute(
            "UPDATE vault_secrets
             SET version = ?2, ciphertext = ?3, nonce = ?4, fingerprint = ?5,
                 rotated_at = ?6
             WHERE name = ?1",
            params![name, version, ciphertext, nonce, fingerprint, now],
        )?;
        emit_audit(&tx, "vault.replace", name, &fingerprint, version)?;
        tx.commit()?;
        drop(secret); // zeroized here
        Ok(VaultSecretMeta {
            name: name.to_string(),
            version,
            fingerprint,
            created_at: existing.created_at,
            rotated_at: Some(now),
            last_used_at: existing.last_used_at,
        })
    }

    /// Destroy a secret: the ciphertext row is deleted outright. Only the
    /// audit trail remembers the entry existed.
    pub fn revoke(&self, name: &str) -> CoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let existing = lookup(&tx, name)?.ok_or_else(|| not_found(name))?;
        tx.execute("DELETE FROM vault_secrets WHERE name = ?1", params![name])?;
        emit_audit(
            &tx,
            "vault.revoke",
            name,
            &existing.fingerprint,
            existing.version,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Metadata for every stored secret — labels for the UI, never material.
    pub fn list_metadata(&self) -> CoreResult<Vec<VaultSecretMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT name, version, fingerprint, created_at, rotated_at, last_used_at
             FROM vault_secrets ORDER BY name",
        )?;
        let rows = stmt.query_map([], map_meta)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Hand the decrypted secret to `consume` inside a closure — the only
    /// read path that exists. The material lives exactly as long as the
    /// closure runs, then is zeroized. The access is recorded in the audit
    /// log (metadata only) and `last_used_at` is stamped *before* the
    /// closure runs, so even a panicking consumer leaves a trace.
    pub fn use_with<T>(
        &self,
        name: &str,
        consume: impl FnOnce(&SecretString) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let tx = self.conn.unchecked_transaction()?;
        let row = lookup(&tx, name)?.ok_or_else(|| not_found(name))?;
        let dek = self.load_or_init_dek(&tx)?;
        let plaintext = open(
            &dek,
            &secret_aad(name, row.version),
            &row.nonce,
            &row.ciphertext,
        )?;
        let secret = SecretString::new(
            std::str::from_utf8(&plaintext)
                .map_err(|_| CoreError::Secret("vault payload is not valid UTF-8".into()))?,
        );
        tx.execute(
            "UPDATE vault_secrets SET last_used_at = ?2 WHERE name = ?1",
            params![name, now_iso()],
        )?;
        emit_audit(&tx, "vault.use", name, &row.fingerprint, row.version)?;
        tx.commit()?;
        consume(&secret)
        // `secret` and `plaintext` are zeroized on drop here.
    }

    // -- key management -----------------------------------------------------

    /// Unwrap (or, on first use, create) the per-machine DEK. The KEK lives
    /// only in the OS keychain; without it a copied database is useless.
    fn load_or_init_dek(&self, conn: &Connection) -> CoreResult<Zeroizing<Vec<u8>>> {
        let wrapped: Option<(Vec<u8>, Vec<u8>, String)> = conn
            .query_row(
                "SELECT wrapped_key, nonce, kek_ref FROM vault_keys WHERE id = ?1",
                params![DEK_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match wrapped {
            Some((ciphertext, nonce, kek_ref)) => {
                let kek_hex =
                    Zeroizing::new(self.keychain.get_secret(&kek_ref)?.ok_or_else(|| {
                        CoreError::Secret(
                            "vault key-encryption key is missing from the OS keychain; \
                             stored secrets cannot be recovered on this machine"
                                .into(),
                        )
                    })?);
                let kek = from_hex(&kek_hex)?;
                open(&kek, DEK_AAD, &nonce, &ciphertext)
            }
            None => {
                // First use on this database: reuse the machine KEK if the
                // keychain already has one, otherwise mint it.
                let kek = match self.keychain.get_secret(KEK_ENTRY)? {
                    Some(existing) => from_hex(&Zeroizing::new(existing))?,
                    None => {
                        let kek = generate_key();
                        self.keychain.set_secret(KEK_ENTRY, &to_hex(&kek))?;
                        kek
                    }
                };
                let dek = generate_key();
                let (nonce, ciphertext) = seal(&kek, DEK_AAD, &dek)?;
                conn.execute(
                    "INSERT INTO vault_keys (id, wrapped_key, nonce, kek_ref, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![DEK_ID, ciphertext, nonce, KEK_ENTRY, now_iso()],
                )?;
                Ok(dek)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Row plumbing
// ---------------------------------------------------------------------------

struct SecretRow {
    version: i64,
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    fingerprint: String,
    created_at: String,
    last_used_at: Option<String>,
}

fn lookup(conn: &Connection, name: &str) -> CoreResult<Option<SecretRow>> {
    Ok(conn
        .query_row(
            "SELECT version, ciphertext, nonce, fingerprint, created_at, last_used_at
             FROM vault_secrets WHERE name = ?1",
            params![name],
            |row| {
                Ok(SecretRow {
                    version: row.get("version")?,
                    ciphertext: row.get("ciphertext")?,
                    nonce: row.get("nonce")?,
                    fingerprint: row.get("fingerprint")?,
                    created_at: row.get("created_at")?,
                    last_used_at: row.get("last_used_at")?,
                })
            },
        )
        .optional()?)
}

fn map_meta(row: &Row<'_>) -> rusqlite::Result<VaultSecretMeta> {
    Ok(VaultSecretMeta {
        name: row.get("name")?,
        version: row.get("version")?,
        fingerprint: row.get("fingerprint")?,
        created_at: row.get("created_at")?,
        rotated_at: row.get("rotated_at")?,
        last_used_at: row.get("last_used_at")?,
    })
}

fn not_found(name: &str) -> CoreError {
    CoreError::NotFound {
        entity: "vault_secret",
        id: name.to_string(),
    }
}

fn validate_name(name: &str) -> CoreResult<()> {
    if name.trim().is_empty() {
        return Err(CoreError::Validation("vault secret name is empty".into()));
    }
    Ok(())
}

/// Audit every vault access — metadata only, never material or ciphertext.
fn emit_audit(
    conn: &Connection,
    action: &str,
    name: &str,
    fingerprint: &str,
    version: i64,
) -> CoreResult<()> {
    repo::audit::insert(
        conn,
        &AuditEntry {
            id: new_id(),
            book_id: None,
            entity_type: "vault_secret".to_string(),
            entity_id: Some(name.to_string()),
            action: action.to_string(),
            before_json: None,
            after_json: Some(
                serde_json::json!({
                    "name": name,
                    "fingerprint": fingerprint,
                    "version": version,
                })
                .to_string(),
            ),
            created_at: now_iso(),
        },
    )
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

fn generate_key() -> Zeroizing<Vec<u8>> {
    Zeroizing::new(XChaCha20Poly1305::generate_key(&mut OsRng).to_vec())
}

/// Encrypt `plaintext` under `key`, binding it to `aad`. Returns
/// `(nonce, ciphertext)`; the nonce is random per call.
fn seal(key: &[u8], aad: &[u8], plaintext: &[u8]) -> CoreResult<(Vec<u8>, Vec<u8>)> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CoreError::Secret("vault encryption failed".into()))?;
    Ok((nonce.to_vec(), ciphertext))
}

fn open(key: &[u8], aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> CoreResult<Zeroizing<Vec<u8>>> {
    if key.len() != 32 || nonce.len() != 24 {
        return Err(CoreError::Secret("vault key material is malformed".into()));
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| {
            CoreError::Secret("vault decryption failed: wrong or missing key-encryption key".into())
        })
}

/// AAD binding a secret's ciphertext to its name and version so rows cannot
/// be swapped or replayed across entries.
fn secret_aad(name: &str, version: i64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(32 + name.len());
    aad.extend_from_slice(b"slipscan.vault.secret.v1");
    aad.push(0x1f);
    aad.extend_from_slice(name.as_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(&version.to_le_bytes());
    aad
}

/// Short, non-reversible fingerprint: first [`FINGERPRINT_HEX_LEN`] hex chars
/// of a domain-separated SHA-256 over (name, material).
fn fingerprint(name: &str, secret: &SecretString) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_DOMAIN);
    hasher.update([0x1f]);
    hasher.update(name.as_bytes());
    hasher.update([0x1f]);
    hasher.update(secret.expose_secret().as_bytes());
    let digest = hasher.finalize();
    to_hex(&digest)[..FINGERPRINT_HEX_LEN].to_string()
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn from_hex(hex: &str) -> CoreResult<Zeroizing<Vec<u8>>> {
    if hex.len() % 2 != 0 {
        return Err(CoreError::Secret("vault key material is malformed".into()));
    }
    let mut out = Zeroizing::new(Vec::with_capacity(hex.len() / 2));
    for chunk in hex.as_bytes().chunks(2) {
        let s = std::str::from_utf8(chunk)
            .map_err(|_| CoreError::Secret("vault key material is malformed".into()))?;
        out.push(
            u8::from_str_radix(s, 16)
                .map_err(|_| CoreError::Secret("vault key material is malformed".into()))?,
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::secrets::MemorySecretStore;

    fn setup() -> (Db, MemorySecretStore) {
        (
            Db::open_in_memory().expect("open"),
            MemorySecretStore::new(),
        )
    }

    fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn all_ciphertexts(conn: &Connection) -> Vec<Vec<u8>> {
        let mut stmt = conn
            .prepare("SELECT ciphertext FROM vault_secrets")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn set_then_use_with_round_trips() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        let meta = vault
            .set("imap.password", SecretString::new("hunter2-material"))
            .unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.fingerprint.len(), FINGERPRINT_HEX_LEN);

        let seen = vault
            .use_with("imap.password", |secret| {
                Ok(secret.expose_secret().to_string())
            })
            .unwrap();
        assert_eq!(seen, "hunter2-material");

        // Metadata never carries material, and last_used is stamped.
        let listed = vault.list_metadata().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].last_used_at.is_some());
        let as_json = serde_json::to_string(&listed).unwrap();
        assert!(!as_json.contains("hunter2"));
    }

    #[test]
    fn duplicate_set_is_rejected_and_missing_names_are_not_found() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        vault.set("k", SecretString::new("v1")).unwrap();
        assert!(matches!(
            vault.set("k", SecretString::new("v2")),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            vault.use_with("nope", |_| Ok(())),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            vault.replace("nope", SecretString::new("x")),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            vault.revoke("nope"),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            vault.set("  ", SecretString::new("x")),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn copied_database_without_kek_yields_nothing() {
        let (db, keychain) = setup();
        Vault::new(db.conn(), &keychain)
            .set("bank.login", SecretString::new("s3cret-material"))
            .unwrap();

        // Plaintext never appears in stored ciphertext.
        for ct in all_ciphertexts(db.conn()) {
            assert!(!contains_subslice(&ct, b"s3cret-material"));
        }

        // Attacker has the SQLite file but an empty keychain (copied disk).
        let empty_keychain = MemorySecretStore::new();
        let stolen = Vault::new(db.conn(), &empty_keychain);
        let err = stolen
            .use_with("bank.login", |_| Ok(()))
            .expect_err("must not decrypt without the KEK");
        assert!(matches!(err, CoreError::Secret(_)));
        assert!(!err.to_string().contains("s3cret"));

        // A *different* KEK (another machine's keychain) is equally useless.
        let wrong_keychain = MemorySecretStore::new();
        wrong_keychain
            .set_secret(KEK_ENTRY, &to_hex(&generate_key()))
            .unwrap();
        let err = Vault::new(db.conn(), &wrong_keychain)
            .use_with("bank.login", |_| Ok(()))
            .expect_err("must not decrypt with a foreign KEK");
        assert!(matches!(err, CoreError::Secret(_)));
    }

    #[test]
    fn rotation_destroys_old_ciphertext() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        let old_meta = vault
            .set("llm.api_key", SecretString::new("old-material"))
            .unwrap();
        let old_ciphertexts = all_ciphertexts(db.conn());

        let new_meta = vault
            .replace("llm.api_key", SecretString::new("new-material"))
            .unwrap();
        assert_eq!(new_meta.version, 2);
        assert!(new_meta.rotated_at.is_some());
        assert_ne!(new_meta.fingerprint, old_meta.fingerprint);

        // The old ciphertext is gone from the database entirely.
        let remaining = all_ciphertexts(db.conn());
        assert_eq!(remaining.len(), 1);
        for old in &old_ciphertexts {
            assert!(!remaining.contains(old), "old ciphertext must be destroyed");
        }

        // Only the new value is reachable.
        let seen = vault
            .use_with("llm.api_key", |s| Ok(s.expose_secret().to_string()))
            .unwrap();
        assert_eq!(seen, "new-material");
    }

    #[test]
    fn revoke_deletes_the_row() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        vault.set("gone", SecretString::new("bye")).unwrap();
        vault.revoke("gone").unwrap();
        assert!(vault.list_metadata().unwrap().is_empty());
        assert!(matches!(
            vault.use_with("gone", |_| Ok(())),
            Err(CoreError::NotFound { .. })
        ));
        assert_eq!(all_ciphertexts(db.conn()).len(), 0);
    }

    #[test]
    fn every_access_is_audited_without_material() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        vault
            .set("imap.password", SecretString::new("aud1t-material"))
            .unwrap();
        vault.use_with("imap.password", |_| Ok(())).unwrap();
        vault
            .replace("imap.password", SecretString::new("r0tated-material"))
            .unwrap();
        vault.revoke("imap.password").unwrap();

        let entries = repo::audit::list(db.conn(), None, 100).unwrap();
        let actions: Vec<&str> = entries
            .iter()
            .filter(|e| e.entity_type == "vault_secret")
            .map(|e| e.action.as_str())
            .collect();
        for expected in ["vault.set", "vault.use", "vault.replace", "vault.revoke"] {
            assert!(actions.contains(&expected), "missing audit {expected}");
        }
        for entry in &entries {
            let blob = format!("{entry:?}");
            assert!(!blob.contains("aud1t-material"));
            assert!(!blob.contains("r0tated-material"));
        }
    }

    #[test]
    fn kek_lives_only_in_the_keychain_and_is_reused() {
        let (db, keychain) = setup();
        let vault = Vault::new(db.conn(), &keychain);
        vault.set("a", SecretString::new("one")).unwrap();
        let kek = keychain.get_secret(KEK_ENTRY).unwrap().expect("KEK set");
        vault.set("b", SecretString::new("two")).unwrap();
        // Same KEK for the whole machine, and the DB never stores it.
        assert_eq!(keychain.get_secret(KEK_ENTRY).unwrap().unwrap(), kek);
        let kek_bytes = from_hex(&kek).unwrap();
        let wrapped: Vec<u8> = db
            .conn()
            .query_row("SELECT wrapped_key FROM vault_keys", [], |r| r.get(0))
            .unwrap();
        assert!(!contains_subslice(&wrapped, &kek_bytes));
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 15, 16, 255];
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap().as_slice(), &bytes);
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }
}
