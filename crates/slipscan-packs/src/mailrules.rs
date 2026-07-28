//! `mailrules` packs: bank-alert emails → statement lines, as signed data.
//!
//! A bank emailing you that your card was used is the most common way money
//! visibly moves, and every bank writes that mail differently. Hardcoding
//! those formats would put bank- and country-specific literals in the product
//! and violate the regions-are-data contract (docs/ARCHITECTURE.md, "Global
//! by default"), so alert formats ship the same way taxonomies and benchmarks
//! do: as a **pack kind**, signed, versioned, TOFU-pinned, installed per book.
//!
//! A rule is two halves:
//!
//! * a **gate** — which messages it claims ([`MailRule::from_patterns`], plus
//!   optional subject/body regexes);
//! * a set of **field extractors** — amount, currency, date, merchant,
//!   reference, direction, account hint.
//!
//! This module owns the *format and its validation only*. Applying rules to a
//! message lives in `slipscan-ingest`'s email module, next to the money parser
//! and the statement-import path it feeds. Everything here is inert data:
//! nothing in a mailrules pack can name a category, an amount of yours, or a
//! person.
//!
//! # The conservatism contract
//!
//! A wrongly-parsed transaction is worse than an unparsed one — it corrupts
//! the books *and* feeds the learning loop that categorises future spend. So
//! the format is built to make declining easy and guessing hard:
//!
//! * every extractor names an explicit capture group — nothing is inferred
//!   from position;
//! * dates use **named** `y`/`m`/`d` groups, so `03/04` can never be read as
//!   April 3rd by a rule that meant March 4th;
//! * month names are pack data ([`DateSpec::Extract::months`]), not a
//!   hardcoded English (or any other) list;
//! * the decimal separator is declared ([`AmountStyle`]) rather than sniffed,
//!   because `1.234` is a different amount in different places;
//! * direction is either fixed or decided by two mutually exclusive patterns
//!   — matching both, or neither, is a decline rather than a coin flip.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{PackError, PackResult};

/// Upper bound on rules in one pack. Generous for a real bank pack (a bank
/// has a handful of alert formats), low enough that a malformed or hostile
/// pack cannot make matching arbitrarily expensive.
pub const MAX_MAIL_RULES: usize = 256;

/// Compiled-size ceiling for one pattern. The `regex` crate matches in linear
/// time and has no catastrophic-backtracking mode, so this bounds *memory*,
/// not runtime.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// Compile a pack-supplied pattern under the shared size limit.
///
/// Every regex in a mailrules pack goes through here — at validation time, so
/// an uncompilable or oversized pattern is rejected before the pack installs,
/// and again at match time, so the engine never has to trust that.
pub fn compile_pattern(pattern: &str) -> PackResult<regex::Regex> {
    regex::RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| PackError::InvalidRegex {
            pattern: pattern.to_string(),
            message: e.to_string(),
        })
}

/// Which text of a message an extractor reads.
///
/// `Body` is the message body as plain text (a text/plain part when present,
/// otherwise the HTML body with tags stripped) — never rendered HTML.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailPart {
    Subject,
    Body,
    /// Subject and body together, subject first, separated by a newline.
    #[default]
    Any,
}

/// How the amount's decimal separator is written.
///
/// Mirrors `slipscan_ingest::bank::DecimalStyle`, which is what actually does
/// the parsing; it is restated here so the pack format does not depend on the
/// ingest crate. `Point`/`Comma` are strict — more than two digits after the
/// declared separator is a parse error rather than a silent mis-scale — and
/// pack authors should declare one. `Auto` keeps the shared heuristic.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmountStyle {
    /// The last `.` or `,` followed by 1–2 digits is the decimal separator.
    #[default]
    Auto,
    /// `.` is the decimal separator, `,` groups thousands: `1,234.56`.
    Point,
    /// `,` is the decimal separator, `.` groups thousands: `1.234,56`.
    Comma,
}

/// One regex extractor: where to look, what to match, which group to take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extractor {
    #[serde(default)]
    pub part: MailPart,
    /// Regex over the chosen part. Use inline flags for options — `(?i)` for
    /// case-insensitive, `(?s)` to let `.` cross newlines.
    pub pattern: String,
    /// Capture group to take. 1-based; group 0 (the whole match) is
    /// deliberately not allowed — naming the group is what keeps a rule from
    /// silently capturing surrounding prose.
    #[serde(default = "default_group")]
    pub group: usize,
}

