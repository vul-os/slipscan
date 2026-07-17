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
