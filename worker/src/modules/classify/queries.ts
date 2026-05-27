/**
 * Raw SQL queries for the classify module — 1:1 port of Go store.go and the
 * query helpers embedded in classify.go / corrections.go / signals.go.
 * Uses the frozen queryRows / queryOne / withOrg foundation from db/client.
 */
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { Env } from "../../bindings";
import type {
  Transaction,
  Extracted,
  RuleRow,
  Signal,
  TransactionRow,
  CategoryItem,
  CorrectionInput,
  BackfillResult,
} from "./types";

// ─── Extraction ───────────────────────────────────────────────────────────────

export async function loadCurrentExtraction(
  env: Env,
  orgId: string,
  docId: string,
): Promise<{ extracted: Extracted; extractionId: string } | null> {
  const row = await queryOne(
    env,
    `SELECT de.id, de.extracted
     FROM document_extractions de
     WHERE de.document_id = $1
       AND de.organization_id = $2
       AND de.is_current = true
     LIMIT 1`,
    [docId, orgId],
  );
  if (!row) return null;
  const raw = row.extracted as string | Record<string, unknown>;
  const parsed: Extracted =
    typeof raw === "string" ? (JSON.parse(raw) as Extracted) : (raw as unknown as Extracted);
  return { extracted: parsed, extractionId: row.id as string };
}

// ─── Transaction persistence ──────────────────────────────────────────────────

export async function insertTransaction(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  t: Omit<Transaction, "id" | "current_classification_id">,
): Promise<string> {
  const rows = await q(
    `INSERT INTO transactions (
       organization_id, document_id, document_extraction_id,
       uploaded_by, merchant, merchant_normalized,
       description, amount, currency, tax,
       posted_date, direction, status
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12::transaction_direction, $13::transaction_status
     ) RETURNING id`,
    [
      t.organization_id,
      t.document_id,
      t.document_extraction_id,
      t.uploaded_by,
      t.merchant || null,
      t.merchant_normalized || null,
      t.description || null,
      t.amount,
      t.currency || null,
      t.tax,
      t.posted_date,
      t.direction,
      t.status,
    ],
  );
  return rows[0].id as string;
}

// ─── Classification rules ─────────────────────────────────────────────────────

export async function fetchRules(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
): Promise<RuleRow[]> {
  const rows = await q(
    `SELECT id, match_type, match_value, category_id, account_id, confidence
     FROM classification_rules
     WHERE organization_id = $1
     ORDER BY
       CASE match_type
         WHEN 'merchant_exact'    THEN 1
         WHEN 'merchant_contains' THEN 2
         WHEN 'merchant_regex'    THEN 3
       END,
       confidence DESC`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    match_type: r.match_type as RuleRow["match_type"],
    match_value: r.match_value as string,
    category_id: (r.category_id as string) ?? null,
    account_id: (r.account_id as string) ?? null,
    confidence: Number(r.confidence),
  }));
}

export async function bumpRule(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  ruleId: string,
): Promise<void> {
  await q(
    `UPDATE classification_rules
     SET applied_count = applied_count + 1,
         last_applied_at = NOW()
     WHERE id = $1`,
    [ruleId],
  );
}

// ─── Merchant signals ─────────────────────────────────────────────────────────

export async function lookupSignal(env: Env, merchantNormalized: string): Promise<Signal | null> {
  if (!merchantNormalized) return null;
  const row = await queryOne(
    env,
    `SELECT category_label, vote_count
     FROM merchant_signals
     WHERE merchant_normalized = $1
     ORDER BY vote_count DESC, last_seen_at DESC
     LIMIT 1`,
    [merchantNormalized],
  );
  if (!row) return null;
  return {
    category_label: row.category_label as string,
    vote_count: Number(row.vote_count),
  };
}

