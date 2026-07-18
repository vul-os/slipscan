//! The slip-v2 extraction prompt and JSON schema.
//!
//! Port of the legacy `extract/prompts.ts` slip prompt, adapted to the
//! slip-v2 wire shape in [`crate::wire`]. The prompt version string is
//! recorded alongside extractions so prompt changes stay traceable.

/// Version tag recorded with every extraction.
pub const PROMPT_VERSION_SLIP: &str = "slip-v2";

/// Category taxonomy the model must pick from (two-level, dot-separated).
pub const CATEGORY_TAXONOMY: &str = "\
groceries.{produce, dairy, meat, bakery, pantry, beverages, frozen, snacks, household, personal_care, baby, pet, other}
fuel.{petrol, diesel, other}
food.{restaurant, takeaway, cafe, fast_food, alcohol, other}
retail.{clothing, electronics, books, home, beauty, hobby, other}
transport.{rideshare, taxi, public, parking, tolls, other}
utilities.{electricity, water, internet, mobile, tv, other}
services.{health, beauty, repair, professional, financial, other}
entertainment.{movies, events, subscriptions, other}
travel.{flights, accommodation, car_rental, other}
medical.{pharmacy, doctor, hospital, other}
other";

/// Build the slip-v2 extraction prompt. `hint` is an optional user-supplied
/// nudge (e.g. "grocery slip").
pub fn slip_prompt(hint: Option<&str>) -> String {
    let mut prompt = format!(
        r#"You are a receipt parser (version: {PROMPT_VERSION_SLIP}).
Extract structured data from the attached image or PDF receipt.

OUTPUT RULES — read carefully before filling any field:
- Return STRICT JSON matching the schema. No markdown fences, no commentary.
- All money amounts: decimal numbers exactly as printed. No currency symbols, no thousand-separators.
- All amounts positive EXCEPT entries in the discounts array (negative numbers).
- date: ISO 8601 YYYY-MM-DD. Null if not visible. time: HH:MM (24h). Null if not visible.
- currency: 3-letter ISO code (USD, EUR, ZAR, JPY, ...). Null if absent.
- Use null for any field you cannot read confidently.

MERCHANT:
- name: brand name as printed (e.g. "SHOPRITE").
- branch: store/branch identifier or location if printed (e.g. "Usave #219 BELLVILLE").
- address: street address if printed. vat_number: the merchant VAT registration number if printed.

ITEMS ARRAY — one entry per purchased product/service line:
- description: verbatim line text from the receipt (e.g. "POTATO B BUY 7KG").
- quantity: quantity purchased (may be fractional, e.g. 0.454 for weighed goods). 1 if not stated.
- unit_price: price per unit. Null if not stated.
- total: line total as printed — MUST be positive.
- discount: positive amount of any discount already applied to this line. Null if none.
- category: two-level dot-separated category from this taxonomy:
{CATEGORY_TAXONOMY}
  If the sub-category is unclear use the parent + ".other" (e.g. "groceries.other").
- vat_rate_percent: the VAT/sales-tax rate applied to this line as a percentage, exactly as shown on the receipt (e.g. 15 for a 15% rate, 0 for zero-rated or tax-free items). Follow the receipt's own tax markings — do not assume any country's tax rules. Null if unknown.

DISCOUNTS ARRAY — any slip-level line that reduces the total (loyalty rewards,
promotional discounts, coupons, manager overrides). DO NOT include these in items.
- description: verbatim line text. label: short human-readable label (e.g. "Loyalty reward").
- amount: NEGATIVE number (e.g. -29.99).
- source: one of loyalty | promo | coupon | manager | other.

VAT BREAKDOWN — one entry per VAT rate shown in the receipt's tax summary:
- rate_percent: the rate (e.g. 15). base: the taxable amount. vat: the VAT amount.

TOTALS:
- subtotal: amount before VAT/discounts if printed. discount: total of all discounts as a POSITIVE number.
- vat: total VAT. tip: tip/gratuity if any. total: the grand total actually paid.

PAYMENT: method is one of cash | card | eft | loyalty | other — null if not shown.
card_last4: last 4 digits of the card if printed.

CONFIDENCE: overall self-rating 0.0-1.0. Be honest — this prioritises manual review.

IMPORTANT: any line with a negative amount belongs in discounts, never in items."#
    );
    if let Some(hint) = hint {
        prompt.push_str("\n\nUSER HINT: ");
        prompt.push_str(hint);
    }
    prompt
}

/// JSON schema for the wire shape, used for structured output on providers
/// that support it (Anthropic `output_config.format`).
pub fn slip_schema() -> serde_json::Value {
    let money = serde_json::json!({"type": ["number", "null"]});
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["merchant", "date", "time", "currency", "items", "discounts",
                     "vat_breakdown", "subtotal", "discount", "vat", "tip", "total",
                     "payment", "confidence"],
        "properties": {
            "merchant": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "required": ["name", "branch", "address", "vat_number"],
                "properties": {
                    "name": {"type": ["string", "null"]},
                    "branch": {"type": ["string", "null"]},
                    "address": {"type": ["string", "null"]},
                    "vat_number": {"type": ["string", "null"]}
                }
            },
            "date": {"type": ["string", "null"]},
            "time": {"type": ["string", "null"]},
            "currency": {"type": ["string", "null"]},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["description", "quantity", "unit_price", "total",
                                 "discount", "category", "vat_rate_percent"],
                    "properties": {
                        "description": {"type": "string"},
                        "quantity": {"type": ["number", "null"]},
                        "unit_price": money,
                        "total": {"type": "number"},
                        "discount": money,
                        "category": {"type": ["string", "null"]},
                        "vat_rate_percent": {"type": ["number", "null"]}
                    }
                }
            },
            "discounts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["description", "label", "amount", "source"],
                    "properties": {
                        "description": {"type": "string"},
                        "label": {"type": ["string", "null"]},
                        "amount": {"type": "number"},
                        "source": {"type": ["string", "null"],
                                    "enum": ["loyalty", "promo", "coupon", "manager", "other", null]}
                    }
                }
            },
            "vat_breakdown": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["rate_percent", "base", "vat"],
                    "properties": {
                        "rate_percent": {"type": "number"},
                        "base": {"type": "number"},
                        "vat": {"type": "number"}
                    }
                }
            },
            "subtotal": money,
            "discount": money,
            "vat": money,
            "tip": money,
            "total": money,
            "payment": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "required": ["method", "card_last4"],
                "properties": {
                    "method": {"type": ["string", "null"],
                                "enum": ["cash", "card", "eft", "loyalty", "other", null]},
                    "card_last4": {"type": ["string", "null"]}
                }
            },
            "confidence": {"type": ["number", "null"]}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_mentions_version_and_taxonomy() {
        let p = slip_prompt(None);
        assert!(p.contains(PROMPT_VERSION_SLIP));
        assert!(p.contains("groceries.{"));
        assert!(!p.contains("USER HINT"));
    }

    #[test]
    fn hint_is_appended() {
        let p = slip_prompt(Some("fuel slip"));
        assert!(p.ends_with("USER HINT: fuel slip"));
    }

    #[test]
    fn schema_is_an_object_schema() {
        let s = slip_schema();
        assert_eq!(s["type"], "object");
        assert_eq!(s["additionalProperties"], false);
        assert!(s["properties"]["items"]["items"]["properties"]["category"].is_object());
    }
}
