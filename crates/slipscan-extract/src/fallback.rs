//! Deterministic no-LLM fallback: regex heuristics over receipt text.
//!
//! Handles `text/plain` receipts (email bodies, pasted text, pre-OCR'd
//! slips) fully offline with zero network egress. It extracts the grand
//! total, VAT amount, purchase date/time, currency, and merchant name —
//! never line items — and reports low confidence so results land in the
//! manual-review queue.

use crate::provider::{ExtractError, ExtractionProvider, ExtractionRequest, MIME_TEXT};
use crate::types::{MerchantInfo, SlipExtraction, Totals, SLIP_SCHEMA_VERSION};
use crate::{currency, wire};
use async_trait::async_trait;
use regex::Regex;
use std::sync::OnceLock;

/// Base self-rating for heuristic extractions (before local scoring).
const HEURISTIC_CONFIDENCE: f64 = 0.3;

pub struct HeuristicProvider;

#[async_trait]
impl ExtractionProvider for HeuristicProvider {
    fn name(&self) -> &str {
        "heuristic"
    }

    async fn extract(&self, request: ExtractionRequest) -> Result<SlipExtraction, ExtractError> {
        if request.mime_type != MIME_TEXT {
            return Err(ExtractError::Unsupported {
                mime_type: request.mime_type,
            });
        }
        let text = String::from_utf8_lossy(&request.bytes).into_owned();
        extract_from_text(&text)
    }
}

/// Run the heuristics over receipt text and produce a finalized slip.
pub fn extract_from_text(text: &str) -> Result<SlipExtraction, ExtractError> {
    let code = detect_currency(text);
    let mut warnings =
        vec!["extracted offline with regex heuristics; review recommended".to_string()];
    let total_minor = detect_total(text, &code, &mut warnings)?;
    let vat_minor = detect_vat(text, &code);
    let purchased_at = detect_datetime(text);
    let merchant = detect_merchant(text);

    let mut slip = SlipExtraction {
        schema: SLIP_SCHEMA_VERSION.to_string(),
        merchant,
        purchased_at,
        currency: Some(code),
        totals: Totals {
            subtotal_minor: None,
            discount_minor: None,
            vat_minor,
            tip_minor: None,
            total_minor,
        },
        line_items: vec![],
        discounts: vec![],
        vat_breakdown: vec![],
        payment: None,
        confidence: Some(HEURISTIC_CONFIDENCE),
        validation: None,
        warnings,
    };
    wire::finalize(&mut slip);
    Ok(slip)
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Amounts must have a 2-digit decimal part — this excludes card numbers,
/// phone numbers, and quantities.
fn amount_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"([0-9]{1,3}(?:[ ,][0-9]{3})+|[0-9]+)[.,]([0-9]{2})\b")
}

fn strong_total_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|amount\s*payable)\b",
    )
}

fn weak_total_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)\btotal\b")
}

fn subtotal_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)\bsub[\s-]?total\b")
}

fn vat_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)\b(vat|tax)\b")
}

fn vat_number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)\bvat\s*(no|nr|number|reg)\b")
}

fn incl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)\bincl")
}

/// Parse the last amount on a line into minor units for `code`.
/// Exact integer math end-to-end — no float round-trip (money contract:
/// i64 minor units, never floats).
fn last_amount_minor(line: &str, code: &str) -> Option<i64> {
    let caps = amount_re().captures_iter(line).last()?;
    let int_part: String = caps[1].chars().filter(|c| c.is_ascii_digit()).collect();
    let int: i64 = int_part.parse().ok()?;
    let frac: i64 = caps[2].parse().ok()?;
    currency::minor_from_major_hundredths(int, frac, code)
}

fn detect_total(text: &str, code: &str, warnings: &mut Vec<String>) -> Result<i64, ExtractError> {
    // rank 2: explicit grand-total keywords; rank 1: a plain "total" line
    // that isn't a subtotal or a bare VAT summary. Later lines win ties
    // (totals print near the bottom).
    let mut best: Option<(u8, i64)> = None;
    for line in text.lines() {
        let Some(amount) = last_amount_minor(line, code) else {
            continue;
        };
        let rank = if strong_total_re().is_match(line) {
            2
        } else if weak_total_re().is_match(line)
            && !subtotal_re().is_match(line)
            && (!vat_word_re().is_match(line) || incl_re().is_match(line))
        {
            1
        } else {
            continue;
        };
        if best.is_none_or(|(r, _)| rank >= r) {
            best = Some((rank, amount));
        }
    }
    if let Some((_, amount)) = best {
        return Ok(amount);
    }
    // Last resort: the largest amount anywhere in the text.
    let fallback = text
        .lines()
        .filter_map(|l| last_amount_minor(l, code))
        .max();
    match fallback {
        Some(amount) => {
            warnings.push("no total keyword found; used the largest amount".to_string());
            Ok(amount)
        }
        None => Err(ExtractError::InvalidResponse(
            "no monetary amounts found in receipt text".into(),
        )),
    }
}

fn detect_vat(text: &str, code: &str) -> Option<i64> {
    text.lines()
        .filter(|l| {
            vat_word_re().is_match(l)
                && !vat_number_re().is_match(l)
                && !incl_re().is_match(l)
                && !strong_total_re().is_match(l)
        })
        .filter_map(|l| last_amount_minor(l, code))
        .next_back()
}

