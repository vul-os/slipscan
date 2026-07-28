//! Signing and verification: ed25519 detached signatures over the exact
//! payload bytes.
//!
//! Signer identity **is** the public key — there is no name registry and no
//! central authority. Humans check a short fingerprint out-of-band (like an
//! SSH host key); the trust-on-first-use store lives in [`crate::trust`].
//!
//! The only way to reach [`crate::install::Installer::install`] is through a
//! [`VerifiedPack`], and the only ways to construct one are:
//! * [`Pack::verify`] — a valid signature over the payload bytes;
//! * [`crate::builtin::seed_packs`] — payloads compiled into this binary;
//! * [`VerifiedPack::dangerously_allow_unsigned`] — the explicit, loudly
//!   named developer override for authoring packs locally.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::error::{PackError, PackResult};
use crate::format::{ManifestSignature, Pack, SIGNATURE_ALGORITHM};
use crate::hex;
use crate::model::PackPayload;

/// Signer id recorded for packs accepted through the developer override.
pub const DEV_UNSIGNED_SIGNER: &str = "dev-unsigned";

/// Short, non-reversible fingerprint of a signer's public key: the first
/// 8 bytes of SHA-256 over the raw key, grouped for humans
/// (`"ab12-cd34-ef56-7890"`). Non-key signer ids (builtin/dev) fingerprint
/// their label bytes the same way, so every signer has a checkable form.
pub fn key_fingerprint(public_key_hex: &str) -> String {
    let bytes = hex::decode(public_key_hex).unwrap_or_else(|| public_key_hex.as_bytes().to_vec());
    let digest = Sha256::digest(&bytes);
    let mut out = String::with_capacity(19);
    for (i, chunk) in digest[..8].chunks(2).enumerate() {
        if i > 0 {
            out.push('-');
        }
        out.push_str(&hex::encode(chunk));
    }
    out
}

/// Sign a pack's payload bytes, returning a copy carrying the signature
/// block. Pack authoring / export path; the signing key never touches disk
/// through this crate.
pub fn sign_pack(pack: &Pack, signing_key: &SigningKey) -> Pack {
    let signature = signing_key.sign(pack.payload_bytes());
    let mut signed = pack.clone();
    signed.manifest.signature = Some(ManifestSignature {
        algorithm: SIGNATURE_ALGORITHM.to_string(),
        public_key: hex::encode(signing_key.verifying_key().as_bytes()),
        signature: hex::encode(&signature.to_bytes()),
    });
    signed
}

/// Verify a **detached** ed25519 signature over the exact bytes of a pack
/// document, and adopt the result as a [`VerifiedPack`] the installer will
/// accept.
///
/// This is the three-input form users actually hold — document, signature,
/// publisher key — as `slipscan pack install` and the server's `pack_install`
/// take them. Both pack document shapes are accepted, and the signature is
/// checked over the bytes exactly as given, before either is interpreted:
///
/// * the current [`PackPayload`] JSON — kept byte-for-byte, signature block
///   attached, so the installed pack is what was signed and stays verifiable;
/// * the legacy flat manifest ([`crate::PackManifest`]) — converted to a
///   payload only after its own bytes verified. The stored payload is a
///   re-encoding, so it carries no signature block of its own; the integrity
///   claim is what it always was for those files, checked here at install.
pub fn verify_detached(
    document: &[u8],
    signature: &[u8],
    public_key: &[u8],
) -> PackResult<VerifiedPack> {
    let key_arr: &[u8; 32] = public_key
        .try_into()
        .map_err(|_| PackError::InvalidPublicKey)?;
    let key = VerifyingKey::from_bytes(key_arr).map_err(|_| PackError::InvalidPublicKey)?;
    let sig = Signature::from_slice(signature).map_err(|_| PackError::InvalidSignature)?;
    key.verify(document, &sig)
        .map_err(|_| PackError::VerificationFailed)?;
    let signer = hex::encode(key_arr);

    // Shape check, not a fallback chain: `meta` is the payload's own envelope
    // and the legacy manifest has no such key, so each document is parsed
    // once, as itself, and reports its own errors.
    let document_json: serde_json::Value = serde_json::from_slice(document)?;
    let pack = if document_json.get("meta").is_some() {
        let payload = PackPayload::from_json(document)?;
        Pack::from_signed_payload(
            document.to_vec(),
            payload,
            Some(ManifestSignature {
                algorithm: SIGNATURE_ALGORITHM.to_string(),
                public_key: signer.clone(),
                signature: hex::encode(&sig.to_bytes()),
            }),
        )
    } else {
        Pack::build(&crate::compat::PackManifest::from_json(document)?.into_payload()?)?
    };

    Ok(VerifiedPack::new(pack, signer, Provenance::External))
}

/// Where a verified pack came from — drives the trust check on install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// Loaded from outside; signer must be in the trust store.
    External,
    /// Compiled into this binary; integrity comes from the binary itself.
    Builtin,
    /// Explicit developer override for authoring packs locally.
    DevUnsigned,
}

/// A pack whose signature has been checked. The installer accepts nothing
/// else.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedPack {
    pack: Pack,
    signer: String,
    provenance: Provenance,
}

