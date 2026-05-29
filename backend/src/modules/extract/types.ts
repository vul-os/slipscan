/**
 * Extract module types — port of backend/internal/extract/types.go.
 * DocumentKind and DocumentStatus mirror the Postgres enums defined in
 * backend/migrations/20260430000002_documents_chat.sql and
 * src/types/schema.ts (re-exported here for local use without cross-imports).
 */

export type DocumentKind = "slip" | "invoice" | "bank_statement" | "unknown";
export type DocumentStatus = "pending" | "processing" | "extracted" | "failed";

/** One purchased line on a slip or invoice (legacy shape — v1). */
export interface LineItem {
  description: string;
  qty: number;
  unit: number;
  amount: number;
}

/** Rich item shape returned by slip-v2 prompt. */
export interface RichItem {
  raw_text: string;
  normalized_name: string;
  category: string;
  qty: number;
  unit_price: number;
  amount: number;
  vat_status: "zero-rated" | "standard" | "exempt" | "unknown";
  confidence: number;
}

/** Discount / reward line returned by slip-v2 prompt. */
export interface DiscountItem {
  raw_text: string;
  label: string;
  amount: number; // negative number
  source: "loyalty" | "promo" | "coupon" | "manager" | "other";
}

/** Validation block computed after parsing (never from Gemini). */
export interface ExtractionValidation {
  sum_matches: boolean;
  computed_total: number;
  delta: number;
}

/** One row on a bank statement. */
export interface StatementLine {
  date: string;
  description: string;
  amount: number;
  balance: number;
}

/**
 * Canonical P1-01 → P1-02 handoff struct. Serialized as JSONB into
 * document_extractions.extracted (binding contract: see Go PHASE1-CONTRACT.md §2).
 *
 * v2 shape (slip-v2 prompt) adds: receipt_type, merchant_normalized,
 * discount_total, payment_method, receipt_number, items[], discounts[], validation.
 * Legacy line_items[] retained for invoice/bank_statement kinds.
 */
export interface Extracted {
  kind: DocumentKind;
  merchant: string;
  date: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  confidence: number;
  // v2 rich fields (slip kind only; undefined for invoice/bank_statement)
  receipt_type?: string;
  merchant_normalized?: string;
  discount_total?: number;
  payment_method?: string;
  receipt_number?: string | null;
  items?: RichItem[];
  discounts?: DiscountItem[];
  validation?: ExtractionValidation;
  // legacy fields (invoice/bank_statement)
  line_items?: LineItem[];
  statement_lines?: StatementLine[];
}

/** Minimal document row needed for extraction (mirrors Go docRow). */
export interface DocRow {
  id: string;
  organization_id: string;
  kind: string;
  status: string;
  storage_url: string;
  mime_type: string | null;
}

/** Shape Gemini returns before mapping to Extracted (v1 + v2 fields). */
export interface GeminiRaw {
  // shared
  merchant?: string | null;
  date?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  confidence?: number | null;
  // v2 slip fields
  receipt_type?: string | null;
  merchant_normalized?: string | null;
  discount_total?: number | null;
  payment_method?: string | null;
  receipt_number?: string | null;
  items?: Array<{
    raw_text?: string | null;
    normalized_name?: string | null;
    category?: string | null;
    qty?: number | null;
    unit_price?: number | null;
    amount?: number | null;
    vat_status?: string | null;
    confidence?: number | null;
  }>;
  discounts?: Array<{
    raw_text?: string | null;
    label?: string | null;
    amount?: number | null;
    source?: string | null;
  }>;
  // v1 legacy (invoice/bank_statement)
  line_items?: Array<{
    description?: string | null;
    qty?: number | null;
    unit?: number | null;
    amount?: number | null;
  }>;
  statement_lines?: Array<{
    date?: string | null;
    description?: string | null;
    amount?: number | null;
    balance?: number | null;
  }>;
}

/** Shape of the kind-detection response. */
export interface GeminiKind {
  kind: string;
  confidence?: number | null;
}
