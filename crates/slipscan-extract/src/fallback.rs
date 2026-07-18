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
        extract_from_text(&text, request.default_currency.as_deref())
    }
}

/// Run the heuristics over receipt text and produce a finalized slip.
///
/// `default_currency` is the caller's fallback (the book currency) used when
/// the text itself carries no strong currency signal. With no default and no
/// signal at all the extracted currency is `None` — never a hardcoded
/// jurisdiction ("global by default — regions are data, not code").
pub fn extract_from_text(
    text: &str,
    default_currency: Option<&str>,
) -> Result<SlipExtraction, ExtractError> {
    let code = detect_currency(text, default_currency);
    // Minor-unit exponent: the detected currency's, or the common 2-decimal
    // shape when unknown.
    let exponent_code = code.clone().unwrap_or_default();
    let mut warnings =
        vec!["extracted offline with regex heuristics; review recommended".to_string()];
    let total_minor = detect_total(text, &exponent_code, &mut warnings)?;
    let vat_minor = detect_vat(text, &exponent_code);
    let purchased_at = detect_datetime(text);
    let merchant = detect_merchant(text);

    let mut slip = SlipExtraction {
        schema: SLIP_SCHEMA_VERSION.to_string(),
        merchant,
        purchased_at,
        currency: code,
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

/// Active ISO-4217 currency codes — worldwide data, no region favoured.
const ISO_CODES: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
    "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD",
    "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD",
    "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ",
    "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
    "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
    "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
    "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN",
    "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR",
    "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS",
    "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES",
    "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
];

/// ISO codes that are also common English words — matched only when
/// adjacent to an amount, so "CUP OF COFFEE" or "ALL ITEMS" never sets a
/// currency.
const AMBIGUOUS_ISO_CODES: &[&str] = &[
    "ALL", "AMD", "BAM", "COP", "CUP", "GEL", "MAD", "PEN", "RON", "SOS", "TOP", "TRY",
];

/// Currency symbols that identify one currency unambiguously enough to beat
/// the book default. Multi-character prefixes first ("R$" before "$").
const STRONG_SYMBOLS: &[(&str, &str)] = &[
    ("R$", "BRL"),
    ("US$", "USD"),
    ("€", "EUR"),
    ("£", "GBP"),
    ("₹", "INR"),
    ("₦", "NGN"),
    ("₩", "KRW"),
    ("₫", "VND"),
    ("₺", "TRY"),
    ("฿", "THB"),
    ("₪", "ILS"),
    ("₴", "UAH"),
    ("¥", "JPY"),
];

/// Currency detection, worldwide and data-driven. Precedence:
/// 1. an ISO-4217 code printed in the text (ambiguous English-word codes
///    only count next to an amount);
/// 2. an unambiguous currency symbol;
/// 3. the caller's default (the book currency);
/// 4. weak symbols (`$`, a bare `R` before digits) that many currencies
///    share — used only when nothing better exists, mapped to their most
///    common currency.
fn detect_currency(text: &str, default_currency: Option<&str>) -> Option<String> {
    static CAND: OnceLock<Regex> = OnceLock::new();
    let candidates = regex(&CAND, r"\b[A-Z]{3}\b");
    for m in candidates.find_iter(text) {
        let code = m.as_str();
        if !ISO_CODES.contains(&code) {
            continue;
        }
        if !AMBIGUOUS_ISO_CODES.contains(&code) || next_to_digit(text, m.start(), m.end()) {
            return Some(code.to_string());
        }
    }
    for (symbol, code) in STRONG_SYMBOLS {
        if text.contains(symbol) {
            return Some((*code).to_string());
        }
    }
    if let Some(code) = default_currency.and_then(currency::normalize_currency_opt) {
        return Some(code);
    }
    if text.contains('$') {
        return Some("USD".into());
    }
    static RAND: OnceLock<Regex> = OnceLock::new();
    if regex(&RAND, r"\bR\s*[0-9]").is_match(text) {
        return Some("ZAR".into());
    }
    None
}

/// Whether the byte range `start..end` in `text` has a digit next to it
/// (at most one space away) on either side — "INR 100.00", "100 SEK".
fn next_to_digit(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().rev().find(|c| *c != ' ');
    let after = text[end..].chars().find(|c| *c != ' ');
    before.is_some_and(|c| c.is_ascii_digit()) || after.is_some_and(|c| c.is_ascii_digit())
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
        let slip = extract_from_text("SUBTOTAL 100.00\nGRAND TOTAL 115.00", None).unwrap();
        assert_eq!(slip.totals.total_minor, 11_500);
    }

    #[test]
    fn thousands_separators_parse() {
        let slip = extract_from_text("TOTAL DUE R 12,345.67", None).unwrap();
        assert_eq!(slip.totals.total_minor, 1_234_567);
    }

    #[test]
    fn falls_back_to_largest_amount_with_warning() {
        let slip = extract_from_text("CAPPUCCINO 32.50\nMUFFIN 18.00", None).unwrap();
        assert_eq!(slip.totals.total_minor, 3_250);
        assert!(slip.warnings.iter().any(|w| w.contains("largest amount")));
    }

    #[test]
    fn dmy_dates_normalise() {
        let slip = extract_from_text("STORE\nTOTAL 10.00\n01/07/2026", None).unwrap();
        assert_eq!(slip.purchased_at.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn no_amounts_is_invalid() {
        let err = extract_from_text("hello there\nno numbers here", None).unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }

    #[test]
    fn euro_symbol_sets_currency() {
        let slip = extract_from_text("CAFE BERLIN\nTOTAL €12.50", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("EUR"));
        assert_eq!(slip.totals.total_minor, 1_250);
    }

    #[test]
    fn worldwide_iso_codes_are_detected() {
        // Regression: the old list was SADC-heavy — INR fell through to a
        // hardcoded ZAR.
        let slip = extract_from_text("CHAI POINT\nTOTAL INR 100.00", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("INR"));
        let slip = extract_from_text("MERCADO\nTOTAL BRL 25.90", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("BRL"));
        // Unambiguous symbols work too — ₹, and R$ before the weak $ rule.
        let slip = extract_from_text("CHAI POINT\nTOTAL ₹100.00", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("INR"));
        let slip = extract_from_text("MERCADO\nTOTAL R$ 25.90", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("BRL"));
    }

    #[test]
    fn english_word_iso_codes_need_an_adjacent_amount() {
        // "CUP" and "ALL" are ISO codes (Cuban peso, Albanian lek) but also
        // plain English — they must not hijack the currency.
        let slip = extract_from_text("CUP OF COFFEE 32.50\nALL ITEMS\nTOTAL 32.50", None).unwrap();
        assert_eq!(slip.currency, None);
        // Next to an amount they are genuine: "TOTAL ALL 500.00".
        let slip = extract_from_text("TIRANA MARKET\nTOTAL ALL 500.00", None).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("ALL"));
    }

    #[test]
    fn currencyless_text_uses_the_book_default_or_stays_unknown() {
        // Regression: "CORNER CAFE / TOTAL DUE 3.50" used to come back ZAR
        // regardless of the book ("no hardcoded currency anywhere").
        let text = "CORNER CAFE\nTOTAL DUE 3.50";
        let slip = extract_from_text(text, Some("EUR")).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("EUR"));
        let slip = extract_from_text(text, None).unwrap();
        assert_eq!(slip.currency, None);
        // A strong signal in the text beats the default…
        let slip = extract_from_text("CAFE\nTOTAL €3.50", Some("USD")).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("EUR"));
        // …but the weak `R`/`$` heuristics do not.
        let slip = extract_from_text("SHOP\nTOTAL R 49.99", Some("USD")).unwrap();
        assert_eq!(slip.currency.as_deref(), Some("USD"));
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
