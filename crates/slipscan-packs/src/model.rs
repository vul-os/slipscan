//! Pack payload model: metadata, category taxonomy, classification rules,
//! and VAT hints. The payload is the exact JSON document that gets signed.

use std::collections::HashSet;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use slipscan_core::domain::CategoryKind;

use crate::error::{PackError, PackResult};

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

/// Strict `MAJOR.MINOR.PATCH` semantic version (no pre-release / build tags —
/// packs are simple, versions stay simple).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl FromStr for Semver {
    type Err = PackError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bad = || PackError::InvalidVersion(s.to_string());
        let mut parts = s.split('.');
        let mut next = |parts: &mut std::str::Split<'_, char>| -> PackResult<u64> {
            let part = parts.next().ok_or_else(bad)?;
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            part.parse().map_err(|_| bad())
        };
        let version = Semver {
            major: next(&mut parts)?,
            minor: next(&mut parts)?,
            patch: next(&mut parts)?,
        };
        if parts.next().is_some() {
            return Err(bad());
        }
        Ok(version)
    }
}

impl std::fmt::Display for Semver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

// ---------------------------------------------------------------------------
// Payload structs
// ---------------------------------------------------------------------------

/// Pack metadata, embedded in the signed payload (and mirrored, for humans,
/// in the TOML manifest — the two must agree).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackMeta {
    /// Stable pack id, e.g. `"za-personal"`. Lowercase `[a-z0-9-]`.
    pub id: String,
    pub name: String,
    /// Strict semver string, e.g. `"1.0.0"`.
    pub version: String,
    /// ISO 3166-1 alpha-2 region the taxonomy targets, e.g. `"ZA"`.
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

impl PackMeta {
    pub fn semver(&self) -> PackResult<Semver> {
        self.version.parse()
    }
}

/// One category in the pack taxonomy. `key` is a stable slug (e.g.
/// `"groceries_food.supermarket"`); installation maps keys to local category
/// ids and remembers the mapping, so upgrades and user renames are safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackCategory {
    pub key: String,
    pub name: String,
    /// Parent category `key`. Parents must be declared before children.
    #[serde(default)]
    pub parent_key: Option<String>,
    /// `"income" | "expense" | "transfer"` — validated against core's enum.
    pub kind: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Merchant match strategies, mirroring the legacy classification cascade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// Normalized merchant equals the normalized pattern.
    Exact,
    /// Normalized merchant contains the normalized pattern.
    Contains,
    /// Regex over the normalized merchant string.
    Regex,
}

/// One merchant→category rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MerchantRule {
    #[serde(rename = "match")]
    pub match_kind: MatchKind,
    pub pattern: String,
    pub category_key: String,
    #[serde(default = "default_merchant_confidence")]
    pub confidence: f64,
}

fn default_merchant_confidence() -> f64 {
    0.8
}

/// One keyword rule: if any keyword appears in the normalized merchant or
/// description text, suggest the category. Weaker than merchant rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeywordRule {
    pub keywords: Vec<String>,
    pub category_key: String,
    #[serde(default = "default_keyword_confidence")]
    pub confidence: f64,
}

fn default_keyword_confidence() -> f64 {
    0.6
}

/// Advisory VAT information for a category. Hints are consumed by the
/// classification engine / UI; they are never written into core's `vat_rates`
/// table (that stays user-managed per book).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VatHint {
    pub category_key: String,
    /// Basis points: 1500 = 15.00%.
    pub rate_bps: i64,
    #[serde(default)]
    pub note: Option<String>,
}

/// The full pack payload — the exact bytes of its JSON serialization are what
/// gets ed25519-signed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackPayload {
    pub meta: PackMeta,
    #[serde(default)]
    pub categories: Vec<PackCategory>,
    #[serde(default)]
    pub merchant_rules: Vec<MerchantRule>,
    #[serde(default)]
    pub keyword_rules: Vec<KeywordRule>,
    #[serde(default)]
    pub vat_hints: Vec<VatHint>,
}

