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
export const PROMPT_VERSION_SLIP        = "slip-v1";
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

// ---- Slip / receipt ----

export const slipPrompt = `You are a receipt parser (version: slip-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: full name as printed (e.g. "WOOLWORTHS PTY LTD #4021"). Null if absent.
- date: ISO 8601 YYYY-MM-DD. Null if not visible.
- currency: 3-letter ISO code (ZAR, USD, EUR…). Null if absent.
- subtotal: amount before tax. 0 if not printed.
- tax: VAT/GST amount. 0 if none.
- total: final amount charged. 0 if not readable.
- line_items: array of purchased lines. Use [] if no lines visible.
  Each item: description (string), qty (number), unit (unit price, number), amount (line total, number).
- confidence: self-rating 0.0 – 1.0. Be honest — admins use this to decide what needs manual review.
- Numbers are decimals only. No currency symbols. No thousand-separators.`;

export const slipSchema = {
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

// invoiceSchema reuses slipSchema (same structure — mirrors Go invoiceSchema = slipSchema).
export const invoiceSchema = slipSchema;

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
