/**
 * Cross-tenant merchant signal aggregation — port of Go signals.go Aggregate().
 *
 * Privacy model: merchant_signals has NO org/user references — only
 * merchant_normalized (TEXT), category_label (TEXT), vote_count (INTEGER),
 * and timestamps. Amounts, org IDs, and user IDs are NEVER written.
 *
 * The integrator wires this into the Worker's scheduled() handler.
 * Do NOT edit index.ts — import and call aggregateSignals there.
 *
 * Usage in scheduled():
 *   import { aggregateSignals } from "./modules/classify/signals";
 *   await aggregateSignals(env);
 */
import { queryRows } from "../../db/client";
import type { Env } from "../../bindings";

// ─── Tuneable defaults ────────────────────────────────────────────────────────

const DEFAULT_MIN_ORGS = 2;

function getMinOrgs(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>)["SIGNALS_MIN_ORGS"];
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (n > 0) return n;
  }
  return DEFAULT_MIN_ORGS;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * aggregateSignals reads classification_corrections across ALL orgs, groups by
 * (merchant_normalized, category_name), counts distinct org_ids, and upserts
 * merchant_signals for groups with >= minOrgs distinct organisations.
 *
 * Idempotent: re-running produces the same result.
 * PRIVACY: no amounts, org IDs, or user IDs are written — only aggregated
 * vote_count and timestamps. This is enforced by the SQL query itself.
 *
 * Exported for use in the Worker's scheduled() handler (cron.ts at the
 * integration layer).
 */
export async function aggregateSignals(env: Env): Promise<void> {
  const minOrgs = getMinOrgs(env);

  // PRIVACY: the query selects only merchant_normalized, category name,
  // COUNT(DISTINCT org_id), and MAX(created_at). No amounts, no org UUIDs,
  // no user UUIDs cross the boundary into merchant_signals.
  const rows = await queryRows(
    env,
    `INSERT INTO merchant_signals (merchant_normalized, category_label, vote_count, last_seen_at)
     SELECT
       cc.merchant_normalized,
       cat.name            AS category_label,
       COUNT(DISTINCT cc.organization_id) AS vote_count,
       MAX(cc.created_at)  AS last_seen_at
     FROM  classification_corrections cc
     JOIN  categories cat ON cat.id = cc.new_category_id
     WHERE cc.merchant_normalized IS NOT NULL
       AND cc.merchant_normalized <> ''
       AND cc.new_category_id     IS NOT NULL
     GROUP BY cc.merchant_normalized, cat.name
     HAVING COUNT(DISTINCT cc.organization_id) >= $1
     ON CONFLICT (merchant_normalized, category_label)
     DO UPDATE SET
       vote_count   = EXCLUDED.vote_count,
       last_seen_at = EXCLUDED.last_seen_at
     RETURNING merchant_normalized`,
    [minOrgs],
  );

  console.log(
    `classify: signals aggregated — ${rows.length} rows upserted (min_orgs=${minOrgs})`,
  );
}
