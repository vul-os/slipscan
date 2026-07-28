//! Device identity: a per-device ed25519 keypair whose **public half is the
//! device id**, plus the peer pins that pairing produces.
//!
//! **Nothing here syncs anything.** This is phase 1 of the node model
//! (docs/NODES.md): identity and pairing only. There is no oplog, no
//! transport, no coordinator, no directory, and no default endpoint. Two
//! paired devices know each other's keys and can prove possession of them —
//! and that is the entire extent of it.
//!
//! ## No accounts, ever
//!
//! There is no email address, no password, no username, no login, and no
//! server that decides who you are. A device generates its own keypair; the
//! public key is the id. Pairing establishes that *this* key and *that* key
//! belong together, and nothing more.
//!
//! ## The pinning discipline
//!
//! Lifted from AQL's `proto/PAIRING-PROFILE.md`, which exists to be copied,
//! and consistent with the trust-on-first-use rule `slipscan-packs` already
//! applies to pack signers:
//!
//! > A peer's key is accepted at exactly one moment — the redeem — and
//! > thereafter only a deliberate local reset can change it. **A key change
//! > is a refusal, never a silent re-pin.**
//!
//! Concretely, in this module:
//!
//! * [`Devices::initialize`] refuses when an identity already exists. The
//!   local trust root is written once.
//! * [`Devices::rotate`] requires a signature made by the key being
//!   replaced, and refuses if the vault's key does not match the pinned
//!   public key.
//! * A revoked peer is a **tombstone**, not a deleted row: re-pairing it is
//!   refused until the user deliberately [`Devices::peer_forget`]s it. A
//!   peer that has been thrown out cannot let itself back in.
//! * `device_peers.public_key` is never `UPDATE`d anywhere. Since the key
//!   *is* the id, there is no id under which a key could be swapped — and
//!   [`tests::only_one_code_path_writes_each_pinned_key`] asserts the set of
//!   writers structurally, because the thing that breaks a rule like this
//!   later is a new call site, not a changed behaviour.

pub mod keys;
pub mod pairing;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::AuditEntry;
use crate::error::{CoreError, CoreResult};
use crate::repo;
use crate::secrets::{SecretStore, Vault};
use crate::util::{new_id, now_iso};

pub use keys::{keyname, keyname_is_valid, normalize_keyname, DeviceKeypair};

/// Vault entry holding this device's private key. One entry, one device.
pub const IDENTITY_SECRET_REF: &str = "device.identity.ed25519";

/// Domain separator for the rotation statement. Versioned so a future
/// format cannot be confused with this one.
const ROTATION_DOMAIN: &str = "slipscan.device.rotate.v1";

/// This device's own identity — public information only. No key material,
/// no vault contents, safe to serialize over IPC and HTTP.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceIdentity {
    /// The device id: lowercase hex ed25519 public key.
    pub public_key: String,
    /// Human-comparable rendering of `public_key` (9 words). This is what a
    /// user reads out loud to confirm two devices agree.
    pub keyname: String,
    /// Cosmetic. Not an identity and not resolvable — two devices may share
    /// a label and nothing anywhere cares.
    pub label: String,
    pub created_at: String,
    pub rotated_at: Option<String>,
}

/// A peer device this device has pinned.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DevicePeer {
    /// The peer's device id: lowercase hex ed25519 public key. Pinned at
    /// pairing and never updated.
    pub public_key: String,
    pub keyname: String,
    pub label: String,
    pub paired_at: String,
    /// Tombstone. `Some` means revoked: the pin is kept precisely so this
    /// key cannot quietly re-pair itself.
    pub revoked_at: Option<String>,
    /// Always `None` today — nothing connects to anything.
    pub last_seen_at: Option<String>,
}

impl DevicePeer {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

/// One rotation of this device's own key, provable against the key it
/// replaced. Nothing transmits these yet.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceRotation {
    pub old_public_key: String,
    pub new_public_key: String,
    /// Detached ed25519 signature by `old_public_key` over
    /// [`rotation_statement`].
    pub signature: String,
    pub rotated_at: String,
}

impl DeviceRotation {
    /// Re-verify this rotation against the key it claims to replace. A
    /// rotation that does not verify is not a rotation.
    pub fn verify(&self) -> bool {
        keys::verify_hex(
            &self.old_public_key,
            rotation_statement(&self.old_public_key, &self.new_public_key).as_bytes(),
            &self.signature,
        )
    }
}

/// The exact bytes a rotation is signed over: domain separator, outgoing
/// key, incoming key. Signing this with the outgoing key is what makes a
/// rotation provable rather than asserted.
pub fn rotation_statement(old_public_key: &str, new_public_key: &str) -> String {
    format!("{ROTATION_DOMAIN}\n{old_public_key}\n{new_public_key}")
}

/// Device identity and peer pins over one SQLite connection plus the OS
/// keychain. Cheap to construct; borrows both handles, exactly like
/// [`Vault`].
pub struct Devices<'a> {
    conn: &'a Connection,
    keychain: &'a dyn SecretStore,
}

