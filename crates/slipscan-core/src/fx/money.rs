//! Integer-only money conversion: `i64` minor units × decimal rate.
//!
//! The mantra: floats never touch money. A rate is a [`Decimal`]
//! (integer mantissa + power-of-ten scale), so the whole conversion is exact
//! integer arithmetic in `i128` — `amount × mantissa / 10^scale` — with
//! banker's rounding (round half to even) applied to the final quotient.

use rust_decimal::Decimal;

use crate::error::{CoreError, CoreResult};

/// Convert an amount in minor units with an FX rate, rounding half to even.
///
/// All intermediates are `i128`; overflow anywhere (including a result that
/// does not fit `i64`) is a hard error, never a wrap or a silent clamp.
/// Negative amounts round symmetrically (half-to-even on the magnitude).
pub fn convert_minor(amount_minor: i64, rate: Decimal) -> CoreResult<i64> {
    if rate.is_sign_negative() {
        return Err(CoreError::Validation(format!(
            "fx rate must not be negative (got {rate})"
        )));
    }

    // Decimal is mantissa × 10^-scale with scale <= 28, so 10^scale fits u128.
    let mantissa = rate.mantissa().unsigned_abs(); // sign already checked non-negative
    let scale = rate.scale();
    let divisor: u128 = 10u128
        .checked_pow(scale)
        .expect("Decimal scale is <= 28, 10^28 fits u128");

    // amount × mantissa can exceed u128 (a 27-digit mantissa on a 10^15
    // amount is ~10^42) even when the final quotient fits i64 easily, so the
    // product is kept as an exact 256-bit value and divided exactly. Floats
    // never touch this path.
    let negative = amount_minor < 0;
    let (hi, lo) = mul_u128(amount_minor.unsigned_abs() as u128, mantissa);

    // quotient >= 2^128 whenever hi >= divisor — far beyond i64 either way.
    if hi >= divisor {
        return Err(overflow(amount_minor, rate));
    }
    let (quotient, remainder) = div_u256_by_u128(hi, lo, divisor);

    // Half-to-even on the magnitude; remainder < divisor <= 10^28 < 2^94,
    // so doubling cannot overflow u128.
    let rounded = match (remainder * 2).cmp(&divisor) {
        std::cmp::Ordering::Less => quotient,
        std::cmp::Ordering::Greater => quotient + 1,
        std::cmp::Ordering::Equal => {
            if quotient % 2 == 0 {
                quotient
            } else {
                quotient + 1
            }
        }
    };
    if negative {
        // |i64::MIN| is representable as u128, compare against it directly.
        if rounded > i64::MIN.unsigned_abs() as u128 {
            return Err(overflow(amount_minor, rate));
        }
        Ok((rounded as i128).checked_neg().expect("bounded above") as i64)
    } else {
        i64::try_from(rounded).map_err(|_| overflow(amount_minor, rate))
    }
}

/// Full 128×128 → 256-bit multiply, returned as (high, low) u128 halves.
fn mul_u128(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = (1u128 << 64) - 1;
    let (a_hi, a_lo) = (a >> 64, a & MASK);
    let (b_hi, b_lo) = (b >> 64, b & MASK);

    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;

    let mid = (ll >> 64) + (lh & MASK) + (hl & MASK);
    let lo = (mid << 64) | (ll & MASK);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
    (hi, lo)
}

/// Exact (hi·2^128 + lo) / d as (quotient, remainder).
///
/// Caller guarantees `hi < d`, which bounds the quotient below 2^128.
/// Bitwise restoring division over the low 128 bits: the running remainder
/// stays < d <= 10^28 < 2^94, so the shift never overflows.
fn div_u256_by_u128(hi: u128, lo: u128, d: u128) -> (u128, u128) {
    debug_assert!(hi < d);
    let mut rem = hi;
    let mut quo = 0u128;
    for i in (0..128).rev() {
        rem = (rem << 1) | ((lo >> i) & 1);
        quo <<= 1;
        if rem >= d {
            rem -= d;
            quo |= 1;
        }
    }
    (quo, rem)
}

