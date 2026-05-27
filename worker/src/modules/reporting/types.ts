/**
 * Reporting types — port of Go internal/reporting reports.go shared types.
 *
 * MONEY INVARIANT: all balance/amount fields are Decimal strings (from
 * lib/money). Never store or return JS number for currency values.
 */

// ─── Period ─────────────────────────────────────────────────────────────────

/** Inclusive date range, YYYY-MM-DD strings. */
export interface Period {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

// ─── Report registry ─────────────────────────────────────────────────────────

export interface ReportMeta {
  name: string;
  description: string;
  kinds: Set<string>; // "personal" | "business"
}

export const REGISTRY: ReportMeta[] = [
  { name: "profit-and-loss",  description: "Income vs expense accounts over the period",    kinds: new Set(["business"]) },
  { name: "balance-sheet",    description: "Assets = liabilities + equity at the end date", kinds: new Set(["business"]) },
  { name: "vat-summary",      description: "Output vs input VAT for the period",             kinds: new Set(["business"]) },
  { name: "cash-flow",        description: "Cash in vs out aggregated by month",             kinds: new Set(["personal"]) },
  { name: "spending-trend",   description: "Spend by category over time",                    kinds: new Set(["personal"]) },
  { name: "net-worth",        description: "Net worth time series",                          kinds: new Set(["personal"]) },
];

// ─── Shared row types ─────────────────────────────────────────────────────────

/** One row in a P&L or balance-sheet section. */
export interface AccountLine {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  balance: string; // money() string
}

// ─── Profit & Loss ─────────────────────────────────────────────────────────

/** One account's P&L contribution as returned from the DB. */
export interface PLLine {
  account_id: string;
  code: string;
  name: string;
  account_type: string; // "income" | "expense"
  net_balance: string;  // NUMERIC as string
}

export interface PLReport {
  period: Period;
  income_lines: AccountLine[];
  expense_lines: AccountLine[];
  total_income: string;
  total_expense: string;
  net_income: string;
}

// ─── Balance Sheet ─────────────────────────────────────────────────────────

export interface BSLine {
  account_id: string;
  code: string;
  name: string;
  account_type: string; // "asset" | "liability" | "equity"
  balance: string;      // NUMERIC as string
}

export interface BSReport {
  as_of: string;            // YYYY-MM-DD
  asset_lines: AccountLine[];
  liability_lines: AccountLine[];
  equity_lines: AccountLine[];
  total_assets: string;
  total_liabilities: string;
  total_equity: string;
  balanced: boolean;
  diff: string; // "0.00" when balanced
}

// ─── VAT Summary ─────────────────────────────────────────────────────────────

export interface VATLine {
  tax_rate_id: string;
  code: string;
  name: string;
  rate: string;       // NUMERIC as string (e.g. "15.0000")
  net: string;        // taxable amount excl tax, NUMERIC as string
  tax_amount: string; // NUMERIC as string
  direction: string;  // "output" | "input"
}

export interface VATReport {
  period: Period;
  output_lines: VATLine[];
  input_lines: VATLine[];
  total_output_tax: string;
  total_input_tax: string;
  net_vat_payable: string;
}

// ─── Cash Flow ───────────────────────────────────────────────────────────────

export interface CashFlowRow {
  month: string;     // "YYYY-MM"
  direction: string; // "credit" | "debit" | "transfer"
  amount: string;    // NUMERIC as string
}

export interface CashFlowMonth {
  month: string;   // "YYYY-MM"
  inflow: string;
  outflow: string;
  net: string;
}

export interface CashFlowReport {
  period: Period;
  months: CashFlowMonth[];
  total_inflow: string;
  total_outflow: string;
  net_cash_flow: string;
}

// ─── Spending Trend ──────────────────────────────────────────────────────────

export interface SpendingTrendRow {
  category_id: string;
  category_name: string;
  month: string;  // "YYYY-MM"
  amount: string; // NUMERIC as string
}

export interface SpendingTrendReport {
  period: Period;
  rows: SpendingTrendRow[];
  months: string[]; // unique months, sorted
}

// ─── Net Worth ───────────────────────────────────────────────────────────────

export interface NetWorthInput {
  date: string;         // "YYYY-MM-DD"
  total_assets: string; // NUMERIC as string
  total_debt: string;   // NUMERIC as string
}

export interface NetWorthPoint {
  date: string;
  total_assets: string;
  total_debt: string;
  net_worth: string;
}

export interface NetWorthReport {
  period: Period;
  series: NetWorthPoint[];
}
