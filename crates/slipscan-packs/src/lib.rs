//! slipscan-packs — signed classification/category packs.
//!
//! Community sharing moves **rules, never data**: a pack contains a category
//! taxonomy and merchant-classification rules only. Packs are ed25519-signed
//! and verified on install; unsigned or tampered packs are rejected.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Errors for pack parsing and verification.
#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("invalid pack manifest: {0}")]
    InvalidManifest(#[from] serde_json::Error),

    #[error("invalid public key")]
    InvalidPublicKey,

    #[error("invalid signature encoding")]
    InvalidSignature,

    #[error("signature verification failed")]
    VerificationFailed,
}

/// Rule match strategies, mirroring slipscan-core's merchant matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    MerchantExact,
    MerchantContains,
    MerchantRegex,
}

/// One category in the pack taxonomy. `key` is a stable slug (e.g.
/// `"groceries.dairy"`); installation maps keys to local category ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackCategory {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub parent_key: Option<String>,
    /// "income" | "expense" | "transfer" (kept as text; core validates).
    pub kind: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// One classification rule: match a merchant, suggest a category key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackRule {
    pub match_type: MatchType,
    pub pattern: String,
    pub category_key: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
}

fn default_confidence() -> f64 {
    0.8
}

/// The pack manifest — the exact bytes that get signed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackManifest {
    /// Stable pack id, e.g. `"za-groceries"`.
    pub id: String,
    pub name: String,
    /// Semver string.
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    /// RFC 3339.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub categories: Vec<PackCategory>,
    #[serde(default)]
    pub rules: Vec<PackRule>,
}

impl PackManifest {
    pub fn from_json(bytes: &[u8]) -> Result<Self, PackError> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// Verify a pack's detached ed25519 signature over the raw manifest bytes,
/// then parse the manifest. Returns the manifest only when the signature is
/// valid for `public_key_bytes` (32 bytes) and `signature_bytes` (64 bytes).
pub fn verify_pack(
    manifest_bytes: &[u8],
    signature_bytes: &[u8],
    public_key_bytes: &[u8],
) -> Result<PackManifest, PackError> {
    let key_arr: &[u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| PackError::InvalidPublicKey)?;
    let key = VerifyingKey::from_bytes(key_arr).map_err(|_| PackError::InvalidPublicKey)?;
    let signature =
        Signature::from_slice(signature_bytes).map_err(|_| PackError::InvalidSignature)?;
    key.verify(manifest_bytes, &signature)
        .map_err(|_| PackError::VerificationFailed)?;
    PackManifest::from_json(manifest_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sample_manifest() -> PackManifest {
        PackManifest {
            id: "za-groceries".into(),
            name: "South African groceries".into(),
            version: "1.0.0".into(),
            description: Some("Common SA grocery merchants".into()),
            author: Some("community".into()),
            created_at: Some("2026-07-01T00:00:00Z".into()),
            categories: vec![PackCategory {
                key: "groceries".into(),
                name: "Groceries".into(),
                parent_key: None,
                kind: "expense".into(),
                icon: None,
                color: None,
            }],
            rules: vec![PackRule {
                match_type: MatchType::MerchantContains,
                pattern: "pick n pay".into(),
                category_key: "groceries".into(),
                confidence: 0.95,
            }],
        }
    }

    #[test]
    fn signed_pack_verifies_and_parses() {
        let manifest = sample_manifest();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let signature = signing.sign(&bytes);

        let verified = verify_pack(
            &bytes,
            &signature.to_bytes(),
            signing.verifying_key().as_bytes(),
        )
        .unwrap();
        assert_eq!(verified, manifest);
    }

    #[test]
    fn tampered_pack_is_rejected() {
        let manifest = sample_manifest();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let signature = signing.sign(&bytes);

        let mut tampered = bytes.clone();
        let idx = tampered.len() - 2;
        tampered[idx] ^= 0x01;
        assert!(matches!(
            verify_pack(
                &tampered,
                &signature.to_bytes(),
                signing.verifying_key().as_bytes()
            ),
            Err(PackError::VerificationFailed)
        ));

        // Wrong key fails too.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert!(matches!(
            verify_pack(
                &bytes,
                &signature.to_bytes(),
                other.verifying_key().as_bytes()
            ),
            Err(PackError::VerificationFailed)
        ));

        // Malformed key / signature sizes are rejected early.
        assert!(matches!(
            verify_pack(&bytes, &signature.to_bytes(), &[1, 2, 3]),
            Err(PackError::InvalidPublicKey)
        ));
        assert!(matches!(
            verify_pack(&bytes, &[0u8; 10], signing.verifying_key().as_bytes()),
            Err(PackError::InvalidSignature)
        ));
    }
}
