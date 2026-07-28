//! The device keypair: generation, the hex/keyname renderings of a public
//! key, and a verification primitive that refuses rather than panics.
//!
//! The keypair is generated **on the device**. There is no provisioned key,
//! no escrow, and no key material in any file SlipScan ships — so there is
//! nothing a supply-chain attacker can copy. The private half's only home is
//! the write-only credential vault (`crate::secrets`); it leaves that vault
//! exactly once per operation, inside a `use_with` closure, and is zeroized
//! when the closure returns.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::error::{CoreError, CoreResult};
use crate::secrets::SecretString;

/// Length of an ed25519 public key, and of the seed we store.
const KEY_LEN: usize = 32;
/// Length of an ed25519 detached signature.
const SIG_LEN: usize = 64;

/// A device signing key. Deliberately has no `Debug`, no `Display`, no
/// `Clone` and no serde impls: the only way out is [`DeviceKeypair::secret`],
/// which yields a redacted, zeroize-on-drop [`SecretString`] bound for the
/// vault.
pub struct DeviceKeypair {
    signing: SigningKey,
}

impl DeviceKeypair {
    /// Generate a fresh keypair from the OS CSPRNG.
    pub fn generate() -> Self {
        // `aead`'s OsRng is rand_core 0.6's, the same trait ed25519-dalek's
        // `rand_core` feature expects — no second RNG stack pulled in.
        let mut rng = chacha20poly1305::aead::OsRng;
        Self {
            signing: SigningKey::generate(&mut rng),
        }
    }

    /// Rebuild the keypair from the seed held in the vault. Any material
    /// that is not exactly 32 bytes of hex is refused — a truncated or
    /// half-written vault entry must fail, not produce a different identity.
    pub fn from_secret(secret: &SecretString) -> CoreResult<Self> {
        let bytes = decode_hex(secret.expose_secret()).ok_or(CoreError::DeviceKeyUnusable {
            subject: "this device's stored private key".into(),
        })?;
        let seed: [u8; KEY_LEN] =
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| CoreError::DeviceKeyUnusable {
                    subject: "this device's stored private key".into(),
                })?;
        Ok(Self {
            signing: SigningKey::from_bytes(&seed),
        })
    }

    /// The seed, wrapped for the vault. Callers hand this straight to
    /// `Vault::set`/`Vault::replace` and never hold it.
    pub fn secret(&self) -> SecretString {
        SecretString::new(encode_hex(&self.signing.to_bytes()))
    }

    /// The device id: lowercase hex of the public key.
    pub fn public_key_hex(&self) -> String {
        encode_hex(self.signing.verifying_key().as_bytes())
    }

    /// Detached signature over `message`, lowercase hex.
    pub fn sign_hex(&self, message: &[u8]) -> String {
        encode_hex(&self.signing.sign(message).to_bytes())
    }
}

/// The human-comparable rendering of a public key: kotva-core's key-name —
/// 8 data words carrying 80 bits of a BLAKE3 digest, plus a checksum word,
/// joined by `-`.
///
/// This exists because **hex fingerprints do not actually get compared**. A
/// person reading 64 hex characters down a phone line checks the first four
/// and the last four; a key-name is nine short pronounceable words, and the
/// checksum word means a misheard or mistyped one fails closed instead of
/// naming some other key. The scheme is not invented here — it is the same
/// one Kotva identities use, so a user who has compared one has compared
/// both.
pub fn keyname(public_key_hex: &str) -> CoreResult<String> {
    let bytes = decode_public_key(public_key_hex)?;
    Ok(kotva_core::keyname::encode(&bytes))
}

/// Is `name` a well-formed key-name (right shape, checksum word agrees)?
/// Used to reject a mistyped out-of-band comparison before it is compared
/// against anything.
pub fn keyname_is_valid(name: &str) -> bool {
    kotva_core::keyname::verify(name)
}

