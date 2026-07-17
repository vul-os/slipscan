//! Minimal, tolerant reader for the slip-v2 extraction payload.
//!
//! The canonical slip-v2 schema lives in `slipscan-extract`; core only stores
//! the payload as JSON (`document_extractions.payload`) and needs the money
//! fields to generate expense journals with a VAT split. To keep core at the
//! bottom of the dependency graph this module mirrors just that subset —
//! field names match `slipscan-extract::types` exactly, and unknown fields
//! are ignored.

use serde::Deserialize;

use crate::error::{CoreError, CoreResult};

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlipPayload {
    #[serde(default)]
    pub merchant: Option<SlipMerchant>,
    /// RFC 3339 purchase timestamp when known.
    #[serde(default)]
    pub purchased_at: Option<String>,
    /// ISO-4217.
    #[serde(default)]
    pub currency: Option<String>,
    pub totals: SlipTotals,
    #[serde(default)]
    pub line_items: Vec<SlipLineItem>,
    #[serde(default)]
    pub vat_breakdown: Vec<SlipVatLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlipMerchant {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlipTotals {
    #[serde(default)]
    pub vat_minor: Option<i64>,
    pub total_minor: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlipLineItem {
    /// Kept for future line-item-level journal narratives.
    #[serde(default)]
    #[allow(dead_code)]
    pub description: Option<String>,
    pub total_minor: i64,
    /// VAT rate in basis points, VAT-inclusive total.
    #[serde(default)]
    pub vat_rate_bps: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlipVatLine {
    pub rate_bps: i64,
    pub base_minor: i64,
    pub vat_minor: i64,
}

impl SlipPayload {
    pub(crate) fn parse(payload_json: &str) -> CoreResult<Self> {
        let slip: SlipPayload = serde_json::from_str(payload_json).map_err(|e| {
            CoreError::Validation(format!(
                "document payload is not a valid slip-v2 result: {e}"
            ))
        })?;
        Ok(slip)
    }

    /// Purchase date as `YYYY-MM-DD`, when `purchased_at` carries one.
    pub(crate) fn purchase_date(&self) -> Option<String> {
        let ts = self.purchased_at.as_deref()?;
        let date_part = ts.get(..10)?;
        crate::util::parse_date(date_part).ok()?;
        Some(date_part.to_string())
    }

    pub(crate) fn merchant_name(&self) -> Option<&str> {
        self.merchant.as_ref().map(|m| m.name.as_str())
    }

    /// VAT groups (rate, base, vat) for journal generation.
    ///
    /// Preference order:
    /// 1. the explicit `vat_breakdown`,
    /// 2. derived from line items carrying `vat_rate_bps` (VAT-inclusive),
    /// 3. a single group from `totals` (`vat_minor` against the rest).
    pub(crate) fn vat_groups(&self) -> Vec<VatGroup> {
        if !self.vat_breakdown.is_empty() {
            return self
                .vat_breakdown
                .iter()
                .map(|v| VatGroup {
                    rate_bps: Some(v.rate_bps),
                    base_minor: v.base_minor,
                    vat_minor: v.vat_minor,
                })
                .collect();
        }

        let tagged: Vec<&SlipLineItem> = self
            .line_items
            .iter()
            .filter(|li| li.vat_rate_bps.is_some())
            .collect();
        if !tagged.is_empty() && tagged.len() == self.line_items.len() {
            let mut groups: Vec<VatGroup> = Vec::new();
            for item in tagged {
                let rate = item.vat_rate_bps.unwrap_or(0);
                let vat = crate::vat::vat_from_inclusive(item.total_minor, rate);
                let base = item.total_minor - vat;
                match groups.iter_mut().find(|g| g.rate_bps == Some(rate)) {
                    Some(g) => {
                        g.base_minor += base;
                        g.vat_minor += vat;
                    }
                    None => groups.push(VatGroup {
                        rate_bps: Some(rate),
                        base_minor: base,
                        vat_minor: vat,
                    }),
                }
            }
            groups.sort_by_key(|g| g.rate_bps);
            // Per-item rounding can drift a few cents from the VAT figure the
            // supplier printed. The tax invoice's stated VAT is authoritative
            // for the input-VAT claim, so reconcile the dominant positive-rate
            // group to it (base absorbs the delta; the group's gross is kept).
            if let Some(stated) = self.totals.vat_minor {
                let derived: i64 = groups.iter().map(|g| g.vat_minor).sum();
                let delta = stated - derived;
                if delta != 0 {
                    if let Some(g) = groups
                        .iter_mut()
                        .filter(|g| g.rate_bps.unwrap_or(0) > 0)
                        .max_by_key(|g| (g.vat_minor, g.rate_bps))
                    {
                        g.vat_minor += delta;
                        g.base_minor -= delta;
                    }
                }
            }
            return groups;
        }

        let vat = self.totals.vat_minor.unwrap_or(0);
        vec![VatGroup {
            rate_bps: None,
            base_minor: self.totals.total_minor - vat,
            vat_minor: vat,
        }]
    }
}

/// One VAT-rate bucket of a slip: net base plus the VAT charged on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VatGroup {
    /// `None` when the slip did not state a rate.
    pub rate_bps: Option<i64>,
    pub base_minor: i64,
    pub vat_minor: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_explicit_vat_breakdown() {
        let slip = SlipPayload::parse(
            r#"{
                "totals": {"total_minor": 11500, "vat_minor": 1500},
                "line_items": [{"description": "x", "total_minor": 11500, "vat_rate_bps": 1500}],
                "vat_breakdown": [{"rate_bps": 1500, "base_minor": 10000, "vat_minor": 1500}]
            }"#,
        )
        .unwrap();
        assert_eq!(
            slip.vat_groups(),
            vec![VatGroup {
                rate_bps: Some(1500),
                base_minor: 10_000,
                vat_minor: 1_500
            }]
        );
    }

    #[test]
    fn derives_groups_from_line_items() {
        let slip = SlipPayload::parse(
            r#"{
                "totals": {"total_minor": 14500},
                "line_items": [
                    {"description": "wine", "total_minor": 11500, "vat_rate_bps": 1500},
                    {"description": "bread", "total_minor": 2000, "vat_rate_bps": 0},
                    {"description": "milk", "total_minor": 1000, "vat_rate_bps": 0}
                ]
            }"#,
        )
        .unwrap();
        let groups = slip.vat_groups();
        assert_eq!(
            groups,
            vec![
                VatGroup {
                    rate_bps: Some(0),
                    base_minor: 3_000,
                    vat_minor: 0
                },
                VatGroup {
                    rate_bps: Some(1500),
                    base_minor: 10_000,
                    vat_minor: 1_500
                },
            ]
        );
    }

    #[test]
    fn stated_total_vat_wins_over_per_item_rounding() {
        // 3 items of 105 minor at 15%: per-item VAT rounds to 3 × 14 = 42,
        // but the supplier's total-level figure is 41 (315 × 15/115 = 41.08).
        let slip = SlipPayload::parse(
            r#"{
                "totals": {"total_minor": 315, "vat_minor": 41},
                "line_items": [
                    {"description": "a", "total_minor": 105, "vat_rate_bps": 1500},
                    {"description": "b", "total_minor": 105, "vat_rate_bps": 1500},
                    {"description": "c", "total_minor": 105, "vat_rate_bps": 1500}
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(
            slip.vat_groups(),
            vec![VatGroup {
                rate_bps: Some(1500),
                base_minor: 274,
                vat_minor: 41
            }],
            "the stated tax-invoice VAT figure is authoritative"
        );

        // With no positive-rate group, the derived zero stays.
        let zero = SlipPayload::parse(
            r#"{
                "totals": {"total_minor": 200, "vat_minor": 5},
                "line_items": [
                    {"description": "bread", "total_minor": 200, "vat_rate_bps": 0}
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(
            zero.vat_groups(),
            vec![VatGroup {
                rate_bps: Some(0),
                base_minor: 200,
                vat_minor: 0
            }]
        );
    }

    #[test]
    fn falls_back_to_totals_when_untagged() {
        let slip = SlipPayload::parse(
            r#"{"totals": {"total_minor": 5000, "vat_minor": 652},
                "line_items": [{"description": "misc", "total_minor": 5000}]}"#,
        )
        .unwrap();
        assert_eq!(
            slip.vat_groups(),
            vec![VatGroup {
                rate_bps: None,
                base_minor: 4_348,
                vat_minor: 652
            }]
        );
    }

    #[test]
    fn purchase_date_extracts_valid_dates_only() {
        let slip = SlipPayload::parse(
            r#"{"purchased_at": "2026-07-01T12:30:00Z", "totals": {"total_minor": 1}}"#,
        )
        .unwrap();
        assert_eq!(slip.purchase_date().as_deref(), Some("2026-07-01"));

        let bad =
            SlipPayload::parse(r#"{"purchased_at": "yesterday", "totals": {"total_minor": 1}}"#)
                .unwrap();
        assert_eq!(bad.purchase_date(), None);
    }

    #[test]
    fn rejects_non_slip_payload() {
        assert!(SlipPayload::parse(r#"{"hello": "world"}"#).is_err());
    }
}
