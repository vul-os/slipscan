/**
 * DB queries for the extraction pipeline.
 * Port of backend/internal/extract/store.go — raw parameterized SQL, 1:1.
 * Uses queryRows/queryOne for simple queries and withOrg for transactional
 * operations. Every org-scoped query includes WHERE organization_id = $ (belt
 * and suspenders — RLS is also enforced at the DB layer).
 */
import { Pool } from "@neondatabase/serverless";
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { Env } from "../../bindings";
import type { DocRow, Extracted, DocumentKind, DocumentStatus } from "./types";

const GEMINI_PROVIDER      = "google";
const GEMINI_DISPLAY_NAME  = "Gemini 2.5 Flash (extraction)";

// ---- Document reads ----

/** Fetch the minimal document row needed for extraction (org-filtered). */
export async function getDocument(env: Env, docId: string, orgId: string): Promise<DocRow | null> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, kind, status, storage_url, mime_type
       FROM documents
      WHERE id = $1 AND organization_id = $2`,
    [docId, orgId],
  );
  if (!row) return null;
  return {
    id:              row.id as string,
    organization_id: row.organization_id as string,
    kind:            row.kind as string,
    status:          row.status as string,
    storage_url:     row.storage_url as string,
    mime_type:       (row.mime_type as string | null) ?? null,
  };
}

/** Returns the default currency for an org (fallback "ZAR"). */
export async function getOrgCurrency(env: Env, orgId: string): Promise<string> {
  const row = await queryOne(
    env,
    `SELECT currency FROM organizations WHERE id = $1`,
    [orgId],
  );
  return (row?.currency as string | null | undefined) ?? "ZAR";
}

// ---- Document status transitions ----

/** Transition documents.status (and optionally documents.kind and error). */
export async function setDocumentStatus(
  env: Env,
  docId: string,
  status: DocumentStatus,
  kind: DocumentKind,
  errMsg: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE documents
        SET status = $2, kind = $3, error = NULLIF($4, '')
      WHERE id = $1`,
    [docId, status, kind, errMsg],
  );
}

// ---- AI model registry ----

/**
 * Upserts the Gemini extraction model into ai_models and returns its UUID.
 * Uses INSERT … ON CONFLICT DO NOTHING + SELECT (safe to call on every request).
 * Port of Go store.EnsureAIModel.
 */
export async function ensureAIModel(env: Env, modelId: string): Promise<string> {
  // Use queryRows (no transaction needed — idempotent upsert).
  await queryRows(
    env,
    `INSERT INTO ai_models (provider, model_id, display_name, kind, is_default, is_active)
     VALUES ($1, $2, $3, 'extraction', false, true)
     ON CONFLICT (provider, model_id, kind) DO NOTHING`,
    [GEMINI_PROVIDER, modelId, GEMINI_DISPLAY_NAME],
  );
  const row = await queryOne(
    env,
    `SELECT id FROM ai_models WHERE provider = $1 AND model_id = $2 AND kind = 'extraction'`,
    [GEMINI_PROVIDER, modelId],
  );
  if (!row) throw new Error("ensureAIModel: model row missing after upsert");
  return row.id as string;
}

// ---- ai_runs ----

/**
 * Inserts an ai_runs row in 'running' state and returns its UUID.
 * Port of Go store.CreateAIRun.
 */
export async function createAIRun(
  env: Env,
  orgId: string,
  modelId: string,
  docId: string,
  promptVersion: string,
): Promise<string> {
  const payload = JSON.stringify({ prompt_version: promptVersion });
  const rows = await queryRows(
    env,
    `INSERT INTO ai_runs (organization_id, model_id, target_type, target_id, status, started_at, request_payload)
     VALUES ($1, $2, 'document', $3, 'running', NOW(), $4)
     RETURNING id`,
    [orgId, modelId, docId, payload],
  );
  if (!rows.length) throw new Error("createAIRun: no id returned");
  return rows[0].id as string;
}

/**
 * Updates an ai_runs row to succeeded/failed with latency + optional error.
 * Port of Go store.FinishAIRun.
 */
