//! Legacy single-file manifest: the first pack file format.
//!
//! The first cut of this crate exposed a flat JSON manifest plus a detached
//! signature (`verify_pack`). Those files exist on people's disks, so the
//! format stays supported forever — but it is no longer a second pipeline:
//! [`PackManifest::into_payload`] converts a legacy manifest into the current
//! [`PackPayload`], and [`crate::verify_detached`] installs it through the
//! same verify → trust → install path as every other pack.
//!
//! New code writes [`PackPayload`]; this module is the on-ramp for old files
//! (and for `slipscan pack verify`, which still reports on a manifest without
//! installing it).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::{PackError, PackResult};
pub use crate::model::PackCategory;
use crate::model::{MatchKind, MerchantRule, PackMeta, PackPayload};

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

    /// Convert a legacy manifest into the current payload, so an old pack
    /// file installs through the one installer instead of a parallel path.
    ///
    /// Two accommodations keep old files installable rather than newly
    /// invalid, and both are deliberate:
    ///
    /// * the pack id is normalized to the payload charset (lowercase,
    ///   anything outside `[a-z0-9-]` becomes `-`) — the legacy format never
    ///   constrained it;
    /// * categories are re-ordered parents-first. The legacy installer
    ///   resolved parents in any order; payload validation requires the
    ///   declaration order, so the order is fixed here rather than the file
    ///   being rejected. Genuinely cyclic or dangling parents still fail,
    ///   with the same wording the old resolver used.
    ///
    /// Legacy manifests carry no region (they predate it), no keyword rules
    /// and no VAT hints, so those come out empty: a converted pack is global
    /// and rule-for-rule what the file said.
    pub fn into_payload(self) -> PackResult<PackPayload> {
        let merchant_rules = self
            .rules
            .into_iter()
            .map(|rule| MerchantRule {
                match_kind: match rule.match_type {
                    MatchType::MerchantExact => MatchKind::Exact,
                    MatchType::MerchantContains => MatchKind::Contains,
                    MatchType::MerchantRegex => MatchKind::Regex,
                },
                pattern: rule.pattern,
                category_key: rule.category_key,
                confidence: rule.confidence,
            })
            .collect();
        let payload = PackPayload {
            meta: PackMeta {
                id: normalize_pack_id(&self.id),
                name: self.name,
                version: self.version,
                region: None,
                author: self.author,
                description: self.description,
            },
            categories: parents_first(self.categories)?,
            merchant_rules,
            keyword_rules: Vec::new(),
            vat_hints: Vec::new(),
            benchmarks: None,
            // The legacy flat manifest predates both of these sections and
            // has nowhere to express them, so a converted pack is always a
            // taxonomy pack.
            mailrules: None,
        };
        payload.validate()?;
        Ok(payload)
    }

    /// Render an installed payload back as a legacy manifest — what the
    /// installed-packs index reports, so existing clients keep reading the
    /// shape they have always read. Keyword rules and VAT hints have no
    /// legacy representation and are omitted (`rules` covers merchant rules).
    pub fn from_payload(payload: &PackPayload, created_at: Option<String>) -> Self {
        Self {
            id: payload.meta.id.clone(),
            name: payload.meta.name.clone(),
            version: payload.meta.version.clone(),
            description: payload.meta.description.clone(),
            author: payload.meta.author.clone(),
            created_at,
            categories: payload.categories.clone(),
            rules: payload
                .merchant_rules
                .iter()
                .map(|rule| PackRule {
                    match_type: match rule.match_kind {
                        MatchKind::Exact => MatchType::MerchantExact,
                        MatchKind::Contains => MatchType::MerchantContains,
                        MatchKind::Regex => MatchType::MerchantRegex,
                    },
                    pattern: rule.pattern.clone(),
                    category_key: rule.category_key.clone(),
                    confidence: rule.confidence,
                })
                .collect(),
        }
    }
}

/// Lowercase a legacy pack id into the payload charset. Not a hash and not
/// reversible — two ids differing only in punctuation collapse together,
/// which is the same collision the legacy index already had on `id`.
fn normalize_pack_id(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Re-order categories so every parent is declared before its children.
fn parents_first(categories: Vec<PackCategory>) -> PackResult<Vec<PackCategory>> {
    let mut declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut ordered = Vec::with_capacity(categories.len());
    let mut pending = categories;
    while !pending.is_empty() {
        let before = pending.len();
        let mut next = Vec::new();
        for category in pending {
            match &category.parent_key {
                Some(parent) if !declared.contains(parent) => next.push(category),
                _ => {
                    declared.insert(category.key.clone());
                    ordered.push(category);
                }
            }
        }
        if next.len() == before {
            let keys: Vec<&str> = next.iter().map(|c| c.key.as_str()).collect();
            return Err(PackError::Validation(format!(
                "pack has unresolved or cyclic parent keys: {}",
                keys.join(", ")
            )));
        }
        pending = next;
    }
    Ok(ordered)
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
    fn legacy_manifest_converts_to_the_current_payload() {
        let mut manifest = sample_manifest();
        manifest.id = "ZA Groceries!".into();
        manifest.categories.push(PackCategory {
            key: "groceries.dairy".into(),
            name: "Dairy".into(),
            parent_key: Some("groceries".into()),
            kind: "expense".into(),
            icon: None,
            color: None,
        });
        // Children first: legal in the legacy format, so it must stay
        // installable.
        manifest.categories.reverse();
        manifest.rules.push(PackRule {
            match_type: MatchType::MerchantRegex,
            pattern: "^woolworths".into(),
            category_key: "groceries".into(),
            confidence: 0.7,
        });

        let payload = manifest.into_payload().unwrap();
        assert_eq!(payload.meta.id, "za-groceries-");
        assert_eq!(payload.meta.version, "1.0.0");
        // Global: the legacy format predates regions and must not claim one.
        assert_eq!(payload.meta.region, None);
        let keys: Vec<&str> = payload.categories.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["groceries", "groceries.dairy"]);
        assert_eq!(payload.merchant_rules[0].match_kind, MatchKind::Contains);
        assert_eq!(payload.merchant_rules[1].match_kind, MatchKind::Regex);
        assert!(payload.keyword_rules.is_empty());
        assert!(payload.vat_hints.is_empty());
    }

    #[test]
    fn cyclic_parents_survive_conversion_as_an_error() {
        let mut manifest = sample_manifest();
        manifest.categories[0].parent_key = Some("groceries".into());
        assert!(matches!(
            manifest.into_payload(),
            Err(PackError::Validation(_))
        ));
    }

    #[test]
    fn payload_renders_back_as_a_legacy_manifest() {
        let payload = sample_manifest().into_payload().unwrap();
        let rendered = PackManifest::from_payload(&payload, Some("2026-07-01T00:00:00Z".into()));
        assert_eq!(rendered.id, "za-groceries");
        assert_eq!(rendered.version, "1.0.0");
        assert_eq!(rendered.categories.len(), 1);
        assert_eq!(rendered.rules.len(), 1);
        assert_eq!(rendered.rules[0].match_type, MatchType::MerchantContains);
        assert_eq!(rendered.rules[0].pattern, "pick n pay");
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
