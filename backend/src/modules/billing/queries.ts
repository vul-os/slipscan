/**
 * Billing queries — usage stats and model preference.
 * All raw parameterized SQL, org-filtered.
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";

// ── Usage ────────────────────────────────────────────────────────────────────

export interface UsageStats {
  extractions_this_month: number;
  extractions_total: number;
  failed_this_month: number;
  input_tokens_this_month: number;
  output_tokens_this_month: number;
  storage_bytes: number;
  calls_last_7_days: Array<{ date: string; calls: number; failed: number }>;
}

export async function getUsageStats(env: Env, orgId: string): Promise<UsageStats> {
  // This-month date boundaries (ISO strings work in Postgres comparisons).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  // Extractions this month (succeeded + failed).
  const monthRows = await queryRows(
    env,
    `SELECT
       COUNT(*)                                                        AS total,
       COUNT(*) FILTER (WHERE status = 'failed')                       AS failed,
       COALESCE(SUM(input_tokens),  0)                                 AS input_tokens,
       COALESCE(SUM(output_tokens), 0)                                 AS output_tokens
     FROM ai_runs
    WHERE organization_id = $1
      AND started_at >= $2
      AND started_at <  $3
      AND status IN ('succeeded','failed')`,
    [orgId, monthStart, monthEnd],
  );

  const monthRow = monthRows[0] ?? {};
  const extractions_this_month = Number(monthRow.total ?? 0);
  const failed_this_month      = Number(monthRow.failed ?? 0);
  const input_tokens_this_month  = Number(monthRow.input_tokens ?? 0);
  const output_tokens_this_month = Number(monthRow.output_tokens ?? 0);

  // Lifetime total extractions (all time, all statuses that have resolved).
  const totalRows = await queryRows(
    env,
    `SELECT COUNT(*) AS total
       FROM ai_runs
      WHERE organization_id = $1
        AND status IN ('succeeded','failed')`,
    [orgId],
  );
  const extractions_total = Number(totalRows[0]?.total ?? 0);

  // Storage: sum of document sizes for this org.
  const storageRows = await queryRows(
    env,
    `SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes
       FROM documents
      WHERE organization_id = $1`,
    [orgId],
  );
  const storage_bytes = Number(storageRows[0]?.total_bytes ?? 0);

  // Calls per day for the last 7 calendar days.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dailyRows = await queryRows(
    env,
    `SELECT
       TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
       COUNT(*)                                               AS calls,
       COUNT(*) FILTER (WHERE status = 'failed')              AS failed
     FROM ai_runs
    WHERE organization_id = $1
      AND started_at >= $2
      AND status IN ('succeeded','failed')
    GROUP BY 1
    ORDER BY 1`,
    [orgId, sevenDaysAgo],
  );

  // Build a dense 7-day series so the chart has a bar for every day.
  const byDate: Record<string, { calls: number; failed: number }> = {};
  for (const r of dailyRows) {
    byDate[r.date as string] = {
      calls:  Number(r.calls ?? 0),
      failed: Number(r.failed ?? 0),
    };
  }

  const calls_last_7_days: Array<{ date: string; calls: number; failed: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    calls_last_7_days.push({
      date:   key,
      calls:  byDate[key]?.calls  ?? 0,
      failed: byDate[key]?.failed ?? 0,
    });
  }

  return {
    extractions_this_month,
    extractions_total,
    failed_this_month,
    input_tokens_this_month,
    output_tokens_this_month,
    storage_bytes,
    calls_last_7_days,
  };
}

// ── Model listing ─────────────────────────────────────────────────────────────

export interface AIModelRow {
  id: string;
  model_id: string;
  display_name: string;
  is_default: boolean;
  is_active: boolean;
}

/** All active extraction models. */
export async function listExtractionModels(env: Env): Promise<AIModelRow[]> {
  const rows = await queryRows(
    env,
    `SELECT id, model_id, display_name, is_default, is_active
       FROM ai_models
      WHERE kind = 'extraction'
        AND is_active = true
      ORDER BY is_default DESC, display_name`,
    [],
  );
  return rows.map((r) => ({
    id:           r.id as string,
    model_id:     r.model_id as string,
    display_name: r.display_name as string,
    is_default:   r.is_default as boolean,
    is_active:    r.is_active as boolean,
  }));
}

/** The UUID of the model this org has selected (null = use default). */
export async function getOrgModelId(env: Env, orgId: string): Promise<string | null> {
  const row = await queryOne(
    env,
    `SELECT active_extraction_model_id FROM organizations WHERE id = $1`,
    [orgId],
  );
  return (row?.active_extraction_model_id as string | null) ?? null;
}

/**
 * Persist the org's preferred extraction model.
 * modelRowId must be a valid ai_models.id (UUID).
 */
export async function setOrgModelId(env: Env, orgId: string, modelRowId: string): Promise<void> {
  await queryRows(
    env,
    `UPDATE organizations
        SET active_extraction_model_id = $2
      WHERE id = $1`,
    [orgId, modelRowId],
  );
}

/**
 * Returns the model_id string (e.g. "gemini-2.5-flash") for the org's selected
 * model, falling back to the is_default=true row if the org has no preference.
 */
export async function resolveOrgModelName(env: Env, orgId: string): Promise<string> {
  // 1. Check if org has an explicit choice.
  const orgRow = await queryOne(
    env,
    `SELECT am.model_id
       FROM organizations o
       JOIN ai_models am ON am.id = o.active_extraction_model_id
      WHERE o.id = $1`,
    [orgId],
  );
  if (orgRow?.model_id) return orgRow.model_id as string;

  // 2. Fall back to the is_default row for extraction.
  const defaultRow = await queryOne(
    env,
    `SELECT model_id FROM ai_models
      WHERE kind = 'extraction' AND is_default = true AND is_active = true
      LIMIT 1`,
    [],
  );
  if (defaultRow?.model_id) return defaultRow.model_id as string;

  // 3. Absolute fallback (should never happen after the migration runs).
  return "gemini-2.5-flash";
}