export async function mapSignalToCategory(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
  label: string,
): Promise<string | null> {
  if (!label) return null;
  const rows = await q(
    `SELECT id FROM categories
     WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [orgId, label],
  );
  return rows.length ? (rows[0].id as string) : null;
}

// ─── Org + categories for LLM ─────────────────────────────────────────────────

export async function loadOrgKind(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
): Promise<string> {
  const rows = await q(`SELECT kind FROM organizations WHERE id = $1`, [orgId]);
  return rows.length ? (rows[0].kind as string) : "business";
}

export async function loadCategoryNames(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
): Promise<string[]> {
  const rows = await q(
    `SELECT name FROM categories WHERE organization_id = $1 ORDER BY kind, name`,
    [orgId],
  );
  return rows.map((r) => r.name as string);
}

export async function findCategoryByName(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
  name: string,
): Promise<string | null> {
  const rows = await q(
    `SELECT id FROM categories
     WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [orgId, name],
  );
  return rows.length ? (rows[0].id as string) : null;
}

// ─── Write classification ─────────────────────────────────────────────────────

/**
 * Writes a transaction_classifications row within an already-open withOrg
 * transaction. Clears the old is_current row first (handles re-classification).
 * Returns the new classification id.
 */
export async function writeClassification(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  txId: string,
  orgId: string,
  opts: {
    ai_run_id?: string | null;
    rule_id?: string | null;
    category_id?: string | null;
    account_id?: string | null;
    source: string;
    confidence: number;
    reasoning?: string;
  },
): Promise<string> {
  // Clear existing is_current row.
  await q(
    `UPDATE transaction_classifications
     SET is_current = false
     WHERE transaction_id = $1 AND is_current = true`,
    [txId],
  );

  const rows = await q(
    `INSERT INTO transaction_classifications (
       transaction_id, organization_id, ai_run_id, rule_id,
       category_id, account_id,
       source, confidence, reasoning, is_current
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::classification_source, $8, $9, true)
     RETURNING id`,
    [
      txId,
      orgId,
      opts.ai_run_id ?? null,
      opts.rule_id ?? null,
      opts.category_id ?? null,
      opts.account_id ?? null,
      opts.source,
      opts.confidence,
      opts.reasoning ?? null,
    ],
  );
  const classId = rows[0].id as string;

  // Update denormalized pointer.
  await q(
    `UPDATE transactions SET current_classification_id = $1 WHERE id = $2`,
    [classId, txId],
  );

  return classId;
}

// ─── AI run tracking ──────────────────────────────────────────────────────────

export async function recordAIRunStart(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  orgId: string,
  txId: string,
): Promise<string | null> {
  // Find default classification model.
  let modelRows = await q(
    `SELECT id FROM ai_models
     WHERE kind = 'classification' AND is_default = true AND is_active = true
     LIMIT 1`,
    [],
  );
  if (!modelRows.length) {
    modelRows = await q(
      `SELECT id FROM ai_models
       WHERE kind = 'classification' AND is_active = true
       LIMIT 1`,
      [],
    );
  }
  if (!modelRows.length) return null;
  const modelId = modelRows[0].id as string;

  const runRows = await q(
    `INSERT INTO ai_runs (organization_id, model_id, target_type, target_id, status)
     VALUES ($1, $2, 'transaction', $3, 'running')
     RETURNING id`,
    [orgId, modelId, txId],
  );
  return runRows.length ? (runRows[0].id as string) : null;
}

export async function finishAIRun(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  runId: string,
  payload: string | null,
  error: Error | null,
  latencyMs: number,
): Promise<void> {
  const status = error ? "failed" : "succeeded";
  await q(
    `UPDATE ai_runs
     SET status = $2::ai_run_status,
         response_payload = $3,
         error = NULLIF($4, ''),
         latency_ms = $5,
         finished_at = NOW()
     WHERE id = $1`,
    [runId, status, payload, error?.message ?? "", latencyMs],
  );
}

// ─── List transactions ────────────────────────────────────────────────────────

