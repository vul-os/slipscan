//! slip-v2: the canonical JSON schema for extracted receipts/slips.
//!
//! Stored by slipscan-core in `document_extractions.payload`. All money is
//! `i64` minor units; rates are basis points (1500 = 15.00%).

use serde::{Deserialize, Serialize};

/// Schema identifier embedded in every payload.
pub const SLIP_SCHEMA_VERSION: &str = "slip-v2";

fn default_schema() -> String {
    SLIP_SCHEMA_VERSION.to_string()
}

/// A fully extracted slip/receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlipExtraction {
    /// Always `"slip-v2"`.
    #[serde(default = "default_schema")]
    pub schema: String,
    #[serde(default)]
    pub merchant: Option<MerchantInfo>,
    /// Purchase timestamp, RFC 3339 when known (date-only when the time is
    /// not printed on the slip).
    #[serde(default)]
    pub purchased_at: Option<String>,
    /// ISO-4217.
    #[serde(default)]
    pub currency: Option<String>,
    pub totals: Totals,
    #[serde(default)]
    pub line_items: Vec<LineItem>,
    /// Discount / reward / coupon lines that reduce the total. Amounts are
    /// negative.
    #[serde(default)]
    pub discounts: Vec<DiscountLine>,
    #[serde(default)]
    pub vat_breakdown: Vec<VatLine>,
    #[serde(default)]
    pub payment: Option<PaymentInfo>,
    /// Provider confidence 0..=1.
    #[serde(default)]
    pub confidence: Option<f64>,
    /// Computed locally (never by the model): do the line items sum to the
    /// stated total within tolerance?
    #[serde(default)]
    pub validation: Option<Validation>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MerchantInfo {
    pub name: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub vat_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Totals {
    #[serde(default)]
    pub subtotal_minor: Option<i64>,
    /// Total discount as a positive magnitude.
    #[serde(default)]
    pub discount_minor: Option<i64>,
    #[serde(default)]
    pub vat_minor: Option<i64>,
    #[serde(default)]
    pub tip_minor: Option<i64>,
    pub total_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineItem {
    pub description: String,
    /// Quantity may be fractional (e.g. 0.454 kg).
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub unit_price_minor: Option<i64>,
    pub total_minor: i64,
    /// Positive magnitude of a discount already applied to this line.
    #[serde(default)]
    pub discount_minor: Option<i64>,
    /// Suggested category label (taxonomy key, not an id), e.g.
    /// `"groceries.dairy"`.
    #[serde(default)]
    pub category: Option<String>,
    /// VAT rate in basis points.
    #[serde(default)]
    pub vat_rate_bps: Option<i64>,
}

/// A slip-level discount / loyalty reward / coupon line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscountLine {
    /// Verbatim line text from the receipt.
    pub description: String,
    /// Short human-readable label, e.g. "Loyalty reward".
    #[serde(default)]
    pub label: Option<String>,
    /// Always negative (it reduces the total).
    pub amount_minor: i64,
    /// One of `loyalty | promo | coupon | manager | other` when known.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VatLine {
    pub rate_bps: i64,
    pub base_minor: i64,
    pub vat_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PaymentInfo {
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub card_last4: Option<String>,
}

/// Locally computed arithmetic check: line items + discounts (+ VAT/tip when
/// the receipt lists lines VAT-exclusive) must reach `totals.total_minor`
/// within tolerance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Validation {
    pub sum_matches: bool,
    pub computed_total_minor: i64,
    /// `total_minor - computed_total_minor`.
    pub delta_minor: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slip_v2_round_trips() {
        let slip = SlipExtraction {
            schema: SLIP_SCHEMA_VERSION.to_string(),
            merchant: Some(MerchantInfo {
                name: "Pick n Pay".into(),
                vat_number: Some("4090001234".into()),
                ..Default::default()
            }),
            purchased_at: Some("2026-07-01T12:30:00Z".into()),
            currency: Some("ZAR".into()),
            totals: Totals {
                subtotal_minor: Some(10_000),
                discount_minor: Some(500),
                vat_minor: Some(1_425),
                tip_minor: None,
                total_minor: 10_925,
            },
            line_items: vec![LineItem {
                description: "Milk 2L".into(),
                quantity: Some(1.0),
                unit_price_minor: Some(3_499),
                total_minor: 3_499,
                discount_minor: None,
                category: Some("groceries.dairy".into()),
                vat_rate_bps: Some(1500),
            }],
            discounts: vec![DiscountLine {
                description: "SMART SHOPPER DISCOUNT".into(),
                label: Some("Loyalty reward".into()),
                amount_minor: -500,
                source: Some("loyalty".into()),
            }],
            vat_breakdown: vec![VatLine {
                rate_bps: 1500,
                base_minor: 9_500,
                vat_minor: 1_425,
            }],
            payment: Some(PaymentInfo {
                method: Some("card".into()),
                card_last4: Some("1234".into()),
            }),
            confidence: Some(0.97),
            validation: Some(Validation {
                sum_matches: true,
                computed_total_minor: 10_925,
                delta_minor: 0,
            }),
            warnings: vec![],
        };
        let json = serde_json::to_string(&slip).unwrap();
        let back: SlipExtraction = serde_json::from_str(&json).unwrap();
        assert_eq!(back, slip);
    }

    #[test]
    fn minimal_payload_parses_with_defaults() {
        let back: SlipExtraction =
            serde_json::from_str(r#"{"totals":{"total_minor":500}}"#).unwrap();
        assert_eq!(back.schema, SLIP_SCHEMA_VERSION);
        assert_eq!(back.totals.total_minor, 500);
        assert!(back.line_items.is_empty());
        assert!(back.discounts.is_empty());
        assert!(back.validation.is_none());
    }
}
