/**
 * Insights query builder — port of Go backend/internal/insights/run.go.
 *
 * All user-supplied filter values become positional SQL parameters ($1, $2, …).
 * The intent-driven SQL column names (merchant, category, month) are from a
 * closed switch — never user input — so they're safe to interpolate.
 *
 * Org scope ($1) is ALWAYS the first arg; missing-filter bugs cannot leak data
 * across orgs.
 */
import type { Env } from "../../bindings";
import { queryRows, queryOne } from "../../db/client";
import type { Filters, InsightDocument, Group, Totals } from "./types";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 200;
const MAX_GROUP_ROWS = 12;

// ─── WHERE clause builder ─────────────────────────────────────────────────────

/**
 * Port of Go buildWhere — assembles the WHERE clause and positional args.
 * orgId is always $1 so org isolation holds even if no other filter is set.
 */
export function buildWhere(orgId: string, f: Filters): { where: string; args: unknown[] } {
  const args: unknown[] = [orgId];
  const conds: string[] = ["organization_id = $1"];

  function add(cond: string, val: unknown): void {
    args.push(val);
    // Replace %d placeholder with the next positional index.
    conds.push(cond.replace("%d", String(args.length)));
  }

  const merchant = (f.merchant_contains ?? "").trim();
  if (merchant !== "") {
    // ILIKE for case-insensitive substring — escape LIKE metacharacters so
    // the model can't turn "%" into a free-text glob.
    add("merchant ILIKE '%%' || $%d || '%%'", escapeLike(merchant));
  }

  const category = (f.category ?? "").trim();
  if (category !== "") {
    add("category = $%d", category.toLowerCase());
  }

  const dateFrom = (f.date_from ?? "").trim();
  if (dateFrom !== "") {
    add("transaction_date >= $%d", dateFrom);
  }

  const dateTo = (f.date_to ?? "").trim();
  if (dateTo !== "") {
    add("transaction_date <= $%d", dateTo);
  }

  if (f.amount_min != null) {
    add("amount >= $%d", f.amount_min);
  }

  if (f.amount_max != null) {
    add("amount <= $%d", f.amount_max);
  }

  const currency = (f.currency ?? "").trim();
  if (currency !== "") {
    add("currency = $%d", currency.toUpperCase());
  }

  const status = (f.status ?? "").trim();
  if (status !== "") {
    add("status = $%d", status);
  }

  return { where: conds.join(" AND "), args };
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ─── Intent runners ────────────────────────────────────────────────────────────

/** Port of Go runList — returns matching transactions ordered by date desc. */
export async function runList(
  env: Env,
  where: string,
  args: unknown[],
  limit: number,
): Promise<InsightDocument[]> {
  let lim = limit <= 0 ? DEFAULT_LIST_LIMIT : limit;
  if (lim > MAX_LIST_LIMIT) lim = MAX_LIST_LIMIT;

  // LIMIT is a safe integer — not user-controlled (bounded above).
  const text = `
    SELECT id, COALESCE(merchant, ''), amount::float8, COALESCE(currency, ''),
           transaction_date, COALESCE(category, ''), status::text, created_at
    FROM transactions
    WHERE ${where}
    ORDER BY transaction_date DESC NULLS LAST, created_at DESC
    LIMIT ${lim}`;

  const rows = await queryRows(env, text, args);
  const out: InsightDocument[] = [];
  for (const r of rows) {
    const doc: InsightDocument = {
      id: String(r.id),
      status: String(r["status::text"] ?? r.status ?? ""),
      created_at: r.created_at != null
        ? new Date(String(r.created_at)).toISOString()
        : "",
    };
    const merchant = String(r["coalesce"] ?? r.merchant ?? "");
    if (merchant) doc.merchant = merchant;
    if (r.amount != null) doc.amount = Number(r.amount);
    const cur = String(r["coalesce"] ?? r.currency ?? "");
    if (cur) doc.currency = cur;
    if (r.transaction_date != null) {
      doc.transaction_date = new Date(String(r.transaction_date)).toISOString().slice(0, 10);
    }
    const cat = String(r.category ?? "");
    if (cat) doc.category = cat;
    out.push(doc);
  }
  return out;
}

/** Port of Go runList — reimplemented with named column aliases for clarity. */
export async function runListSafe(
  env: Env,
  where: string,
  args: unknown[],
  limit: number,
): Promise<InsightDocument[]> {
  let lim = limit <= 0 ? DEFAULT_LIST_LIMIT : limit;
  if (lim > MAX_LIST_LIMIT) lim = MAX_LIST_LIMIT;

  const text = `
    SELECT id,
           COALESCE(merchant, '') AS merchant,
           amount::float8         AS amount,
           COALESCE(currency, '') AS currency,
           transaction_date,
           COALESCE(category, '') AS category,
           status::text           AS status,
           created_at
    FROM transactions
    WHERE ${where}
    ORDER BY transaction_date DESC NULLS LAST, created_at DESC
    LIMIT ${lim}`;

  const rows = await queryRows(env, text, args);
  const out: InsightDocument[] = [];
  for (const r of rows) {
    const doc: InsightDocument = {
      id: String(r.id),
      status: String(r.status ?? ""),
      created_at: r.created_at != null
        ? new Date(String(r.created_at)).toISOString()
        : "",
    };
    if (r.merchant) doc.merchant = String(r.merchant);
    if (r.amount != null) doc.amount = Number(r.amount);
    if (r.currency) doc.currency = String(r.currency);
    if (r.transaction_date != null) {
      doc.transaction_date = new Date(String(r.transaction_date)).toISOString().slice(0, 10);
    }
    if (r.category) doc.category = String(r.category);
    out.push(doc);
  }
  return out;
}

/** Port of Go runSum — total amount + count + most common currency. */
export async function runSum(env: Env, where: string, args: unknown[]): Promise<Totals> {
  const sumRow = await queryOne(env, `
    SELECT COALESCE(SUM(amount::float8), 0) AS total, COUNT(*)::int AS cnt
    FROM transactions WHERE ${where}
  `, args);

  const total = sumRow ? Number(sumRow.total) : 0;
  const count = sumRow ? Number(sumRow.cnt) : 0;

  if (count === 0) {
    return { amount: total, count };
  }

  // Most common currency (separate query — mirrors Go exactly).
  const ccyRow = await queryOne(env, `
    SELECT currency
    FROM transactions
    WHERE ${where} AND currency IS NOT NULL
    GROUP BY currency
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `, args);

  const t: Totals = { amount: total, count };
  if (ccyRow && ccyRow.currency != null) {
    t.currency = String(ccyRow.currency);
  }
  return t;
}

/** Port of Go runCount. */
export async function runCount(env: Env, where: string, args: unknown[]): Promise<number> {
  const row = await queryOne(env, `
    SELECT COUNT(*)::int AS n FROM transactions WHERE ${where}
  `, args);
  return row ? Number(row.n) : 0;
}

/**
 * Port of Go runGroup — groups by a fixed identifier column (merchant | category).
 * col is from a closed switch in run.ts — never user input.
 */
export async function runGroup(
  env: Env,
  col: "merchant" | "category",
  where: string,
  args: unknown[],
): Promise<Group[]> {
  const text = `
    SELECT COALESCE(NULLIF(TRIM(${col}), ''), '(unknown)') AS key,
           COALESCE(SUM(amount::float8), 0)::float8 AS total,
           COUNT(*)::int AS cnt
    FROM transactions
    WHERE ${where}
    GROUP BY key
    ORDER BY total DESC NULLS LAST
    LIMIT ${MAX_GROUP_ROWS}`;

  const rows = await queryRows(env, text, args);
  return rows.map((r) => ({
    key: String(r.key),
    total: Number(r.total),
    count: Number(r.cnt),
  }));
}

/** Port of Go runByMonth — groups by YYYY-MM using date_trunc. */
export async function runByMonth(env: Env, where: string, args: unknown[]): Promise<Group[]> {
  const text = `
    SELECT to_char(date_trunc('month', COALESCE(transaction_date, created_at::date)), 'YYYY-MM') AS key,
           COALESCE(SUM(amount::float8), 0)::float8 AS total,
           COUNT(*)::int AS cnt
    FROM transactions
    WHERE ${where}
    GROUP BY key
    ORDER BY key DESC
    LIMIT ${MAX_GROUP_ROWS}`;

  const rows = await queryRows(env, text, args);
  return rows.map((r) => ({
    key: String(r.key),
    total: Number(r.total),
    count: Number(r.cnt),
  }));
}
