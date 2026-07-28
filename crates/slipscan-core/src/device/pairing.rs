//! Pairing two devices **without accounts**, and without a transport.
//!
//! ## The ceremony
//!
//! Four steps, two devices, no server in the middle:
//!
//! ```text
//!   device A                                    device B
//!   ────────                                    ────────
//! 1 invite_create()  ──── invite blob ────►     (carried by the human:
//!                                                QR, paste, USB stick)
//! 2                                              pair_accept(blob)
//!                                                  · checks the key-name
//!                                                  · PINS A
//! 3   ◄──── acceptance blob ─────────────────    (carried by the human)
//! 4 pair_confirm(blob)
//!     · burns the single-use claim token
//!     · PINS B
//! ```
//!
//! **SlipScan opens no socket to do this.** The blobs are base64url text;
//! moving them between devices is the user's business — a QR code, a paste
//! into a chat, a file on a stick. That is not a limitation being worked
//! around, it is the reason there is no coordinator, no directory and no
//! default endpoint to configure: there is nothing for one to do.
//!
//! ## What the ceremony proves, and what it does not
//!
//! The blobs are self-signed. A signature under the key *inside* the blob
//! proves the sender holds that key and that the blob was not tampered with
//! in flight. It proves **nothing about who the sender is** — an attacker
//! who substitutes the whole blob, key and all, produces one that verifies
//! perfectly.
//!
//! What closes that gap is the human: [`KeynameCheck::Expect`] compares the
//! key-name the user read off the *other device's screen* against the key
//! in the blob, and refuses on mismatch. That comparison is the entire
//! authentication step, which is why the key-name is nine checksummed words
//! instead of 64 hex characters — a fingerprint nobody compares protects
//! nobody.
//!
//! ## Single-use claim tokens
//!
//! The invite carries a 256-bit claim token. It is stored **hashed**, is
//! **single-use** (burned on redemption), and **expires** — the same
//! discipline as the server's bearer token, and as AQL's claim tokens. A
//! replayed or expired acceptance is refused.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::device::{keys, DevicePeer, Devices};
use crate::error::{CoreError, CoreResult};
use crate::util::{new_id, now_iso};

/// Blob prefix; the `1` is the format version, so a future format cannot be
/// mistaken for this one.
const BLOB_PREFIX: &str = "ss-pair1.";
/// Format version carried inside the payload as well.
const BLOB_VERSION: u8 = 1;
const INVITE_TYP: &str = "slipscan.pair.invite";
const ACCEPT_TYP: &str = "slipscan.pair.accept";

/// Domain-separated statements. Versioned; never reused across message
/// kinds, so an invite signature can never be replayed as an acceptance.
const INVITE_DOMAIN: &str = "slipscan.pair.invite.v1";
const ACCEPT_DOMAIN: &str = "slipscan.pair.accept.v1";

/// Hard cap on a pairing blob, in base64 characters.
///
/// The blob arrives before any trust exists, from whatever the user pasted.
/// A hostile or broken source must not be able to make us allocate a
/// gigabyte during the one exchange that happens before authentication —
/// the same reason AQL reads its redeem response through a `LimitReader`.
const MAX_BLOB_CHARS: usize = 8 * 1024;

/// Default invite lifetime. Short: an invite is carried across a room, not
/// mailed.
pub const DEFAULT_INVITE_TTL_SECONDS: i64 = 600;
/// Upper bound on a caller-chosen TTL — one day. An invite that lives
/// forever is a standing credential.
pub const MAX_INVITE_TTL_SECONDS: i64 = 86_400;

/// How the caller discharges the out-of-band key-name comparison.
///
/// Deliberately not `Option<&str>`: skipping the human check must be a
/// visible, spelled-out decision at every call site, not a `None` that got
/// there by accident.
#[derive(Debug, Clone, Copy)]
pub enum KeynameCheck<'a> {
    /// The key-name the user read off the other device. Compared against the
    /// key in the blob; a mismatch is refused. This is the authentication.
    Expect(&'a str),
    /// The caller has already shown the key-name to a human who confirmed
    /// it (the desktop's pairing screen, an interactive CLI prompt). The
    /// pairing is trust-on-first-use with a human in the loop either way —
    /// this variant only says *where* the human was asked.
    ConfirmedByHuman,
}

/// An invite this device minted, ready to carry to another device.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairingInvite {
    pub id: String,
    /// The text to move out of band. Contains the single-use claim token,
    /// so it is a credential until it is redeemed or expires.
    pub blob: String,
    /// This device's key-name — what the *other* user must see match.
    pub keyname: String,
    pub expires_at: String,
}

