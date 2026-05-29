/**
 * Extract module types — port of backend/internal/extract/types.go.
 * DocumentKind and DocumentStatus mirror the Postgres enums defined in
 * backend/migrations/20260430000002_documents_chat.sql and
 * src/types/schema.ts (re-exported here for local use without cross-imports).
 */

export type DocumentKind = "slip" | "invoice" | "bank_statement" | "unknown";
export type DocumentStatus = "pending" | "processing" | "extracted" | "failed";

/** One purchased line on a slip or invoice. */
export interface LineItem {
  description: string;
  qty: number;
  unit: number;
  amount: number;
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
 * JSON shape:
 * {
 *   "kind":       "slip|invoice|bank_statement",
 *   "merchant":   "WOOLWORTHS PTY LTD #4021",
 *   "date":       "2026-05-18",
 *   "currency":   "ZAR",
 *   "subtotal":   210.00,
 *   "tax":        31.50,
 *   "total":      241.50,
 *   "confidence": 0.94,
 *   "line_items": [...],          // slip|invoice only
 *   "statement_lines": [...]      // bank_statement only
 * }
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

/** Shape Gemini returns before mapping to Extracted. */
export interface GeminiRaw {
  merchant?: string | null;
  date?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  confidence?: number | null;
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
