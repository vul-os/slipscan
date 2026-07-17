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
        let ch = ch.to_ascii_lowercase();
        if ch.is_alphanumeric() {
            out.push(ch);
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
    let mut counts: std::collections::HashMap<(char, char), usize> = std::collections::HashMap::new();
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
/// observable fields.
pub fn transaction_dedupe_hash(
    account_id: &str,
    posted_date: &str,
    amount_minor: i64,
    currency: &str,
    provider_txn_id: Option<&str>,
    merchant_normalized: Option<&str>,
    description: Option<&str>,
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
    fn dedupe_hash_is_deterministic_and_sensitive() {
        let a =
            transaction_dedupe_hash("acc", "2026-01-01", -1000, "ZAR", None, Some("spar"), None);
        let b =
            transaction_dedupe_hash("acc", "2026-01-01", -1000, "ZAR", None, Some("spar"), None);
        let c =
            transaction_dedupe_hash("acc", "2026-01-01", -1001, "ZAR", None, Some("spar"), None);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn dedupe_hash_prefers_provider_txn_id() {
        let a = transaction_dedupe_hash("acc", "2026-01-01", -1000, "ZAR", Some("p1"), None, None);
        let b = transaction_dedupe_hash("acc", "2026-02-02", -9999, "USD", Some("p1"), None, None);
        assert_eq!(a, b);
    }

    #[test]
    fn ids_are_sortable_uuids() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 36);
        assert!(a <= b);
    }
}