impl PackPayload {
    pub fn from_json(bytes: &[u8]) -> PackResult<Self> {
        let payload: PackPayload = serde_json::from_slice(bytes)?;
        payload.validate()?;
        Ok(payload)
    }

    /// Structural validation. Called on every parse and before every build,
    /// so downstream code (install, engine) can rely on the invariants:
    /// unique category keys, parents declared before children, valid kinds,
    /// rules referencing existing categories, compiling regexes, confidences
    /// in `[0, 1]`, sane VAT bps.
    pub fn validate(&self) -> PackResult<()> {
        let fail = |msg: String| Err(PackError::Validation(msg));

        if self.meta.id.is_empty()
            || !self
                .meta
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return fail(format!(
                "pack id {:?} must be non-empty lowercase [a-z0-9-]",
                self.meta.id
            ));
        }
        if self.meta.name.is_empty() {
            return fail("pack name must not be empty".into());
        }
        self.meta.semver()?;
        if let Some(region) = &self.meta.region {
            if region.len() != 2 || !region.bytes().all(|b| b.is_ascii_uppercase()) {
                return fail(format!("region {region:?} must be ISO 3166-1 alpha-2"));
            }
        }

        let mut keys: HashSet<&str> = HashSet::new();
        for category in &self.categories {
            if category.key.is_empty() || category.name.is_empty() {
                return fail(format!("category {:?} has empty key or name", category.key));
            }
            if let Some(parent) = &category.parent_key {
                if !keys.contains(parent.as_str()) {
                    return fail(format!(
                        "category {:?} references parent {parent:?} that is not declared before it",
                        category.key
                    ));
                }
            }
            CategoryKind::from_str(&category.kind).map_err(|_| {
                PackError::Validation(format!(
                    "category {:?} has invalid kind {:?}",
                    category.key, category.kind
                ))
            })?;
            if !keys.insert(&category.key) {
                return fail(format!("duplicate category key {:?}", category.key));
            }
        }

        let check_target = |what: &str, key: &str| -> PackResult<()> {
            if keys.contains(key) {
                Ok(())
            } else {
                Err(PackError::Validation(format!(
                    "{what} references unknown category key {key:?}"
                )))
            }
        };
        let check_confidence = |what: &str, confidence: f64| -> PackResult<()> {
            if (0.0..=1.0).contains(&confidence) {
                Ok(())
            } else {
                Err(PackError::Validation(format!(
                    "{what} has confidence {confidence} outside [0, 1]"
                )))
            }
        };

        for rule in &self.merchant_rules {
            if rule.pattern.is_empty() {
                return fail("merchant rule with empty pattern".into());
            }
            check_target("merchant rule", &rule.category_key)?;
            check_confidence(&format!("merchant rule {:?}", rule.pattern), rule.confidence)?;
            if rule.match_kind == MatchKind::Regex {
                regex::Regex::new(&rule.pattern).map_err(|e| PackError::InvalidRegex {
                    pattern: rule.pattern.clone(),
                    message: e.to_string(),
                })?;
            }
        }

        for rule in &self.keyword_rules {
            if rule.keywords.is_empty() || rule.keywords.iter().any(|k| k.is_empty()) {
                return fail("keyword rule with empty keyword list or empty keyword".into());
            }
            check_target("keyword rule", &rule.category_key)?;
            check_confidence("keyword rule", rule.confidence)?;
        }

