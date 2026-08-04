//! Small shared helpers: ids, clock, merchant normalization, dedupe hashing.

use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// New UUID v7 string (time-sortable, no coordination).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current UTC time as an RFC 3339 / ISO-8601 string, the DB storage format.
pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC 3339 formatting of the current time cannot fail")
}

/// Normalize a merchant string for matching: lowercase, collapse whitespace,
/// strip punctuation noise.
pub fn normalize_merchant(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_space = true;
    for ch in raw.chars() {
        if ch.is_alphanumeric() {
            // Unicode-aware lowercasing: "CAFÉ" and "café" must normalize
            // identically or merchant→category mappings and recon merchant
            // scores silently miss for any non-ASCII merchant name.
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim_end().to_string()
}

/// Words that name a *banking operation*, never a merchant. A statement line
/// made of nothing but these (plus reference numbers) names nobody, so
/// [`merchant_key_from_description`] declines rather than invent a merchant
/// called "monthly account fee".
///
/// One non-generic word anywhere in the line is enough to keep it, so this
/// list can never suppress a real merchant — it only decides the all-generic
/// case.
const GENERIC_STATEMENT_WORDS: &[&str] = &[
    "account",
    "admin",
    "atm",
    "auto",
    "balance",
    "bank",
    "banking",
    "branch",
    "brought",
    "card",
    "cash",
    "charge",
    "charges",
    "cheque",
    "credit",
    "date",
    "debit",
    "deposit",
    "eft",
    "fee",
    "fees",
    "forward",
    "from",
    "immediate",
    "instant",
    "interest",
    "internet",
    "monthly",
    "notification",
    "online",
    "order",
    "orders",
    "payment",
    "payments",
    "pmt",
    "pos",
    "purchase",
    "ref",
    "reference",
    "reversal",
    "savings",
    "service",
    "sms",
    "statement",
    "tfr",
    "transaction",
    "transfer",
    "trf",
    "unpaid",
    "value",
    "withdrawal",
];

/// Lowercase three-letter month abbreviations, for spotting `12jul`-style
/// date tokens glued into a statement narrative.
const MONTH_ABBREVIATIONS: &[&str] = &[
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Longest statement narrative we will treat as a merchant name. Beyond this
/// the line is prose ("payment received thank you for your continued
/// support"), not a name, and guessing at it is worse than declining.
const MAX_DERIVED_MERCHANT_TOKENS: usize = 8;

/// Derive a merchant **matching key** from a bank statement narrative, or
/// `None` when the line does not name a merchant with enough confidence.
///
/// Statement lines carry a description and no merchant field, so without this
/// they miss categorisation entirely. The output is already in
/// [`normalize_merchant`] form — the same key space as merchants derived from
/// slips — because a second normalisation would silently split the two paths'
/// mappings.
///
/// Deliberately conservative: a key that is subtly wrong is worse than none,
/// because it both categorises wrongly and writes a durable
/// `merchant_mappings` row. The rule is:
///
/// * normalize the narrative (lowercase, alphanumerics, single spaces);
/// * drop **volatile** tokens — anything with three or more digits (card
///   fragments, references, account numbers) and `12jul`-style date tokens —
///   so the same recurring line yields the same key every month;
/// * keep every other token, in order. We never guess which word is "the
///   brand": `pnp family kenilworth` stays whole, and pack rules
///   (`contains`, `regex`) already match inside it;
/// * **decline** (`None`) unless what survives contains at least one
///   name-like token (three or more letters) that is not in
///   [`GENERIC_STATEMENT_WORDS`], and is at most
///   [`MAX_DERIVED_MERCHANT_TOKENS`] tokens long.
///
/// So `PNP FAMILY KENILWORTH`, `UBER *TRIP HELP.UBER.C`,
/// `CARD PURCHASE 4029*1234 WOOLWORTHS GARDENS` and
/// `DEBIT ORDER NETFLIX.COM 12JUL` all yield keys, while
/// `MONTHLY ACCOUNT FEE`, `ATM CASH WITHDRAWAL`, `IB PAYMENT FROM 62834729183`
/// and a sentence of prose all decline.
pub fn merchant_key_from_description(description: &str) -> Option<String> {
    let normalized = normalize_merchant(description);
    if normalized.is_empty() {
        return None;
    }
    let kept: Vec<&str> = normalized
        .split(' ')
        .filter(|token| !token.is_empty() && !is_volatile_token(token))
        .collect();
    if kept.is_empty() || kept.len() > MAX_DERIVED_MERCHANT_TOKENS {
        return None;
    }
    let names_someone = kept
        .iter()
        .any(|token| is_name_like(token) && !GENERIC_STATEMENT_WORDS.contains(token));
    if !names_someone {
        return None;
    }
    Some(kept.join(" "))
}

/// A token that changes between two otherwise identical statement lines:
/// three-or-more-digit runs (references, card fragments, account numbers) and
/// dates glued to a month abbreviation. Short digit groups stay, because they
/// are part of real names (`7 eleven`, `checkers sixty60`).
fn is_volatile_token(token: &str) -> bool {
    let digits = token.chars().filter(char::is_ascii_digit).count();
    if digits >= 3 {
        return true;
    }
    if digits == 0 {
        return false;
    }
    let letters: String = token.chars().filter(char::is_ascii_alphabetic).collect();
    MONTH_ABBREVIATIONS.contains(&letters.as_str())
}

/// Three or more letters: enough to be a name rather than an initialism,
/// a branch code, or a stray digit group.
fn is_name_like(token: &str) -> bool {
    token.chars().filter(|c| c.is_alphabetic()).count() >= 3
}

/// Parse a `YYYY-MM-DD` date string.
pub fn parse_date(s: &str) -> crate::error::CoreResult<time::Date> {
    let fmt = time::macros::format_description!("[year]-[month]-[day]");
    time::Date::parse(s, &fmt)
        .map_err(|e| crate::error::CoreError::Validation(format!("invalid date {s:?}: {e}")))
}

/// Absolute number of whole days between two `YYYY-MM-DD` dates.
pub fn days_between(a: &str, b: &str) -> crate::error::CoreResult<i64> {
    Ok((parse_date(a)? - parse_date(b)?).whole_days().abs())
}

/// Validate an inclusive `[from_date, to_date]` report period: both must be
/// well-formed `YYYY-MM-DD` dates, and `from_date` must not be after
/// `to_date`.
///
/// Every period report (`report_income_statement`, `report_tax_summary`,
/// `report_spending_by_month`) calls this before touching the database, so
/// an inverted range is a refusal rather than a query that silently matches
/// zero rows — a caller that got `--from`/`--to` backwards gets told, instead
/// of reading "no activity this period" and believing it.
///
/// Not applied to every date-ranged query in this crate: `report_spending`
/// and the per-member reports predate this helper and (in `report_spending`'s
/// case) are also called with a synthetic `{month}-31` upper bound by
/// `slipscan_server::ops::pack_benchmark`, which is not a real calendar date
/// in every month — adding strict parsing there would break that caller, not
/// this one.
pub fn parse_date_range(from_date: &str, to_date: &str) -> crate::error::CoreResult<()> {
    let from = parse_date(from_date)?;
    let to = parse_date(to_date)?;
    if from > to {
        return Err(crate::error::CoreError::Validation(format!(
            "invalid range: from_date {from_date:?} is after to_date {to_date:?}"
        )));
    }
    Ok(())
}

/// Today's date, `YYYY-MM-DD`, UTC — the same day boundary `posted_date`
/// itself uses everywhere in the schema. Used where a caller wants "as of
/// now" without pinning an exact instant, e.g. the default `as_of_date` for
/// `CoreService::networth_capture`.
pub fn today() -> String {
    let fmt = time::macros::format_description!("[year]-[month]-[day]");
    OffsetDateTime::now_utc()
        .date()
        .format(&fmt)
        .expect("YYYY-MM-DD formatting of the current date cannot fail")
}

/// Validate and normalize an ISO-4217 currency code: exactly 3 ASCII
/// letters, uppercased. Mis-cased codes ("zar" vs "ZAR") would otherwise
/// split per-currency sums and balance checks into distinct buckets.
pub fn normalize_currency_code(raw: &str) -> crate::error::CoreResult<String> {
    let trimmed = raw.trim();
    if trimmed.len() == 3 && trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
        Ok(trimmed.to_ascii_uppercase())
    } else {
        Err(crate::error::CoreError::Validation(format!(
            "invalid currency code {raw:?} (expected 3 letters, e.g. \"ZAR\")"
        )))
    }
}

/// Similarity of two merchant names in 0..=1: Dice coefficient over character
/// bigrams of the normalized names. Empty/unknown names score 0.
pub fn merchant_similarity(a: &str, b: &str) -> f64 {
    let a = normalize_merchant(a);
    let b = normalize_merchant(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let bigrams = |s: &str| -> Vec<(char, char)> { s.chars().zip(s.chars().skip(1)).collect() };
    let left = bigrams(&a);
    let right = bigrams(&b);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut counts: std::collections::HashMap<(char, char), usize> =
        std::collections::HashMap::new();
    for g in &left {
        *counts.entry(*g).or_insert(0) += 1;
    }
    let mut shared = 0usize;
    for g in &right {
        if let Some(c) = counts.get_mut(g) {
            if *c > 0 {
                *c -= 1;
                shared += 1;
            }
        }
    }
    2.0 * shared as f64 / (left.len() + right.len()) as f64
}

/// Deterministic dedupe hash for a transaction. When the provider gives us a
/// stable transaction id we hash that; otherwise we fall back to the tuple of
/// observable fields plus `occurrence`, a per-batch counter importers assign
/// to legitimate identical lines (two identical coffees in one statement)
/// so they don't collapse into one. `occurrence == 0` keeps the historical
/// hash for the common single-occurrence case.
#[allow(clippy::too_many_arguments)]
pub fn transaction_dedupe_hash(
    account_id: &str,
    posted_date: &str,
    amount_minor: i64,
    currency: &str,
    provider_txn_id: Option<&str>,
    merchant_normalized: Option<&str>,
    description: Option<&str>,
    occurrence: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hasher.update([0x1f]);
    match provider_txn_id {
        Some(pid) => {
            hasher.update(b"pid");
            hasher.update([0x1f]);
            hasher.update(pid.as_bytes());
        }
        None => {
            hasher.update(posted_date.as_bytes());
            hasher.update([0x1f]);
            hasher.update(amount_minor.to_le_bytes());
            hasher.update([0x1f]);
            hasher.update(currency.as_bytes());
            hasher.update([0x1f]);
            hasher.update(merchant_normalized.unwrap_or("").as_bytes());
            hasher.update([0x1f]);
            hasher.update(description.unwrap_or("").as_bytes());
            if occurrence > 0 {
                hasher.update([0x1f]);
                hasher.update(b"occ");
                hasher.update(occurrence.to_le_bytes());
            }
        }
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Deserializer for a *nullable, optional* patch field — `Option<Option<T>>`,
/// where the outer layer means "was this field present at all?" and the inner
/// means "was it set to null?".
///
/// **Plain `#[serde(default)]` cannot express that, and silently gets it
/// wrong.** `Option<T>`'s own `Deserialize` maps JSON `null` to `None` without
/// descending, so `{"notes": null}` and `{}` both produce `None` — identical,
/// and both read as "leave the field alone". The result was that no nullable
/// field could be cleared over JSON at all: every `Some(None)` path was
/// reachable from Rust (which is how the CLI's `--clear-notes` works, building
/// the value directly) and unreachable from the desktop IPC layer and the HTTP
/// API, with no error anywhere to say so.
///
/// Combined with `#[serde(default)]` for the absent case, this gives the three
/// states the patch structs' doc comments have always claimed:
///
/// ```text
/// {}                  -> None          leave untouched
/// {"notes": null}     -> Some(None)    clear it
/// {"notes": "hello"}  -> Some(Some(…)) set it
/// ```
///
/// Pair it with `skip_serializing_if = "Option::is_none"` on the same field so
/// serializing is the exact inverse: an untouched field is omitted rather than
/// written as `null`, which would otherwise read back as a *clear*.
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_merchant_strips_noise() {
        assert_eq!(normalize_merchant("  PICK n PAY *123 "), "pick n pay 123");
        assert_eq!(normalize_merchant("WOOLWORTHS"), "woolworths");
    }

    #[test]
    fn normalize_merchant_folds_unicode_case() {
        // Regression: per-char to_ascii_lowercase left "CAFÉ" ≠ "café", so
        // learned merchant mappings and recon scores missed for non-ASCII
        // merchants.
        assert_eq!(normalize_merchant("CAFÉ"), normalize_merchant("café"));
        assert_eq!(normalize_merchant("ÉÉ"), "éé");
        assert_eq!(merchant_similarity("CAFÉ", "café"), 1.0);
        assert_eq!(merchant_similarity("ÉÉ", "éé"), 1.0);
        // Multi-char lowercase expansions must not panic (İ → i̇).
        let _ = normalize_merchant("İSTANBUL MARKET");
    }

    #[test]
    fn merchant_key_from_noisy_statement_narratives() {
        // Realistic SA statement narratives. The key stays in
        // `normalize_merchant` form and keeps every non-volatile word, so
        // pack `contains`/`regex` rules match inside it.
        let key = |s: &str| merchant_key_from_description(s).unwrap();
        assert_eq!(key("PNP FAMILY KENILWORTH"), "pnp family kenilworth");
        assert_eq!(key("UBER *TRIP HELP.UBER.C"), "uber trip help uber c");
        assert_eq!(
            key("CHECKERS SIXTY60 RONDEBOSCH"),
            "checkers sixty60 rondebosch",
            "two-digit groups are part of the name, not a reference"
        );
        // Volatile tokens (card fragments, references, dates) are dropped so
        // the merchant behind them is still reachable.
        assert_eq!(
            key("CARD PURCHASE 4029*1234 WOOLWORTHS GARDENS"),
            "card purchase woolworths gardens"
        );
        assert_eq!(
            key("DEBIT ORDER NETFLIX.COM 12JUL"),
            "debit order netflix com"
        );
        assert_eq!(key("Woolworths"), "woolworths");
    }

    #[test]
    fn merchant_key_declines_when_no_merchant_is_named() {
        // Deriving here would be worse than deriving nothing: these lines
        // name a banking operation, not a merchant, and a wrong key writes a
        // durable merchant_mapping the moment the user categorises the row.
        for narrative in [
            "",
            "   ",
            "***",
            "1234567890",
            "R 250.00",
            "MONTHLY ACCOUNT FEE",
            "SERVICE FEE",
            "ATM CASH WITHDRAWAL",
            "IB PAYMENT FROM 62834729183",
            "POS PURCHASE 4029123456789",
            "INTERNET TRF TO SAVINGS",
            "VALUE DATE 20260712",
            // Prose, not a name.
            "PAYMENT RECEIVED THANK YOU FOR YOUR CONTINUED SUPPORT AND BUSINESS",
        ] {
            assert_eq!(
                merchant_key_from_description(narrative),
                None,
                "should decline: {narrative:?}"
            );
        }
    }

    #[test]
    fn merchant_key_is_stable_across_months() {
        // The learning loop only pays off if the same recurring line yields
        // the same key: a mapping keyed on a reference number never hits
        // twice and just grows the table.
        assert_eq!(
            merchant_key_from_description("CHECKERS SIXTY60 REF 88374621 12JUL"),
            merchant_key_from_description("CHECKERS SIXTY60 REF 90021755 09AUG"),
        );
        assert_eq!(
            merchant_key_from_description("CHECKERS SIXTY60 REF 88374621 12JUL").unwrap(),
            "checkers sixty60 ref"
        );
    }

    #[test]
    fn merchant_key_agrees_with_merchant_normalization() {
        // Same key space as the slip path: a description that *is* just a
        // merchant name derives exactly what `normalize_merchant` would.
        for name in ["Pick n Pay", "CAFÉ ÉTOILE", "Dis-Chem Pharmacies"] {
            assert_eq!(
                merchant_key_from_description(name).as_deref(),
                Some(normalize_merchant(name).as_str())
            );
        }
    }

    #[test]
    fn dedupe_hash_is_deterministic_and_sensitive() {
        let a = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1000,
            "ZAR",
            None,
            Some("spar"),
            None,
            0,
        );
        let b = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1000,
            "ZAR",
            None,
            Some("spar"),
            None,
            0,
        );
        let c = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1001,
            "ZAR",
            None,
            Some("spar"),
            None,
            0,
        );
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn dedupe_hash_prefers_provider_txn_id() {
        let a =
            transaction_dedupe_hash("acc", "2026-01-01", -1000, "ZAR", Some("p1"), None, None, 0);
        let b =
            transaction_dedupe_hash("acc", "2026-02-02", -9999, "USD", Some("p1"), None, None, 0);
        assert_eq!(a, b);
        // With a provider id, occurrence is irrelevant.
        let c =
            transaction_dedupe_hash("acc", "2026-01-01", -1000, "ZAR", Some("p1"), None, None, 3);
        assert_eq!(a, c);
    }

    #[test]
    fn dedupe_hash_occurrence_distinguishes_identical_lines() {
        let first = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1000,
            "ZAR",
            None,
            Some("spar"),
            None,
            0,
        );
        let second = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1000,
            "ZAR",
            None,
            Some("spar"),
            None,
            1,
        );
        let second_again = transaction_dedupe_hash(
            "acc",
            "2026-01-01",
            -1000,
            "ZAR",
            None,
            Some("spar"),
            None,
            1,
        );
        assert_ne!(first, second, "identical same-day lines must not collide");
        assert_eq!(second, second_again, "re-imports still dedupe");
    }

    #[test]
    fn currency_codes_normalize_or_reject() {
        assert_eq!(normalize_currency_code("zar").unwrap(), "ZAR");
        assert_eq!(normalize_currency_code(" USD ").unwrap(), "USD");
        assert!(normalize_currency_code("Z1R").is_err());
        assert!(normalize_currency_code("ZARR").is_err());
        assert!(normalize_currency_code("").is_err());
    }

    #[test]
    fn ids_are_sortable_uuids() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 36);
        assert!(a <= b);
    }
}
