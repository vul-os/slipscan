//! Currency normalisation — port of the legacy `extract/currency.ts`.
//!
//! Converts whatever the model returns (symbol, alias, mixed case) to a
//! 3-letter ISO 4217 code, and converts decimal amounts to `i64` minor units
//! using the currency's exponent.

/// Common currency symbols and lowercase aliases → ISO codes.
const SYMBOL_MAP: &[(&str, &str)] = &[
    ("r", "ZAR"),
    ("zar", "ZAR"),
    ("$", "USD"),
    ("usd", "USD"),
    ("us$", "USD"),
    ("€", "EUR"),
    ("eur", "EUR"),
    ("£", "GBP"),
    ("gbp", "GBP"),
    ("¥", "JPY"),
    ("jpy", "JPY"),
    ("cny", "CNY"),
    ("a$", "AUD"),
    ("aud", "AUD"),
    ("c$", "CAD"),
    ("cad", "CAD"),
    ("chf", "CHF"),
    ("nzd", "NZD"),
    ("nz$", "NZD"),
    ("ngn", "NGN"),
    ("₦", "NGN"),
    ("kes", "KES"),
    ("ksh", "KES"),
    ("ghs", "GHS"),
    ("mzn", "MZN"),
    ("bwp", "BWP"),
    ("szl", "SZL"),
    ("lsl", "LSL"),
    ("nad", "NAD"),
    ("mur", "MUR"),
    ("scr", "SCR"),
    ("tzs", "TZS"),
    ("ugx", "UGX"),
    ("rwf", "RWF"),
    ("etb", "ETB"),
    ("egp", "EGP"),
];

fn lookup_symbol(s: &str) -> Option<&'static str> {
    let lower = s.to_lowercase();
    SYMBOL_MAP
        .iter()
        .find(|(sym, _)| *sym == lower)
        .map(|(_, code)| *code)
}

/// True if `s` is exactly 3 ASCII letters (potential ISO code).
fn is_iso_code(s: &str) -> bool {
    s.len() == 3 && s.chars().all(|c| c.is_ascii_alphabetic())
}

/// Convert whatever the model returned to a 3-letter ISO code, falling back
/// to `default` (uppercased) when empty or unrecognised.
pub fn normalize_currency(raw: &str, default: &str) -> String {
    let fallback = || {
        if default.is_empty() {
            "ZAR".to_string()
        } else {
            default.to_uppercase()
        }
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback();
    }

    let upper = trimmed.to_uppercase();
    if is_iso_code(&upper) {
        return upper;
    }

    if let Some(code) = lookup_symbol(trimmed) {
        return code.to_string();
    }

    // Extract a leading symbol/letter prefix (e.g. "R 1,200" → "R").
    let prefix: String = trimmed
        .chars()
        .take_while(|c| c.is_alphabetic() || matches!(c, '€' | '£' | '¥' | '₦' | '$'))
        .collect();
    if !prefix.is_empty() {
        let prefix_upper = prefix.to_uppercase();
        if is_iso_code(&prefix_upper) {
            return prefix_upper;
        }
        if let Some(code) = lookup_symbol(&prefix) {
            return code.to_string();
        }
    }

    fallback()
}

/// ISO 4217 minor-unit exponent for a currency code (uppercase).
pub fn minor_exponent(code: &str) -> u32 {
    match code {
        // Zero-decimal currencies.
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        // Three-decimal currencies.
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        _ => 2,
    }
}

/// Convert a decimal amount to minor units for `code` (e.g. 12.34 ZAR → 1234).
///
/// Float-in by necessity: this is the boundary for amounts that arrive as
/// JSON numbers from an LLM. Text parsed digit-by-digit should use
/// [`minor_from_major_hundredths`] instead — exact integer math, no floats.
pub fn to_minor(value: f64, code: &str) -> i64 {
    let factor = 10f64.powi(minor_exponent(code) as i32);
    (value * factor).round() as i64
}

