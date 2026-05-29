/**
 * Prompt strings and JSON schemas for the Gemini extraction pipeline.
 * Port of backend/internal/extract/prompts.go.
 *
 * Each prompt is paired with a responseSchema object that Gemini uses for
 * structured output. The version constants are recorded in ai_runs so prompt
 * A/B changes are traceable without losing the model-run trail.
 */
import type { DocumentKind } from "./types";

// ---- Prompt version constants (mirrors Go PromptVersion* consts) ----
export const PROMPT_VERSION_KIND_DETECT = "kind-detect-v1";
export const PROMPT_VERSION_SLIP        = "slip-v2";
export const PROMPT_VERSION_INVOICE     = "invoice-v1";
export const PROMPT_VERSION_STATEMENT   = "bank-statement-v1";

// ---- Kind detection ----

export const kindDetectPrompt = `You are a document classifier.
Examine the attached image or PDF and classify it as one of:
  slip          - A point-of-sale receipt or till slip
  invoice       - A tax invoice, purchase order, or billing document
  bank_statement - A bank or credit-card statement listing transactions

Rules:
- Use slip when you see a single retail purchase (merchant + line items + total).
- Use invoice when you see a formal invoice number, billing address, or supplier details.
- Use bank_statement when you see a running balance column with multiple dated transactions.
- If you genuinely cannot tell, default to slip.
- Return only the JSON below, nothing else.`;

export const kindDetectSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["slip", "invoice", "bank_statement"],
    },
    confidence: { type: "number", nullable: true },
  },
  required: ["kind"],
} as const;

// ---- Slip / receipt (v2 — rich structured extraction) ----

export const slipPrompt = `You are a receipt parser (version: slip-v2).
Extract structured data from the attached image or PDF receipt.

OUTPUT RULES — read carefully before filling any field:
- Return STRICT JSON matching the schema. No markdown fences, no commentary.
- All numbers: decimals only. No currency symbols. No thousand-separators.
- All amounts positive except discounts (which are negative numbers).
- date: ISO 8601 YYYY-MM-DD. Null if not visible.
- currency: 3-letter ISO code (ZAR, USD, EUR…). Null if absent.
- Use null for any field you cannot read confidently.

RECEIPT TYPE — set receipt_type to the single best match:
  groceries | fuel | food | retail | transport | utilities | services | entertainment | travel | medical | other
  Detect from the store header, logo, or the majority of items.

MERCHANT FIELDS:
- merchant: verbatim name as printed (e.g. "SHOPRITE Usave #219 BELLVILLE").
- merchant_normalized: clean brand name, no store number/location (e.g. "Shoprite").

ITEMS ARRAY — one entry per purchased product/service line:
- raw_text: verbatim line text from the receipt (e.g. "POTATO B BUY 7KG").
- normalized_name: clean human-readable product name (e.g. "Potatoes 7kg bag").
- category: two-level dot-separated category from this taxonomy:
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
    other
  If the sub-category is unclear use the parent + ".other" (e.g. "groceries.other").
- qty: quantity purchased (number). 1 if not stated.
- unit_price: price per unit (number). 0 if not stated.
- amount: line total — MUST be positive (number). 0 if unreadable.
- vat_status: one of zero-rated | standard | exempt | unknown
    South Africa zero-rated basics: bread, mealie meal, potatoes, milk, eggs, most vegetables,
    fruit, rice, lentils, dried beans, cooking oil, pilchards, brown bread flour, samp.
    standard: 15% VAT — most prepared food, electronics, clothing, fuel, restaurants.
    exempt: financial services, residential rent, education.
    unknown: when you genuinely cannot tell.
- confidence: per-item self-rating 0.0–1.0.

DISCOUNTS ARRAY — any line that reduces the total (loyalty rewards, promotional discounts,
  coupons, manager overrides, etc.). DO NOT include these in items.
- raw_text: verbatim line text from the receipt.
- label: short human-readable label (e.g. "Loyalty reward", "Promotional discount").
- amount: NEGATIVE number (e.g. -29.99).
- source: one of loyalty | promo | coupon | manager | other.

PAYMENT METHOD: cash | card | eft | loyalty | other — null if not shown.

CONFIDENCE (top-level): overall self-rating 0.0–1.0. Be honest — admins use this to prioritize manual review.

IMPORTANT: If a line item has a negative amount it MUST go into discounts, not items.`;

