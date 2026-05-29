/**
 * Reporting DB queries — raw parameterized SQL, ported 1:1 from Go
 * internal/reporting/store.go.
 *
 * Every query includes WHERE organization_id=$1 (app-layer isolation on top
 * of RLS). We connect as table owner so RLS is bypassed, making the explicit
 * predicate the authoritative guard.
 *
 * MONEY INVARIANT: Neon NUMERIC columns arrive as strings from the driver.
 * We pass them through unchanged — callers use lib/money for arithmetic.
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";
import type { PLLine, BSLine, VATLine, CashFlowRow, SpendingTrendRow, NetWorthInput } from "./types";

// ─── Org kind ────────────────────────────────────────────────────────────────

/**
 * fetchOrgKind — port of Go OrgKind().
 * Returns "personal" | "business", or null if the org does not exist.
 */
export async function fetchOrgKind(env: Env, orgId: string): Promise<string | null> {
  const row = await queryOne(
    env,
    `SELECT kind::text AS kind FROM organizations WHERE id = $1`,
    [orgId],
  );
  return row ? (row.kind as string) : null;
}

// ─── Profit & Loss ──────────────────────────────────────────────────────────

/**
 * fetchPLLines — port of Go Store.FetchPLLines.
 *
 * income accounts : credit − debit (normal credit-side balance, positive).
 * expense accounts: debit − credit (normal debit-side balance, positive).
 * Both are returned as positive for "normal" activity.
 */
export async function fetchPLLines(
  env: Env,
  orgId: string,
  from: string,
  to: string,
): Promise<PLLine[]> {
  const rows = await queryRows(
    env,
    `SELECT
       a.id::text                                      AS account_id,
       COALESCE(a.code, '')                            AS code,
       a.name,
       a.type::text                                    AS account_type,
       CASE a.type
         WHEN 'income'  THEN COALESCE(SUM(le.credit - le.debit),  0)
         WHEN 'expense' THEN COALESCE(SUM(le.debit  - le.credit), 0)
         ELSE 0
       END                                             AS net_balance
     FROM accounts a
     LEFT JOIN ledger_entries le
       ON  le.account_id      = a.id
       AND le.organization_id = a.organization_id
       AND le.posted_date    >= $2
       AND le.posted_date    <= $3
     WHERE a.organization_id = $1
       AND a.type IN ('income', 'expense')
       AND NOT a.is_archived
     GROUP BY a.id, a.code, a.name, a.type
     ORDER BY a.type, a.code NULLS LAST, a.name`,
    [orgId, from, to],
  );
  return rows.map((r) => ({
    account_id: r.account_id as string,
    code: r.code as string,
    name: r.name as string,
    account_type: r.account_type as string,
    net_balance: String(r.net_balance ?? "0"),
  }));
}

// ─── Balance Sheet ──────────────────────────────────────────────────────────

/**
 * fetchBSLines — port of Go Store.FetchBSLines.
 * Balance sheet is as-of a single date (to date), so we only pass `asOf`.
 */
export async function fetchBSLines(
  env: Env,
  orgId: string,
  asOf: string,
): Promise<BSLine[]> {
  const rows = await queryRows(
    env,
    `SELECT
       a.id::text                                      AS account_id,
       COALESCE(a.code, '')                            AS code,
       a.name,
       a.type::text                                    AS account_type,
       CASE a.type
         WHEN 'asset'     THEN COALESCE(SUM(le.debit  - le.credit), 0)
         WHEN 'liability' THEN COALESCE(SUM(le.credit - le.debit),  0)
         WHEN 'equity'    THEN COALESCE(SUM(le.credit - le.debit),  0)
         ELSE 0
       END                                             AS balance
     FROM accounts a
     LEFT JOIN ledger_entries le
       ON  le.account_id      = a.id
       AND le.organization_id = a.organization_id
       AND le.posted_date    <= $2
     WHERE a.organization_id = $1
       AND a.type IN ('asset', 'liability', 'equity')
       AND NOT a.is_archived
     GROUP BY a.id, a.code, a.name, a.type
     ORDER BY a.type, a.code NULLS LAST, a.name`,
    [orgId, asOf],
  );
  return rows.map((r) => ({
    account_id: r.account_id as string,
    code: r.code as string,
    name: r.name as string,
    account_type: r.account_type as string,
    balance: String(r.balance ?? "0"),
  }));
}

// ─── VAT Summary ─────────────────────────────────────────────────────────────

/**
 * fetchVATLines — port of Go Store.FetchVATLines.
 * output = tax collected on sales (income account direction).
 * input  = tax paid on purchases (expense account direction).
 */
export async function fetchVATLines(
  env: Env,
  orgId: string,
  from: string,
  to: string,
): Promise<VATLine[]> {
  const rows = await queryRows(
    env,
    `SELECT
       tr.id::text                                                   AS tax_rate_id,
       tr.code,
       tr.name,
       tr.rate::text                                                 AS rate,
       COALESCE(SUM(t.amount - COALESCE(t.tax, 0)), 0)              AS net,
       COALESCE(SUM(COALESCE(t.tax, 0)), 0)                         AS tax_amount,
       CASE WHEN a.type IN ('income') THEN 'output' ELSE 'input' END AS direction
     FROM transactions t
     JOIN tax_rates tr
       ON tr.id = t.tax_rate_id
     LEFT JOIN transaction_classifications tc
       ON tc.id = t.current_classification_id
     LEFT JOIN accounts a
       ON a.id = tc.account_id
     WHERE t.organization_id = $1
       AND t.posted_date >= $2
       AND t.posted_date <= $3
       AND t.tax_rate_id IS NOT NULL
       AND COALESCE(t.tax, 0) > 0
     GROUP BY tr.id, tr.code, tr.name, tr.rate,
              CASE WHEN a.type IN ('income') THEN 'output' ELSE 'input' END
     ORDER BY direction DESC, tr.code, tr.name`,
    [orgId, from, to],
  );
  return rows.map((r) => ({
    tax_rate_id: r.tax_rate_id as string,
    code: r.code as string,
    name: r.name as string,
    rate: String(r.rate ?? "0"),
    net: String(r.net ?? "0"),
    tax_amount: String(r.tax_amount ?? "0"),
    direction: r.direction as string,
  }));
}

