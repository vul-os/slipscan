//! Legacy single-file manifest API.
//!
//! The first cut of this crate exposed a flat JSON manifest plus a detached
//! signature (`verify_pack`). The server ops layer still consumes that
//! surface; it is kept here, delegating to the same primitives, until the
//! server migrates to [`crate::Pack`] / [`crate::VerifiedPack`] + the
//! installer. New code must not use this module.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::{PackError, PackResult};
pub use crate::model::PackCategory;

/// Rule match strategies of the legacy manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    MerchantExact,
    MerchantContains,
    MerchantRegex,
}

/// One classification rule of the legacy manifest.
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

/// The legacy flat manifest — the exact bytes that get signed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackManifest {
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
    pub fn from_json(bytes: &[u8]) -> PackResult<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// Verify a detached ed25519 signature over the raw manifest bytes, then
/// parse the manifest. Returns the manifest only when the signature is valid
/// for `public_key_bytes` (32 bytes) and `signature_bytes` (64 bytes).
pub fn verify_pack(
    manifest_bytes: &[u8],
    signature_bytes: &[u8],
    public_key_bytes: &[u8],
) -> PackResult<PackManifest> {
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
    fn signed_manifest_verifies_and_parses() {
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
    fn tampered_manifest_is_rejected() {
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

        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert!(matches!(
            verify_pack(
                &bytes,
                &signature.to_bytes(),
                other.verifying_key().as_bytes()
            ),
            Err(PackError::VerificationFailed)
        ));

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
