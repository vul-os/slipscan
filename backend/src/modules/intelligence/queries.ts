/**
 * Intelligence queries — port of Go backend/internal/intelligence/store.go.
 * Raw SQL ported 1:1; every org query has WHERE organization_id=$N.
 */
import type { Env } from "../../bindings";
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { RecurringRow, MonthlyTotals, TxRow, TaxReadinessData } from "./types";

// ─── Forecast ─────────────────────────────────────────────────────────────────

/**
 * Returns all active recurring transactions for the org.
 * Port of Go Store.ListActiveRecurring.
 */
export async function listActiveRecurring(env: Env, orgId: string): Promise<RecurringRow[]> {
  const rows = await queryRows(env, `
    SELECT id, merchant_normalized, category_id, expected_amount, currency,
           frequency, next_expected_date
    FROM recurring_transactions
    WHERE organization_id = $1
      AND status          = 'active'
    ORDER BY next_expected_date ASC NULLS LAST
  `, [orgId]);

  return rows.map((r) => ({
    id: String(r.id),
    merchant_normalized: String(r.merchant_normalized ?? ""),
    category_id: r.category_id != null ? String(r.category_id) : null,
    expected_amount: r.expected_amount != null ? Number(r.expected_amount) : null,
    currency: r.currency != null ? String(r.currency) : null,
    frequency: String(r.frequency) as RecurringRow["frequency"],
    next_expected_date: r.next_expected_date != null ? String(r.next_expected_date) : null,
  }));
}

/**
 * Returns the last N months of monthly in/out totals (oldest→newest).
 * Excludes rejected transactions.
 * Port of Go Store.HistoricalMonthlyTotals.
 */
export async function historicalMonthlyTotals(env: Env, orgId: string, months: number): Promise<MonthlyTotals[]> {
  if (months < 1) months = 12;
  const rows = await queryRows(env, `
    SELECT
      EXTRACT(YEAR  FROM posted_date)::int                    AS yr,
      EXTRACT(MONTH FROM posted_date)::int                    AS mo,
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount::float8 ELSE 0 END), 0) AS total_in,
      COALESCE(SUM(CASE WHEN direction='debit'  THEN amount::float8 ELSE 0 END), 0) AS total_out
    FROM transactions
    WHERE organization_id = $1
      AND status          != 'rejected'
      AND posted_date     >= date_trunc('month', NOW() - ($2::int - 1) * INTERVAL '1 month')
      AND posted_date      < date_trunc('month', NOW())
    GROUP BY yr, mo
    ORDER BY yr ASC, mo ASC
  `, [orgId, months]);

  return rows.map((r) => ({
    year: Number(r.yr),
    month: Number(r.mo),
    in: Number(r.total_in),
    out: Number(r.total_out),
  }));
}

/**
 * Returns the most common non-null currency on transactions, or "ZAR" fallback.
 * Port of Go Store.OrgCurrency.
 */
export async function orgCurrency(env: Env, orgId: string): Promise<string> {
  const row = await queryOne(env, `
    SELECT currency
    FROM transactions
    WHERE organization_id = $1
      AND currency IS NOT NULL
    GROUP BY currency
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `, [orgId]);
  if (!row || row.currency == null) return "ZAR";
  return String(row.currency);
}

// ─── Anomaly data ─────────────────────────────────────────────────────────────

/**
 * Returns non-rejected transactions in the last lookbackDays.
 * Port of Go Store.RecentTransactions.
 */
export async function recentTransactions(env: Env, orgId: string, lookbackDays: number): Promise<TxRow[]> {
  if (lookbackDays < 1) lookbackDays = 90;
  const rows = await queryRows(env, `
    SELECT id, posted_date, merchant_normalized, category_id, amount::float8, currency, direction
    FROM transactions
    WHERE organization_id = $1
      AND status          != 'rejected'
      AND posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
    ORDER BY posted_date DESC NULLS LAST, created_at DESC
  `, [orgId, lookbackDays]);

  return rows.map((r) => ({
    id: String(r.id),
    posted_date: r.posted_date != null ? String(r.posted_date) : null,
    merchant_normalized: r.merchant_normalized != null ? String(r.merchant_normalized) : null,
    category_id: r.category_id != null ? String(r.category_id) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    currency: r.currency != null ? String(r.currency) : null,
    direction: String(r.direction),
  }));
}

