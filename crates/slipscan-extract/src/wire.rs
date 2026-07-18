//! slip-v2 wire shape: what the model actually returns.
//!
//! The prompt (see [`crate::prompt`]) asks for decimal money amounts,
//! separate `date`/`time` fields, and percentage VAT rates — friendlier for
//! LLMs than minor units. This module parses that shape leniently (via
//! [`crate::json_util`]), converts it to the canonical
//! [`SlipExtraction`] (minor units, basis points), and runs the local
//! finalization pass: currency normalisation, arithmetic validation, sane
//! dates, and confidence scoring.

use crate::currency::{normalize_currency_opt, to_minor};
use crate::provider::ExtractError;
use crate::types::{
    DiscountLine, LineItem, MerchantInfo, PaymentInfo, SlipExtraction, Totals, VatLine,
    SLIP_SCHEMA_VERSION,
};
use crate::{confidence, json_util, validate};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireSlip {
    #[serde(default)]
    pub merchant: Option<WireMerchant>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub items: Vec<WireItem>,
    #[serde(default)]
    pub discounts: Vec<WireDiscount>,
    #[serde(default)]
    pub vat_breakdown: Vec<WireVat>,
    #[serde(default)]
    pub subtotal: Option<f64>,
    #[serde(default)]
    pub discount: Option<f64>,
    #[serde(default)]
    pub vat: Option<f64>,
    #[serde(default)]
    pub tip: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub payment: Option<WirePayment>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireMerchant {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub vat_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireItem {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub unit_price: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub discount: Option<f64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub vat_rate_percent: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireDiscount {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireVat {
    #[serde(default)]
    pub rate_percent: Option<f64>,
    #[serde(default)]
    pub base: Option<f64>,
    #[serde(default)]
    pub vat: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WirePayment {
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub card_last4: Option<String>,
}

impl WireSlip {
    /// Convert to the canonical slip-v2 shape (minor units, bps).
    ///
    /// `default_currency` is the caller-injected fallback (the book
    /// currency) used when the slip shows no currency of its own. With an
    /// empty default and no detectable currency the result's `currency` is
    /// `None` — never a hardcoded jurisdiction ("global by default").
    pub fn into_slip(self, default_currency: &str) -> Result<SlipExtraction, ExtractError> {
        let code = normalize_currency_opt(self.currency.as_deref().unwrap_or(""))
            .or_else(|| normalize_currency_opt(default_currency));
        // Minor-unit exponent: the resolved currency's, or the common
        // 2-decimal shape when unknown (`minor_exponent` default).
        let exponent_code = code.clone().unwrap_or_default();
        let m = |v: f64| to_minor(v, &exponent_code);
        let mut warnings = Vec::new();

        let mut line_items = Vec::with_capacity(self.items.len());
        for item in self.items {
            let Some(total) = item.total else {
                warnings.push(format!(
                    "dropped line item without a total: {:?}",
                    item.description.as_deref().unwrap_or("")
                ));
                continue;
            };
            line_items.push(LineItem {
                description: item.description.unwrap_or_default(),
                quantity: item.quantity,
                unit_price_minor: item.unit_price.map(m),
                total_minor: m(total),
                discount_minor: item.discount.map(|v| m(v).abs()),
                category: item.category,
                vat_rate_bps: item.vat_rate_percent.map(|p| (p * 100.0).round() as i64),
            });
        }

        let mut discounts = Vec::with_capacity(self.discounts.len());
        for d in self.discounts {
            let Some(amount) = d.amount else { continue };
            // The prompt asks for negative amounts; enforce it regardless.
            discounts.push(DiscountLine {
                description: d.description.unwrap_or_default(),
                label: d.label,
                amount_minor: -m(amount).abs(),
                source: d.source,
            });
        }

        let vat_breakdown = self
            .vat_breakdown
            .into_iter()
            .filter_map(|v| {
                Some(VatLine {
                    rate_bps: (v.rate_percent? * 100.0).round() as i64,
                    base_minor: m(v.base?),
                    vat_minor: m(v.vat?),
                })
            })
            .collect();

        let total_minor = match self.total {
            Some(t) => m(t),
            None if !line_items.is_empty() => {
                let computed: i64 = line_items.iter().map(|l| l.total_minor).sum::<i64>()
                    + discounts.iter().map(|d| d.amount_minor).sum::<i64>();
                warnings.push("slip total missing; computed from line items".to_string());
                computed
            }
            None => {
                return Err(ExtractError::InvalidResponse(
                    "model returned neither a total nor line items".into(),
                ))
            }
        };

        let purchased_at = self.date.filter(|d| !d.trim().is_empty()).map(|date| {
            match self.time.as_deref().filter(|t| !t.trim().is_empty()) {
                Some(time) => format!("{date}T{time}:00"),
                None => date,
            }
        });

        let merchant = self.merchant.and_then(|w| {
            let name = w.name?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(MerchantInfo {
                name,
                branch: w.branch,
                address: w.address,
                vat_number: w.vat_number,
            })
        });

        Ok(SlipExtraction {
            schema: SLIP_SCHEMA_VERSION.to_string(),
            merchant,
            purchased_at,
            currency: code,
            totals: Totals {
                subtotal_minor: self.subtotal.map(m),
                discount_minor: self.discount.map(|v| m(v).abs()),
                vat_minor: self.vat.map(m),
                tip_minor: self.tip.map(m),
                total_minor,
            },
            line_items,
            discounts,
            vat_breakdown,
            payment: self.payment.map(|p| PaymentInfo {
                method: p.method,
                card_last4: p.card_last4,
            }),
            confidence: self.confidence,
            validation: None,
            warnings,
        })
    }
}

/// Local finalization: arithmetic validation, sane-date check, confidence.
/// Always computed here — never trusted from the model.
pub fn finalize(slip: &mut SlipExtraction) {
    validate::attach(slip);
    validate::check_date(slip);
    confidence::apply(slip);
}

/// Full pipeline from raw model output text to a finalized slip: lenient
/// JSON parse (repairing fences/trailing commas), wire → canonical
/// conversion, then [`finalize`].
pub fn parse_slip(text: &str, default_currency: &str) -> Result<SlipExtraction, ExtractError> {
    let value = json_util::parse_lenient(text)?;
    let wire: WireSlip = serde_json::from_value(value)?;
    let mut slip = wire.into_slip(default_currency)?;
    finalize(&mut slip);
    Ok(slip)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "merchant": {"name": "SHOPRITE", "branch": "Usave #219", "address": null, "vat_number": "4090001234"},
        "date": "2026-07-01", "time": "12:30",
        "currency": "R",
        "items": [
            {"description": "MILK 2L", "quantity": 1, "unit_price": 34.99, "total": 34.99, "discount": null, "category": "groceries.dairy", "vat_rate_percent": 0},
            {"description": "BREAD", "quantity": 1, "unit_price": null, "total": 20.00, "discount": null, "category": "groceries.bakery", "vat_rate_percent": 15}
        ],
        "discounts": [{"description": "XTRA SAVINGS", "label": "Loyalty reward", "amount": -5.00, "source": "loyalty"}],
        "vat_breakdown": [{"rate_percent": 15, "base": 17.39, "vat": 2.61}],
        "subtotal": 54.99, "discount": 5.00, "vat": 2.61, "tip": null, "total": 49.99,
        "payment": {"method": "card", "card_last4": "1234"},
        "confidence": 0.9
    }"#;

    #[test]
    fn converts_decimals_to_minor_units() {
        let slip = parse_slip(SAMPLE, "ZAR").unwrap();
        assert_eq!(slip.currency.as_deref(), Some("ZAR"));
        assert_eq!(slip.totals.total_minor, 4_999);
        assert_eq!(slip.totals.subtotal_minor, Some(5_499));
        assert_eq!(slip.totals.vat_minor, Some(261));
        assert_eq!(slip.line_items[0].total_minor, 3_499);
        assert_eq!(slip.line_items[1].vat_rate_bps, Some(1_500));
        assert_eq!(slip.discounts[0].amount_minor, -500);
        assert_eq!(slip.vat_breakdown[0].rate_bps, 1_500);
        assert_eq!(slip.purchased_at.as_deref(), Some("2026-07-01T12:30:00"));
        assert_eq!(slip.merchant.as_ref().unwrap().name, "SHOPRITE");
    }

    #[test]
    fn validation_reconciles_totals() {
        let slip = parse_slip(SAMPLE, "ZAR").unwrap();
        let v = slip.validation.expect("validation attached");
        // 3499 + 2000 - 500 = 4999 == total (VAT-inclusive line amounts).
        assert!(v.sum_matches);
        assert_eq!(v.computed_total_minor, 4_999);
    }

    #[test]
    fn confidence_is_scored_locally() {
        let slip = parse_slip(SAMPLE, "ZAR").unwrap();
        let c = slip.confidence.expect("confidence set");
        assert!(c > 0.8, "clean extraction stays high, got {c}");
    }

    #[test]
    fn fenced_output_is_repaired() {
        let fenced = format!("Here you go:\n```json\n{SAMPLE}\n```");
        let slip = parse_slip(&fenced, "ZAR").unwrap();
        assert_eq!(slip.totals.total_minor, 4_999);
    }

    #[test]
    fn missing_total_is_computed_from_items() {
        let text = r#"{"items": [{"description": "A", "total": 10.00}, {"description": "B", "total": 5.50}]}"#;
        let slip = parse_slip(text, "ZAR").unwrap();
        assert_eq!(slip.totals.total_minor, 1_550);
        assert!(slip.warnings.iter().any(|w| w.contains("total missing")));
    }

    #[test]
    fn no_total_and_no_items_is_invalid() {
        let err = parse_slip(r#"{"merchant": {"name": "X"}}"#, "ZAR").unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }

    #[test]
    fn positive_discount_amounts_are_negated() {
        let text = r#"{"total": 5.00, "discounts": [{"description": "PROMO", "amount": 2.50}]}"#;
        let slip = parse_slip(text, "ZAR").unwrap();
        assert_eq!(slip.discounts[0].amount_minor, -250);
    }

    #[test]
    fn insane_date_is_cleared_with_warning() {
        let text = r#"{"total": 5.00, "date": "1993-01-01"}"#;
        let slip = parse_slip(text, "ZAR").unwrap();
        assert!(slip.purchased_at.is_none());
        assert!(slip.warnings.iter().any(|w| w.contains("date")));
    }

    #[test]
    fn zero_decimal_currency_uses_its_exponent() {
        let text = r#"{"currency": "JPY", "total": 1200}"#;
        let slip = parse_slip(text, "ZAR").unwrap();
        assert_eq!(slip.currency.as_deref(), Some("JPY"));
        assert_eq!(slip.totals.total_minor, 1_200);
    }

    #[test]
    fn missing_currency_uses_the_injected_book_default() {
        // Regression: this used to hardcode ZAR regardless of the book.
        let text = r#"{"currency": null, "total": 12.34}"#;
        let slip = parse_slip(text, "EUR").unwrap();
        assert_eq!(slip.currency.as_deref(), Some("EUR"));
        let slip = parse_slip(text, "jpy").unwrap();
        assert_eq!(slip.currency.as_deref(), Some("JPY"));
        assert_eq!(slip.totals.total_minor, 12, "default drives the exponent");
    }

    #[test]
    fn missing_currency_without_a_default_stays_unknown() {
        // No slip currency + no default → None, never a hardcoded currency
        // ("global by default" contract). Amounts convert at the common
        // 2-decimal exponent.
        let slip = parse_slip(r#"{"total": 12.34}"#, "").unwrap();
        assert_eq!(slip.currency, None);
        assert_eq!(slip.totals.total_minor, 1_234);
    }
}