/// Exact integer conversion of an amount captured as whole `major` units
/// plus a two-digit decimal part (`hundredths`, 0..=99) into minor units
/// for `code`. Never touches floats, so precision holds for arbitrarily
/// large amounts; `None` on overflow.
///
/// * exponent 2 (most currencies): `major * 100 + hundredths`
/// * exponent 3 (BHD-class): `major * 1000 + hundredths * 10`
/// * exponent 0 (JPY-class): `major`, rounding the decimal part half-up
///   instead of silently discarding it
pub fn minor_from_major_hundredths(major: i64, hundredths: i64, code: &str) -> Option<i64> {
    debug_assert!((0..=99).contains(&hundredths));
    match minor_exponent(code) {
        0 => major.checked_add(i64::from(hundredths >= 50)),
        exponent => {
            let factor = 10i64.checked_pow(exponent)?;
            major
                .checked_mul(factor)?
                .checked_add(hundredths.checked_mul(factor / 100)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_codes_pass_through_uppercased() {
        assert_eq!(normalize_currency("zar", "USD"), "ZAR");
        assert_eq!(normalize_currency("EUR", "ZAR"), "EUR");
    }

    #[test]
    fn symbols_map_to_codes() {
        assert_eq!(normalize_currency("R", "USD"), "ZAR");
        assert_eq!(normalize_currency("$", "ZAR"), "USD");
        assert_eq!(normalize_currency("€", "ZAR"), "EUR");
        assert_eq!(normalize_currency("₦", "ZAR"), "NGN");
    }

    #[test]
    fn leading_prefix_is_extracted() {
        assert_eq!(normalize_currency("R 1,200", "USD"), "ZAR");
        assert_eq!(normalize_currency("US$ 42", "ZAR"), "USD");
    }

    #[test]
    fn unknown_falls_back_to_default() {
        assert_eq!(normalize_currency("???", "usd"), "USD");
        assert_eq!(normalize_currency("", ""), "ZAR");
    }

    #[test]
    fn minor_conversion_respects_exponent() {
        assert_eq!(to_minor(12.34, "ZAR"), 1234);
        assert_eq!(to_minor(12.345, "ZAR"), 1235); // rounds
        assert_eq!(to_minor(1200.0, "JPY"), 1200);
        assert_eq!(to_minor(1.234, "BHD"), 1234);
        assert_eq!(to_minor(-29.99, "ZAR"), -2999);
    }

    #[test]
    fn float_edge_rounding() {
        // Classic binary-float trap: 19.99 * 100 = 1998.9999…
        assert_eq!(to_minor(19.99, "ZAR"), 1999);
        assert_eq!(to_minor(0.1 + 0.2, "ZAR"), 30);
    }

    #[test]
    fn integer_parts_conversion_is_exact() {
        assert_eq!(minor_from_major_hundredths(12, 34, "ZAR"), Some(1_234));
        assert_eq!(minor_from_major_hundredths(0, 7, "ZAR"), Some(7));
        // JPY-class: no minor exponent — decimal part rounds, not dropped.
        assert_eq!(minor_from_major_hundredths(1_200, 0, "JPY"), Some(1_200));
        assert_eq!(minor_from_major_hundredths(1_200, 49, "JPY"), Some(1_200));
        assert_eq!(minor_from_major_hundredths(1_200, 50, "JPY"), Some(1_201));
        // BHD-class: three decimals; two captured digits scale by 10.
        assert_eq!(minor_from_major_hundredths(1, 23, "BHD"), Some(1_230));
        // Exact above f64's 2^53 integer ceiling (where floats would drift).
        let big = 90_071_992_547_409_929_i64; // > 2^53 minor units
        assert_eq!(
            minor_from_major_hundredths(big / 100, (big % 100).abs(), "ZAR"),
            Some(big / 100 * 100 + big % 100)
        );
        // Overflow is an error, not a wrap.
        assert_eq!(minor_from_major_hundredths(i64::MAX, 99, "ZAR"), None);
    }
}
