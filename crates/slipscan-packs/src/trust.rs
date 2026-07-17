//! Trust-on-first-use signer store with per-pack pinning.
//!
//! Trust is per-publisher and local: the user adds a publisher's public key
//! once (checking the fingerprint out-of-band, like an SSH host key); after
//! that, the publisher's packs verify silently. There is no central authority
//! deciding who may publish.
//!
//! Pinning: the first signer seen for a pack id is pinned to it. A later
//! version of the same pack signed by a *different* key is rejected outright
//! (`PackError::SignerChanged`) — even if that other key is itself trusted.
//!
//! Tables are namespaced `pack_*` and created lazily on whatever connection
//! the caller provides (the per-book SQLite file managed by slipscan-core).
//! Only public keys and labels are stored — never secret material.

use rusqlite::{params, Connection, OptionalExtension};

use slipscan_core::util::now_iso;

use crate::error::{PackError, PackResult};
use crate::hex;
use crate::verify::key_fingerprint;

pub(crate) const TRUST_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pack_trusted_signers (
    public_key       TEXT PRIMARY KEY,
    label            TEXT NOT NULL,
    fingerprint      TEXT NOT NULL,
    first_trusted_at TEXT NOT NULL,
    last_used_at     TEXT
);
CREATE TABLE IF NOT EXISTS pack_signer_pins (
    pack_id    TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    pinned_at  TEXT NOT NULL
);
";

/// One trusted signer, as shown in settings. Metadata only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedSigner {
    /// Lowercase hex ed25519 public key.
    pub public_key: String,
    /// User-chosen label ("SlipScan Community", "alice's packs", ...).
    pub label: String,
    pub fingerprint: String,
    pub first_trusted_at: String,
    pub last_used_at: Option<String>,
}

/// The TOFU decision for a signer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustStatus {
    Trusted {
        label: String,
    },
    /// First use: surface the fingerprint to the user and call
    /// [`TrustStore::trust`] if they accept.
    Unknown {
        fingerprint: String,
    },
}

/// Signer trust store over a SQLite connection.
pub struct TrustStore<'c> {
    conn: &'c Connection,
}

impl<'c> TrustStore<'c> {
    /// Open the store, creating its tables if needed.
    pub fn open(conn: &'c Connection) -> PackResult<Self> {
        conn.execute_batch(TRUST_SCHEMA)?;
        Ok(Self { conn })
    }