fn default_group() -> usize {
    1
}

impl Extractor {
    fn validate(&self, what: &str) -> PackResult<()> {
        if self.pattern.is_empty() {
            return Err(PackError::Validation(format!(
                "{what} has an empty pattern"
            )));
        }
        let regex = compile_pattern(&self.pattern)?;
        if self.group == 0 {
            return Err(PackError::Validation(format!(
                "{what} uses capture group 0; name an explicit group (1-based)"
            )));
        }
        if self.group >= regex.captures_len() {
            return Err(PackError::Validation(format!(
                "{what} wants capture group {} but pattern {:?} has {}",
                self.group,
                self.pattern,
                regex.captures_len().saturating_sub(1)
            )));
        }
        Ok(())
    }
}

/// The amount extractor plus its decimal convention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AmountSpec {
    #[serde(default)]
    pub part: MailPart,
    pub pattern: String,
    #[serde(default = "default_group")]
    pub group: usize,
    /// Declare this. See [`AmountStyle`].
    #[serde(default)]
    pub style: AmountStyle,
}

impl AmountSpec {
    /// The extractor half, for the shared matching code.
    pub fn extractor(&self) -> Extractor {
        Extractor {
            part: self.part,
            pattern: self.pattern.clone(),
            group: self.group,
        }
    }
}

/// Where the currency comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CurrencySpec {
    /// The rule's messages always quote one currency.
    Fixed { code: String },
    /// Pull it out of the message: an ISO-4217 code directly, or a symbol
    /// resolved through `map` (`{"R": "ZAR", "€": "EUR"}`). Symbols are
    /// pack data precisely because they are not universal — `$` is not one
    /// currency.
    Extract {
        #[serde(default)]
        part: MailPart,
        pattern: String,
        #[serde(default = "default_group")]
        group: usize,
        #[serde(default)]
        map: BTreeMap<String, String>,
    },
}

/// Where the posted date comes from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DateSpec {
    /// Use the message's own `Date` header. The safe default: an alert is
    /// sent when the transaction happens, and a header cannot be misread.
    #[default]
    Received,
    /// Pull the date out of the text. The pattern **must** use named capture
    /// groups `y`, `m` and `d`, so day/month order is stated by the pack
    /// author and never inferred.
    Extract {
        #[serde(default)]
        part: MailPart,
        pattern: String,
        /// Month names, January first, lowercase — needed only when `m`
        /// captures a name rather than digits. Matching is by prefix, so
        /// `["january", ...]` also matches `Jan`. Absent, a non-numeric
        /// month is a decline.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        months: Option<Vec<String>>,
    },
}

/// Money in or money out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Money out — imported as a negative amount.
    Debit,
    /// Money in — imported as a positive amount.
    Credit,
}

/// How to tell a debit from a credit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DirectionSpec {
    /// This alert format only ever reports one direction (the common case:
    /// a "card purchase" alert is always money out).
    Fixed { direction: Direction },
    /// One format reports both. The two patterns must be mutually exclusive
    /// on any real message: matching both — or neither — is a decline, never
    /// a guess.
    Match {
        #[serde(default)]
        part: MailPart,
        debit_pattern: String,
        credit_pattern: String,
    },
}

/// The bank's own reference for the transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceSpec {
    #[serde(default)]
    pub part: MailPart,
    pub pattern: String,
    #[serde(default = "default_group")]
    pub group: usize,
    /// Set only when this reference identifies **one** transaction at the
    /// bank. Then it becomes the transaction's `provider_txn_id` and dedupe
    /// is exact. Left false (the default), the reference is reported but
    /// never used as a dedupe key — a merchant-side reference that repeats
    /// would otherwise silently swallow real transactions.
    #[serde(default)]
    pub unique: bool,
}

impl ReferenceSpec {
    pub fn extractor(&self) -> Extractor {
        Extractor {
            part: self.part,
            pattern: self.pattern.clone(),
            group: self.group,
        }
    }
}

/// Default window, in days, between the message's own date and a date the
/// rule extracted from its text. A card alert is sent when the card is used;
/// a date far from the send time means the pattern found something else (a
/// card expiry, a statement period, a reference number). Generous enough for
/// weekend batching and timezone skew.
pub const DEFAULT_MAX_DATE_DRIFT_DAYS: i64 = 30;