fn detect_currency(text: &str) -> String {
    static ISO: OnceLock<Regex> = OnceLock::new();
    let iso = regex(
        &ISO,
        r"\b(ZAR|USD|EUR|GBP|AUD|CAD|NZD|JPY|CHF|NGN|KES|GHS|BWP|NAD|MZN|SZL|LSL)\b",
    );
    if let Some(m) = iso.find(text) {
        return m.as_str().to_string();
    }
    if text.contains('€') {
        return "EUR".into();
    }
    if text.contains('£') {
        return "GBP".into();
    }
    if text.contains('$') {
        return "USD".into();
    }
    static RAND: OnceLock<Regex> = OnceLock::new();
    if regex(&RAND, r"\bR\s?[0-9]").is_match(text) {
        return "ZAR".into();
    }
    currency::normalize_currency("", "")
}

fn detect_datetime(text: &str) -> Option<String> {
    static ISO: OnceLock<Regex> = OnceLock::new();
    static DMY: OnceLock<Regex> = OnceLock::new();
    static TIME: OnceLock<Regex> = OnceLock::new();

    let date = if let Some(c) =
        regex(&ISO, r"\b(20[0-9]{2})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})\b").captures(text)
    {
        let (y, mut m, mut d): (i64, i64, i64) =
            (c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?);
        if m > 12 && d <= 12 {
            std::mem::swap(&mut m, &mut d);
        }
        format!("{y:04}-{m:02}-{d:02}")
    } else if let Some(c) =
        regex(&DMY, r"\b([0-9]{1,2})[-/.]([0-9]{1,2})[-/.](20[0-9]{2})\b").captures(text)
    {
        let (mut d, mut m, y): (i64, i64, i64) =
            (c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?);
        // Receipts here print day-first; swap when that can't be right.
        if m > 12 && d <= 12 {
            std::mem::swap(&mut m, &mut d);
        }
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        return None;
    };

    let time = regex(&TIME, r"\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b")
        .captures(text)
        .map(|c| format!("{:0>2}:{}", &c[1], &c[2]));
    Some(match time {
        Some(t) => format!("{date}T{t}:00"),
        None => date,
    })
}

fn detect_merchant(text: &str) -> Option<MerchantInfo> {
    let name = text.lines().map(str::trim).find(|line| {
        !line.is_empty()
            && line.chars().filter(|c| c.is_alphabetic()).count() >= 3
            && !weak_total_re().is_match(line)
            && !subtotal_re().is_match(line)
            && !vat_word_re().is_match(line)
    })?;
    let name: String = name.chars().take(64).collect();
    Some(MerchantInfo {
        name,
        branch: None,
        address: None,
        vat_number: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECEIPT: &str = "\
PICK N PAY FAMILY CLAREMONT
VAT No: 4090001234
2026/07/01 12:30
MILK 2L            34.99
BREAD              20.00
SUBTOTAL           54.99
TOTAL VAT           2.61
TOTAL          R   49.99
CARD **** 1234";

    #[tokio::test]
    async fn provider_extracts_totals_date_and_merchant() {
        let slip = HeuristicProvider
            .extract(ExtractionRequest::new(
                MIME_TEXT,
                RECEIPT.as_bytes().to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(
            slip.merchant.as_ref().unwrap().name,
            "PICK N PAY FAMILY CLAREMONT"
        );
        assert_eq!(slip.totals.total_minor, 4_999);
        assert_eq!(slip.totals.vat_minor, Some(261));
        assert_eq!(slip.currency.as_deref(), Some("ZAR"));
        assert_eq!(slip.purchased_at.as_deref(), Some("2026-07-01T12:30:00"));
        let confidence = slip.confidence.unwrap();
        assert!(
            confidence <= HEURISTIC_CONFIDENCE,
            "heuristics stay low-confidence"
        );
        assert!(slip.warnings.iter().any(|w| w.contains("regex heuristics")));
    }

    #[test]
    fn subtotal_is_never_picked_as_the_total() {
        let slip = extract_from_text("SUBTOTAL 100.00\nGRAND TOTAL 115.00").unwrap();
        assert_eq!(slip.totals.total_minor, 11_500);
    }

    #[test]
    fn thousands_separators_parse() {
        let slip = extract_from_text("TOTAL DUE R 12,345.67").unwrap();
        assert_eq!(slip.totals.total_minor, 1_234_567);
    }

    #[test]
    fn falls_back_to_largest_amount_with_warning() {
        let slip = extract_from_text("CAPPUCCINO 32.50\nMUFFIN 18.00").unwrap();
        assert_eq!(slip.totals.total_minor, 3_250);
        assert!(slip.warnings.iter().any(|w| w.contains("largest amount")));
    }

    #[test]
    fn dmy_dates_normalise() {
        let slip = extract_from_text("STORE\nTOTAL 10.00\n01/07/2026").unwrap();
        assert_eq!(slip.purchased_at.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn no_amounts_is_invalid() {
        let err = extract_from_text("hello there\nno numbers here").unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }

    #[test]
    fn euro_symbol_sets_currency() {
        let slip = extract_from_text("CAFE BERLIN\nTOTAL €12.50").unwrap();
        assert_eq!(slip.currency.as_deref(), Some("EUR"));
        assert_eq!(slip.totals.total_minor, 1_250);
    }

    #[tokio::test]
    async fn non_text_input_is_unsupported() {
        let err = HeuristicProvider
            .extract(ExtractionRequest::new("image/jpeg", vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Unsupported { .. }));
    }
}
