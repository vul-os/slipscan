//! Integer VAT arithmetic on minor units. No floats in money paths.
//!
//! Rates are basis points (1500 = 15.00%, the SA standard rate). All
//! computations round half away from zero on the VAT portion, and splits are
//! exact by construction: `net + vat == gross` always.

/// VAT portion of a VAT-inclusive amount at `rate_bps`.
///
/// `vat = gross * rate / (10_000 + rate)`, rounded half away from zero.
pub fn vat_from_inclusive(gross_minor: i64, rate_bps: i64) -> i64 {
    if rate_bps <= 0 {
        return 0;
    }
    div_round_half_away(
        i128::from(gross_minor) * i128::from(rate_bps),
        i128::from(10_000 + rate_bps),
    )
}

/// VAT charged on a VAT-exclusive (net) amount at `rate_bps`.
pub fn vat_on_net(net_minor: i64, rate_bps: i64) -> i64 {
    if rate_bps <= 0 {
        return 0;
    }
    div_round_half_away(i128::from(net_minor) * i128::from(rate_bps), 10_000)
}

/// Split a VAT-inclusive amount into `(net, vat)`. `net + vat == gross`.
pub fn split_inclusive(gross_minor: i64, rate_bps: i64) -> (i64, i64) {
    let vat = vat_from_inclusive(gross_minor, rate_bps);
    (gross_minor - vat, vat)
}

fn div_round_half_away(numerator: i128, denominator: i128) -> i64 {
    debug_assert!(denominator > 0);
    let half = denominator / 2;
    let rounded = if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        (numerator - half) / denominator
    };
    rounded as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_rate_split_is_exact() {
        // R115.00 inclusive at 15% -> R100.00 net + R15.00 VAT.
        assert_eq!(split_inclusive(11_500, 1500), (10_000, 1_500));
        // And the other direction agrees.
        assert_eq!(vat_on_net(10_000, 1500), 1_500);
    }

    #[test]
    fn split_always_sums_to_gross() {
        for gross in [-11_501, -1, 0, 1, 7, 99, 11_499, 123_457, i64::MAX / 2] {
            for rate in [0, 1, 1400, 1500, 2000, 10_000] {
                let (net, vat) = split_inclusive(gross, rate);
                assert_eq!(net + vat, gross, "gross {gross} rate {rate}");
            }
        }
    }

    #[test]
    fn rounding_is_half_away_from_zero() {
        // 1000 * 1500 / 11500 = 130.43... -> 130.
        assert_eq!(vat_from_inclusive(1_000, 1500), 130);
        // 115 * 1500 / 11500 = 15 exactly.
        assert_eq!(vat_from_inclusive(115, 1500), 15);
        // 23 * 1500 / 11500 = 3.0 exactly; 27 -> 3.52 -> 4.
        assert_eq!(vat_from_inclusive(23, 1500), 3);
        assert_eq!(vat_from_inclusive(27, 1500), 4);
        // Negative amounts (credit notes) mirror positives.
        assert_eq!(vat_from_inclusive(-11_500, 1500), -1_500);
        assert_eq!(vat_from_inclusive(-27, 1500), -4);
        // vat_on_net: 333 * 15% = 49.95 -> 50.
        assert_eq!(vat_on_net(333, 1500), 50);
        assert_eq!(vat_on_net(-333, 1500), -50);
    }

    #[test]
    fn zero_and_negative_rates_charge_nothing() {
        assert_eq!(vat_from_inclusive(11_500, 0), 0);
        assert_eq!(vat_on_net(11_500, 0), 0);
        assert_eq!(vat_from_inclusive(11_500, -5), 0);
        assert_eq!(split_inclusive(11_500, 0), (11_500, 0));
    }

    #[test]
    fn no_overflow_on_large_amounts() {
        // i64::MAX minor units at 15% would overflow i64 math; i128 keeps it exact.
        let (net, vat) = split_inclusive(i64::MAX, 1500);
        assert_eq!(net + vat, i64::MAX);
        assert!(vat > 0);
    }
}