export const slipSchema = {
  type: "object",
  properties: {
    receipt_type:        { type: "string", nullable: true, enum: ["groceries","fuel","food","retail","transport","utilities","services","entertainment","travel","medical","other"] },
    merchant:            { type: "string", nullable: true },
    merchant_normalized: { type: "string", nullable: true },
    date:                { type: "string", nullable: true },
    currency:            { type: "string", nullable: true },
    subtotal:            { type: "number", nullable: true },
    tax:                 { type: "number", nullable: true },
    discount_total:      { type: "number", nullable: true },
    total:               { type: "number", nullable: true },
    payment_method:      { type: "string", nullable: true, enum: ["cash","card","eft","loyalty","other"] },
    receipt_number:      { type: "string", nullable: true },
    confidence:          { type: "number", nullable: true },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw_text:        { type: "string", nullable: true },
          normalized_name: { type: "string", nullable: true },
          category:        { type: "string", nullable: true },
          qty:             { type: "number", nullable: true },
          unit_price:      { type: "number", nullable: true },
          amount:          { type: "number", nullable: true },
          vat_status:      { type: "string", nullable: true, enum: ["zero-rated","standard","exempt","unknown"] },
          confidence:      { type: "number", nullable: true },
        },
      },
    },
    discounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw_text: { type: "string", nullable: true },
          label:    { type: "string", nullable: true },
          amount:   { type: "number", nullable: true },
          source:   { type: "string", nullable: true, enum: ["loyalty","promo","coupon","manager","other"] },
        },
      },
    },
  },
} as const;

// ---- Invoice ----

export const invoicePrompt = `You are an invoice parser (version: invoice-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: supplier / seller name as printed. Null if absent.
- date: invoice date, ISO 8601 YYYY-MM-DD. Null if absent.
- currency: 3-letter ISO code. Null if absent.
- subtotal: amount before tax. 0 if absent.
- tax: VAT/GST. 0 if absent.
- total: invoice total (subtotal + tax). 0 if absent.
- line_items: each billed line. Use [] if none visible.
  Each item: description, qty, unit (unit price), amount (line total).
- confidence: 0.0–1.0 self-rating.
- Numbers are decimals only. No currency symbols. No thousand-separators.`;

// invoiceSchema: invoice-v1 uses the old flat line_items shape, not the v2 rich items schema.
// Kept separate so the invoice prompt + schema stay consistent.
export const invoiceSchema = {
  type: "object",
  properties: {
    merchant:   { type: "string", nullable: true },
    date:       { type: "string", nullable: true },
    currency:   { type: "string", nullable: true },
    subtotal:   { type: "number", nullable: true },
    tax:        { type: "number", nullable: true },
    total:      { type: "number", nullable: true },
    confidence: { type: "number", nullable: true },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string", nullable: true },
          qty:         { type: "number", nullable: true },
          unit:        { type: "number", nullable: true },
          amount:      { type: "number", nullable: true },
        },
      },
    },
  },
} as const;

// ---- Bank statement ----

export const statementPrompt = `You are a bank statement parser (version: bank-statement-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: bank / institution name. Null if absent.
- date: statement date or end-date, ISO 8601 YYYY-MM-DD. Null if absent.
- currency: 3-letter ISO code. Null if absent.
- subtotal: 0 (not applicable for statements).
- tax: 0 (not applicable for statements).
- total: 0 (not applicable for statements).
- confidence: 0.0–1.0 self-rating.
- statement_lines: array of transaction rows on the statement.
  Each line: date (YYYY-MM-DD), description, amount (negative = debit), balance (running balance after transaction).
- Numbers are decimals only. Debits as negative numbers.`;

export const statementSchema = {
  type: "object",
  properties: {
    merchant:   { type: "string", nullable: true },
    date:       { type: "string", nullable: true },
    currency:   { type: "string", nullable: true },
    subtotal:   { type: "number", nullable: true },
    tax:        { type: "number", nullable: true },
    total:      { type: "number", nullable: true },
    confidence: { type: "number", nullable: true },
    statement_lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date:        { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          amount:      { type: "number", nullable: true },
          balance:     { type: "number", nullable: true },
        },
      },
    },
  },
} as const;

// ---- Helpers ----

/** Returns the prompt version string for a given kind (mirrors Go promptVersionFor). */
export function promptVersionFor(kind: DocumentKind): string {
  switch (kind) {
    case "slip":           return PROMPT_VERSION_SLIP;
    case "invoice":        return PROMPT_VERSION_INVOICE;
    case "bank_statement": return PROMPT_VERSION_STATEMENT;
    default:               return PROMPT_VERSION_KIND_DETECT;
  }
}

/** Returns the [prompt, schema] pair for a given kind (mirrors Go promptSchemaFor). */
export function promptSchemaFor(kind: DocumentKind): [string, unknown] {
  switch (kind) {
    case "invoice":        return [invoicePrompt,   invoiceSchema];
    case "bank_statement": return [statementPrompt, statementSchema];
    default:               return [slipPrompt,      slipSchema];
  }
}
