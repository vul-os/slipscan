//! Pack file format: a two-part pack (`pack.toml` manifest + JSON payload).
//!
//! # Format (documented contract)
//!
//! A pack on disk is a directory with exactly two files:
//!
//! ```text
//! my-pack/
//!   pack.toml       # human-readable manifest + detached signature
//!   payload.json    # the signed content — metadata, taxonomy, rules, hints
//! ```
//!
//! `payload.json` is the **exact byte sequence that is ed25519-signed** —
//! it is stored and verified verbatim, so there is no canonicalization step
//! to get wrong. It deserializes into [`PackPayload`].
//!
//! `pack.toml` looks like:
//!
//! ```toml
//! [pack]
//! id = "za-personal"
//! name = "South Africa — Personal"
//! version = "1.0.0"
//! region = "ZA"                       # optional
//! author = "SlipScan Community"       # optional
//! payload = "payload.json"            # file name, no path separators
//! payload_sha256 = "<hex sha-256 of payload bytes>"
//!
//! [signature]                          # optional, but required to install
//! algorithm = "ed25519"
//! public_key = "<hex, 32 bytes>"       # the author's public key
//! signature = "<hex, 64 bytes>"        # over the raw payload bytes
//! ```
//!
//! Integrity rules enforced on load:
//! * `payload_sha256` must match the payload bytes;
//! * `pack.id` and `pack.version` must equal `meta.id` / `meta.version`
//!   inside the payload (the signature covers the payload, so the manifest
//!   cannot lie about identity or version);
//! * the payload must pass [`PackPayload::validate`].

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{PackError, PackResult};
use crate::hex;
use crate::model::PackPayload;