/// Outstanding-invite metadata. Carries no claim token: the clear token
/// exists only in the blob the user already holds.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PairingInviteMeta {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub expires_at: String,
    pub redeemed_at: Option<String>,
    /// Device id that redeemed this invite, once one has.
    pub redeemed_by: Option<String>,
}

impl PairingInviteMeta {
    pub fn is_redeemed(&self) -> bool {
        self.redeemed_at.is_some()
    }
}

/// The result of accepting an invite: the inviter is now pinned, and the
/// blob goes back so the inviter can pin us.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairingAcceptance {
    /// The peer we just pinned (the inviter).
    pub peer: DevicePeer,
    /// The text to carry back to the inviting device.
    pub blob: String,
}

/// Wire payload of an invite blob.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct InvitePayload {
    v: u8,
    typ: String,
    /// Inviter's device id (hex public key).
    device_id: String,
    /// Inviter's key-name. Advisory only — always recomputed from
    /// `device_id` before it is shown or compared.
    keyname: String,
    label: String,
    /// The single-use claim token, hex.
    claim: String,
    expires_at: String,
    /// Detached signature by `device_id` over [`invite_statement`].
    sig: String,
}

/// Wire payload of an acceptance blob.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct AcceptPayload {
    v: u8,
    typ: String,
    /// Accepter's device id (hex public key).
    device_id: String,
    keyname: String,
    label: String,
    /// Echoed claim token, proving the accepter saw the invite.
    claim: String,
    /// The inviter this acceptance is addressed to. Binding it here stops
    /// the blob being replayed at a third device.
    for_device_id: String,
    /// Detached signature by `device_id` over [`accept_statement`].
    sig: String,
}

/// Bytes an invite is signed over.
fn invite_statement(device_id: &str, claim_sha256: &str, expires_at: &str) -> String {
    format!("{INVITE_DOMAIN}\n{device_id}\n{claim_sha256}\n{expires_at}")
}

/// Bytes an acceptance is signed over. Includes the inviter's id, so an
/// acceptance is valid for exactly one counterparty.
fn accept_statement(device_id: &str, for_device_id: &str, claim_sha256: &str) -> String {
    format!("{ACCEPT_DOMAIN}\n{device_id}\n{for_device_id}\n{claim_sha256}")
}