/// Normalize a user-typed key-name for comparison: lowercase, trimmed, and
/// tolerant of spaces where a user typed words instead of hyphens.
pub fn normalize_keyname(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Decode a hex public key into exactly 32 bytes, or refuse.
///
/// Every wire-borne key arrives through a decoder that enforces this length.
/// The *pinned* key is the one that does not — it came from the database,
/// where a truncated write or a hand-edited row can leave anything at all.
/// Most ed25519 libraries panic on a wrong-sized key; a books daemon must
/// refuse a command it cannot verify, not die on it.
pub fn decode_public_key(public_key_hex: &str) -> CoreResult<[u8; KEY_LEN]> {
    decode_hex(public_key_hex)
        .and_then(|bytes| <[u8; KEY_LEN]>::try_from(bytes.as_slice()).ok())
        .ok_or_else(|| CoreError::DeviceKeyUnusable {
            subject: format!("public key {}", truncate_for_message(public_key_hex)),
        })
}

/// Verify a detached hex signature under a hex public key.
///
/// **Fail-closed and total**: every malformed input — wrong-length key,
/// wrong-length signature, non-hex in either — returns `false`. It never
/// panics and never returns an error the caller might treat as "unknown,
/// carry on". An unusable pinned key means nothing can be authenticated
/// against it, so nothing may be accepted.
pub fn verify_hex(public_key_hex: &str, message: &[u8], signature_hex: &str) -> bool {
    let Ok(key_bytes) = decode_public_key(public_key_hex) else {
        return false;
    };
    let Some(sig_bytes) = decode_hex(signature_hex) else {
        return false;
    };
    if sig_bytes.len() != SIG_LEN {
        return false;
    }
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    key.verify(message, &sig).is_ok()
}

/// Lowercase hex.
pub fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Strict hex decode: even length, hex digits only. `None` on anything else.
pub fn decode_hex(text: &str) -> Option<Vec<u8>> {
    // `usize::is_multiple_of` is stable only from 1.87; this crate's MSRV is
    // 1.85.
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

/// Keep error messages from echoing an arbitrarily long attacker-supplied
/// string back into a log line.
fn truncate_for_message(raw: &str) -> String {
    let shown: String = raw.chars().take(16).collect();
    if raw.chars().count() > 16 {
        format!("{shown}…")
    } else {
        shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_keypair_round_trips_through_the_vault_representation() {
        let key = DeviceKeypair::generate();
        let restored = DeviceKeypair::from_secret(&key.secret()).expect("valid seed");
        assert_eq!(key.public_key_hex(), restored.public_key_hex());
    }

    #[test]
    fn two_generated_keypairs_differ() {
        let a = DeviceKeypair::generate();
        let b = DeviceKeypair::generate();
        assert_ne!(a.public_key_hex(), b.public_key_hex());
    }

    #[test]
    fn a_signature_verifies_only_under_its_own_key_and_message() {
        let key = DeviceKeypair::generate();
        let other = DeviceKeypair::generate();
        let sig = key.sign_hex(b"pair this device");

        assert!(verify_hex(&key.public_key_hex(), b"pair this device", &sig));
        assert!(!verify_hex(
            &other.public_key_hex(),
            b"pair this device",
            &sig
        ));
        assert!(!verify_hex(
            &key.public_key_hex(),
            b"pair that device",
            &sig
        ));
    }

    /// The failure the AQL profile calls out: a *pinned* key comes from
    /// storage, not from a length-checked decoder, so a corrupt row reaches
    /// the verification primitive directly. It must refuse, not panic.
    #[test]
    fn an_unusable_pinned_key_refuses_instead_of_panicking() {
        let key = DeviceKeypair::generate();
        let sig = key.sign_hex(b"message");

        for broken in [
            "",                       // empty
            "00",                     // far too short
            "zz".repeat(32).as_str(), // right length, not hex
            "ab".repeat(31).as_str(), // 31 bytes
            "ab".repeat(33).as_str(), // 33 bytes
            "abc",                    // odd length
        ] {
            assert!(
                !verify_hex(broken, b"message", &sig),
                "a {broken:?} pinned key must refuse"
            );
            assert!(decode_public_key(broken).is_err());
        }
    }

    #[test]
    fn a_malformed_signature_refuses_instead_of_panicking() {
        let key = DeviceKeypair::generate();
        for broken in ["", "00", "zz", &"ab".repeat(63), &"ab".repeat(65)] {
            assert!(!verify_hex(&key.public_key_hex(), b"message", broken));
        }
    }

    #[test]
    fn a_seed_that_is_not_thirty_two_bytes_is_refused() {
        for broken in ["", "ab", "zz", &"ab".repeat(31), &"ab".repeat(33)] {
            assert!(DeviceKeypair::from_secret(&SecretString::new(broken.to_string())).is_err());
        }
    }

    #[test]
    fn a_keyname_is_nine_words_and_self_checks() {
        let key = DeviceKeypair::generate();
        let name = keyname(&key.public_key_hex()).expect("valid key");
        assert_eq!(name.split('-').count(), 9, "8 data words + 1 checksum word");
        assert!(keyname_is_valid(&name));
    }

    #[test]
    fn different_keys_get_different_keynames() {
        let a = keyname(&DeviceKeypair::generate().public_key_hex()).unwrap();
        let b = keyname(&DeviceKeypair::generate().public_key_hex()).unwrap();
        assert_ne!(a, b);
    }

    /// The checksum word is the whole point: a name with a word swapped for
    /// another real word must fail rather than resolve to something.
    #[test]
    fn a_corrupted_keyname_fails_its_checksum() {
        let name = keyname(&DeviceKeypair::generate().public_key_hex()).unwrap();
        let mut words: Vec<&str> = name.split('-').collect();
        // Swap the first two data words — still all real words, wrong name.
        words.swap(0, 1);
        let swapped = words.join("-");
        if swapped != name {
            assert!(!keyname_is_valid(&swapped));
        }
    }

    #[test]
    fn keyname_normalization_accepts_spaces_and_case() {
        let name = keyname(&DeviceKeypair::generate().public_key_hex()).unwrap();
        let typed = name.replace('-', " ").to_uppercase();
        assert_eq!(normalize_keyname(&typed), name);
        assert_eq!(normalize_keyname(&format!("  {name}  ")), name);
    }

    #[test]
    fn keyname_refuses_an_unusable_key() {
        assert!(keyname("not-a-key").is_err());
        assert!(keyname(&"ab".repeat(31)).is_err());
    }
}
