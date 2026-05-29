/**
 * Classify module types — mirror of Go classify package structs.
 * All domain types for transactions, classifications, corrections, and signals.
 */
import type { ClassificationSource, ClassificationMatchType } from "../../types/schema";

// ─── Extracted document shape (contract from P1-01 extraction) ────────────────

export interface LineItem {
  description?: string | null;
  qty?: number | null;
  unit?: number | null;
  amount?: number | null;
}

export interface StatementLine {
  date: string;        // YYYY-MM-DD
  description: string;
  amount: number;
  balance?: number | null;
}

export interface Extracted {
  kind: string;          // slip|invoice|bank_statement
  merchant?: string;
  date?: string;         // YYYY-MM-DD
  currency?: string;     // ISO-4217
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  confidence?: number | null;
  line_items?: LineItem[];
  statement_lines?: StatementLine[];
}

// ─── Transaction record ───────────────────────────────────────────────────────

export interface Transaction {
  id: string;
  organization_id: string;
  document_id: string | null;
  document_extraction_id: string | null;
  uploaded_by: string | null;
  merchant: string;
  merchant_normalized: string;
  description: string;
  amount: number | null;
  currency: string;
  tax: number | null;
  posted_date: string | null;  // YYYY-MM-DD
  direction: "debit" | "credit" | "transfer";
  status: string;
  current_classification_id: string | null;
}

// ─── Classification record ────────────────────────────────────────────────────

export interface Classification {
  id?: string;
  transaction_id: string;
  organization_id: string;
  ai_run_id?: string | null;
  rule_id?: string | null;
  category_id?: string | null;
  account_id?: string | null;
  source: ClassificationSource;
  confidence: number;
  reasoning?: string;
  is_current: boolean;
}

// ─── Rule row (internal to cascade) ──────────────────────────────────────────

export interface RuleRow {
  id: string;
  match_type: ClassificationMatchType;
  match_value: string;
  category_id: string | null;
  account_id: string | null;
  confidence: number;
}

// ─── Signal row ───────────────────────────────────────────────────────────────

export interface Signal {
  category_label: string;
  vote_count: number;
}

// ─── Transaction list row (GET /transactions) ─────────────────────────────────

export interface TransactionRow {
  id: string;
  organization_id: string;
  document_id: string | null;
  merchant: string | null;
  merchant_normalized: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
  tax: number | null;
  posted_date: string | null;
  direction: string;
  status: string;
  current_classification_id: string | null;
  created_at: string;
  updated_at: string;
  // Classification fields (null when unclassified)
  class_source: ClassificationSource | null;
  class_confidence: number | null;
  class_category_id: string | null;
  class_account_id: string | null;
  category_name: string | null;
}

// ─── Category list item (GET /categories) ────────────────────────────────────

export interface CategoryItem {
  id: string;
  parent_id?: string | null;
  name: string;
  kind: string;
  icon?: string | null;
  color?: string | null;
}

// ─── Correction types ─────────────────────────────────────────────────────────

export interface CorrectionInput {
  category_id: string;    // new_category_id
  account_id?: string;    // new_account_id (optional)
}

export interface CorrectionResult {
  correction_id: string;
  classification_id: string;
  rule_promoted: boolean;
  rule_id?: string;
  backfill?: BackfillResult;
}

export interface BackfillResult {
  updated: number;
  skipped: number;
}

// ─── HTTP response shapes ─────────────────────────────────────────────────────

export interface TransactionResponse {
  id: string;
  organization_id: string;
  document_id?: string;
  merchant?: string;
  merchant_normalized?: string;
  amount?: number;
  currency?: string;
  tax?: number;
  posted_date?: string;
  direction: string;
  status: string;
  current_classification_id?: string;
  created_at?: string;
}

export interface TransactionListItem {
  id: string;
  organization_id: string;
  document_id?: string;
  merchant?: string;
  merchant_normalized?: string;
  description?: string;
  amount?: number;
  currency?: string;
  posted_date?: string;
  direction: string;
  status: string;
  classification_source?: string;
  classification_confidence?: number;
  category_id?: string;
  category_name?: string;
}