fn default_max_date_drift_days() -> i64 {
    DEFAULT_MAX_DATE_DRIFT_DAYS
}

/// One bank-alert format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailRule {
    /// Stable id within the pack, e.g. `"card-purchase"`. Appears in decline
    /// reports, so make it descriptive.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Sender addresses or domains this rule claims, e.g.
    /// `["alerts@bank.example", "bank.example"]`. Domain entries match
    /// subdomains. A rule with no sender is not a rule — every message would
    /// be a candidate — so this must be non-empty.
    pub from_patterns: Vec<String>,
    /// Optional extra gates; **all** listed patterns must match for the rule
    /// to claim the message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subject_patterns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub body_patterns: Vec<String>,

    pub amount: AmountSpec,
    pub currency: CurrencySpec,
    #[serde(default)]
    pub date: DateSpec,
    /// The merchant or narrative. Becomes the transaction's description, from
    /// which core derives the categorisation key exactly as it does for a
    /// bank statement line.
    pub merchant: Extractor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<ReferenceSpec>,
    pub direction: DirectionSpec,
    /// Which account the alert is about, e.g. a masked card tail. Checked
    /// against the target account's masked number when both are known; a
    /// clear mismatch declines rather than booking to the wrong card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_hint: Option<Extractor>,
    /// See [`DEFAULT_MAX_DATE_DRIFT_DAYS`]. Ignored when the date comes from
    /// the message header. `0` disables the check.
    #[serde(default = "default_max_date_drift_days")]
    pub max_date_drift_days: i64,
}

/// A mailrules pack's payload section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailRuleSet {
    pub rules: Vec<MailRule>,
}

pub(crate) fn validate_mailrules(set: &MailRuleSet) -> PackResult<()> {
    let fail = |msg: String| Err(PackError::Validation(msg));

    if set.rules.is_empty() {
        return fail("mailrules pack declares no rules".into());
    }
    if set.rules.len() > MAX_MAIL_RULES {
        return fail(format!(
            "mailrules pack declares {} rules, more than the {MAX_MAIL_RULES} allowed",
            set.rules.len()
        ));
    }

    let mut ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for rule in &set.rules {
        if rule.id.is_empty()
            || !rule
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
        {
            return fail(format!(
                "mail rule id {:?} must be non-empty lowercase [a-z0-9-_]",
                rule.id
            ));
        }
        if !ids.insert(&rule.id) {
            return fail(format!("duplicate mail rule id {:?}", rule.id));
        }
        let what = |field: &str| format!("mail rule {:?} {field}", rule.id);

        if rule.from_patterns.is_empty() {
            return fail(format!(
                "mail rule {:?} has no from_patterns; a rule that claims every \
                 sender is not a rule",
                rule.id
            ));
        }
        for from in &rule.from_patterns {
            if from.trim().is_empty() {
                return fail(format!("mail rule {:?} has an empty from pattern", rule.id));
            }
        }
        for pattern in rule.subject_patterns.iter().chain(&rule.body_patterns) {
            if pattern.is_empty() {
                return fail(format!("mail rule {:?} has an empty gate pattern", rule.id));
            }
            compile_pattern(pattern)?;
        }

        rule.amount.extractor().validate(&what("amount"))?;
        rule.merchant.validate(&what("merchant"))?;
        if let Some(reference) = &rule.reference {
            reference.extractor().validate(&what("reference"))?;
        }
        if let Some(hint) = &rule.account_hint {
            hint.validate(&what("account_hint"))?;
        }

        match &rule.currency {
            CurrencySpec::Fixed { code } => validate_currency(code, &what("currency"))?,
            CurrencySpec::Extract {
                part,
                pattern,
                group,
                map,
            } => {
                Extractor {
                    part: *part,
                    pattern: pattern.clone(),
                    group: *group,
                }
                .validate(&what("currency"))?;
                for (symbol, code) in map {
                    if symbol.is_empty() {
                        return fail(format!("{} maps an empty symbol", what("currency")));
                    }
                    validate_currency(code, &what("currency map"))?;
                }
            }
        }

        match &rule.date {
            DateSpec::Received => {}
            DateSpec::Extract {
                pattern, months, ..
            } => {
                if pattern.is_empty() {
                    return fail(format!("{} has an empty pattern", what("date")));
                }
                let regex = compile_pattern(pattern)?;
                let names: Vec<&str> = regex.capture_names().flatten().collect();
                for required in ["y", "m", "d"] {
                    if !names.contains(&required) {
                        return fail(format!(
                            "{} must use named capture groups (?P<y>…), (?P<m>…) and \
                             (?P<d>…) so day/month order is explicit; {:?} is missing {:?}",
                            what("date"),
                            pattern,
                            required
                        ));
                    }
                }
                if let Some(months) = months {
                    if months.len() != 12 {
                        return fail(format!(
                            "{} lists {} month names; exactly 12 are required, \
                             January first",
                            what("date"),
                            months.len()
                        ));
                    }
                    let mut seen: std::collections::HashSet<String> =
                        std::collections::HashSet::new();
                    for month in months {
                        let normalized = month.trim().to_lowercase();
                        if normalized.is_empty() {
                            return fail(format!("{} has an empty month name", what("date")));
                        }
                        if !seen.insert(normalized) {
                            return fail(format!("{} repeats month name {month:?}", what("date")));
                        }
                    }
                }
            }
        }

        match &rule.direction {
            DirectionSpec::Fixed { .. } => {}
            DirectionSpec::Match {
                debit_pattern,
                credit_pattern,
                ..
            } => {
                if debit_pattern.is_empty() || credit_pattern.is_empty() {
                    return fail(format!("{} has an empty pattern", what("direction")));
                }
                if debit_pattern == credit_pattern {
                    return fail(format!(
                        "{} uses the same pattern for debit and credit, so every \
                         message would match both and decline",
                        what("direction")
                    ));
                }
                compile_pattern(debit_pattern)?;
                compile_pattern(credit_pattern)?;
            }
        }

        if rule.max_date_drift_days < 0 {
            return fail(format!(
                "mail rule {:?} has a negative max_date_drift_days",
                rule.id
            ));
        }
    }
    Ok(())
}