impl Devices<'_> {
    // -- Minting an invite (device A, step 1) ------------------------------

    /// Mint a single-use pairing invite. `label` describes the device you
    /// expect to pair with; it is cosmetic.
    pub fn invite_create(&self, label: &str, ttl_seconds: i64) -> CoreResult<PairingInvite> {
        if !(1..=MAX_INVITE_TTL_SECONDS).contains(&ttl_seconds) {
            return Err(CoreError::Validation(format!(
                "invite lifetime must be between 1 and {MAX_INVITE_TTL_SECONDS} seconds"
            )));
        }
        let identity = self.require_identity()?;
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Validation(
                "invite label must not be empty".into(),
            ));
        }

        let claim = random_claim_token();
        let claim_sha256 = sha256_hex(claim.as_bytes());
        let expires_at = iso_after(ttl_seconds)?;
        let statement = invite_statement(&identity.public_key, &claim_sha256, &expires_at);
        let sig = self.sign(statement.as_bytes())?;

        let id = new_id();
        self.conn().execute(
            "INSERT INTO device_pair_invites
                 (id, claim_sha256, label, created_at, expires_at, redeemed_at, redeemed_by)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
            params![id, claim_sha256, label, now_iso(), expires_at],
        )?;
        self.audit(
            "device.pair.invite",
            &identity.public_key,
            &identity.keyname,
        )?;

        let payload = InvitePayload {
            v: BLOB_VERSION,
            typ: INVITE_TYP.to_string(),
            device_id: identity.public_key,
            keyname: identity.keyname.clone(),
            label: identity.label,
            claim,
            expires_at: expires_at.clone(),
            sig,
        };
        Ok(PairingInvite {
            id,
            blob: encode_blob(&payload)?,
            keyname: identity.keyname,
            expires_at,
        })
    }

    /// Outstanding and historical invites minted by this device, newest
    /// first. Never includes a claim token.
    pub fn invite_list(&self) -> CoreResult<Vec<PairingInviteMeta>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, label, created_at, expires_at, redeemed_at, redeemed_by
             FROM device_pair_invites ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], map_invite)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// Withdraw an unredeemed invite. Returns whether a row went away.
    pub fn invite_cancel(&self, id: &str) -> CoreResult<bool> {
        let removed = self.conn().execute(
            "DELETE FROM device_pair_invites WHERE id = ?1 AND redeemed_at IS NULL",
            params![id],
        )?;
        Ok(removed > 0)
    }

    // -- Accepting an invite (device B, step 2) ---------------------------

    /// Redeem an invite blob: check it, **pin the inviter**, and produce the
    /// acceptance blob to carry back.
    ///
    /// This is one of the two moments a peer key is ever accepted. The
    /// refusals here are the point:
    ///
    /// * a blob over [`MAX_BLOB_CHARS`], or that is not base64/JSON, or
    ///   whose `typ`/`v` is not this format;
    /// * a signature that does not verify under the key inside the blob;
    /// * an expired invite;
    /// * a key-name that is not the one the user expected
    ///   ([`KeynameCheck::Expect`]);
    /// * an inviter whose key this device has **revoked** — the tombstone
    ///   refuses, and only a deliberate local `peer_forget` clears it.
    pub fn pair_accept(
        &self,
        blob: &str,
        check: KeynameCheck<'_>,
    ) -> CoreResult<PairingAcceptance> {
        let identity = self.require_identity()?;
        let payload: InvitePayload = decode_blob(blob)?;
        if payload.v != BLOB_VERSION || payload.typ != INVITE_TYP {
            return Err(CoreError::DevicePairing(format!(
                "not a SlipScan pairing invite (typ {:?}, v {})",
                payload.typ, payload.v
            )));
        }

        // Length-check and normalize the key before it touches anything.
        let inviter_id = crate::device::normalize_public_key(&payload.device_id)?;
        if inviter_id == identity.public_key {
            return Err(CoreError::DevicePairing(
                "this invite came from this device — pair two different devices".into(),
            ));
        }

        // Recompute the key-name; never trust the one in the blob.
        let inviter_keyname = keys::keyname(&inviter_id)?;
        let claim_sha256 = sha256_hex(payload.claim.as_bytes());
        let statement = invite_statement(&inviter_id, &claim_sha256, &payload.expires_at);
        if !keys::verify_hex(&inviter_id, statement.as_bytes(), &payload.sig) {
            return Err(CoreError::DevicePairing(
                "the invite's signature does not verify under the key it carries".into(),
            ));
        }
        if is_expired(&payload.expires_at)? {
            return Err(CoreError::DevicePairing(format!(
                "this invite expired at {} — ask for a fresh one",
                payload.expires_at
            )));
        }
        check_keyname(check, &inviter_keyname)?;

        let tx = self.conn().unchecked_transaction()?;
        let peer = self.pin_peer(&tx, &inviter_id, &payload.label)?;
        tx.commit()?;
        self.audit("device.pair.accept", &peer.public_key, &peer.keyname)?;

        let accept_statement = accept_statement(&identity.public_key, &inviter_id, &claim_sha256);
        let sig = self.sign(accept_statement.as_bytes())?;
        let response = AcceptPayload {
            v: BLOB_VERSION,
            typ: ACCEPT_TYP.to_string(),
            device_id: identity.public_key,
            keyname: identity.keyname,
            label: identity.label,
            claim: payload.claim,
            for_device_id: inviter_id,
            sig,
        };
        Ok(PairingAcceptance {
            peer,
            blob: encode_blob(&response)?,
        })
    }

    // -- Confirming an acceptance (device A, step 4) ----------------------

    /// Redeem an acceptance blob: **burn the claim token** and pin the
    /// accepter. The other of the two moments a peer key is accepted.
    ///
    /// The token is what makes this an answer to *our* invite rather than an
    /// unsolicited introduction, and burning it is what makes an invite
    /// single-use: replaying the same blob is refused.
    pub fn pair_confirm(&self, blob: &str, check: KeynameCheck<'_>) -> CoreResult<DevicePeer> {
        let identity = self.require_identity()?;
        let payload: AcceptPayload = decode_blob(blob)?;
        if payload.v != BLOB_VERSION || payload.typ != ACCEPT_TYP {
            return Err(CoreError::DevicePairing(format!(
                "not a SlipScan pairing acceptance (typ {:?}, v {})",
                payload.typ, payload.v
            )));
        }

        let accepter_id = crate::device::normalize_public_key(&payload.device_id)?;
        if accepter_id == identity.public_key {
            return Err(CoreError::DevicePairing(
                "this acceptance came from this device — pair two different devices".into(),
            ));
        }
        // The acceptance must be addressed to us. Without this, an
        // acceptance collected from one pairing could be redeemed at a
        // different device that happened to mint the same invite.
        if crate::device::normalize_public_key(&payload.for_device_id)? != identity.public_key {
            return Err(CoreError::DevicePairing(
                "this acceptance is addressed to a different device".into(),
            ));
        }

        let accepter_keyname = keys::keyname(&accepter_id)?;
        let claim_sha256 = sha256_hex(payload.claim.as_bytes());
        let statement = accept_statement(&accepter_id, &identity.public_key, &claim_sha256);
        if !keys::verify_hex(&accepter_id, statement.as_bytes(), &payload.sig) {
            return Err(CoreError::DevicePairing(
                "the acceptance's signature does not verify under the key it carries".into(),
            ));
        }
        check_keyname(check, &accepter_keyname)?;

        let tx = self.conn().unchecked_transaction()?;
        // Look the invite up by the token's HASH — the clear token is never
        // stored, so a database copy cannot redeem anything.
        let invite: Option<PairingInviteMeta> = tx
            .query_row(
                "SELECT id, label, created_at, expires_at, redeemed_at, redeemed_by
                 FROM device_pair_invites WHERE claim_sha256 = ?1",
                params![claim_sha256],
                map_invite,
            )
            .optional()?;
        let invite = invite.ok_or_else(|| {
            CoreError::DevicePairing(
                "this acceptance answers no invite from this device — it may have been \
                 withdrawn, or minted somewhere else"
                    .into(),
            )
        })?;
        if invite.is_redeemed() {
            return Err(CoreError::DevicePairing(
                "this invite was already redeemed — invites are single-use; mint a fresh one"
                    .into(),
            ));
        }
        if is_expired(&invite.expires_at)? {
            return Err(CoreError::DevicePairing(format!(
                "this invite expired at {} — mint a fresh one",
                invite.expires_at
            )));
        }

        let peer = self.pin_peer(&tx, &accepter_id, &payload.label)?;
        // Burn it, in the same transaction as the pin: a pin without a burnt
        // token would leave the invite live for a second redemption.
        tx.execute(
            "UPDATE device_pair_invites
             SET redeemed_at = ?2, redeemed_by = ?3
             WHERE id = ?1 AND redeemed_at IS NULL",
            params![invite.id, now_iso(), peer.public_key],
        )?;
        tx.commit()?;
        self.audit("device.pair.confirm", &peer.public_key, &peer.keyname)?;
        Ok(peer)
    }
}

