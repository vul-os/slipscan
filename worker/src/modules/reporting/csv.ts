/**
 * CSV serialisation — port of Go internal/reporting/csv.go.
 *
 * All monetary values are already money() strings (2 dp) from the report
 * builders, so no additional formatting is needed here.
 *
 * RFC 4180 escaping: values containing comma, double-quote, or newline are
 * wrapped in double-quotes; embedded double-quotes are doubled.
 */
import type {
  PLReport,
  BSReport,
  VATReport,
  CashFlowReport,
  SpendingTrendReport,
  NetWorthReport,
} from "./types";

// ─── RFC 4180 primitives ─────────────────────────────────────────────────────

/** Escape a single CSV field per RFC 4180. */
function escapeField(v: string): string {
  // Fields needing quoting: contain comma, double-quote, CR, or LF.
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Serialise one CSV row (array of strings) to a CRLF-terminated line. */
function row(fields: string[]): string {
  return fields.map(escapeField).join(",") + "\r\n";
}

// ─── Report serialisers ──────────────────────────────────────────────────────

function writePL(r: PLReport): string {
  let out = row(["section", "account_id", "code", "name", "balance"]);
  for (const l of r.income_lines) {
    out += row(["income", l.account_id, l.code, l.name, l.balance]);
  }
  out += row(["income_total", "", "", "Total Income", r.total_income]);
  for (const l of r.expense_lines) {
    out += row(["expense", l.account_id, l.code, l.name, l.balance]);
  }
  out += row(["expense_total", "", "", "Total Expense", r.total_expense]);
  out += row(["net_income", "", "", "Net Income", r.net_income]);
  return out;
}

function writeBS(r: BSReport): string {
  let out = row(["section", "account_id", "code", "name", "balance"]);
  for (const l of r.asset_lines) {
    out += row(["asset", l.account_id, l.code, l.name, l.balance]);
  }
  out += row(["asset_total", "", "", "Total Assets", r.total_assets]);
  for (const l of r.liability_lines) {
    out += row(["liability", l.account_id, l.code, l.name, l.balance]);
  }
  out += row(["liability_total", "", "", "Total Liabilities", r.total_liabilities]);
  for (const l of r.equity_lines) {
    out += row(["equity", l.account_id, l.code, l.name, l.balance]);
  }
  out += row(["equity_total", "", "", "Total Equity", r.total_equity]);
  return out;
}

function writeVAT(r: VATReport): string {
  let out = row(["direction", "tax_rate_id", "code", "name", "rate", "net", "tax_amount"]);
  for (const l of r.output_lines) {
    out += row(["output", l.tax_rate_id, l.code, l.name, l.rate, l.net, l.tax_amount]);
  }
  out += row(["output_total", "", "", "Total Output VAT", "", "", r.total_output_tax]);
  for (const l of r.input_lines) {
    out += row(["input", l.tax_rate_id, l.code, l.name, l.rate, l.net, l.tax_amount]);
  }
  out += row(["input_total", "", "", "Total Input VAT", "", "", r.total_input_tax]);
  out += row(["net_vat_payable", "", "", "Net VAT Payable", "", "", r.net_vat_payable]);
  return out;
}

function writeCashFlow(r: CashFlowReport): string {
  let out = row(["month", "inflow", "outflow", "net"]);
  for (const m of r.months) {
    out += row([m.month, m.inflow, m.outflow, m.net]);
  }
  out += row(["total", r.total_inflow, r.total_outflow, r.net_cash_flow]);
  return out;
}

function writeSpendingTrend(r: SpendingTrendReport): string {
  let out = row(["category_id", "category_name", "month", "amount"]);
  for (const sr of r.rows) {
    out += row([sr.category_id, sr.category_name, sr.month, sr.amount]);
  }
  return out;
}

function writeNetWorth(r: NetWorthReport): string {
  let out = row(["date", "total_assets", "total_debt", "net_worth"]);
  for (const p of r.series) {
    out += row([p.date, p.total_assets, p.total_debt, p.net_worth]);
  }
  return out;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export type AnyReport =
  | PLReport
  | BSReport
  | VATReport
  | CashFlowReport
  | SpendingTrendReport
  | NetWorthReport;

/**
 * writeCSV — port of Go WriteCSV.
 * Returns the full CSV string for any supported report type.
 * Throws if the report type is not recognised (should never happen in practice).
 */
export function writeCSV(report: AnyReport): string {
  // Discriminate by presence of characteristic keys.
  if ("income_lines" in report) return writePL(report as PLReport);
  if ("asset_lines" in report) return writeBS(report as BSReport);
  if ("output_lines" in report) return writeVAT(report as VATReport);
  if ("months" in report && "total_inflow" in report) return writeCashFlow(report as CashFlowReport);
  if ("rows" in report && "months" in report) return writeSpendingTrend(report as SpendingTrendReport);
  if ("series" in report) return writeNetWorth(report as NetWorthReport);
  throw new Error("csv: unsupported report type");
}