    /// TOFU status of a signer key (lowercase hex).
    pub fn status(&self, public_key: &str) -> PackResult<TrustStatus> {
        let public_key = normalize_key(public_key)?;
        let label: Option<String> = self
            .conn
            .query_row(
                "SELECT label FROM pack_trusted_signers WHERE public_key = ?1",
                params![public_key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(match label {
            Some(label) => TrustStatus::Trusted { label },
            None => TrustStatus::Unknown {
                fingerprint: key_fingerprint(&public_key),
            },
        })
    }

    /// Accept a signer (the "yes, I checked the fingerprint" step of TOFU).
    /// Idempotent; re-trusting updates the label. The well-known builtin seed
    /// key is refused — it is public knowledge and proves nothing.
    pub fn trust(&self, public_key: &str, label: &str) -> PackResult<TrustedSigner> {
        let public_key = normalize_key(public_key)?;
        if public_key == crate::builtin::seed_public_key_hex() {
            return Err(PackError::SignerNotTrustable);
        }
        let label = label.trim();
        if label.is_empty() {
            return Err(PackError::Validation(
                "signer label must not be empty".into(),
            ));
        }
        let fingerprint = key_fingerprint(&public_key);
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO pack_trusted_signers
                 (public_key, label, fingerprint, first_trusted_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT (public_key) DO UPDATE SET label = excluded.label",
            params![public_key, label, fingerprint, now],
        )?;
        self.get(&public_key)?
            .ok_or_else(|| PackError::CorruptState {
                pack_id: String::new(),
                message: "trusted signer vanished after insert".into(),
            })
    }

    /// Remove a signer from the trust store. Pins are kept: a pack id stays
    /// bound to its original signer even after revocation, so a different key
    /// can never take over the id. Returns whether a row was removed.
    pub fn revoke(&self, public_key: &str) -> PackResult<bool> {
        let public_key = normalize_key(public_key)?;
        let removed = self.conn.execute(
            "DELETE FROM pack_trusted_signers WHERE public_key = ?1",
            params![public_key],
        )?;
        Ok(removed > 0)
    }

    /// All trusted signers, oldest first.
    pub fn list(&self) -> PackResult<Vec<TrustedSigner>> {
        let mut stmt = self.conn.prepare(
            "SELECT public_key, label, fingerprint, first_trusted_at, last_used_at
             FROM pack_trusted_signers ORDER BY first_trusted_at, public_key",
        )?;
        let signers = stmt
            .query_map([], map_signer)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(signers)
    }

    /// The signer a pack id is pinned to, if any.
    pub fn pinned_signer(&self, pack_id: &str) -> PackResult<Option<String>> {
        pinned_signer(self.conn, pack_id)
    }

    fn get(&self, public_key: &str) -> PackResult<Option<TrustedSigner>> {
        Ok(self
            .conn
            .query_row(
                "SELECT public_key, label, fingerprint, first_trusted_at, last_used_at
                 FROM pack_trusted_signers WHERE public_key = ?1",
                params![public_key],
                map_signer,
            )
            .optional()?)
    }
}

fn map_signer(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrustedSigner> {
    Ok(TrustedSigner {
        public_key: row.get(0)?,
        label: row.get(1)?,
        fingerprint: row.get(2)?,
        first_trusted_at: row.get(3)?,
        last_used_at: row.get(4)?,
    })
}

/// Lowercase and sanity-check a signer key: 32 hex-decodable bytes.
fn normalize_key(public_key: &str) -> PackResult<String> {
    let lower = public_key.to_ascii_lowercase();
    match hex::decode(&lower) {
        Some(bytes) if bytes.len() == 32 => Ok(lower),
        _ => Err(PackError::InvalidPublicKey),
    }
}

// ---------------------------------------------------------------------------
// Free functions used inside install transactions (they take the tx conn).
// ---------------------------------------------------------------------------

pub(crate) fn pinned_signer(conn: &Connection, pack_id: &str) -> PackResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT public_key FROM pack_signer_pins WHERE pack_id = ?1",
            params![pack_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Enforce the pin for `pack_id`, pinning `signer` on first use.
pub(crate) fn check_and_pin(conn: &Connection, pack_id: &str, signer: &str) -> PackResult<()> {
    match pinned_signer(conn, pack_id)? {
        Some(pinned) if pinned == signer => Ok(()),
        Some(pinned) => Err(PackError::SignerChanged {
            pack_id: pack_id.to_string(),
            pinned_fingerprint: key_fingerprint(&pinned),
        }),
        None => {
            conn.execute(
                "INSERT INTO pack_signer_pins (pack_id, public_key, pinned_at)
                 VALUES (?1, ?2, ?3)",
                params![pack_id, signer, now_iso()],
            )?;
            Ok(())
        }
    }
}

/// Require a trusted signer (external packs only) and touch `last_used_at`.
pub(crate) fn require_trusted(conn: &Connection, signer: &str) -> PackResult<()> {
    let updated = conn.execute(
        "UPDATE pack_trusted_signers SET last_used_at = ?2 WHERE public_key = ?1",
        params![signer, now_iso()],
    )?;
    if updated == 0 {
        return Err(PackError::UntrustedSigner {
            fingerprint: key_fingerprint(signer),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    fn key_hex(seed: u8) -> String {
        hex::encode(
            SigningKey::from_bytes(&[seed; 32])
                .verifying_key()
                .as_bytes(),
        )
    }

    #[test]
    fn tofu_trust_and_revoke() {
        let conn = conn();
        let store = TrustStore::open(&conn).unwrap();
        let key = key_hex(1);

        assert!(matches!(
            store.status(&key).unwrap(),
            TrustStatus::Unknown { .. }
        ));
        let signer = store.trust(&key, "alice").unwrap();
        assert_eq!(signer.label, "alice");
        assert_eq!(signer.fingerprint, key_fingerprint(&key));
        assert!(matches!(
            store.status(&key).unwrap(),
            TrustStatus::Trusted { .. }
        ));
        assert_eq!(store.list().unwrap().len(), 1);

        assert!(store.revoke(&key).unwrap());
        assert!(!store.revoke(&key).unwrap());
        assert!(matches!(
            store.status(&key).unwrap(),
            TrustStatus::Unknown { .. }
        ));
    }

    #[test]
    fn pin_binds_pack_id_to_first_signer() {
        let conn = conn();
        let _store = TrustStore::open(&conn).unwrap();
        let (a, b) = (key_hex(1), key_hex(2));

        check_and_pin(&conn, "za-personal", &a).unwrap();
        check_and_pin(&conn, "za-personal", &a).unwrap();
        assert!(matches!(
            check_and_pin(&conn, "za-personal", &b),
            Err(PackError::SignerChanged { .. })
        ));
        // A different pack id is free to use the other key.
        check_and_pin(&conn, "other-pack", &b).unwrap();
    }

    #[test]
    fn require_trusted_rejects_unknown_and_touches_last_used() {
        let conn = conn();
        let store = TrustStore::open(&conn).unwrap();
        let key = key_hex(1);

        assert!(matches!(
            require_trusted(&conn, &key),
            Err(PackError::UntrustedSigner { .. })
        ));
        store.trust(&key, "alice").unwrap();
        require_trusted(&conn, &key).unwrap();
        let signer = &store.list().unwrap()[0];
        assert!(signer.last_used_at.is_some());
    }

    #[test]
    fn builtin_seed_key_cannot_be_trusted() {
        let conn = conn();
        let store = TrustStore::open(&conn).unwrap();
        assert!(matches!(
            store.trust(&crate::builtin::seed_public_key_hex(), "evil"),
            Err(PackError::SignerNotTrustable)
        ));
    }

    #[test]
    fn malformed_keys_are_rejected() {
        let conn = conn();
        let store = TrustStore::open(&conn).unwrap();
        assert!(matches!(
            store.trust("not-hex", "x"),
            Err(PackError::InvalidPublicKey)
        ));
        assert!(matches!(
            store.status("abcd"),
            Err(PackError::InvalidPublicKey)
        ));
    }
}