fn overflow(amount_minor: i64, rate: Decimal) -> CoreError {
    CoreError::Validation(format!(
        "fx conversion overflows i64 minor units ({amount_minor} × {rate})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).expect("test decimal")
    }

    #[test]
    fn identity_rate_returns_amount() {
        assert_eq!(convert_minor(0, dec("1")).unwrap(), 0);
        assert_eq!(convert_minor(123_456, dec("1")).unwrap(), 123_456);
        assert_eq!(convert_minor(-123_456, dec("1")).unwrap(), -123_456);
        assert_eq!(convert_minor(i64::MAX, dec("1")).unwrap(), i64::MAX);
        assert_eq!(convert_minor(i64::MIN, dec("1")).unwrap(), i64::MIN);
    }

    #[test]
    fn bankers_rounding_half_goes_to_even() {
        // 2.5 -> 2, 3.5 -> 4 (half to even), 2.51 -> 3.
        assert_eq!(convert_minor(25, dec("0.1")).unwrap(), 2);
        assert_eq!(convert_minor(35, dec("0.1")).unwrap(), 4);
        assert_eq!(convert_minor(251, dec("0.01")).unwrap(), 3);
        // 0.5 -> 0 (zero is even), 1.5 -> 2.
        assert_eq!(convert_minor(1, dec("0.5")).unwrap(), 0);
        assert_eq!(convert_minor(3, dec("0.5")).unwrap(), 2);
    }

    #[test]
    fn negative_amounts_round_symmetrically() {
        // -2.5 -> -2 and -3.5 -> -4: half-to-even on the magnitude, sign kept.
        assert_eq!(convert_minor(-25, dec("0.1")).unwrap(), -2);
        assert_eq!(convert_minor(-35, dec("0.1")).unwrap(), -4);
        assert_eq!(convert_minor(-1, dec("0.5")).unwrap(), 0);
        assert_eq!(convert_minor(-3, dec("0.5")).unwrap(), -2);
        assert_eq!(convert_minor(-251, dec("0.01")).unwrap(), -3);
    }

    #[test]
    fn high_precision_rate_on_large_amounts_is_exact() {
        // A 12-decimal rate an f64 could not carry exactly, applied to a
        // very large minor amount (the ledger's per-line cap is 10^15).
        let rate = dec("0.052631578947");
        assert_eq!(
            convert_minor(1_000_000_000_000_000, rate).unwrap(),
            52_631_578_947_000
        );
        // 19 × 0.052631578947 = 0.999999999993 -> 1.
        assert_eq!(convert_minor(19, rate).unwrap(), 1);
        // Full 28-significant-digit mantissa stays exact.
        let long = dec("0.0526315789473684210526315789");
        // 10^15 × rate = 52631578947368.4210526315789 -> 52 631 578 947 368
        assert_eq!(
            convert_minor(1_000_000_000_000_000, long).unwrap(),
            52_631_578_947_368
        );
    }

    #[test]
    fn zero_rate_yields_zero() {
        assert_eq!(convert_minor(987_654_321, dec("0")).unwrap(), 0);
        assert_eq!(convert_minor(987_654_321, dec("0.000")).unwrap(), 0);
    }

    #[test]
    fn negative_rate_is_rejected() {
        let err = convert_minor(100, dec("-1.5")).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
    }

    #[test]
    fn result_overflowing_i64_errors() {
        let err = convert_minor(i64::MAX, dec("1.000000001")).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
        let err = convert_minor(i64::MIN, dec("2")).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
    }

    #[test]
    fn i128_intermediate_overflow_errors_cleanly() {
        // Max mantissa (2^96-1, scale 0) × i64::MAX overflows i128 — must be
        // a checked error, never a wrap.
        let huge = Decimal::MAX; // 79 228 162 514 264 337 593 543 950 335
        let err = convert_minor(i64::MAX, huge).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
        // But a huge rate on a tiny amount is fine.
        assert_eq!(convert_minor(0, huge).unwrap(), 0);
    }

    #[test]
    fn extreme_but_valid_conversions_stay_exact() {
        // i64::MAX halved exactly.
        assert_eq!(
            convert_minor(i64::MAX, dec("0.5")).unwrap(),
            4611686018427387904
        );
        // (i64::MAX = 9223372036854775807; × 0.5 = 4611686018427387903.5,
        // half-to-even rounds up to ...904.)
        assert_eq!(
            convert_minor(i64::MIN, dec("0.5")).unwrap(),
            -4611686018427387904
        );
    }
}