export async function listTransactions(
  env: Env,
  orgId: string,
  limit: number,
  offset: number,
  documentId: string | null,
): Promise<TransactionRow[]> {
  const safeLimit = limit <= 0 || limit > 200 ? 50 : limit;
  const args: unknown[] = [orgId, safeLimit, offset];
  const docFilter = documentId ? ` AND t.document_id = $4` : "";
  if (documentId) args.push(documentId);

  const rows = await queryRows(
    env,
    `SELECT
       t.id, t.organization_id, t.document_id,
       t.merchant, t.merchant_normalized, t.description,
       t.amount, t.currency, t.tax, t.posted_date,
       t.direction, t.status,
       t.current_classification_id,
       t.created_at, t.updated_at,
       tc.source, tc.confidence, tc.category_id, tc.account_id,
       c.name
     FROM transactions t
     LEFT JOIN transaction_classifications tc
       ON tc.id = t.current_classification_id
     LEFT JOIN categories c
       ON c.id = tc.category_id
     WHERE t.organization_id = $1${docFilter}
     ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
     LIMIT $2 OFFSET $3`,
    args,
  );

  return rows.map((r) => ({
    id: r.id as string,
    organization_id: r.organization_id as string,
    document_id: (r.document_id as string) ?? null,
    merchant: (r.merchant as string) ?? null,
    merchant_normalized: (r.merchant_normalized as string) ?? null,
    description: (r.description as string) ?? null,
    amount: r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
    currency: (r.currency as string) ?? null,
    tax: r.tax !== null && r.tax !== undefined ? Number(r.tax) : null,
    posted_date: r.posted_date ? String(r.posted_date).slice(0, 10) : null,
    direction: r.direction as string,
    status: r.status as string,
    current_classification_id: (r.current_classification_id as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    class_source: (r.source as TransactionRow["class_source"]) ?? null,
    class_confidence:
      r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
    class_category_id: (r.category_id as string) ?? null,
    class_account_id: (r.account_id as string) ?? null,
    category_name: (r.name as string) ?? null,
  }));
}

// ─── List categories ──────────────────────────────────────────────────────────

export async function listCategories(env: Env, orgId: string): Promise<CategoryItem[]> {
  const rows = await queryRows(
    env,
    `SELECT id, parent_id, name, kind, icon, color
     FROM categories
     WHERE organization_id = $1
     ORDER BY (parent_id IS NOT NULL), name`,
    [orgId],
  );
  return rows.map((r) => {
    const item: CategoryItem = {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as string,
    };
    if (r.parent_id) item.parent_id = r.parent_id as string;
    if (r.icon) item.icon = r.icon as string;
    if (r.color) item.color = r.color as string;
    return item;
  });
}

// ─── Corrections ──────────────────────────────────────────────────────────────

/**
 * Returns the locked merchant_normalized + current_classification_id for a
 * transaction row (inside a withOrg transaction, using FOR UPDATE).
 */
export async function lockTransaction(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  txId: string,
  orgId: string,
): Promise<{ merchant_normalized: string | null; current_classification_id: string | null } | null> {
  const rows = await q(
    `SELECT merchant_normalized, current_classification_id
     FROM transactions
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [txId, orgId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    merchant_normalized: (r.merchant_normalized as string) ?? null,
    current_classification_id: (r.current_classification_id as string) ?? null,
  };
}

export async function fetchCurrentClassification(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  classId: string,
): Promise<{ id: string; category_id: string | null; account_id: string | null; source: string } | null> {
  const rows = await q(
    `SELECT id, category_id, account_id, source
     FROM transaction_classifications
     WHERE id = $1`,
    [classId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as string,
    category_id: (r.category_id as string) ?? null,
    account_id: (r.account_id as string) ?? null,
    source: r.source as string,
  };
}

export async function insertUserClassification(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  newClsId: string,
  txId: string,
  orgId: string,
  input: CorrectionInput,
): Promise<void> {
  await q(
    `INSERT INTO transaction_classifications
       (id, transaction_id, organization_id, category_id, account_id,
        source, confidence, is_current, created_at)
     VALUES ($1, $2, $3, $4, $5, 'user', 1.0, TRUE, NOW())`,
    [
      newClsId,
      txId,
      orgId,
      input.category_id || null,
      input.account_id || null,
    ],
  );
}

export async function clearOldIsCurrentFlag(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  oldClsId: string,
): Promise<void> {
  await q(
    `UPDATE transaction_classifications SET is_current = FALSE WHERE id = $1`,
    [oldClsId],
  );
}

export async function updateTransactionPointer(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  newClsId: string,
  txId: string,
  orgId: string,
  input: CorrectionInput,
): Promise<void> {
  await q(
    `UPDATE transactions
     SET current_classification_id = $1,
         category_id               = $2,
         account_id                = $3,
         updated_at                = NOW()
     WHERE id = $4 AND organization_id = $5`,
    [
      newClsId,
      input.category_id || null,
      input.account_id || null,
      txId,
      orgId,
    ],
  );
}

export async function insertCorrectionRecord(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  corrId: string,
  orgId: string,
  txId: string,
  merchantNorm: string | null,
  oldCategoryId: string | null,
  newCategoryId: string | null,
  oldSource: string | null,
  oldClsId: string | null,
  newClsId: string,
  correctedBy: string,
): Promise<void> {
  await q(
    `INSERT INTO classification_corrections
       (id, organization_id, transaction_id, merchant_normalized,
        old_category_id, new_category_id,
        old_source,
        old_classification_id, new_classification_id,
        corrected_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      corrId,
      orgId,
      txId,
      merchantNorm,
      oldCategoryId,
      newCategoryId,
      oldSource,
      oldClsId,
      newClsId,
      correctedBy,
    ],
  );
}

export async function countCorrections(
  env: Env,
  orgId: string,
  merchantNorm: string,
  categoryId: string,
): Promise<number> {
  const rows = await queryRows(
    env,
    `SELECT COUNT(DISTINCT transaction_id) AS cnt
     FROM classification_corrections
     WHERE organization_id     = $1
       AND merchant_normalized = $2
       AND new_category_id     = $3`,
    [orgId, merchantNorm, categoryId],
  );
  return rows.length ? Number(rows[0].cnt) : 0;
}

export async function upsertRule(
  env: Env,
  ruleId: string,
  orgId: string,
  merchantNorm: string,
  input: CorrectionInput,
): Promise<string> {
  const rows = await queryRows(
    env,
    `INSERT INTO classification_rules
       (id, organization_id, match_type, match_value,
        category_id, account_id,
        source, confidence, applied_count, last_applied_at,
        created_at, updated_at)
     VALUES ($1, $2, 'merchant_exact', $3, $4, $5, 'user', 1.0, 0, NULL, NOW(), NOW())
     ON CONFLICT (organization_id, match_type, match_value)
     DO UPDATE SET
       category_id = EXCLUDED.category_id,
       account_id  = EXCLUDED.account_id,
       updated_at  = NOW()
     RETURNING id`,
    [
      ruleId,
      orgId,
      merchantNorm,
      input.category_id || null,
      input.account_id || null,
    ],
  );
  return rows[0].id as string;
}

export async function getTransactionMerchantNorm(
  env: Env,
  orgId: string,
  txId: string,
): Promise<string | null> {
  const row = await queryOne(
    env,
    `SELECT merchant_normalized FROM transactions WHERE id = $1 AND organization_id = $2`,
    [txId, orgId],
  );
  if (!row) return null;
  return (row.merchant_normalized as string) ?? null;
}

export async function fetchBackfillCandidates(
  env: Env,
  orgId: string,
  merchantNorm: string,
  excludeTxId: string,
): Promise<
  Array<{
    tx_id: string;
    cur_cls_id: string | null;
    cur_cat_id: string | null;
    cur_source: string | null;
  }>
> {
  const rows = await queryRows(
    env,
    `SELECT t.id, tc.id AS cls_id, tc.category_id, tc.source
     FROM transactions t
     LEFT JOIN transaction_classifications tc
       ON tc.id = t.current_classification_id
     WHERE t.organization_id     = $1
       AND t.merchant_normalized = $2
       AND t.id                 != $3
       AND (tc.id IS NULL OR tc.source != 'user')
     ORDER BY t.created_at DESC`,
    [orgId, merchantNorm, excludeTxId],
  );
  return rows.map((r) => ({
    tx_id: r.id as string,
    cur_cls_id: (r.cls_id as string) ?? null,
    cur_cat_id: (r.category_id as string) ?? null,
    cur_source: (r.source as string) ?? null,
  }));
}
