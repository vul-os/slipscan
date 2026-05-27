/**
 * Financial report builders — pure functions, no I/O.
 * Port of Go internal/reporting/reports.go.
 *
 * MONEY INVARIANT: all arithmetic goes through lib/money (Decimal). Balances
 * are returned as money() strings (2 dp). Never use JS number for currency.
 */
import { dec, money, sum } from "../../lib/money";
import type {
  Period,
  ReportMeta,
  AccountLine,
  PLLine,
  PLReport,
  BSLine,
  BSReport,
  VATLine,
  VATReport,
  CashFlowRow,
  CashFlowMonth,
  CashFlowReport,
  SpendingTrendRow,
  SpendingTrendReport,
  NetWorthInput,
  NetWorthPoint,
  NetWorthReport,
} from "./types";
import { REGISTRY } from "./types";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ErrUnknownReport extends Error {
  constructor(name: string) {
    super(`unknown report name: "${name}"`);
    this.name = "ErrUnknownReport";
  }
}

export class ErrWrongOrgKind extends Error {
  constructor(report: string, kind: string) {
    super(`report not available for this org kind: "${report}" is not available for "${kind}" orgs`);
    this.name = "ErrWrongOrgKind";
  }
}

/**
 * Validate that `name` exists and is available for `orgKind`.
 * Throws ErrUnknownReport or ErrWrongOrgKind — callers map to HTTP status.
 */
export function validateReport(name: string, orgKind: string): ReportMeta {
  const meta = REGISTRY.find((m) => m.name === name);
  if (!meta) throw new ErrUnknownReport(name);
  if (!meta.kinds.has(orgKind)) throw new ErrWrongOrgKind(name, orgKind);
  return meta;
}

// ─── Profit & Loss ─────────────────────────────────────────────────────────

/**
 * BuildPL — port of Go BuildPL.
 * income: credit – debit (normal credit-side balance, positive).
 * expense: debit – credit (normal debit-side balance, positive).
 * netIncome = totalIncome − totalExpense (negative = loss).
 */
export function buildPL(period: Period, rows: PLLine[]): PLReport {
  const incomeLines: AccountLine[] = [];
  const expenseLines: AccountLine[] = [];
  let totalIncome = dec(0);
  let totalExpense = dec(0);

  for (const l of rows) {
    const line: AccountLine = {
      account_id: l.account_id,
      code: l.code,
      name: l.name,
      account_type: l.account_type,
      balance: money(l.net_balance),
    };
    if (l.account_type === "income") {
      incomeLines.push(line);
      totalIncome = totalIncome.plus(dec(l.net_balance));
    } else if (l.account_type === "expense") {
      expenseLines.push(line);
      totalExpense = totalExpense.plus(dec(l.net_balance));
    }
  }

  const netIncome = totalIncome.minus(totalExpense);

  return {
    period,
    income_lines: incomeLines,
    expense_lines: expenseLines,
    total_income: money(totalIncome),
    total_expense: money(totalExpense),
    net_income: money(netIncome),
  };
}

// ─── Balance Sheet ──────────────────────────────────────────────────────────

/**
 * BuildBalanceSheet — port of Go BuildBalanceSheet.
 * Assets: debit – credit (positive = asset value).
 * Liabilities/Equity: credit – debit (positive = owed/invested).
 * balanced = |assets − (liabilities + equity)| ≤ 0.01.
 */
export function buildBalanceSheet(asOf: string, rows: BSLine[]): BSReport {
  const assetLines: AccountLine[] = [];
  const liabilityLines: AccountLine[] = [];
  const equityLines: AccountLine[] = [];
  let totalAssets = dec(0);
  let totalLiabilities = dec(0);
  let totalEquity = dec(0);

  for (const l of rows) {
    const line: AccountLine = {
      account_id: l.account_id,
      code: l.code,
      name: l.name,
      account_type: l.account_type,
      balance: money(l.balance),
    };
    switch (l.account_type) {
      case "asset":
        assetLines.push(line);
        totalAssets = totalAssets.plus(dec(l.balance));
        break;
      case "liability":
        liabilityLines.push(line);
        totalLiabilities = totalLiabilities.plus(dec(l.balance));
        break;
      case "equity":
        equityLines.push(line);
        totalEquity = totalEquity.plus(dec(l.balance));
        break;
    }
  }

  const diff = totalAssets.minus(totalLiabilities.plus(totalEquity));
  const balanced = diff.abs().lte(dec("0.01"));

  return {
    as_of: asOf,
    asset_lines: assetLines,
    liability_lines: liabilityLines,
    equity_lines: equityLines,
    total_assets: money(totalAssets),
    total_liabilities: money(totalLiabilities),
    total_equity: money(totalEquity),
    balanced,
    diff: money(diff),
  };
}