// ─── Cash Flow ───────────────────────────────────────────────────────────────

/**
 * fetchCashFlowRows — port of Go Store.FetchCashFlowRows.
 * Aggregates per-month totals; direction: credit | debit | transfer.
 */
export async function fetchCashFlowRows(
  env: Env,
  orgId: string,
  from: string,
  to: string,
): Promise<CashFlowRow[]> {
  const rows = await queryRows(
    env,
    `SELECT
       TO_CHAR(posted_date, 'YYYY-MM') AS month,
       direction::text                 AS direction,
       COALESCE(SUM(amount), 0)        AS amount
     FROM transactions
     WHERE organization_id = $1
       AND posted_date >= $2
       AND posted_date <= $3
       AND amount IS NOT NULL
     GROUP BY month, direction
     ORDER BY month, direction`,
    [orgId, from, to],
  );
  return rows.map((r) => ({
    month: r.month as string,
    direction: r.direction as string,
    amount: String(r.amount ?? "0"),
  }));
}

// ─── Spending Trend ──────────────────────────────────────────────────────────

/**
 * fetchSpendingTrendRows — port of Go Store.FetchSpendingTrendRows.
 * Debit (expense) transactions joined to categories, aggregated by month.
 */
export async function fetchSpendingTrendRows(
  env: Env,
  orgId: string,
  from: string,
  to: string,
): Promise<SpendingTrendRow[]> {
  const rows = await queryRows(
    env,
    `SELECT
       c.id::text                             AS category_id,
       c.name                                 AS category_name,
       TO_CHAR(t.posted_date, 'YYYY-MM')      AS month,
       COALESCE(SUM(t.amount), 0)             AS amount
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.organization_id = $1
       AND t.posted_date >= $2
       AND t.posted_date <= $3
       AND t.direction = 'debit'
       AND t.amount IS NOT NULL
     GROUP BY c.id, c.name, month
     ORDER BY month, c.name`,
    [orgId, from, to],
  );
  return rows.map((r) => ({
    category_id: r.category_id as string,
    category_name: r.category_name as string,
    month: r.month as string,
    amount: String(r.amount ?? "0"),
  }));
}

// ─── Net Worth ───────────────────────────────────────────────────────────────

/**
 * fetchNetWorthSeries — port of Go Store.FetchNetWorthSeries.
 * CTE unions asset_valuations + liability_balances, latest per month end,
 * and aggregates one row per calendar month in the period.
 */
export async function fetchNetWorthSeries(
  env: Env,
  orgId: string,
  from: string,
  to: string,
): Promise<NetWorthInput[]> {
  const rows = await queryRows(
    env,
    `WITH months AS (
       SELECT
         TO_CHAR(gs, 'YYYY-MM-DD')::date AS month_end
       FROM generate_series(
         DATE_TRUNC('month', $2::date),
         DATE_TRUNC('month', $3::date),
         INTERVAL '1 month'
       ) gs
     ),
     asset_vals AS (
       SELECT
         m.month_end,
         a.organization_id,
         av.asset_id,
         av.value,
         ROW_NUMBER() OVER (
           PARTITION BY a.organization_id, av.asset_id, m.month_end
           ORDER BY av.as_of DESC
         ) AS rn
       FROM months m
       JOIN asset_valuations av ON av.as_of <= m.month_end
       JOIN assets a ON a.id = av.asset_id
       WHERE a.organization_id = $1
         AND NOT a.is_archived
     ),
     liab_vals AS (
       SELECT
         m.month_end,
         l.organization_id,
         lb.liability_id,
         lb.balance,
         ROW_NUMBER() OVER (
           PARTITION BY l.organization_id, lb.liability_id, m.month_end
           ORDER BY lb.as_of DESC
         ) AS rn
       FROM months m
       JOIN liability_balances lb ON lb.as_of <= m.month_end
       JOIN liabilities l ON l.id = lb.liability_id
       WHERE l.organization_id = $1
         AND NOT l.is_archived
     )
     SELECT
       TO_CHAR(m.month_end, 'YYYY-MM-DD')  AS date,
       COALESCE(SUM(av.value),   0)         AS total_assets,
       COALESCE(SUM(lv.balance), 0)         AS total_debt
     FROM months m
     LEFT JOIN asset_vals av
       ON av.month_end = m.month_end
       AND av.organization_id = $1
       AND av.rn = 1
     LEFT JOIN liab_vals lv
       ON lv.month_end = m.month_end
       AND lv.organization_id = $1
       AND lv.rn = 1
     GROUP BY m.month_end
     ORDER BY m.month_end`,
    [orgId, from, to],
  );
  return rows.map((r) => ({
    date: r.date as string,
    total_assets: String(r.total_assets ?? "0"),
    total_debt: String(r.total_debt ?? "0"),
  }));
}
