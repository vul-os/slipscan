//! Arithmetic validation: do the extracted line items sum to the stated
//! total within tolerance? Always computed locally — never trusted from the
//! model (port of the legacy `computeValidation`, adapted to minor units).

use crate::types::{SlipExtraction, Validation};

/// Tolerance in minor units (legacy used 0.05 in decimal → 5 minor units).
pub const TOLERANCE_MINOR: i64 = 5;

/// Compute the validation block for a slip.
///
/// Receipts are printed two ways: line amounts VAT-inclusive (typical till
/// slips) or VAT-exclusive (typical invoices). We compute both candidates and
/// keep the closer one:
///
/// * inclusive: `items + discounts + tip`
/// * exclusive: `items + discounts + tip + vat`
pub fn compute(slip: &SlipExtraction) -> Validation {
    let items: i64 = slip.line_items.iter().map(|l| l.total_minor).sum();
    let discounts: i64 = slip.discounts.iter().map(|d| d.amount_minor).sum(); // negative
    let tip = slip.totals.tip_minor.unwrap_or(0);
    let vat = slip.totals.vat_minor.unwrap_or(0);

    let inclusive = items + discounts + tip;
    let exclusive = inclusive + vat;
    let total = slip.totals.total_minor;

    let computed = if (total - inclusive).abs() <= (total - exclusive).abs() {
        inclusive
    } else {
        exclusive
    };
    let delta = total - computed;

    Validation {
        sum_matches: delta.abs() <= TOLERANCE_MINOR,
        computed_total_minor: computed,
        delta_minor: delta,
    }
}

/// Attach a computed validation block to the slip (no-op when there are no
/// line items — there is nothing to sum) and record a warning on mismatch.
pub fn attach(slip: &mut SlipExtraction) {
    if slip.line_items.is_empty() {
        slip.warnings
            .push("no line items extracted; totals not validated".to_string());
        return;
    }
    let validation = compute(slip);
    if !validation.sum_matches {
        slip.warnings.push(format!(
            "line items sum to {} but the slip total is {} (delta {})",
            validation.computed_total_minor, slip.totals.total_minor, validation.delta_minor
        ));
    }
    slip.validation = Some(validation);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DiscountLine, LineItem, Totals};

    fn item(total_minor: i64) -> LineItem {
        LineItem {
            description: "item".into(),
            quantity: Some(1.0),
            unit_price_minor: None,
            total_minor,
            discount_minor: None,
            category: None,
            vat_rate_bps: None,
        }
    }

    fn slip(items: Vec<LineItem>, totals: Totals) -> SlipExtraction {
        SlipExtraction {
            schema: crate::types::SLIP_SCHEMA_VERSION.into(),
            merchant: None,
            purchased_at: None,
            currency: Some("ZAR".into()),
            totals,
            line_items: items,
            discounts: vec![],
            vat_breakdown: vec![],
            payment: None,
            confidence: None,
            validation: None,
            warnings: vec![],
        }
    }

    #[test]
    fn vat_inclusive_lines_match() {
        // Till slip: line amounts include VAT; total == sum(items).
        let s = slip(
            vec![item(3499), item(1500)],
            Totals {
                vat_minor: Some(652),
                total_minor: 4999,
                ..Default::default()
            },
        );
        let v = compute(&s);
        assert!(v.sum_matches);
        assert_eq!(v.computed_total_minor, 4999);
        assert_eq!(v.delta_minor, 0);
    }

    #[test]
    fn vat_exclusive_lines_match() {
        // Invoice style: total = items + VAT.
        let s = slip(
            vec![item(10_000)],
            Totals {
                vat_minor: Some(1_500),
                total_minor: 11_500,
                ..Default::default()
            },
        );
        let v = compute(&s);
        assert!(v.sum_matches);
        assert_eq!(v.computed_total_minor, 11_500);
    }

    #[test]
    fn discounts_reduce_the_computed_total() {
        let mut s = slip(
            vec![item(5_000)],
            Totals {
                total_minor: 4_500,
                ..Default::default()
            },
        );
        s.discounts.push(DiscountLine {
            description: "PROMO".into(),
            label: None,
            amount_minor: -500,
            source: Some("promo".into()),
        });
        let v = compute(&s);
        assert!(v.sum_matches);
        assert_eq!(v.computed_total_minor, 4_500);
    }

    #[test]
    fn within_tolerance_still_matches() {
        let s = slip(
            vec![item(1_000)],
            Totals {
                total_minor: 1_004,
                ..Default::default()
            },
        );
        let v = compute(&s);
        assert!(v.sum_matches);
        assert_eq!(v.delta_minor, 4);
    }

    #[test]
    fn mismatch_attaches_warning() {
        let mut s = slip(
            vec![item(1_000)],
            Totals {
                total_minor: 2_000,
                ..Default::default()
            },
        );
        attach(&mut s);
        let v = s.validation.expect("validation attached");
        assert!(!v.sum_matches);
        assert_eq!(v.delta_minor, 1_000);
        assert_eq!(s.warnings.len(), 1);
    }

    #[test]
    fn no_line_items_skips_validation() {
        let mut s = slip(
            vec![],
            Totals {
                total_minor: 2_000,
                ..Default::default()
            },
        );
        attach(&mut s);
        assert!(s.validation.is_none());
        assert_eq!(s.warnings.len(), 1);
    }
}