impl VerifiedPack {
    pub(crate) fn new(pack: Pack, signer: String, provenance: Provenance) -> Self {
        Self {
            pack,
            signer,
            provenance,
        }
    }

    /// Developer override: accept an unsigned pack for local development.
    /// Never wired to any default flow; callers must opt in explicitly.
    pub fn dangerously_allow_unsigned(pack: Pack) -> Self {
        Self::new(
            pack,
            DEV_UNSIGNED_SIGNER.to_string(),
            Provenance::DevUnsigned,
        )
    }

    pub fn pack(&self) -> &Pack {
        &self.pack
    }

    pub fn payload(&self) -> &PackPayload {
        self.pack.payload()
    }

    /// The signer identity: lowercase hex ed25519 public key for external
    /// packs, or a reserved label for builtin / dev-override packs.
    pub fn signer(&self) -> &str {
        &self.signer
    }

    /// Human-checkable fingerprint of the signer.
    pub fn fingerprint(&self) -> String {
        key_fingerprint(&self.signer)
    }

    pub fn provenance(&self) -> Provenance {
        self.provenance
    }
}

impl Pack {
    /// Verify this pack's detached ed25519 signature over the exact payload
    /// bytes. Unsigned packs are rejected (`PackError::Unsigned`); tampered
    /// payloads or wrong keys fail with `PackError::VerificationFailed`.
    pub fn verify(&self) -> PackResult<VerifiedPack> {
        let signature = self
            .signature()
            .ok_or_else(|| PackError::Unsigned(self.id().to_string()))?;

        let key_bytes = hex::decode(&signature.public_key)
            .filter(|b| b.len() == 32)
            .ok_or(PackError::InvalidPublicKey)?;
        let key_arr: [u8; 32] = key_bytes
            .as_slice()
            .try_into()
            .map_err(|_| PackError::InvalidPublicKey)?;
        let key = VerifyingKey::from_bytes(&key_arr).map_err(|_| PackError::InvalidPublicKey)?;

        let sig_bytes = hex::decode(&signature.signature)
            .filter(|b| b.len() == 64)
            .ok_or(PackError::InvalidSignature)?;
        let sig = Signature::from_slice(&sig_bytes).map_err(|_| PackError::InvalidSignature)?;

        key.verify(self.payload_bytes(), &sig)
            .map_err(|_| PackError::VerificationFailed)?;

        Ok(VerifiedPack::new(
            self.clone(),
            hex::encode(&key_arr),
            Provenance::External,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MatchKind, MerchantRule, PackCategory, PackMeta};

    fn payload() -> PackPayload {
        PackPayload {
            meta: PackMeta {
                id: "za-verify-test".into(),
                name: "Verify test".into(),
                version: "1.0.0".into(),
                region: Some("ZA".into()),
                author: Some("tests".into()),
                description: None,
            },
            categories: vec![PackCategory {
                key: "groceries".into(),
                name: "Groceries".into(),
                parent_key: None,
                kind: "expense".into(),
                icon: None,
                color: None,
            }],
            merchant_rules: vec![MerchantRule {
                match_kind: MatchKind::Contains,
                pattern: "checkers".into(),
                category_key: "groceries".into(),
                confidence: 0.95,
            }],
            keyword_rules: vec![],
            vat_hints: vec![],
            benchmarks: None,
            mailrules: None,
        }
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    #[test]
    fn sign_verify_round_trip() {
        let pack = Pack::build(&payload()).unwrap();
        let signing = key(7);
        let signed = sign_pack(&pack, &signing);

        let verified = signed.verify().unwrap();
        assert_eq!(verified.payload(), pack.payload());
        assert_eq!(
            verified.signer(),
            hex::encode(signing.verifying_key().as_bytes())
        );
        assert_eq!(verified.provenance(), Provenance::External);

        // Round-trips through the on-disk form too.
        let dir = tempfile::tempdir().unwrap();
        signed.write_dir(dir.path().join("p")).unwrap();
        let reloaded = Pack::load_dir(dir.path().join("p")).unwrap();
        reloaded.verify().unwrap();
    }

    #[test]
    fn unsigned_pack_is_rejected() {
        let pack = Pack::build(&payload()).unwrap();
        assert!(matches!(pack.verify(), Err(PackError::Unsigned(_))));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let pack = sign_pack(&Pack::build(&payload()).unwrap(), &key(7));
        // Tampering after signing: rebuild parts with flipped payload byte.
        // The hash check fires before the signature is even consulted.
        let manifest = pack.manifest_toml().unwrap();
        let mut bytes = pack.payload_bytes().to_vec();
        let idx = bytes.len() - 2;
        bytes[idx] ^= 0x01;
        assert!(matches!(
            Pack::from_parts(&manifest, &bytes),
            Err(PackError::HashMismatch { .. })
        ));
    }

    #[test]
    fn wrong_key_or_garbled_signature_is_rejected() {
        let pack = Pack::build(&payload()).unwrap();
        let signed = sign_pack(&pack, &key(7));

        // Signature block swapped for another key's signature.
        let forged = sign_pack(&pack, &key(9));
        let mut mixed = signed.clone();
        mixed.manifest.signature = Some(ManifestSignature {
            public_key: forged.signature().unwrap().public_key.clone(),
            ..signed.signature().unwrap().clone()
        });
        assert!(matches!(mixed.verify(), Err(PackError::VerificationFailed)));

        // Corrupted signature hex.
        let mut garbled = signed.clone();
        let sig = garbled.manifest.signature.as_mut().unwrap();
        sig.signature = format!("00{}", &sig.signature[2..]);
        assert!(matches!(
            garbled.verify(),
            Err(PackError::VerificationFailed)
        ));

        // Malformed encodings.
        let mut short_key = signed.clone();
        short_key.manifest.signature.as_mut().unwrap().public_key = "abcd".into();
        assert!(matches!(
            short_key.verify(),
            Err(PackError::InvalidPublicKey)
        ));
        let mut short_sig = signed;
        short_sig.manifest.signature.as_mut().unwrap().signature = "abcd".into();
        assert!(matches!(
            short_sig.verify(),
            Err(PackError::InvalidSignature)
        ));
    }

    #[test]
    fn verify_detached_takes_both_document_shapes() {
        let signing = key(7);
        let signer_hex = hex::encode(signing.verifying_key().as_bytes());

        // Current form: payload JSON, signature handed over separately. The
        // bytes are kept exactly, and the result stays verifiable on its own.
        let payload_bytes = serde_json::to_vec_pretty(&payload()).unwrap();
        let signature = signing.sign(&payload_bytes);
        let verified = verify_detached(
            &payload_bytes,
            &signature.to_bytes(),
            signing.verifying_key().as_bytes(),
        )
        .unwrap();
        assert_eq!(verified.signer(), signer_hex);
        assert_eq!(verified.provenance(), Provenance::External);
        assert_eq!(verified.pack().payload_bytes(), payload_bytes);
        verified.pack().verify().unwrap();

        // Legacy form: the flat manifest, converted after its own bytes
        // verified.
        let legacy = serde_json::json!({
            "id": "za-verify-test",
            "name": "Verify test",
            "version": "1.0.0",
            "categories": [
                { "key": "groceries", "name": "Groceries", "kind": "expense" }
            ],
            "rules": [
                { "match_type": "merchant_contains", "pattern": "checkers",
                  "category_key": "groceries", "confidence": 0.95 }
            ],
        });
        let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
        let signature = signing.sign(&legacy_bytes);
        let verified = verify_detached(
            &legacy_bytes,
            &signature.to_bytes(),
            signing.verifying_key().as_bytes(),
        )
        .unwrap();
        assert_eq!(verified.signer(), signer_hex);
        assert_eq!(verified.payload().meta.id, "za-verify-test");
        assert_eq!(verified.payload().merchant_rules.len(), 1);
    }

    #[test]
    fn verify_detached_rejects_tampering_before_it_interprets_anything() {
        let signing = key(7);
        let bytes = serde_json::to_vec_pretty(&payload()).unwrap();
        let signature = signing.sign(&bytes).to_bytes();
        let verifying = signing.verifying_key();
        let public = verifying.as_bytes();

        let mut tampered = bytes.clone();
        let idx = tampered.len() - 2;
        tampered[idx] ^= 0x01;
        assert!(matches!(
            verify_detached(&tampered, &signature, public),
            Err(PackError::VerificationFailed)
        ));
        assert!(matches!(
            verify_detached(&bytes, &signature, key(9).verifying_key().as_bytes()),
            Err(PackError::VerificationFailed)
        ));
        assert!(matches!(
            verify_detached(&bytes, &signature, &[1, 2, 3]),
            Err(PackError::InvalidPublicKey)
        ));
        assert!(matches!(
            verify_detached(&bytes, &[0u8; 10], public),
            Err(PackError::InvalidSignature)
        ));

        // Signed, but not a pack: reported as the parse failure it is.
        let junk = b"{\"nope\":true}".to_vec();
        let signature = signing.sign(&junk).to_bytes();
        assert!(matches!(
            verify_detached(&junk, &signature, public),
            Err(PackError::PayloadParse(_))
        ));
    }

    #[test]
    fn fingerprint_is_short_and_stable() {
        let signing = key(7);
        let pub_hex = hex::encode(signing.verifying_key().as_bytes());
        let fp = key_fingerprint(&pub_hex);
        assert_eq!(fp, key_fingerprint(&pub_hex));
        assert_eq!(fp.len(), 19, "4 groups of 4 hex chars: {fp}");
        assert_ne!(
            fp,
            key_fingerprint(&hex::encode(key(9).verifying_key().as_bytes()))
        );
        // The fingerprint must not reveal the key.
        assert!(!pub_hex.contains(&fp.replace('-', "")));
    }

    #[test]
    fn dev_override_is_explicit() {
        let pack = Pack::build(&payload()).unwrap();
        let verified = VerifiedPack::dangerously_allow_unsigned(pack);
        assert_eq!(verified.provenance(), Provenance::DevUnsigned);
        assert_eq!(verified.signer(), DEV_UNSIGNED_SIGNER);
    }
}
