/**
 * DB queries for FX rates — port of backend/internal/fx/store.go.
 *
 * Uses raw parameterized SQL via queryRows / withOrg.
 * fx_rates has no organization_id column; it is a shared lookup table.
 * We use queryRows (no RLS required) for both read and upsert.
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";
import type { FetchResult } from "./client";

/**
 * Upsert all rates from result into fx_rates.
 * Conflict key: (base, quote, as_of) — idempotent.
 * Skips base==quote pairs and rate<=0 rows.
 */
export async function upsertRates(
  env:    Env,
  result: FetchResult,
  source: string,
): Promise<void> {
  if (!result.rates || Object.keys(result.rates).length === 0) return;

  const asOf = result.asOf.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const q = `
    INSERT INTO fx_rates (base, quote, rate, as_of, source)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (base, quote, as_of)
    DO UPDATE SET
      rate   = EXCLUDED.rate,
      source = EXCLUDED.source
  `;

  // Neon HTTP doesn't support multi-statement transactions for bulk inserts;
  // we issue individual parameterized upserts. The neon() tag handles
  // each call independently; the ON CONFLICT keeps it idempotent.
  for (const [quote, rate] of Object.entries(result.rates)) {
    if (quote === result.base) continue; // skip identity pair
    if (rate <= 0) continue;             // guard malformed responses
    await queryRows(env, q, [result.base, quote, rate, asOf, source]);
  }
}

/**
 * Returns the most recent as_of date in fx_rates for the given base,
 * or null if no rows exist yet.
 */
export async function lastSync(env: Env, base: string): Promise<Date | null> {
  const row = await queryOne(
    env,
    `SELECT MAX(as_of)::text AS max_date FROM fx_rates WHERE base = $1`,
    [base],
  );
  if (!row || !row.max_date) return null;
  return new Date(row.max_date as string);
}