export async function finishAIRun(
  env: Env,
  runId: string,
  status: "succeeded" | "failed",
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
  errMsg: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE ai_runs
        SET status = $2,
            finished_at = NOW(),
            latency_ms = $3,
            input_tokens = $4,
            output_tokens = $5,
            error = NULLIF($6, '')
      WHERE id = $1`,
    [runId, status, latencyMs, inputTokens, outputTokens, errMsg],
  );
}

// ---- document_extractions ----

/**
 * Inserts a new document_extractions row in 'processing' state and returns its UUID.
 * Port of Go store.CreateExtraction.
 */
export async function createExtraction(
  env: Env,
  docId: string,
  orgId: string,
  aiRunId: string,
  modelId: string,
): Promise<string> {
  const rows = await queryRows(
    env,
    `INSERT INTO document_extractions (document_id, organization_id, ai_run_id, model_id, status, is_current)
     VALUES ($1, $2, $3, $4, 'processing', false)
     RETURNING id`,
    [docId, orgId, aiRunId, modelId],
  );
  if (!rows.length) throw new Error("createExtraction: no id returned");
  return rows[0].id as string;
}

/**
 * Sets extracted JSONB, status=extracted, marks is_current=true on this row,
 * clears is_current on all other rows for this document, and updates
 * documents.current_extraction_id + documents.status — all in one transaction.
 * Port of Go store.CompleteExtraction.
 */
export async function completeExtraction(
  env: Env,
  orgId: string,
  extractionId: string,
  docId: string,
  extracted: Extracted,
  kind: DocumentKind,
): Promise<void> {
  const extractedJSON = JSON.stringify(extracted);
  await withOrg(env, orgId, null, async (q) => {
    // Clear is_current on any prior extraction.
    await q(
      `UPDATE document_extractions SET is_current = false WHERE document_id = $1 AND id <> $2`,
      [docId, extractionId],
    );
    // Mark this extraction as current + store result.
    await q(
      `UPDATE document_extractions
          SET status = 'extracted', extracted = $2, is_current = true
        WHERE id = $1`,
      [extractionId, extractedJSON],
    );
    // Update documents.
    await q(
      `UPDATE documents
          SET status = 'extracted', kind = $1, current_extraction_id = $2, error = NULL
        WHERE id = $3`,
      [kind, extractionId, docId],
    );
  });
}

/**
 * Stores the raw response, sets status=failed on document_extractions and
 * documents, and records the error message — in one transaction.
 * Port of Go store.FailExtraction.
 */
export async function failExtraction(
  env: Env,
  orgId: string,
  extractionId: string,
  docId: string,
  rawResp: string | null,
  errMsg: string,
): Promise<void> {
  await withOrg(env, orgId, null, async (q) => {
    await q(
      `UPDATE document_extractions
          SET status = 'failed', raw = $2, error = $3
        WHERE id = $1`,
      [extractionId, rawResp, errMsg],
    );
    await q(
      `UPDATE documents SET status = 'failed', error = $2 WHERE id = $1`,
      [docId, errMsg],
    );
  });
}

/**
 * Claim a batch of pending documents for processing using FOR UPDATE SKIP LOCKED.
 * Returns up to `limit` document IDs and transitions them to 'processing'.
 * Port of the Go cron batch-claim pattern.
 */
export async function claimPendingDocuments(
  env: Env,
  limit: number,
): Promise<Array<{ id: string; organization_id: string }>> {
  // We need a transaction to do FOR UPDATE + UPDATE atomically.
  // Use withOrg with a dummy orgId — the query is not org-scoped (it's a
  // system-level cron claim). We pass null for userId and bypass RLS by
  // targeting a plain transaction (the worker connects as table owner).
  // We use withOrg with an empty orgId since set_config does not affect DML.
  let claimed: Array<{ id: string; organization_id: string }> = [];
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      // Claim freshly-uploaded docs ('pending') AND self-heal any doc wedged in
      // 'processing' for >5 min — e.g. a prior run whose waitUntil/extraction was
      // cancelled by the Workers runtime. 5 min comfortably exceeds a full
      // extract+classify pass (two 60s-capped Gemini calls + classify), so an
      // actively-processing doc is never double-claimed.
      `SELECT id, organization_id
         FROM documents
        WHERE status = 'pending'
           OR (status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes')
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    ) as { rows: Array<{ id: string; organization_id: string }> };
    claimed = res.rows;
    if (claimed.length > 0) {
      const ids = claimed.map((r) => r.id);
      await client.query(
        `UPDATE documents SET status = 'processing' WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    (client as { release: () => void }).release();
    void pool.end().catch(() => {});
  }
  return claimed;
}

/**
 * Fetch a document_extraction row by its ID (org-filtered) for the API response.
 */
export async function getExtraction(
  env: Env,
  extractionId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  return queryOne(
    env,
    `SELECT id, document_id, organization_id, ai_run_id, model_id,
            status, raw, extracted, error, is_current, created_at, updated_at
       FROM document_extractions
      WHERE id = $1 AND organization_id = $2`,
    [extractionId, orgId],
  );
}
