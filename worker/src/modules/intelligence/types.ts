/**
 * Intelligence module types — port of Go backend/internal/intelligence/compute.go
 * and store.go type definitions.
 */

// ─── Recurring ────────────────────────────────────────────────────────────────

export interface RecurringRow {
  id: string;
  merchant_normalized: string;
  category_id: string | null;
  expected_amount: number | null; // null when DB returns NULL
  currency: string | null;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  next_expected_date: string | null;
}

// ─── Forecast ─────────────────────────────────────────────────────────────────

export interface MonthlyTotals {
  year: number;
  month: number; // 1–12
  in: number;   // credit sum
  out: number;  // debit sum
}

export interface ForecastPoint {
  month: string;           // "YYYY-MM"
  projected_inflow: number;
  projected_outflow: number;
  projected_net: number;
  projected_balance: number;
}

export interface ForecastResult {
  horizon: number;
  currency: string;
  points: ForecastPoint[];
  assumptions: string[];
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

export type AnomalyType = "duplicate" | "unusual_spend" | "missing_receipt";
export type Severity = "high" | "medium" | "low";

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: Severity;
  title: string;
  description: string;
  amount?: number;
  currency?: string;
  transaction_id?: string;
  detected_at: string; // RFC3339
}

export interface TxRow {
  id: string;
  posted_date: string | null;
  merchant_normalized: string | null;
  category_id: string | null;
  amount: number | null;
  currency: string | null;
  direction: string;
}

// ─── Tax readiness ────────────────────────────────────────────────────────────

export interface TaxReadinessData {
  vat_output: number;
  vat_input: number;
  total_expenses: number;
  documented_expenses: number;
  unreconciled_count: number;
}

export interface TaxComponent {
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

export interface TaxReadinessResult {
  score: number;
  vat_position?: number;
  documented_expense_pct: number;
  unreconciled_count: number;
  components: TaxComponent[];
}
