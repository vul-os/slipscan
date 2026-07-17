//! Local confidence scoring.
//!
//! Providers report a self-rated confidence, but we never trust it alone:
//! the final score starts from the model's rating (or 0.5 when absent) and
//! is penalised for objectively-checkable gaps — totals that don't
//! reconcile, missing merchant/date/line items. The result prioritises
//! slips for manual review.

use crate::types::SlipExtraction;

/// Floor so a slip is never scored as impossible (it did parse).
const MIN_SCORE: f64 = 0.05;

/// Compute the final confidence for a slip (0.05..=1.0).
pub fn score(slip: &SlipExtraction) -> f64 {
    let mut s = slip.confidence.unwrap_or(0.5).clamp(0.0, 1.0);

    match &slip.validation {
        Some(v) if !v.sum_matches => s -= 0.25,
        Some(_) => {}
        // No validation block means there was nothing to sum.
        None => s -= 0.10,
    }
    if slip.line_items.is_empty() {
        s -= 0.10;
    }
    if slip.merchant.is_none() {
        s -= 0.10;
    }
    if slip.purchased_at.is_none() {
        s -= 0.10;
    }

    s.clamp(MIN_SCORE, 1.0)
}

/// Replace the model-reported confidence with the locally computed score.
pub fn apply(slip: &mut SlipExtraction) {
    slip.confidence = Some(score(slip));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LineItem, MerchantInfo, Totals, Validation};

    fn base_slip() -> SlipExtraction {
        SlipExtraction {
            schema: crate::types::SLIP_SCHEMA_VERSION.into(),
            merchant: Some(MerchantInfo {
                name: "Store".into(),
                ..Default::default()
            }),
            purchased_at: Some("2026-07-01".into()),
            currency: Some("ZAR".into()),
            totals: Totals {
                total_minor: 1_000,
                ..Default::default()
            },
            line_items: vec![LineItem {
                description: "item".into(),
                quantity: None,
                unit_price_minor: None,
                total_minor: 1_000,
                discount_minor: None,
                category: None,
                vat_rate_bps: None,
            }],
            discounts: vec![],
            vat_breakdown: vec![],
            payment: None,
            confidence: Some(0.9),
            validation: Some(Validation {
                sum_matches: true,
                computed_total_minor: 1_000,
                delta_minor: 0,
            }),
            warnings: vec![],
        }
    }

    #[test]
    fn clean_slip_keeps_model_confidence() {
        assert_eq!(score(&base_slip()), 0.9);
    }

    #[test]
    fn mismatched_totals_are_penalised() {
        let mut slip = base_slip();
        slip.validation = Some(Validation {
            sum_matches: false,
            computed_total_minor: 900,
            delta_minor: 100,
        });
        assert!(score(&slip) < 0.7);
    }

    #[test]
    fn missing_fields_stack_penalties_with_a_floor() {
        let mut slip = base_slip();
        slip.merchant = None;
        slip.purchased_at = None;
        slip.line_items.clear();
        slip.validation = None;
        slip.confidence = Some(0.2);
        let s = score(&slip);
        assert!(s >= MIN_SCORE);
        assert!(s < 0.2);
    }

    #[test]
    fn apply_overwrites_model_rating() {
        let mut slip = base_slip();
        slip.confidence = Some(7.0); // out-of-range model rating
        apply(&mut slip);
        assert_eq!(slip.confidence, Some(1.0));
    }
}