// ─── VAT Summary ─────────────────────────────────────────────────────────────

/**
 * BuildVAT — port of Go BuildVAT.
 * output = tax collected on sales; input = tax paid on purchases.
 * netVATPayable = totalOutput − totalInput (negative = refund due).
 */
export function buildVAT(period: Period, rows: VATLine[]): VATReport {
  const outputLines: VATLine[] = [];
  const inputLines: VATLine[] = [];
  let totalOutput = dec(0);
  let totalInput = dec(0);

  for (const l of rows) {
    if (l.direction === "output") {
      outputLines.push(l);
      totalOutput = totalOutput.plus(dec(l.tax_amount));
    } else if (l.direction === "input") {
      inputLines.push(l);
      totalInput = totalInput.plus(dec(l.tax_amount));
    }
  }

  return {
    period,
    output_lines: outputLines,
    input_lines: inputLines,
    total_output_tax: money(totalOutput),
    total_input_tax: money(totalInput),
    net_vat_payable: money(totalOutput.minus(totalInput)),
  };
}

// ─── Cash Flow ───────────────────────────────────────────────────────────────

/**
 * BuildCashFlow — port of Go BuildCashFlow.
 * Credits = inflows; debits = outflows. Transfers ignored (avoid double-count).
 * Months sorted lexicographically (YYYY-MM sorts correctly).
 */
export function buildCashFlow(period: Period, rows: CashFlowRow[]): CashFlowReport {
  const byMonth = new Map<string, { in: ReturnType<typeof dec>; out: ReturnType<typeof dec> }>();
  const order: string[] = [];

  for (const row of rows) {
    if (row.direction === "transfer") continue;
    if (!byMonth.has(row.month)) {
      byMonth.set(row.month, { in: dec(0), out: dec(0) });
      order.push(row.month);
    }
    const m = byMonth.get(row.month)!;
    if (row.direction === "credit") {
      m.in = m.in.plus(dec(row.amount));
    } else if (row.direction === "debit") {
      m.out = m.out.plus(dec(row.amount));
    }
  }

  // Deduplicate and sort months.
  const uniqueMonths = [...new Set(order)].sort();

  const months: CashFlowMonth[] = [];
  let totalInflow = dec(0);
  let totalOutflow = dec(0);

  for (const mon of uniqueMonths) {
    const m = byMonth.get(mon)!;
    const net = m.in.minus(m.out);
    months.push({
      month: mon,
      inflow: money(m.in),
      outflow: money(m.out),
      net: money(net),
    });
    totalInflow = totalInflow.plus(m.in);
    totalOutflow = totalOutflow.plus(m.out);
  }

  return {
    period,
    months,
    total_inflow: money(totalInflow),
    total_outflow: money(totalOutflow),
    net_cash_flow: money(totalInflow.minus(totalOutflow)),
  };
}

// ─── Spending Trend ──────────────────────────────────────────────────────────

/**
 * BuildSpendingTrend — port of Go BuildSpendingTrend.
 * Returns per-(category, month) rows plus the sorted unique month list.
 */
export function buildSpendingTrend(period: Period, rows: SpendingTrendRow[]): SpendingTrendReport {
  const monthSet = new Set<string>();
  const out: SpendingTrendRow[] = [];

  for (const row of rows) {
    out.push({
      category_id: row.category_id,
      category_name: row.category_name,
      month: row.month,
      amount: money(row.amount),
    });
    monthSet.add(row.month);
  }

  const months = [...monthSet].sort();

  return { period, rows: out, months };
}

// ─── Net Worth ───────────────────────────────────────────────────────────────

/**
 * BuildNetWorth — port of Go BuildNetWorth.
 * net_worth = total_assets − total_debt per data point.
 */
export function buildNetWorth(period: Period, rows: NetWorthInput[]): NetWorthReport {
  const series: NetWorthPoint[] = rows.map((r) => ({
    date: r.date,
    total_assets: money(r.total_assets),
    total_debt: money(r.total_debt),
    net_worth: money(dec(r.total_assets).minus(dec(r.total_debt))),
  }));

  return { period, series };
}

// Re-export sum for use in tests (tree-shaken away if unused).
export { sum };