/// Manifest file name inside a pack directory.
pub const MANIFEST_FILE: &str = "pack.toml";
/// Default payload file name.
pub const DEFAULT_PAYLOAD_FILE: &str = "payload.json";
/// The only supported signature algorithm.
pub const SIGNATURE_ALGORITHM: &str = "ed25519";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManifestDoc {
    pub pack: ManifestPack,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<ManifestSignature>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManifestPack {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub payload: String,
    pub payload_sha256: String,
}

/// Detached signature block from the manifest (all hex-encoded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSignature {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

/// A parsed, integrity-checked (but not yet signature-verified) pack.
///
/// Use [`Pack::verify`](crate::verify) (or the explicit dev override) to turn
/// it into a [`crate::VerifiedPack`] before installing.
#[derive(Debug, Clone, PartialEq)]
pub struct Pack {
    pub(crate) manifest: ManifestDoc,
    pub(crate) payload_bytes: Vec<u8>,
    pub(crate) payload: PackPayload,
}

impl Pack {
    /// Parse a pack from its manifest TOML text and raw payload bytes,
    /// enforcing all integrity rules described in the module docs.
    pub fn from_parts(manifest_toml: &str, payload_bytes: &[u8]) -> PackResult<Self> {
        let manifest: ManifestDoc = toml::from_str(manifest_toml)?;

        // Integrity before interpretation: check the hash first so tampering
        // is reported as tampering, never as a parse error.
        let actual = sha256_hex(payload_bytes);
        if !manifest.pack.payload_sha256.eq_ignore_ascii_case(&actual) {
            return Err(PackError::HashMismatch {
                expected: manifest.pack.payload_sha256.clone(),
                actual,
            });
        }
        let payload = PackPayload::from_json(payload_bytes)?;
        if manifest.pack.id != payload.meta.id {
            return Err(PackError::Mismatch(format!(
                "manifest id {:?} != payload id {:?}",
                manifest.pack.id, payload.meta.id
            )));
        }
        if manifest.pack.version != payload.meta.version {
            return Err(PackError::Mismatch(format!(
                "manifest version {:?} != payload version {:?}",
                manifest.pack.version, payload.meta.version
            )));
        }
        if let Some(signature) = &manifest.signature {
            if signature.algorithm != SIGNATURE_ALGORITHM {
                return Err(PackError::UnsupportedAlgorithm(signature.algorithm.clone()));
            }
        }
        Ok(Self {
            manifest,
            payload_bytes: payload_bytes.to_vec(),
            payload,
        })
    }

    /// Load a pack from a directory containing `pack.toml` and the payload
    /// file it names. The payload name must be a plain file name — path
    /// separators and `..` are rejected.
    pub fn load_dir(dir: impl AsRef<Path>) -> PackResult<Self> {
        let dir = dir.as_ref();
        let manifest_toml = std::fs::read_to_string(dir.join(MANIFEST_FILE))?;
        let manifest: ManifestDoc = toml::from_str(&manifest_toml)?;
        let payload_name = &manifest.pack.payload;
        if payload_name.is_empty()
            || payload_name == ".."
            || payload_name.contains('/')
            || payload_name.contains('\\')
        {
            return Err(PackError::UnsafePayloadPath(payload_name.clone()));
        }
        let payload_bytes = std::fs::read(dir.join(payload_name))?;
        Self::from_parts(&manifest_toml, &payload_bytes)
    }

    /// Write the pack out as a directory (creating it if needed).
    /// This is the export path; `load_dir` reads it back byte-identically.
    pub fn write_dir(&self, dir: impl AsRef<Path>) -> PackResult<()> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join(MANIFEST_FILE), self.manifest_toml()?)?;
        std::fs::write(dir.join(&self.manifest.pack.payload), &self.payload_bytes)?;
        Ok(())
    }

    /// Render the manifest as TOML text.
    pub fn manifest_toml(&self) -> PackResult<String> {
        Ok(toml::to_string_pretty(&self.manifest)?)
    }

    /// The parsed payload.
    pub fn payload(&self) -> &PackPayload {
        &self.payload
    }

    /// The exact signed payload bytes.
    pub fn payload_bytes(&self) -> &[u8] {
        &self.payload_bytes
    }

    /// The signature block, if the pack carries one.
    pub fn signature(&self) -> Option<&ManifestSignature> {
        self.manifest.signature.as_ref()
    }

    pub fn id(&self) -> &str {
        &self.payload.meta.id
    }

    pub fn version(&self) -> &str {
        &self.payload.meta.version
    }

    /// Build a pack from a payload (used by pack authors, the builtin packs,
    /// and tests). Serializes the payload to pretty JSON — those bytes become
    /// the signable artifact. Sign with [`crate::verify::sign_pack`].
    pub fn build(payload: &PackPayload) -> PackResult<Self> {
        payload.validate()?;
        let payload_bytes = serde_json::to_vec_pretty(payload)?;
        let manifest = ManifestDoc {
            pack: ManifestPack {
                id: payload.meta.id.clone(),
                name: payload.meta.name.clone(),
                version: payload.meta.version.clone(),
                region: payload.meta.region.clone(),
                author: payload.meta.author.clone(),
                payload: DEFAULT_PAYLOAD_FILE.to_string(),
                payload_sha256: sha256_hex(&payload_bytes),
            },
            signature: None,
        };
        Ok(Self {
            manifest,
            payload: payload.clone(),
            payload_bytes,
        })
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MatchKind, MerchantRule, PackCategory, PackMeta};

    pub(crate) fn sample_payload() -> PackPayload {
        PackPayload {
            meta: PackMeta {
                id: "za-test".into(),
                name: "ZA test pack".into(),
                version: "1.0.0".into(),
                region: Some("ZA".into()),
                author: Some("tests".into()),
                description: Some("test fixture".into()),
            },
            categories: vec![PackCategory {
                key: "groceries".into(),
                name: "Groceries".into(),
                parent_key: None,
                kind: "expense".into(),
                icon: Some("shopping-cart".into()),
                color: Some("#f97316".into()),
            }],
            merchant_rules: vec![MerchantRule {
                match_kind: MatchKind::Exact,
                pattern: "Woolworths".into(),
                category_key: "groceries".into(),
                confidence: 0.95,
            }],
            keyword_rules: vec![],
            vat_hints: vec![],
            benchmarks: None,
        }
    }

    #[test]
    fn build_and_reparse_round_trips() {
        let pack = Pack::build(&sample_payload()).unwrap();
        let manifest = pack.manifest_toml().unwrap();
        let reparsed = Pack::from_parts(&manifest, pack.payload_bytes()).unwrap();
        assert_eq!(reparsed, pack);
        assert_eq!(reparsed.id(), "za-test");
        assert_eq!(reparsed.version(), "1.0.0");
        assert!(reparsed.signature().is_none());
    }

    #[test]
    fn write_and_load_dir_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let pack = Pack::build(&sample_payload()).unwrap();
        pack.write_dir(dir.path().join("za-test")).unwrap();
        let loaded = Pack::load_dir(dir.path().join("za-test")).unwrap();
        assert_eq!(loaded, pack);
    }

    #[test]
    fn tampered_payload_fails_hash_check() {
        let pack = Pack::build(&sample_payload()).unwrap();
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
    fn manifest_identity_must_match_payload() {
        let pack = Pack::build(&sample_payload()).unwrap();
        let manifest = pack
            .manifest_toml()
            .unwrap()
            .replace("id = \"za-test\"", "id = \"za-evil\"");
        assert!(matches!(
            Pack::from_parts(&manifest, pack.payload_bytes()),
            Err(PackError::Mismatch(_))
        ));

        let manifest = pack
            .manifest_toml()
            .unwrap()
            .replace("version = \"1.0.0\"", "version = \"9.9.9\"");
        assert!(matches!(
            Pack::from_parts(&manifest, pack.payload_bytes()),
            Err(PackError::Mismatch(_))
        ));
    }

    #[test]
    fn unsafe_payload_file_names_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = dir.path().join("evil");
        let pack = Pack::build(&sample_payload()).unwrap();
        pack.write_dir(&pack_dir).unwrap();
        let manifest_path = pack_dir.join(MANIFEST_FILE);
        let manifest = std::fs::read_to_string(&manifest_path).unwrap().replace(
            "payload = \"payload.json\"",
            "payload = \"../payload.json\"",
        );
        std::fs::write(&manifest_path, manifest).unwrap();
        assert!(matches!(
            Pack::load_dir(&pack_dir),
            Err(PackError::UnsafePayloadPath(_))
        ));
    }

    #[test]
    fn unsupported_signature_algorithm_is_rejected() {
        let pack = Pack::build(&sample_payload()).unwrap();
        let manifest = format!(
            "{}\n[signature]\nalgorithm = \"rsa\"\npublic_key = \"00\"\nsignature = \"00\"\n",
            pack.manifest_toml().unwrap()
        );
        assert!(matches!(
            Pack::from_parts(&manifest, pack.payload_bytes()),
            Err(PackError::UnsupportedAlgorithm(_))
        ));
    }
}
