/**
 * Finance module types — port of Go internal/finance/store.go domain types.
 *
 * MONEY CONTRACT: All currency amounts from the DB arrive as strings (Neon
 * returns NUMERIC as string). Never coerce to a JS number for math.
 * Use lib/money (dec, add, sub, money, sum) exclusively.
 */

// ─── Spending ─────────────────────────────────────────────────────────────────

export interface CategoryTotal {
  category_id: string | null; // null for uncategorized
  category_name: string;
  kind: string; // "income" | "expense" | "transfer"
  total_amount: string; // NUMERIC as string
  tx_count: number;
}

export interface SpendingRow {
  category_id: string | null;
  category_name: string | null;
  category_kind: string | null;
  total_amount: string; // NUMERIC
  tx_count: string; // bigint from COUNT(*)
}

export interface TransactionSummaryRow {
  id: string;
  posted_date: string | null; // DATE as ISO string
  merchant: string | null;
  description: string | null;
  amount: string | null; // NUMERIC
  currency: string | null;
  direction: string;
  category_name: string | null;
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

export interface BudgetRow {
  id: string;
  organization_id: string;
  name: string;
  period: string; // budget_period enum
  start_date: string; // DATE as ISO string
  end_date: string | null;
  currency: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BudgetLineRow {
  id: string;
  budget_id: string;
  category_id: string | null;
  amount: string; // NUMERIC
  rollover: boolean;
}

export interface BudgetLineWithActual extends BudgetLineRow {
  actual: string; // computed — NUMERIC string
  remaining: string; // computed — NUMERIC string
}

export interface BudgetWithLines {
  budget: BudgetRow;
  lines: BudgetLineWithActual[];
}

export interface CreateBudgetInput {
  name: string;
  period: string;
  start_date: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
  currency: string;
}

export interface BudgetLineInput {
  category_id?: string;
  amount: number;
  rollover: boolean;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: string;
  organization_id: string;
  account_id: string | null;
  category_id: string | null;
  name: string;
  kind: string; // goal_kind enum
  target_amount: string; // NUMERIC
  current_amount: string; // NUMERIC
  target_date: string | null; // DATE
  currency: string;
  status: string; // goal_status enum
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  name: string;
  kind: string;
  target_amount: number;
  current_amount: number;
  target_date?: string; // YYYY-MM-DD
  currency: string;
  account_id?: string;
  category_id?: string;
}

// ─── Net worth ────────────────────────────────────────────────────────────────

export interface ValueRow {
  value: string; // NUMERIC
  currency: string;
}

export interface FxRateRow {
  quote: string;
  rate: string; // NUMERIC
}

export interface DateRow {
  as_of: string; // DATE
}

export interface AssetAtDateRow {
  value: string;
  currency: string;
}

// ─── HTTP response shapes (match Go exactly) ─────────────────────────────────

export interface CategoryOut {
  category_id?: string;
  category_name: string;
  kind: string;
  total_amount: number;
  share_percent: number;
  tx_count: number;
}

export interface TransactionOut {
  id: string;
  posted_date?: string;
  merchant?: string;
  description?: string;
  amount?: number;
  currency?: string;
  direction: string;
  category_name?: string;
}

export interface BudgetLineOut {
  id: string;
  category_id?: string;
  amount: number;
  rollover: boolean;
  actual: number;
  remaining: number;
}

export interface BudgetOut {
  id: string;
  name: string;
  period: string;
  start_date: string;
  end_date?: string;
  currency: string;
  is_active: boolean;
  lines: BudgetLineOut[];
}

export interface GoalOut {
  id: string;
  name: string;
  kind: string;
  target_amount: number;
  current_amount: number;
  progress_pct: number;
  target_date?: string;
  currency: string;
  status: string;
  account_id?: string;
  category_id?: string;
}

export interface NetWorthOut {
  as_of: string;
  base_currency: string;
  total_assets: number;
  total_holdings: number;
  total_liabs: number;
  net_worth: number;
}

export interface NetWorthPointOut {
  as_of: string;
  net_worth: number;
}