fn check_keyname(check: KeynameCheck<'_>, actual: &str) -> CoreResult<()> {
    let KeynameCheck::Expect(expected) = check else {
        return Ok(());
    };
    let expected = keys::normalize_keyname(expected);
    if expected.is_empty() {
        return Err(CoreError::Validation(
            "expected key-name must not be empty".into(),
        ));
    }
    // Reject a name that fails its own checksum before comparing, so a
    // mistyped name says "you typed it wrong", not "that is the wrong
    // device" — two very different things for the user to act on.
    if !keys::keyname_is_valid(&expected) {
        return Err(CoreError::DeviceKeynameMistyped { typed: expected });
    }
    if expected != actual {
        return Err(CoreError::DeviceKeynameMismatch {
            expected,
            actual: actual.to_string(),
        });
    }
    Ok(())
}

fn map_invite(row: &Row<'_>) -> rusqlite::Result<PairingInviteMeta> {
    Ok(PairingInviteMeta {
        id: row.get(0)?,
        label: row.get(1)?,
        created_at: row.get(2)?,
        expires_at: row.get(3)?,
        redeemed_at: row.get(4)?,
        redeemed_by: row.get(5)?,
    })
}

/// 256 bits from the OS CSPRNG, hex.
fn random_claim_token() -> String {
    use chacha20poly1305::aead::rand_core::RngCore as _;
    let mut bytes = [0u8; 32];
    chacha20poly1305::aead::OsRng.fill_bytes(&mut bytes);
    keys::encode_hex(&bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    keys::encode_hex(&Sha256::digest(bytes))
}

fn iso_after(seconds: i64) -> CoreResult<String> {
    (OffsetDateTime::now_utc() + Duration::seconds(seconds))
        .format(&Rfc3339)
        .map_err(|err| CoreError::Validation(format!("cannot format an expiry time: {err}")))
}

fn is_expired(expires_at: &str) -> CoreResult<bool> {
    let at = OffsetDateTime::parse(expires_at, &Rfc3339).map_err(|_| {
        // An unparsable expiry is treated as a malformed blob, never as
        // "no expiry".
        CoreError::DevicePairing(format!("malformed expiry timestamp {expires_at:?}"))
    })?;
    Ok(at <= OffsetDateTime::now_utc())
}

fn encode_blob<T: serde::Serialize>(payload: &T) -> CoreResult<String> {
    let json = serde_json::to_vec(payload)?;
    Ok(format!("{BLOB_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
}

/// Decode a pairing blob, refusing anything oversized or malformed **before**
/// allocating for it.
fn decode_blob<T: serde::de::DeserializeOwned>(blob: &str) -> CoreResult<T> {
    let blob = blob.trim();
    if blob.len() > MAX_BLOB_CHARS {
        return Err(CoreError::DevicePairing(format!(
            "pairing blob is too large ({} bytes, limit {MAX_BLOB_CHARS})",
            blob.len()
        )));
    }
    let body = blob.strip_prefix(BLOB_PREFIX).ok_or_else(|| {
        CoreError::DevicePairing(format!(
            "not a SlipScan pairing blob (expected it to start with {BLOB_PREFIX:?})"
        ))
    })?;
    let json = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| CoreError::DevicePairing("pairing blob is not valid base64url".into()))?;
    serde_json::from_slice(&json)
        .map_err(|err| CoreError::DevicePairing(format!("malformed pairing blob: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::tests::TestDevice;
    use crate::device::DeviceKeypair;

    /// Run the whole ceremony and return both devices, mutually pinned.
    fn pair(a: &TestDevice, b: &TestDevice) {
        let invite = a.devices().invite_create("laptop", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::Expect(&a.keyname()))
            .unwrap();
        a.devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::Expect(&b.keyname()))
            .unwrap();
    }

    #[test]
    fn the_full_ceremony_leaves_both_devices_pinned_to_each_other() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        pair(&a, &b);

        let a_peers = a.devices().peer_list().unwrap();
        let b_peers = b.devices().peer_list().unwrap();
        assert_eq!(a_peers.len(), 1);
        assert_eq!(b_peers.len(), 1);
        assert_eq!(a_peers[0].public_key, b.id());
        assert_eq!(b_peers[0].public_key, a.id());
        assert_eq!(a_peers[0].keyname, b.keyname());
        assert_eq!(b_peers[0].keyname, a.keyname());
        assert!(!a_peers[0].is_revoked());

        // Cosmetic labels travelled across.
        assert_eq!(a_peers[0].label, "home server");
        assert_eq!(b_peers[0].label, "laptop");
    }

    #[test]
    fn pairing_needs_no_network_and_records_no_endpoint() {
        // Nothing in the produced artefacts names a host, a port or a URL:
        // there is no coordinator and no default endpoint to leak into one.
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        for blob in [&invite.blob, &acceptance.blob] {
            let json = String::from_utf8(
                URL_SAFE_NO_PAD
                    .decode(blob.strip_prefix(BLOB_PREFIX).unwrap())
                    .unwrap(),
            )
            .unwrap();
            for forbidden in ["http", "://", "ws", "port", "host", "endpoint"] {
                assert!(
                    !json.contains(forbidden),
                    "a pairing blob must carry no location: {json}"
                );
            }
        }
    }

    // -- The key-name is the authentication -------------------------------

    /// **The substitution attack.** An attacker replaces the entire invite
    /// with one minted by their own device, keeping the label. Every
    /// signature verifies — it is a perfectly valid invite, from the wrong
    /// device. Only the key-name comparison catches it.
    #[test]
    fn a_substituted_invite_verifies_but_the_keyname_check_refuses_it() {
        let honest = TestDevice::new("laptop");
        let attacker = TestDevice::new("laptop");
        let victim = TestDevice::new("home server");

        let forged = attacker
            .devices()
            .invite_create("home server", 600)
            .unwrap();

        // Without the human check, TOFU pins whoever showed up — which is
        // exactly why the check exists.
        let err = victim
            .devices()
            .pair_accept(&forged.blob, KeynameCheck::Expect(&honest.keyname()))
            .unwrap_err();
        assert!(
            matches!(err, CoreError::DeviceKeynameMismatch { .. }),
            "got {err:?}"
        );
        assert!(
            victim.devices().peer_list().unwrap().is_empty(),
            "a refused pairing pins nothing"
        );

        // The same blob with the *attacker's* key-name is accepted — the
        // check is a comparison, not an oracle. This is the honest limit of
        // TOFU: it binds a key to what the user checked, nothing more.
        assert!(victim
            .devices()
            .pair_accept(&forged.blob, KeynameCheck::Expect(&attacker.keyname()))
            .is_ok());
    }

    #[test]
    fn a_mistyped_keyname_is_distinguished_from_the_wrong_device() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        // A name that fails its own checksum: "you typed it wrong".
        let honest = a.keyname();
        let mut words: Vec<&str> = honest.split('-').collect();
        words.swap(0, 1);
        let mistyped = words.join("-");
        if mistyped != honest {
            let err = b
                .devices()
                .pair_accept(&invite.blob, KeynameCheck::Expect(&mistyped))
                .unwrap_err();
            assert!(
                matches!(err, CoreError::DeviceKeynameMistyped { .. }),
                "got {err:?}"
            );
        }
    }

    #[test]
    fn keyname_comparison_tolerates_spaces_and_case() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let typed = a.keyname().replace('-', " ").to_uppercase();
        assert!(b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::Expect(&typed))
            .is_ok());
    }

    // -- Single-use, expiring claim tokens --------------------------------

    #[test]
    fn an_invite_is_single_use_and_replaying_the_acceptance_is_refused() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");

        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        a.devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        let err = a
            .devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(matches!(err, CoreError::DevicePairing(_)), "got {err:?}");
        assert!(err.to_string().contains("single-use"));
    }

    #[test]
    fn the_claim_token_is_stored_hashed_and_never_in_the_clear() {
        let a = TestDevice::new("laptop");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        let json = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(invite.blob.strip_prefix(BLOB_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();
        let payload: InvitePayload = serde_json::from_str(&json).unwrap();

        let stored: Vec<String> =
            a.db.conn()
                .prepare("SELECT claim_sha256 FROM device_pair_invites")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
        assert_eq!(stored.len(), 1);
        assert_ne!(
            stored[0], payload.claim,
            "the clear token must not be at rest"
        );
        assert_eq!(stored[0], sha256_hex(payload.claim.as_bytes()));
        // 256 bits of entropy.
        assert_eq!(payload.claim.len(), 64);
    }

    #[test]
    fn two_invites_carry_different_claim_tokens() {
        let a = TestDevice::new("laptop");
        let one = a.devices().invite_create("x", 600).unwrap();
        let two = a.devices().invite_create("y", 600).unwrap();
        assert_ne!(one.blob, two.blob);
        assert_ne!(one.id, two.id);
    }

    #[test]
    fn an_expired_invite_is_refused_on_both_sides() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        // Backdate the invite everywhere it is recorded.
        let expired = "2020-01-01T00:00:00Z";
        a.db.conn()
            .execute(
                "UPDATE device_pair_invites SET expires_at = ?1",
                params![expired],
            )
            .unwrap();

        // The accept side reads the expiry off the blob, so re-sign a
        // backdated invite the way an inviter's clock skew would produce.
        let json = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(invite.blob.strip_prefix(BLOB_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();
        let mut payload: InvitePayload = serde_json::from_str(&json).unwrap();
        payload.expires_at = expired.to_string();
        let claim_sha256 = sha256_hex(payload.claim.as_bytes());
        payload.sig = a
            .devices()
            .sign(invite_statement(&a.id(), &claim_sha256, expired).as_bytes())
            .unwrap();
        let backdated = encode_blob(&payload).unwrap();

        let err = b
            .devices()
            .pair_accept(&backdated, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(err.to_string().contains("expired"), "got {err}");
        assert!(b.devices().peer_list().unwrap().is_empty());
    }

    #[test]
    fn an_acceptance_answering_no_invite_is_refused() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        // The inviter withdraws it before the acceptance comes back.
        assert!(a.devices().invite_cancel(&invite.id).unwrap());

        let err = a
            .devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(err.to_string().contains("answers no invite"), "got {err}");
        assert!(a.devices().peer_list().unwrap().is_empty());
    }

    /// An acceptance is addressed to one inviter. A third device that
    /// happens to hold the same blob cannot redeem it.
    #[test]
    fn an_acceptance_cannot_be_redeemed_by_a_different_device() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let c = TestDevice::new("cloud box");

        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        let err = c
            .devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(
            err.to_string().contains("addressed to a different device"),
            "got {err}"
        );
        assert!(c.devices().peer_list().unwrap().is_empty());
    }

    // -- Blob hygiene ------------------------------------------------------

    #[test]
    fn a_tampered_blob_fails_its_signature() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        // Re-label the invite without re-signing.
        let json = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(invite.blob.strip_prefix(BLOB_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();
        let mut payload: InvitePayload = serde_json::from_str(&json).unwrap();
        payload.claim = keys::encode_hex(&[0u8; 32]);
        let tampered = encode_blob(&payload).unwrap();

        let err = b
            .devices()
            .pair_accept(&tampered, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(err.to_string().contains("signature"), "got {err}");
    }

    /// A blob whose `keyname` field lies about its own `device_id` must not
    /// fool the comparison: the name shown to the user is always recomputed
    /// from the key.
    #[test]
    fn the_keyname_in_a_blob_is_never_trusted() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let c = TestDevice::new("decoy");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        let json = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(invite.blob.strip_prefix(BLOB_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();
        let mut payload: InvitePayload = serde_json::from_str(&json).unwrap();
        // Claim to be someone else's key-name; the signature still verifies
        // because keyname is not part of the signed statement.
        payload.keyname = c.keyname();
        let lying = encode_blob(&payload).unwrap();

        let err = b
            .devices()
            .pair_accept(&lying, KeynameCheck::Expect(&c.keyname()))
            .unwrap_err();
        assert!(
            matches!(err, CoreError::DeviceKeynameMismatch { .. }),
            "got {err:?}"
        );
        // And the honest name still works, proving the field is simply ignored.
        assert!(b
            .devices()
            .pair_accept(&lying, KeynameCheck::Expect(&a.keyname()))
            .is_ok());
    }

    #[test]
    fn an_oversized_blob_is_refused_before_it_is_parsed() {
        let b = TestDevice::new("home server");
        let huge = format!("{BLOB_PREFIX}{}", "A".repeat(MAX_BLOB_CHARS + 1));
        let err = b
            .devices()
            .pair_accept(&huge, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(err.to_string().contains("too large"), "got {err}");
    }

    #[test]
    fn malformed_blobs_are_refused_without_panicking() {
        let b = TestDevice::new("home server");
        for junk in [
            "",
            "hello",
            "ss-pair1.",
            "ss-pair1.!!!!not-base64!!!!",
            "ss-pair1.aGVsbG8", // valid base64, not JSON
            "ss-pair2.aGVsbG8", // wrong format version prefix
            &format!("{BLOB_PREFIX}{}", URL_SAFE_NO_PAD.encode(b"{}")),
        ] {
            let err = b
                .devices()
                .pair_accept(junk, KeynameCheck::ConfirmedByHuman)
                .unwrap_err();
            assert!(matches!(
                err,
                CoreError::DevicePairing(_) | CoreError::Validation(_)
            ));
        }
    }

    /// A blob carrying an unusable (wrong-length) key must refuse, not
    /// panic — the ed25519 primitive is reached with unvalidated bytes here.
    #[test]
    fn a_blob_carrying_an_unusable_key_refuses_instead_of_panicking() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let json = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(invite.blob.strip_prefix(BLOB_PREFIX).unwrap())
                .unwrap(),
        )
        .unwrap();

        for broken in ["", "ab", &"ab".repeat(31), &"zz".repeat(32)] {
            let mut payload: InvitePayload = serde_json::from_str(&json).unwrap();
            payload.device_id = broken.to_string();
            let err = b
                .devices()
                .pair_accept(
                    &encode_blob(&payload).unwrap(),
                    KeynameCheck::ConfirmedByHuman,
                )
                .unwrap_err();
            assert!(
                matches!(err, CoreError::DeviceKeyUnusable { .. }),
                "got {err:?}"
            );
        }
    }

    #[test]
    fn a_device_cannot_pair_with_itself() {
        let a = TestDevice::new("laptop");
        let invite = a.devices().invite_create("itself", 600).unwrap();
        let err = a
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(
            err.to_string().contains("two different devices"),
            "got {err}"
        );
    }

    #[test]
    fn pairing_requires_an_identity_first() {
        let bare = TestDevice::bare();
        assert!(matches!(
            bare.devices().invite_create("x", 600).unwrap_err(),
            CoreError::DeviceIdentityMissing
        ));

        let a = TestDevice::new("laptop");
        let invite = a.devices().invite_create("x", 600).unwrap();
        assert!(matches!(
            bare.devices()
                .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
                .unwrap_err(),
            CoreError::DeviceIdentityMissing
        ));
    }

    #[test]
    fn invite_ttls_are_bounded() {
        let a = TestDevice::new("laptop");
        assert!(a.devices().invite_create("x", 0).is_err());
        assert!(a.devices().invite_create("x", -1).is_err());
        assert!(a
            .devices()
            .invite_create("x", MAX_INVITE_TTL_SECONDS + 1)
            .is_err());
        assert!(a.devices().invite_create("x", 1).is_ok());
        assert!(a
            .devices()
            .invite_create("x", MAX_INVITE_TTL_SECONDS)
            .is_ok());
    }

    #[test]
    fn invite_metadata_lists_without_ever_carrying_a_token() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        let invite = a.devices().invite_create("home server", 600).unwrap();

        let listed = a.devices().invite_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].is_redeemed());
        let rendered = serde_json::to_string(&listed).unwrap();
        assert!(!rendered.contains("claim"), "no token in metadata");

        // Redeem *this* invite (not a fresh one) so the burn is observable
        // on the row we listed above.
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        a.devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        let listed = a.devices().invite_list().unwrap();
        let redeemed = listed.iter().find(|meta| meta.id == invite.id).unwrap();
        assert!(redeemed.is_redeemed());
        assert_eq!(redeemed.redeemed_by.as_deref(), Some(b.id().as_str()));
        assert!(!serde_json::to_string(&listed).unwrap().contains("claim"));
    }

    // -- Revocation refuses a re-pair -------------------------------------

    /// **The refusal that matters.** After revoking a peer, the same device
    /// running the same ceremony again is refused. A device that has been
    /// thrown out cannot let itself back in — only the user can, locally.
    #[test]
    fn a_revoked_peer_cannot_re_pair_through_the_ceremony() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        pair(&a, &b);

        a.devices().peer_revoke(&b.id()).unwrap();

        // B tries again with a brand-new invite from A.
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        let err = a
            .devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(
            matches!(err, CoreError::DevicePeerRevoked { .. }),
            "got {err:?}"
        );
        assert!(
            a.devices().peer_get(&b.id()).unwrap().unwrap().is_revoked(),
            "still revoked"
        );

        // The refused confirm must not have burnt the invite either — a
        // failed pairing leaves no debris.
        let listed = a.devices().invite_list().unwrap();
        let this = listed.iter().find(|meta| meta.id == invite.id).unwrap();
        assert!(!this.is_redeemed(), "a refused pairing burns nothing");

        // Only the deliberate local reset opens the door.
        a.devices().peer_forget(&b.id()).unwrap();
        let invite = a.devices().invite_create("home server", 600).unwrap();
        let acceptance = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        assert!(a
            .devices()
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .is_ok());
    }

    /// Symmetrically, an invite from a peer this device has revoked is
    /// refused at the accept step too.
    #[test]
    fn an_invite_from_a_revoked_peer_is_refused_at_accept() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        pair(&a, &b);
        b.devices().peer_revoke(&a.id()).unwrap();

        let invite = a.devices().invite_create("home server", 600).unwrap();
        let err = b
            .devices()
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        assert!(
            matches!(err, CoreError::DevicePeerRevoked { .. }),
            "got {err:?}"
        );
    }

    /// Re-running the ceremony with the *same* key is allowed — the AQL
    /// allowance for a redeem carrying an unchanged key — and does not
    /// disturb the pin.
    #[test]
    fn re_pairing_the_same_device_keeps_the_original_pin() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        pair(&a, &b);
        let first = a.devices().peer_get(&b.id()).unwrap().unwrap();

        pair(&a, &b);
        let second = a.devices().peer_get(&b.id()).unwrap().unwrap();

        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.paired_at, second.paired_at, "the pin is untouched");
        assert_eq!(a.devices().peer_list().unwrap().len(), 1);
    }

    /// After a peer rotates its key it is a *new* device id, so it pairs as
    /// a new peer. The old pin is untouched — nothing anywhere silently
    /// upgrades an existing pin to a new key.
    #[test]
    fn a_peers_rotated_key_pairs_as_a_new_peer_and_never_replaces_the_old_pin() {
        let a = TestDevice::new("laptop");
        let b = TestDevice::new("home server");
        pair(&a, &b);
        let original = b.id();

        b.devices().rotate().unwrap();
        assert_ne!(b.id(), original);
        pair(&a, &b);

        let peers = a.devices().peer_list().unwrap();
        assert_eq!(peers.len(), 2, "a rotated key is a new peer, not a re-pin");
        assert!(peers.iter().any(|peer| peer.public_key == original));
        assert!(peers.iter().any(|peer| peer.public_key == b.id()));
        // The original pin is byte-for-byte what it was.
        let old = peers
            .iter()
            .find(|peer| peer.public_key == original)
            .unwrap();
        assert_eq!(old.keyname, keys::keyname(&original).unwrap());
    }

    /// A peer key is only ever accepted at accept/confirm. Nothing else in
    /// the crate can introduce one — a random unpinned key is simply unknown.
    #[test]
    fn a_key_that_never_went_through_the_ceremony_is_not_pinned() {
        let a = TestDevice::new("laptop");
        let stranger = DeviceKeypair::generate().public_key_hex();
        assert!(a.devices().peer_get(&stranger).unwrap().is_none());
        assert!(a.devices().peer_list().unwrap().is_empty());
    }
}