/**
 * Returns monthly debit spend per category over the lookback period.
 * Result: map of categoryID → float64[] (one entry per month seen).
 * Port of Go Store.CategorySpendHistory.
 */
export async function categorySpendHistory(env: Env, orgId: string, months: number): Promise<Map<string, number[]>> {
  if (months < 3) months = 12;
  const rows = await queryRows(env, `
    SELECT
      category_id::text,
      EXTRACT(YEAR  FROM posted_date)::int AS yr,
      EXTRACT(MONTH FROM posted_date)::int AS mo,
      COALESCE(SUM(amount::float8), 0)     AS total
    FROM transactions
    WHERE organization_id = $1
      AND status          != 'rejected'
      AND direction       = 'debit'
      AND category_id     IS NOT NULL
      AND posted_date     >= date_trunc('month', NOW() - ($2::int - 1) * INTERVAL '1 month')
      AND posted_date      < date_trunc('month', NOW())
    GROUP BY category_id, yr, mo
    ORDER BY category_id, yr, mo
  `, [orgId, months]);

  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const catId = String(r.category_id);
    if (!grouped.has(catId)) grouped.set(catId, []);
    grouped.get(catId)!.push(Number(r.total));
  }
  return grouped;
}

/**
 * Returns a Set of transaction IDs that have confirmed or auto reconciliation matches.
 * Port of Go Store.ReconciledTransactionIDs.
 */
export async function reconciledTransactionIds(env: Env, orgId: string): Promise<Set<string>> {
  const rows = await queryRows(env, `
    SELECT transaction_id
    FROM reconciliation_matches
    WHERE organization_id = $1
      AND state IN ('confirmed', 'auto')
  `, [orgId]);

  const out = new Set<string>();
  for (const r of rows) {
    out.add(String(r.transaction_id));
  }
  return out;
}

// ─── Tax readiness ────────────────────────────────────────────────────────────

/**
 * Returns all aggregated data needed for the tax readiness score.
 * Port of Go Store.GetTaxReadinessData — three separate queries.
 */
export async function getTaxReadinessData(env: Env, orgId: string, lookbackDays: number): Promise<TaxReadinessData> {
  if (lookbackDays < 1) lookbackDays = 365;

  // 1. VAT position
  const vatRow = await queryOne(env, `
    SELECT
      COALESCE(SUM(CASE WHEN t.direction = 'credit' THEN COALESCE(t.tax::float8, 0) ELSE 0 END), 0) AS vat_output,
      COALESCE(SUM(CASE WHEN t.direction = 'debit'  THEN COALESCE(t.tax::float8, 0) ELSE 0 END), 0) AS vat_input
    FROM transactions t
    WHERE t.organization_id = $1
      AND t.status          != 'rejected'
      AND t.tax_rate_id     IS NOT NULL
      AND t.posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
  `, [orgId, lookbackDays]);

  // 2. Document coverage
  const docRow = await queryOne(env, `
    SELECT
      COUNT(*)::int                                             AS total,
      COUNT(CASE WHEN document_id IS NOT NULL THEN 1 END)::int AS documented
    FROM transactions
    WHERE organization_id = $1
      AND direction       = 'debit'
      AND status          != 'rejected'
      AND posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
  `, [orgId, lookbackDays]);

  // 3. Unreconciled count
  const reconRow = await queryOne(env, `
    SELECT COUNT(*)::int AS n
    FROM transactions t
    WHERE t.organization_id = $1
      AND t.direction       = 'debit'
      AND t.status          != 'rejected'
      AND t.posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation_matches rm
        WHERE rm.transaction_id  = t.id
          AND rm.organization_id = t.organization_id
          AND rm.state           IN ('confirmed', 'auto')
      )
  `, [orgId, lookbackDays]);

  return {
    vat_output: vatRow ? Number(vatRow.vat_output) : 0,
    vat_input: vatRow ? Number(vatRow.vat_input) : 0,
    total_expenses: docRow ? Number(docRow.total) : 0,
    documented_expenses: docRow ? Number(docRow.documented) : 0,
    unreconciled_count: reconRow ? Number(reconRow.n) : 0,
  };
}
