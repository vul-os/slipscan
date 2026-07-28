//! Local classification engine over installed pack rules.
//!
//! Consulted when core's own `merchant_mappings` (user corrections, learned
//! mappings) have nothing to say — the user's judgement always beats the
//! community's. Matching runs over the normalized merchant string
//! ([`slipscan_core::util::normalize_merchant`]) in a fixed cascade:
//!
//! 1. `exact` — normalized merchant equals the pattern;
//! 2. `contains` — normalized merchant contains the pattern;
//! 3. `regex` — pattern matches the normalized merchant;
//! 4. `keyword` — keyword appears in merchant + description text.
//!
//! Within a tier the highest confidence wins; ties break to the longer
//! (more specific) pattern, then to pack install order. Everything is local
//! and deterministic — no network, no model calls.

use regex::Regex;
use rusqlite::{params, Connection};

use slipscan_core::service::{CategorySuggestion, MerchantClassifier};
use slipscan_core::util::normalize_merchant;

use crate::error::{PackError, PackResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleKind {
    Exact,
    Contains,
    Regex,
    Keyword,
}

impl RuleKind {
    fn tier(self) -> u8 {
        match self {
            RuleKind::Exact => 0,
            RuleKind::Contains => 1,
            RuleKind::Regex => 2,
            RuleKind::Keyword => 3,
        }
    }

    fn parse(s: &str) -> PackResult<Self> {
        match s {
            "exact" => Ok(RuleKind::Exact),
            "contains" => Ok(RuleKind::Contains),
            "regex" => Ok(RuleKind::Regex),
            "keyword" => Ok(RuleKind::Keyword),
            other => Err(PackError::Validation(format!(
                "unknown pack rule kind {other:?}"
            ))),
        }
    }
}

#[derive(Debug)]
struct CompiledRule {
    pack_id: String,
    kind: RuleKind,
    pattern: String,
    regex: Option<Regex>,
    category_id: String,
    confidence: f64,
    position: i64,
}

/// A category suggestion from pack rules.
#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    pub category_id: String,
    pub confidence: f64,
    /// The pack whose rule matched.
    pub pack_id: String,
    /// The pattern that matched (for the "why this category?" UI).
    pub matched_pattern: String,
}

/// In-memory compiled rule set for one book. Cheap to rebuild after a pack
/// install/uninstall.
#[derive(Debug)]
pub struct Classifier {
    rules: Vec<CompiledRule>,
}

impl Classifier {
    /// Load and compile all installed pack rules for a book. A book that has
    /// never installed a pack yields an empty (always-`None`) classifier.
    ///
    /// Strictly read-only, including the "no packs here" case: this runs
    /// inside core's categorisation path, which must work against a
    /// connection the user has flagged read-only.
    pub fn load(conn: &Connection, book_id: &str) -> PackResult<Self> {
        if !rules_table_exists(conn)? {
            return Ok(Self { rules: Vec::new() });
        }
        let mut stmt = conn.prepare(
            "SELECT pack_id, rule_kind, pattern, category_id, confidence, position
             FROM pack_rules WHERE book_id = ?1 ORDER BY pack_id, position",
        )?;
        let rows = stmt.query_map(params![book_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;

        let mut rules = Vec::new();
        for row in rows {
            let (pack_id, kind_raw, pattern, category_id, confidence, position) = row?;
            let kind = RuleKind::parse(&kind_raw)?;
            let regex = match kind {
                RuleKind::Regex => {
                    Some(Regex::new(&pattern).map_err(|e| PackError::InvalidRegex {
                        pattern: pattern.clone(),
                        message: e.to_string(),
                    })?)
                }
                _ => None,
            };
            rules.push(CompiledRule {
                pack_id,
                kind,
                pattern,
                regex,
                category_id,
                confidence,
                position,
            });
        }
        Ok(Self { rules })
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// Suggest a category for a merchant string.
    pub fn suggest(&self, merchant_raw: &str) -> Option<Suggestion> {
        self.suggest_with_description(merchant_raw, None)
    }

    /// Suggest a category for a merchant plus free-text description
    /// (keyword rules also search the description).
    pub fn suggest_with_description(
        &self,
        merchant_raw: &str,
        description: Option<&str>,
    ) -> Option<Suggestion> {
        let merchant = normalize_merchant(merchant_raw);
        if merchant.is_empty() {
            return None;
        }
        let text = match description {
            Some(desc) => format!("{merchant} {}", normalize_merchant(desc)),
            None => merchant.clone(),
        };

        self.rules
            .iter()
            .filter(|rule| rule_matches(rule, &merchant, &text))
            .min_by(|a, b| {
                a.kind
                    .tier()
                    .cmp(&b.kind.tier())
                    .then(
                        b.confidence
                            .partial_cmp(&a.confidence)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
                    .then(b.pattern.len().cmp(&a.pattern.len()))
                    // Full determinism: pack id, then install order.
                    .then_with(|| a.pack_id.cmp(&b.pack_id))
                    .then(a.position.cmp(&b.position))
            })
            .map(|rule| Suggestion {
                category_id: rule.category_id.clone(),
                confidence: rule.confidence,
                pack_id: rule.pack_id.clone(),
                matched_pattern: rule.pattern.clone(),
            })
    }
}

fn rules_table_exists(conn: &Connection) -> PackResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'pack_rules'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// The classifier core consults during categorisation: the cascade above,
/// over the rules installed packs wrote into the same database.
///
/// This is the concrete half of core's [`MerchantClassifier`] seam. Core
/// reaches it only for merchants the book has no mapping for, so corrections
/// and user mappings keep winning; see [`register_classifier`].
#[derive(Debug, Clone, Copy, Default)]
pub struct PackClassifier;

static PACK_CLASSIFIER: PackClassifier = PackClassifier;

impl MerchantClassifier for PackClassifier {
    fn suggest(
        &self,
        conn: &Connection,
        book_id: &str,
        merchant_normalized: &str,
        description: Option<&str>,
    ) -> Option<CategorySuggestion> {
        // A rule set that will not load (corrupt row, uncompilable regex) is
        // "no opinion", never a failed import: the transaction still lands,
        // uncategorised, exactly as it would with no pack installed.
        let hit = Classifier::load(conn, book_id)
            .ok()?
            .suggest_with_description(merchant_normalized, description)?;
        Some(CategorySuggestion {
            category_id: hit.category_id,
            confidence: hit.confidence,
        })
    }
}

/// Register [`PackClassifier`] as this process's merchant classifier, so
/// installed pack rules are consulted when core categorises a transaction.
///
/// Call it once at startup, in every binary that imports transactions. It is
/// idempotent (the first registration in a process wins) and costs nothing
/// until a book actually has pack rules. Returns whether this call is the one
/// that registered.
pub fn register_classifier() -> bool {
    slipscan_core::service::register_merchant_classifier(&PACK_CLASSIFIER)
}

fn rule_matches(rule: &CompiledRule, merchant: &str, text: &str) -> bool {
    match rule.kind {
        RuleKind::Exact => merchant == rule.pattern,
        RuleKind::Contains => merchant.contains(&rule.pattern),
        RuleKind::Regex => rule
            .regex
            .as_ref()
            .is_some_and(|regex| regex.is_match(merchant)),
        RuleKind::Keyword => text.contains(&rule.pattern),
    }
}