        let mut hinted: HashSet<&str> = HashSet::new();
        for hint in &self.vat_hints {
            check_target("vat hint", &hint.category_key)?;
            if !(0..=10_000).contains(&hint.rate_bps) {
                return fail(format!(
                    "vat hint for {:?} has rate_bps {} outside [0, 10000]",
                    hint.category_key, hint.rate_bps
                ));
            }
            if !hinted.insert(&hint.category_key) {
                return fail(format!(
                    "duplicate vat hint for category {:?}",
                    hint.category_key
                ));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_payload() -> PackPayload {
        PackPayload {
            meta: PackMeta {
                id: "test-pack".into(),
                name: "Test pack".into(),
                version: "1.0.0".into(),
                region: Some("ZA".into()),
                author: Some("tests".into()),
                description: None,
            },
            categories: vec![
                PackCategory {
                    key: "groceries".into(),
                    name: "Groceries".into(),
                    parent_key: None,
                    kind: "expense".into(),
                    icon: None,
                    color: None,
                },
                PackCategory {
                    key: "groceries.supermarket".into(),
                    name: "Supermarket".into(),
                    parent_key: Some("groceries".into()),
                    kind: "expense".into(),
                    icon: None,
                    color: None,
                },
            ],
            merchant_rules: vec![MerchantRule {
                match_kind: MatchKind::Contains,
                pattern: "woolworths".into(),
                category_key: "groceries.supermarket".into(),
                confidence: 0.95,
            }],
            keyword_rules: vec![KeywordRule {
                keywords: vec!["grocer".into()],
                category_key: "groceries".into(),
                confidence: 0.6,
            }],
            vat_hints: vec![VatHint {
                category_key: "groceries".into(),
                rate_bps: 1500,
                note: Some("standard rate".into()),
            }],
        }
    }

    #[test]
    fn semver_parses_and_orders() {
        let v1: Semver = "1.2.3".parse().unwrap();
        assert_eq!((v1.major, v1.minor, v1.patch), (1, 2, 3));
        let v2: Semver = "1.10.0".parse().unwrap();
        assert!(v2 > v1);
        assert!("2.0.0".parse::<Semver>().unwrap() > v2);
        assert_eq!(v1.to_string(), "1.2.3");

        for bad in ["", "1", "1.2", "1.2.3.4", "1.2.x", "v1.2.3", "1.-2.3", "1.2. 3"] {
            assert!(bad.parse::<Semver>().is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn valid_payload_passes() {
        minimal_payload().validate().unwrap();
    }

    #[test]
    fn payload_round_trips_through_json() {
        let payload = minimal_payload();
        let bytes = serde_json::to_vec_pretty(&payload).unwrap();
        let parsed = PackPayload::from_json(&bytes).unwrap();
        assert_eq!(parsed, payload);
    }

    #[test]
    fn duplicate_category_key_is_rejected() {
        let mut payload = minimal_payload();
        let dup = payload.categories[0].clone();
        payload.categories.push(dup);
        assert!(matches!(payload.validate(), Err(PackError::Validation(_))));
    }

    #[test]
    fn parent_must_be_declared_before_child() {
        let mut payload = minimal_payload();
        payload.categories.swap(0, 1);
        assert!(matches!(payload.validate(), Err(PackError::Validation(_))));
    }

    #[test]
    fn invalid_kind_is_rejected() {
        let mut payload = minimal_payload();
        payload.categories[0].kind = "spending".into();
        assert!(matches!(payload.validate(), Err(PackError::Validation(_))));
    }

    #[test]
    fn rule_must_reference_known_category() {
        let mut payload = minimal_payload();
        payload.merchant_rules[0].category_key = "nope".into();
        assert!(matches!(payload.validate(), Err(PackError::Validation(_))));
    }

    #[test]
    fn bad_regex_is_rejected() {
        let mut payload = minimal_payload();
        payload.merchant_rules.push(MerchantRule {
            match_kind: MatchKind::Regex,
            pattern: "(unclosed".into(),
            category_key: "groceries".into(),
            confidence: 0.7,
        });
        assert!(matches!(
            payload.validate(),
            Err(PackError::InvalidRegex { .. })
        ));
    }

    #[test]
    fn confidence_and_vat_ranges_are_enforced() {
        let mut payload = minimal_payload();
        payload.merchant_rules[0].confidence = 1.5;
        assert!(payload.validate().is_err());

        let mut payload = minimal_payload();
        payload.vat_hints[0].rate_bps = 20_000;
        assert!(payload.validate().is_err());

        let mut payload = minimal_payload();
        payload.vat_hints.push(payload.vat_hints[0].clone());
        assert!(payload.validate().is_err(), "duplicate vat hint");
    }

    #[test]
    fn pack_id_format_is_enforced() {
        let mut payload = minimal_payload();
        payload.meta.id = "Bad_Id".into();
        assert!(payload.validate().is_err());
    }
}