fn validate_currency(code: &str, what: &str) -> PackResult<()> {
    if code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(PackError::Validation(format!(
            "{what} code {code:?} must be an ISO 4217 code"
        )))
    }
}

/// A deliberately generic fixture rule — no real bank, no jurisdiction, and
/// compiled only for tests. Shipping bank patterns is exactly what this pack
/// kind exists to avoid: real formats are data the community publishes.
#[cfg(test)]
pub(crate) fn sample_rule() -> MailRule {
    MailRule {
        id: "card-purchase".into(),
        description: Some("Fixture card alert".into()),
        from_patterns: vec!["alerts.bank.example".into()],
        subject_patterns: vec![r"(?i)card\s+purchase".into()],
        body_patterns: vec![],
        amount: AmountSpec {
            part: MailPart::Body,
            pattern: r"(?i)amount\s+of\s+[A-Z]{0,3}\s*([0-9][0-9., ]*)".into(),
            group: 1,
            style: AmountStyle::Point,
        },
        currency: CurrencySpec::Fixed { code: "USD".into() },
        date: DateSpec::Received,
        merchant: Extractor {
            part: MailPart::Body,
            pattern: r"(?i)\bat\s+(.+?)\s+on\b".into(),
            group: 1,
        },
        reference: None,
        direction: DirectionSpec::Fixed {
            direction: Direction::Debit,
        },
        account_hint: None,
        max_date_drift_days: DEFAULT_MAX_DATE_DRIFT_DAYS,
    }
}