impl std::fmt::Debug for Devices<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Devices").finish_non_exhaustive()
    }
}

impl<'a> Devices<'a> {
    pub fn new(conn: &'a Connection, keychain: &'a dyn SecretStore) -> Self {
        Self { conn, keychain }
    }

    pub(crate) fn conn(&self) -> &'a Connection {
        self.conn
    }

    fn vault(&self) -> Vault<'a> {
        Vault::new(self.conn, self.keychain)
    }

    // -- This device's identity ------------------------------------------

    /// This device's identity, or `None` if `initialize` has never run.
    pub fn identity(&self) -> CoreResult<Option<DeviceIdentity>> {
        self.conn
            .query_row(
                "SELECT public_key, keyname, label, created_at, rotated_at
                 FROM device_identity WHERE id = 1",
                [],
                map_identity,
            )
            .optional()
            .map_err(CoreError::from)
    }

    /// This device's identity, or an error naming the command that creates
    /// one. Callers that cannot proceed without an identity use this.
    pub fn require_identity(&self) -> CoreResult<DeviceIdentity> {
        self.identity()?.ok_or(CoreError::DeviceIdentityMissing)
    }

    /// Generate this device's keypair. The private half goes straight into
    /// the write-only vault; the public half becomes the device id.
    ///
    /// **Refuses if an identity already exists.** Replacing the local trust
    /// root is [`Devices::rotate`] (signed by the outgoing key) or
    /// [`Devices::reset`] (a deliberate local wipe) — never a second
    /// `initialize`.
    pub fn initialize(&self, label: &str) -> CoreResult<DeviceIdentity> {
        let label = validate_label(label)?;
        if let Some(existing) = self.identity()? {
            return Err(CoreError::DeviceIdentityExists {
                keyname: existing.keyname,
            });
        }
        // A vault entry with no identity row is a torn write, not a fresh
        // install. Refuse loudly rather than minting a second key beside a
        // secret we would then orphan.
        if self
            .vault()
            .list_metadata()?
            .iter()
            .any(|meta| meta.name == IDENTITY_SECRET_REF)
        {
            return Err(CoreError::DeviceIdentityTorn);
        }

        let keypair = DeviceKeypair::generate();
        let public_key = keypair.public_key_hex();
        let keyname = keys::keyname(&public_key)?;
        self.vault().set(IDENTITY_SECRET_REF, keypair.secret())?;

        let now = now_iso();
        // Fail closed: if the identity row cannot be written, roll the vault
        // entry back rather than leaving a private key with no identity.
        if let Err(err) = self.write_identity(&public_key, &keyname, &label, &now, None) {
            let _ = self.vault().revoke(IDENTITY_SECRET_REF);
            return Err(err);
        }
        self.audit("device.identity.init", &public_key, &keyname)?;

        Ok(DeviceIdentity {
            public_key,
            keyname,
            label,
            created_at: now,
            rotated_at: None,
        })
    }

    /// Rotate this device's key.
    ///
    /// The new key is only accepted alongside a signature made by **the key
    /// being replaced**, so possession of the outgoing private key is the
    /// precondition for replacing it. If the vault's key does not match the
    /// pinned public key the rotation is refused — a mismatch means either a
    /// torn vault or a key someone swapped underneath us, and neither is a
    /// reason to hand out a new identity.
    ///
    /// The device id changes, so existing peers' pins of *this* device go
    /// stale. Nothing re-pairs them automatically; there is no transport to
    /// do it over.
    pub fn rotate(&self) -> CoreResult<(DeviceIdentity, DeviceRotation)> {
        let current = self.require_identity()?;
        let new_keypair = DeviceKeypair::generate();
        let new_public_key = new_keypair.public_key_hex();
        let new_keyname = keys::keyname(&new_public_key)?;
        let statement = rotation_statement(&current.public_key, &new_public_key);

        // Sign with the OUTGOING key, inside the vault's closure — the
        // material never outlives this call.
        let signature = self.vault().use_with(IDENTITY_SECRET_REF, |secret| {
            let outgoing = DeviceKeypair::from_secret(secret)?;
            if outgoing.public_key_hex() != current.public_key {
                return Err(CoreError::DeviceKeyMismatch);
            }
            Ok(outgoing.sign_hex(statement.as_bytes()))
        })?;

        // Belt and braces: never persist a rotation that does not verify
        // against the key it claims to replace.
        if !keys::verify_hex(&current.public_key, statement.as_bytes(), &signature) {
            return Err(CoreError::DeviceRotationUnsigned);
        }

        self.vault()
            .replace(IDENTITY_SECRET_REF, new_keypair.secret())?;
        let now = now_iso();
        let rotation = DeviceRotation {
            old_public_key: current.public_key.clone(),
            new_public_key: new_public_key.clone(),
            signature,
            rotated_at: now.clone(),
        };

        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO device_identity_rotations
                 (id, old_public_key, new_public_key, signature, rotated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id(),
                rotation.old_public_key,
                rotation.new_public_key,
                rotation.signature,
                rotation.rotated_at
            ],
        )?;
        tx.commit()?;

        self.write_identity(
            &new_public_key,
            &new_keyname,
            &current.label,
            &current.created_at,
            Some(&now),
        )?;
        self.audit("device.identity.rotate", &new_public_key, &new_keyname)?;

        Ok((
            DeviceIdentity {
                public_key: new_public_key,
                keyname: new_keyname,
                label: current.label,
                created_at: current.created_at,
                rotated_at: Some(now),
            },
            rotation,
        ))
    }

    /// The rotation chain, oldest first.
    pub fn rotations(&self) -> CoreResult<Vec<DeviceRotation>> {
        let mut stmt = self.conn.prepare(
            "SELECT old_public_key, new_public_key, signature, rotated_at
             FROM device_identity_rotations ORDER BY rotated_at, id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DeviceRotation {
                old_public_key: row.get(0)?,
                new_public_key: row.get(1)?,
                signature: row.get(2)?,
                rotated_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// **The deliberate local reset.** Destroys this device's private key
    /// and its identity row. This is the only way to clear an identity
    /// without proving possession of it, and it is local-only by
    /// construction: no message, no endpoint and no peer can trigger it.
    ///
    /// Peer pins are deliberately kept — they are this device's opinions
    /// about *other* devices and are not invalidated by changing our own
    /// key. Use [`Devices::peer_forget`] for those, one at a time.
    pub fn reset(&self) -> CoreResult<()> {
        let existing = self.identity()?;
        // Revoking a missing entry is not an error here: reset must be able
        // to clean up a torn state, which is the case where one of the two
        // halves is already gone.
        let _ = self.vault().revoke(IDENTITY_SECRET_REF);
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM device_identity WHERE id = 1", [])?;
        tx.execute("DELETE FROM device_identity_rotations", [])?;
        tx.execute("DELETE FROM device_pair_invites", [])?;
        tx.commit()?;
        if let Some(identity) = existing {
            self.audit(
                "device.identity.reset",
                &identity.public_key,
                &identity.keyname,
            )?;
        }
        Ok(())
    }

    // -- Peers ------------------------------------------------------------

    /// Every pinned peer, including revoked tombstones, oldest first.
    pub fn peer_list(&self) -> CoreResult<Vec<DevicePeer>> {
        let mut stmt = self.conn.prepare(
            "SELECT public_key, keyname, label, paired_at, revoked_at, last_seen_at
             FROM device_peers ORDER BY paired_at, public_key",
        )?;
        let rows = stmt.query_map([], map_peer)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// One peer by device id (hex public key), if pinned.
    pub fn peer_get(&self, public_key: &str) -> CoreResult<Option<DevicePeer>> {
        let public_key = normalize_public_key(public_key)?;
        self.conn
            .query_row(
                "SELECT public_key, keyname, label, paired_at, revoked_at, last_seen_at
                 FROM device_peers WHERE public_key = ?1",
                params![public_key],
                map_peer,
            )
            .optional()
            .map_err(CoreError::from)
    }

    /// Revoke a peer: the pin becomes a **tombstone**. The row stays so the
    /// key cannot silently re-pair — a later pairing attempt from it is
    /// refused rather than treated as a fresh introduction. Idempotent.
    pub fn peer_revoke(&self, public_key: &str) -> CoreResult<DevicePeer> {
        let public_key = normalize_public_key(public_key)?;
        let peer = self
            .peer_get(&public_key)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "device peer",
                id: public_key.clone(),
            })?;
        if peer.is_revoked() {
            return Ok(peer);
        }
        let now = now_iso();
        self.conn.execute(
            "UPDATE device_peers SET revoked_at = ?2 WHERE public_key = ?1",
            params![public_key, now],
        )?;
        self.audit("device.peer.revoke", &public_key, &peer.keyname)?;
        Ok(DevicePeer {
            revoked_at: Some(now),
            ..peer
        })
    }

    /// **The deliberate local reset for one pin.** Removes the row outright,
    /// tombstone included, so the key may pair again from scratch. This is
    /// the *only* way back from a revocation, and like every reset here it
    /// is local-only: no peer, message or endpoint can reach it.
    pub fn peer_forget(&self, public_key: &str) -> CoreResult<bool> {
        let public_key = normalize_public_key(public_key)?;
        let Some(peer) = self.peer_get(&public_key)? else {
            return Ok(false);
        };
        self.conn.execute(
            "DELETE FROM device_peers WHERE public_key = ?1",
            params![public_key],
        )?;
        self.audit("device.peer.forget", &public_key, &peer.keyname)?;
        Ok(true)
    }

    // -- The one write path for each pinned key ---------------------------

    /// **The only place `device_identity.public_key` is written.** Held by
    /// `tests::only_one_code_path_writes_each_pinned_key`; every caller must
    /// have already established the right to replace the trust root
    /// (`initialize` proves there is none, `rotate` proves possession of the
    /// outgoing key).
    fn write_identity(
        &self,
        public_key: &str,
        keyname: &str,
        label: &str,
        created_at: &str,
        rotated_at: Option<&str>,
    ) -> CoreResult<()> {
        self.conn.execute(
            "INSERT INTO device_identity
                 (id, public_key, keyname, label, secret_ref, created_at, rotated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET
                 public_key = excluded.public_key,
                 keyname    = excluded.keyname,
                 label      = excluded.label,
                 rotated_at = excluded.rotated_at",
            params![
                public_key,
                keyname,
                label,
                IDENTITY_SECRET_REF,
                created_at,
                rotated_at
            ],
        )?;
        Ok(())
    }

    /// **The only place `device_peers.public_key` is written.** Held by
    /// `tests::only_one_code_path_writes_each_pinned_key`.
    ///
    /// Trust-on-first-use, taken literally:
    ///
    /// * an unknown key is pinned;
    /// * an already-pinned key may refresh its cosmetic label — the same
    ///   allowance AQL makes for a redeem carrying the *same* key;
    /// * a **revoked** key is refused. Its tombstone exists for exactly this
    ///   moment. Getting back in requires the user to
    ///   [`Devices::peer_forget`] it first, locally and deliberately.
    ///
    /// There is no branch that changes an existing row's `public_key`,
    /// because the key is the id: there is no id under which a key could be
    /// swapped.
    fn pin_peer(&self, tx: &Connection, public_key: &str, label: &str) -> CoreResult<DevicePeer> {
        let public_key = normalize_public_key(public_key)?;
        let keyname = keys::keyname(&public_key)?;
        let label = validate_label(label)?;

        let existing: Option<DevicePeer> = tx
            .query_row(
                "SELECT public_key, keyname, label, paired_at, revoked_at, last_seen_at
                 FROM device_peers WHERE public_key = ?1",
                params![public_key],
                map_peer,
            )
            .optional()?;

        if let Some(peer) = existing {
            if peer.is_revoked() {
                return Err(CoreError::DevicePeerRevoked {
                    keyname: peer.keyname,
                    public_key: peer.public_key,
                });
            }
            tx.execute(
                "UPDATE device_peers SET label = ?2 WHERE public_key = ?1",
                params![public_key, label],
            )?;
            return Ok(DevicePeer { label, ..peer });
        }

        let now = now_iso();
        tx.execute(
            "INSERT INTO device_peers
                 (public_key, keyname, label, paired_at, revoked_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![public_key, keyname, label, now],
        )?;
        Ok(DevicePeer {
            public_key,
            keyname,
            label,
            paired_at: now,
            revoked_at: None,
            last_seen_at: None,
        })
    }

    /// Sign `message` with this device's key. The material lives only inside
    /// the vault closure.
    pub(crate) fn sign(&self, message: &[u8]) -> CoreResult<String> {
        let identity = self.require_identity()?;
        self.vault().use_with(IDENTITY_SECRET_REF, |secret| {
            let keypair = DeviceKeypair::from_secret(secret)?;
            if keypair.public_key_hex() != identity.public_key {
                return Err(CoreError::DeviceKeyMismatch);
            }
            Ok(keypair.sign_hex(message))
        })
    }

    pub(crate) fn audit(&self, action: &str, public_key: &str, keyname: &str) -> CoreResult<()> {
        repo::audit::insert(
            self.conn,
            &AuditEntry {
                id: new_id(),
                book_id: None,
                entity_type: "device".to_string(),
                entity_id: Some(public_key.to_string()),
                action: action.to_string(),
                before_json: None,
                // Public key and key-name only. Never key material — there
                // is none here to leak, and the invariant should stay
                // obvious to the next reader.
                after_json: Some(
                    serde_json::json!({
                        "public_key": public_key,
                        "keyname": keyname,
                    })
                    .to_string(),
                ),
                created_at: now_iso(),
            },
        )
    }
}

/// Normalize and length-check a device id. Anything that is not 32 bytes of
/// hex is refused before it can reach a pin or a verification.
pub fn normalize_public_key(raw: &str) -> CoreResult<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    // Decoding is the length check; the result is discarded on purpose.
    keys::decode_public_key(&lowered)?;
    Ok(lowered)
}

fn validate_label(raw: &str) -> CoreResult<String> {
    let label = raw.trim();
    if label.is_empty() {
        return Err(CoreError::Validation(
            "device label must not be empty".into(),
        ));
    }
    if label.chars().count() > 64 {
        return Err(CoreError::Validation(
            "device label must be 64 characters or fewer".into(),
        ));
    }
    Ok(label.to_string())
}

fn map_identity(row: &Row<'_>) -> rusqlite::Result<DeviceIdentity> {
    Ok(DeviceIdentity {
        public_key: row.get(0)?,
        keyname: row.get(1)?,
        label: row.get(2)?,
        created_at: row.get(3)?,
        rotated_at: row.get(4)?,
    })
}

fn map_peer(row: &Row<'_>) -> rusqlite::Result<DevicePeer> {
    Ok(DevicePeer {
        public_key: row.get(0)?,
        keyname: row.get(1)?,
        label: row.get(2)?,
        paired_at: row.get(3)?,
        revoked_at: row.get(4)?,
        last_seen_at: row.get(5)?,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::Db;
    use crate::secrets::MemorySecretStore;

    /// A device: its own database and its own mock keychain, exactly as two
    /// separate machines would have.
    pub(crate) struct TestDevice {
        pub db: Db,
        pub keychain: MemorySecretStore,
    }

    impl TestDevice {
        pub fn new(label: &str) -> Self {
            let device = Self {
                db: Db::open_in_memory().expect("db"),
                keychain: MemorySecretStore::default(),
            };
            device.devices().initialize(label).expect("initialize");
            device
        }

        pub fn bare() -> Self {
            Self {
                db: Db::open_in_memory().expect("db"),
                keychain: MemorySecretStore::default(),
            }
        }

        pub fn devices(&self) -> Devices<'_> {
            Devices::new(self.db.conn(), &self.keychain)
        }

        pub fn id(&self) -> String {
            self.devices()
                .require_identity()
                .expect("identity")
                .public_key
        }

        pub fn keyname(&self) -> String {
            self.devices().require_identity().expect("identity").keyname
        }
    }

    #[test]
    fn initialize_mints_an_identity_whose_public_key_is_the_id() {
        let device = TestDevice::new("laptop");
        let identity = device.devices().require_identity().unwrap();

        assert_eq!(identity.label, "laptop");
        assert_eq!(identity.public_key.len(), 64, "32 bytes of hex");
        assert_eq!(
            identity.keyname,
            keys::keyname(&identity.public_key).unwrap()
        );
        assert!(identity.rotated_at.is_none());
    }

    #[test]
    fn the_private_key_lives_in_the_vault_and_never_in_the_identity_row() {
        let device = TestDevice::new("laptop");
        let identity = device.devices().require_identity().unwrap();

        // The vault holds exactly one device entry, and only metadata is
        // reachable from it.
        let metadata = Vault::new(device.db.conn(), &device.keychain)
            .list_metadata()
            .unwrap();
        let entry = metadata
            .iter()
            .find(|meta| meta.name == IDENTITY_SECRET_REF)
            .expect("device key is in the vault");
        assert_eq!(entry.version, 1);

        // Nothing in the identity row can reconstruct the private key: dump
        // every column as text and assert the public key is all that is
        // there.
        let dumped: String = device
            .db
            .conn()
            .query_row(
                "SELECT public_key || '|' || keyname || '|' || label || '|' || secret_ref
                 FROM device_identity WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(dumped.contains(&identity.public_key));
        assert!(dumped.contains(IDENTITY_SECRET_REF));
    }

    /// Rule 1: the local trust root is written once. A second `initialize`
    /// is a refusal, not a re-key.
    #[test]
    fn a_second_initialize_is_refused_rather_than_replacing_the_identity() {
        let device = TestDevice::new("laptop");
        let before = device.devices().require_identity().unwrap();

        let err = device.devices().initialize("laptop again").unwrap_err();
        assert!(
            matches!(err, CoreError::DeviceIdentityExists { .. }),
            "got {err:?}"
        );

        let after = device.devices().require_identity().unwrap();
        assert_eq!(before, after, "the identity must be untouched");
    }

    /// Rule 3: rotation is signed by the key being replaced.
    #[test]
    fn rotation_is_signed_by_the_outgoing_key_and_verifies_against_it() {
        let device = TestDevice::new("laptop");
        let before = device.devices().require_identity().unwrap();

        let (after, rotation) = device.devices().rotate().unwrap();

        assert_ne!(after.public_key, before.public_key, "a new id");
        assert_eq!(rotation.old_public_key, before.public_key);
        assert_eq!(rotation.new_public_key, after.public_key);
        assert!(rotation.verify(), "the rotation must prove itself");
        assert!(after.rotated_at.is_some());
        assert_eq!(after.created_at, before.created_at);

        // And the chain is durable.
        let chain = device.devices().rotations().unwrap();
        assert_eq!(chain.len(), 1);
        assert!(chain[0].verify());
    }

    /// A rotation signature must not verify under the *incoming* key — the
    /// whole point is that the outgoing key authorised the change.
    #[test]
    fn a_rotation_does_not_verify_under_the_key_it_installed() {
        let device = TestDevice::new("laptop");
        let (_, rotation) = device.devices().rotate().unwrap();
        let statement = rotation_statement(&rotation.old_public_key, &rotation.new_public_key);
        assert!(!keys::verify_hex(
            &rotation.new_public_key,
            statement.as_bytes(),
            &rotation.signature
        ));
    }

    /// If the vault's key is not the pinned key, rotation refuses. Rotating
    /// from a key you cannot prove you hold is exactly the silent re-pin the
    /// discipline forbids.
    #[test]
    fn rotation_refuses_when_the_vault_key_is_not_the_pinned_key() {
        let device = TestDevice::new("laptop");
        let pinned = device.devices().require_identity().unwrap();

        // Swap the vault's key for an unrelated one, leaving the pinned
        // public key in place.
        let intruder = DeviceKeypair::generate();
        Vault::new(device.db.conn(), &device.keychain)
            .replace(IDENTITY_SECRET_REF, intruder.secret())
            .unwrap();

        let err = device.devices().rotate().unwrap_err();
        assert!(matches!(err, CoreError::DeviceKeyMismatch), "got {err:?}");
        assert_eq!(
            device.devices().require_identity().unwrap(),
            pinned,
            "a refused rotation changes nothing"
        );
    }

    #[test]
    fn signing_refuses_when_the_vault_key_is_not_the_pinned_key() {
        let device = TestDevice::new("laptop");
        let intruder = DeviceKeypair::generate();
        Vault::new(device.db.conn(), &device.keychain)
            .replace(IDENTITY_SECRET_REF, intruder.secret())
            .unwrap();
        assert!(matches!(
            device.devices().sign(b"anything").unwrap_err(),
            CoreError::DeviceKeyMismatch
        ));
    }

    #[test]
    fn a_missing_identity_names_the_command_that_creates_one() {
        let device = TestDevice::bare();
        assert!(device.devices().identity().unwrap().is_none());
        assert!(matches!(
            device.devices().require_identity().unwrap_err(),
            CoreError::DeviceIdentityMissing
        ));
    }

    /// A vault entry with no identity row is a torn write. Refuse rather
    /// than mint a second key next to an orphaned secret.
    #[test]
    fn initialize_refuses_a_torn_state_instead_of_minting_a_second_key() {
        let device = TestDevice::bare();
        let stray = DeviceKeypair::generate();
        Vault::new(device.db.conn(), &device.keychain)
            .set(IDENTITY_SECRET_REF, stray.secret())
            .unwrap();

        assert!(matches!(
            device.devices().initialize("laptop").unwrap_err(),
            CoreError::DeviceIdentityTorn
        ));
    }

    #[test]
    fn reset_destroys_the_key_and_the_identity_but_keeps_peer_pins() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        device
            .devices()
            .pin_peer(&tx, &peer, "home server")
            .unwrap();
        tx.commit().unwrap();

        device.devices().reset().unwrap();

        assert!(device.devices().identity().unwrap().is_none());
        assert!(!Vault::new(device.db.conn(), &device.keychain)
            .list_metadata()
            .unwrap()
            .iter()
            .any(|meta| meta.name == IDENTITY_SECRET_REF));
        assert_eq!(
            device.devices().peer_list().unwrap().len(),
            1,
            "our opinions about other devices survive changing our own key"
        );

        // And a fresh identity can be minted afterwards.
        let fresh = device.devices().initialize("laptop").unwrap();
        assert_eq!(fresh.label, "laptop");
    }

    #[test]
    fn a_revoked_peer_stays_as_a_tombstone_and_forget_removes_it() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        device.devices().pin_peer(&tx, &peer, "phone").unwrap();
        tx.commit().unwrap();

        let revoked = device.devices().peer_revoke(&peer).unwrap();
        assert!(revoked.is_revoked());
        assert_eq!(
            device.devices().peer_list().unwrap().len(),
            1,
            "revocation is a tombstone, not a delete"
        );

        // Revocation is idempotent.
        assert!(device.devices().peer_revoke(&peer).unwrap().is_revoked());

        assert!(device.devices().peer_forget(&peer).unwrap());
        assert!(device.devices().peer_list().unwrap().is_empty());
        assert!(!device.devices().peer_forget(&peer).unwrap());
    }

    /// **The core refusal.** A revoked peer cannot let itself back in: the
    /// tombstone makes re-pairing an error, and only a deliberate local
    /// `peer_forget` clears the way.
    #[test]
    fn a_revoked_peer_cannot_silently_re_pin_itself() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        device.devices().pin_peer(&tx, &peer, "phone").unwrap();
        tx.commit().unwrap();
        device.devices().peer_revoke(&peer).unwrap();

        let tx = device.db.conn().unchecked_transaction().unwrap();
        let err = device
            .devices()
            .pin_peer(&tx, &peer, "phone")
            .expect_err("a revoked peer must be refused");
        assert!(
            matches!(err, CoreError::DevicePeerRevoked { .. }),
            "got {err:?}"
        );
        drop(tx);

        // Still revoked.
        assert!(device
            .devices()
            .peer_get(&peer)
            .unwrap()
            .unwrap()
            .is_revoked());

        // The deliberate local reset is the only way back.
        device.devices().peer_forget(&peer).unwrap();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        assert!(device.devices().pin_peer(&tx, &peer, "phone").is_ok());
    }

    /// Re-pinning the *same* key refreshes only its cosmetic label — the
    /// same allowance AQL makes for a redeem carrying the same key.
    #[test]
    fn re_pinning_the_same_key_refreshes_the_label_and_nothing_else() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        let first = device.devices().pin_peer(&tx, &peer, "phone").unwrap();
        let second = device.devices().pin_peer(&tx, &peer, "old phone").unwrap();
        tx.commit().unwrap();

        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.keyname, second.keyname);
        assert_eq!(first.paired_at, second.paired_at);
        assert_eq!(second.label, "old phone");
    }

    #[test]
    fn an_unusable_device_id_is_refused_before_it_reaches_a_pin() {
        let device = TestDevice::new("laptop");
        for broken in ["", "nonsense", &"ab".repeat(31), &"zz".repeat(32)] {
            assert!(normalize_public_key(broken).is_err(), "{broken:?}");
            assert!(device.devices().peer_get(broken).is_err());
        }
    }

    #[test]
    fn a_device_id_is_accepted_case_insensitively() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        device.devices().pin_peer(&tx, &peer, "phone").unwrap();
        tx.commit().unwrap();
        assert!(device
            .devices()
            .peer_get(&peer.to_uppercase())
            .unwrap()
            .is_some());
    }

    #[test]
    fn labels_are_validated() {
        let device = TestDevice::bare();
        assert!(device.devices().initialize("").is_err());
        assert!(device.devices().initialize("   ").is_err());
        assert!(device.devices().initialize(&"x".repeat(65)).is_err());
        assert!(device.devices().initialize(&"x".repeat(64)).is_ok());
    }

    #[test]
    fn identity_and_peer_operations_are_audited_with_no_key_material() {
        let device = TestDevice::new("laptop");
        let peer = DeviceKeypair::generate().public_key_hex();
        let tx = device.db.conn().unchecked_transaction().unwrap();
        device.devices().pin_peer(&tx, &peer, "phone").unwrap();
        tx.commit().unwrap();
        device.devices().peer_revoke(&peer).unwrap();

        let actions: Vec<String> = device
            .db
            .conn()
            .prepare(
                "SELECT action FROM audit_log WHERE entity_type = 'device' ORDER BY created_at, id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(actions.contains(&"device.identity.init".to_string()));
        assert!(actions.contains(&"device.peer.revoke".to_string()));

        // The audit payloads carry public keys only. The private seed must
        // appear nowhere in the database at all.
        let seed = Vault::new(device.db.conn(), &device.keychain)
            .use_with(IDENTITY_SECRET_REF, |secret| {
                Ok(secret.expose_secret().to_string())
            })
            .unwrap();
        assert_eq!(seed.len(), 64, "the seed is 32 bytes of hex");

        // Sweep *every* text-ish cell in the whole database rather than just
        // the audit log: the guarantee is that the private key is nowhere in
        // this file in the clear, and a test that only checks the columns we
        // remembered to name would miss the next one somebody adds.
        let tables: Vec<String> = device
            .db
            .conn()
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            tables.len() > 10,
            "the scan is broken, not the code: {} tables seen",
            tables.len()
        );

        let mut cells = 0usize;
        for table in &tables {
            // CAST(... AS TEXT) over every column, concatenated per row. A
            // BLOB of ciphertext stringifies to bytes that cannot contain the
            // hex seed, so this is a real check rather than a vacuous one.
            let sql = format!("SELECT * FROM \"{table}\"");
            let mut stmt = device.db.conn().prepare(&sql).unwrap();
            let column_count = stmt.column_count();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                for index in 0..column_count {
                    let value: rusqlite::types::Value = row.get(index).unwrap();
                    let text = match value {
                        rusqlite::types::Value::Text(text) => text,
                        rusqlite::types::Value::Blob(bytes) => {
                            String::from_utf8_lossy(&bytes).into_owned()
                        }
                        _ => continue,
                    };
                    cells += 1;
                    assert!(
                        !text.contains(&seed),
                        "{table} holds this device's private key in the clear"
                    );
                }
            }
        }
        assert!(
            cells > 10,
            "the scan is broken, not the code: {cells} cells seen"
        );
    }

    /// The structural test the AQL profile insists on: assert the **set** of
    /// code paths that write a pinned key, not merely their behaviour.
    ///
    /// Behaviour tests all keep passing when someone adds a *new* call site
    /// — a config reload, a "recovery" path, an import — that writes a peer
    /// key without going through the trust-on-first-use branch. So the write
    /// sites themselves are counted.
    #[test]
    fn only_one_code_path_writes_each_pinned_key() {
        let sources = [
            ("mod.rs", include_str!("mod.rs")),
            ("keys.rs", include_str!("keys.rs")),
            ("pairing.rs", include_str!("pairing.rs")),
        ];
        // Scan **shipped** code only. Test modules are cut off first, for a
        // concrete reason: this test's own assertions contain the SQL
        // needles as string literals, so scanning itself would count them.
        // Everything before `#[cfg(test)]` is what actually compiles into
        // the binary, which is the surface the rule is about.
        let sources: Vec<(&str, &str)> = sources
            .into_iter()
            .map(|(name, src)| {
                let shipped = src.split("#[cfg(test)]").next().unwrap_or(src);
                assert!(
                    shipped.len() < src.len(),
                    "{name} has no test module — the split marker moved and the scan is \
                     silently reading test code"
                );
                (name, shipped)
            })
            .collect();

        // Assert the scan found something: a structural test whose walk came
        // back empty passes for the wrong reason.
        let total_lines: usize = sources.iter().map(|(_, src)| src.lines().count()).sum();
        assert!(
            total_lines > 500,
            "the scan is broken, not the code: only {total_lines} lines of shipped code seen"
        );

        // Normalize *before* matching. An earlier version of this test
        // anchored on lines that START with the SQL verb, and a rogue
        // `conn.execute("INSERT INTO device_peers ...)` on a single line
        // sailed straight past it — the scan was broken, not the code. So:
        // strip comment lines, join everything, collapse whitespace. That
        // survives arbitrary rustfmt wrapping and multi-line SQL literals.
        let normalized: Vec<(&str, String)> = sources
            .iter()
            .map(|(name, src)| {
                let code: String = src
                    .lines()
                    .map(str::trim)
                    // Skip comments and doc comments: the false positive is
                    // a comment *explaining* a write, and whoever hits it
                    // would weaken this test rather than fix the code.
                    .filter(|line| !line.starts_with("//") && !line.starts_with('*'))
                    .collect::<Vec<_>>()
                    .join(" ");
                (
                    *name,
                    code.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_ascii_uppercase(),
                )
            })
            .collect();

        // Prove the normalizer still sees the real statements. Without this
        // the counts below could all be zero and the test would "pass".
        let corpus: String = normalized
            .iter()
            .map(|(_, code)| code.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            corpus.contains("INSERT INTO DEVICE_PEERS")
                && corpus.contains("INSERT INTO DEVICE_IDENTITY "),
            "the scan is broken, not the code: it cannot see the known writers"
        );

        let count = |needle: &str| -> usize { corpus.matches(needle).count() };

        // device_peers: exactly one INSERT (the pin in `pin_peer`), exactly
        // two UPDATEs (the cosmetic label refresh in `pin_peer`, and the
        // revocation tombstone), and exactly one DELETE (`peer_forget`, the
        // deliberate local reset). A second DELETE would be a silent unpin;
        // a second INSERT would be a second door onto the trust store.
        assert_eq!(
            count("INSERT INTO DEVICE_PEERS"),
            1,
            "the set of device_peers INSERTs changed:\n{corpus}"
        );
        assert_eq!(
            count("UPDATE DEVICE_PEERS"),
            2,
            "the set of device_peers UPDATEs changed"
        );
        assert_eq!(
            count("DELETE FROM DEVICE_PEERS"),
            1,
            "the set of device_peers DELETEs changed"
        );

        // No UPDATE may *assign* public_key. `WHERE public_key = ?` is how a
        // row is found, which is what a pin-preserving update looks like —
        // so only the assignment list between SET and WHERE is checked.
        for update in corpus.split("UPDATE DEVICE_PEERS").skip(1) {
            let assignments = update
                .split_once(" SET ")
                .map(|(_, rest)| rest.split(" WHERE ").next().unwrap_or(rest))
                .unwrap_or("");
            assert!(
                !assignments.contains("PUBLIC_KEY"),
                "an UPDATE assigns a pinned peer key: ...{assignments}"
            );
        }

        // device_identity: exactly one write statement — the upsert inside
        // `write_identity` — and it lives in mod.rs.
        assert_eq!(
            count("INSERT INTO DEVICE_IDENTITY "),
            1,
            "the set of device_identity writers changed"
        );
        assert_eq!(
            count("UPDATE DEVICE_IDENTITY "),
            0,
            "device_identity is written only through the single upsert"
        );
        let (owner, _) = normalized
            .iter()
            .find(|(_, code)| code.contains("INSERT INTO DEVICE_IDENTITY "))
            .expect("the identity writer must exist");
        assert_eq!(
            *owner, "mod.rs",
            "the identity write moved out of mod.rs, into {owner}"
        );
    }

    /// The pinned-key writers must also be reachable from exactly one place
    /// each, so a second caller cannot slip a key in past the TOFU branch.
    #[test]
    fn pin_peer_has_exactly_the_expected_callers() {
        let sources = [
            ("mod.rs", include_str!("mod.rs")),
            ("pairing.rs", include_str!("pairing.rs")),
        ];
        let mut callers = Vec::new();
        for (name, src) in sources {
            let mut in_tests = false;
            for (index, line) in src.lines().enumerate() {
                let code = line.trim();
                // Test modules are allowed to drive the pin directly.
                if code.starts_with("mod tests") || code.starts_with("pub(crate) mod tests") {
                    in_tests = true;
                }
                if in_tests || code.starts_with("//") {
                    continue;
                }
                if code.contains("pin_peer(") && !code.contains("fn pin_peer") {
                    callers.push(format!("{name}:{}", index + 1));
                }
            }
        }
        // Exactly two: the accept side and the confirm side of the pairing
        // ceremony. Anything else is a new door onto the trust store.
        assert_eq!(
            callers.len(),
            2,
            "the set of pin_peer callers changed: {callers:#?}"
        );
        assert!(
            callers.iter().all(|at| at.starts_with("pairing.rs")),
            "pin_peer is called outside the pairing ceremony: {callers:#?}"
        );
    }
}