#[cfg(test)]
pub(crate) fn sample_set() -> MailRuleSet {
    MailRuleSet {
        rules: vec![sample_rule()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_set_validates_and_round_trips() {
        let set = sample_set();
        validate_mailrules(&set).unwrap();
        let json = serde_json::to_vec_pretty(&set).unwrap();
        let back: MailRuleSet = serde_json::from_slice(&json).unwrap();
        assert_eq!(back, set);
    }

    #[test]
    fn empty_rule_set_is_rejected() {
        assert!(validate_mailrules(&MailRuleSet { rules: vec![] }).is_err());
    }

    #[test]
    fn rule_must_claim_a_sender() {
        let mut set = sample_set();
        set.rules[0].from_patterns.clear();
        assert!(validate_mailrules(&set).is_err());
    }

    #[test]
    fn duplicate_rule_ids_are_rejected() {
        let mut set = sample_set();
        let dup = set.rules[0].clone();
        set.rules.push(dup);
        assert!(validate_mailrules(&set).is_err());
    }

    #[test]
    fn extractors_must_name_a_real_capture_group() {
        // Group 0 is refused outright.
        let mut set = sample_set();
        set.rules[0].merchant.group = 0;
        assert!(validate_mailrules(&set).is_err(), "group 0");

        // So is a group the pattern does not have.
        let mut set = sample_set();
        set.rules[0].merchant.group = 4;
        assert!(validate_mailrules(&set).is_err(), "group out of range");
    }

    #[test]
    fn uncompilable_patterns_are_rejected() {
        let mut set = sample_set();
        set.rules[0].merchant.pattern = "(unclosed".into();
        assert!(matches!(
            validate_mailrules(&set),
            Err(PackError::InvalidRegex { .. })
        ));
    }

    #[test]
    fn extracted_dates_must_name_y_m_and_d() {
        let mut set = sample_set();
        // Positional groups are exactly the ambiguity this format refuses.
        set.rules[0].date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(\d{2})/(\d{2})/(\d{4})".into(),
            months: None,
        };
        assert!(validate_mailrules(&set).is_err(), "positional groups");

        set.rules[0].date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{2})/(?P<m>\d{2})/(?P<y>\d{4})".into(),
            months: None,
        };
        validate_mailrules(&set).unwrap();
    }

    #[test]
    fn month_names_are_pack_data_and_must_be_complete() {
        let mut set = sample_set();
        set.rules[0].date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{1,2})\s+(?P<m>\w+)\s+(?P<y>\d{4})".into(),
            months: Some(vec!["janvier".into(), "février".into()]),
        };
        assert!(validate_mailrules(&set).is_err(), "only two months");

        // Any language, as long as all twelve are there.
        set.rules[0].date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{1,2})\s+(?P<m>\w+)\s+(?P<y>\d{4})".into(),
            months: Some(
                [
                    "janvier",
                    "février",
                    "mars",
                    "avril",
                    "mai",
                    "juin",
                    "juillet",
                    "août",
                    "septembre",
                    "octobre",
                    "novembre",
                    "décembre",
                ]
                .iter()
                .map(|m| m.to_string())
                .collect(),
            ),
        };
        validate_mailrules(&set).unwrap();
    }

    #[test]
    fn currency_codes_must_be_iso_4217() {
        for bad in ["zar", "ZAR1", "Z", ""] {
            let mut set = sample_set();
            set.rules[0].currency = CurrencySpec::Fixed { code: bad.into() };
            assert!(validate_mailrules(&set).is_err(), "should reject {bad:?}");
        }
        // Nothing here is jurisdiction-specific: any ISO code is fine.
        for good in ["ZAR", "EUR", "JPY", "NGN", "BRL"] {
            let mut set = sample_set();
            set.rules[0].currency = CurrencySpec::Fixed { code: good.into() };
            validate_mailrules(&set).unwrap_or_else(|e| panic!("{good}: {e}"));
        }
    }

    #[test]
    fn currency_symbol_map_values_are_checked() {
        let mut set = sample_set();
        set.rules[0].currency = CurrencySpec::Extract {
            part: MailPart::Body,
            pattern: r"([R$€])\s*[0-9]".into(),
            group: 1,
            map: BTreeMap::from([("R".to_string(), "nope".to_string())]),
        };
        assert!(validate_mailrules(&set).is_err());
    }

    #[test]
    fn direction_patterns_must_differ() {
        let mut set = sample_set();
        set.rules[0].direction = DirectionSpec::Match {
            part: MailPart::Any,
            debit_pattern: "(?i)paid".into(),
            credit_pattern: "(?i)paid".into(),
        };
        assert!(validate_mailrules(&set).is_err());
    }

    #[test]
    fn rule_count_is_bounded() {
        let set = MailRuleSet {
            rules: (0..MAX_MAIL_RULES + 1)
                .map(|i| {
                    let mut rule = sample_rule();
                    rule.id = format!("rule-{i}");
                    rule
                })
                .collect(),
        };
        assert!(validate_mailrules(&set).is_err());
    }
}
