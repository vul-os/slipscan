/**
 * Correction logic — port of Go internal/classify/corrections.go.
 *
 * Handles:
 * - applyCorrection: records user reclassification + optional rule promotion
 * - applyToExisting: backfill past non-user transactions for the same merchant
 */
import type { Env } from "../../bindings";
import { normalizeMerchant } from "../../lib/merchant";
import { withOrg } from "../../db/client";
import {
  lockTransaction,
  fetchCurrentClassification,
  insertUserClassification,
  clearOldIsCurrentFlag,
  updateTransactionPointer,
  insertCorrectionRecord,
  countCorrections,
  upsertRule,
  getTransactionMerchantNorm,
  fetchBackfillCandidates,
} from "./queries";
import type { CorrectionInput, CorrectionResult, BackfillResult } from "./types";

// ─── Tuneable defaults ────────────────────────────────────────────────────────

const DEFAULT_PROMOTION_THRESHOLD = 2;

function getPromotionThreshold(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>)["CLASSIFY_PROMOTION_THRESHOLD"];
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (n > 0) return n;
  }
  return DEFAULT_PROMOTION_THRESHOLD;
}

// ─── Sentinel errors ──────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(msg = "not found") {
    super(msg);
    this.name = "NotFoundError";
  }
}

// ─── Promotion helper ─────────────────────────────────────────────────────────

/**
 * maybePromote: if the correction count for (merchant_normalized, category_id)
 * has reached the threshold, upsert a merchant_exact classification_rules row.
 * Returns { ruleId, promoted } — non-fatal on error (caller logs + continues).
 */
async function maybePromote(
  env: Env,
  orgId: string,
  merchantNorm: string,
  input: CorrectionInput,
  threshold: number,
): Promise<{ ruleId: string | null; promoted: boolean }> {
  const norm = normalizeMerchant(merchantNorm);
  if (!norm) return { ruleId: null, promoted: false };

  const count = await countCorrections(env, orgId, norm, input.category_id);
  if (count < threshold) return { ruleId: null, promoted: false };

  // Idempotent upsert.
  const newRuleId = crypto.randomUUID();
  const returnedId = await upsertRule(env, newRuleId, orgId, norm, input);
  console.log(
    `classify: promoted merchant="${norm}" → category=${input.category_id} as rule=${returnedId} (org=${orgId}, corrections=${count})`,
  );
  return { ruleId: returnedId, promoted: true };
}

// ─── Core: applyCorrection ────────────────────────────────────────────────────

/**
 * Records a user-initiated reclassification.
 *
 * Contract (P1-03 §2):
 * - Inserts classification_corrections row.
 * - Inserts new transaction_classifications row (source='user', conf=1.0).
 * - Flips is_current: old row → false, new row → true.
 * - Updates transactions.current_classification_id.
 * - After ≥ threshold corrections for (merchant_normalized, category_id),
 *   upserts a classification_rules row (merchant_exact).
 *
 * Throws NotFoundError when the transaction doesn't exist or is out of org.
 */
export async function applyCorrection(
  env: Env,
  orgId: string,
  txId: string,
  correctedBy: string,
  input: CorrectionInput,
): Promise<Omit<CorrectionResult, "backfill">> {
  const threshold = getPromotionThreshold(env);
  let merchantNorm: string | null = null;
  let corrId: string = "";
  let newClsId: string = "";

  await withOrg(env, orgId, correctedBy, async (q) => {
    // 1. Lock the transaction row and read merchant_normalized.
    const txRow = await lockTransaction(q, txId, orgId);
    if (!txRow) throw new NotFoundError("transaction not found");
    merchantNorm = txRow.merchant_normalized;

    // 2. Read current classification if present.
    let curId: string | null = null;
    let curCatId: string | null = null;
    let curSource: string | null = null;

    if (txRow.current_classification_id) {
      const cur = await fetchCurrentClassification(q, txRow.current_classification_id);
      if (cur) {
        curId = cur.id;
        curCatId = cur.category_id;
        curSource = cur.source;
      }
    }

    // 3. Insert new classification row (source=user, confidence=1.0).
    newClsId = crypto.randomUUID();
    await insertUserClassification(q, newClsId, txId, orgId, input);

    // 4. Flip old row to is_current=false.
    if (curId && curId !== newClsId) {
      await clearOldIsCurrentFlag(q, curId);
    }

    // 5. Update transactions.current_classification_id.
    await updateTransactionPointer(q, newClsId, txId, orgId, input);

    // 6. Insert classification_corrections record.
    corrId = crypto.randomUUID();
    await insertCorrectionRecord(
      q,
      corrId,
      orgId,
      txId,
      merchantNorm,
      curCatId,
      input.category_id || null,
      curSource,
      curId,
      newClsId,
      correctedBy,
    );
  });

  // 7. Check for promotion (outside the transaction — idempotent upsert).
  let rulePromoted = false;
  let ruleId: string | undefined;

  if (merchantNorm) {
    try {
      const promotion = await maybePromote(env, orgId, merchantNorm, input, threshold);
      rulePromoted = promotion.promoted;
      if (promotion.ruleId) ruleId = promotion.ruleId;
    } catch (e) {
      console.error(`classify: promotion check failed org=${orgId} merchant="${merchantNorm}": ${String(e)}`);
    }
  }

  return {
    correction_id: corrId,
    classification_id: newClsId,
    rule_promoted: rulePromoted,
    ...(ruleId !== undefined ? { rule_id: ruleId } : {}),
  };
}

// ─── Backfill: applyToExisting ────────────────────────────────────────────────

/**
 * Reclassifies past transactions for the same merchant_normalized, applying
 * the new category/account. NEVER overwrites source='user' transactions.
 * The given txId is excluded (already updated by applyCorrection).
 *
 * Processes rows individually (one withOrg per row) to avoid a single
 * long-running transaction.
 */
export async function applyToExisting(
  env: Env,
  orgId: string,
  excludeTxId: string,
  merchantNorm: string,
  input: CorrectionInput,
  appliedBy: string,
): Promise<BackfillResult> {
  const norm = normalizeMerchant(merchantNorm);
  if (!norm) return { updated: 0, skipped: 0 };

  const candidates = await fetchBackfillCandidates(env, orgId, norm, excludeTxId);

  const result: BackfillResult = { updated: 0, skipped: 0 };

  for (const c of candidates) {
    try {
      const updated = await backfillOne(env, orgId, c.tx_id, c.cur_cls_id, c.cur_cat_id, input, appliedBy);
      if (updated) {
        result.updated++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      console.error(`classify: backfill tx=${c.tx_id} failed: ${String(e)}`);
      result.skipped++;
    }
  }

  return result;
}

/**
 * Applies a single reclassification within its own transaction.
 * Returns true when updated, false when skipped (user invariant or idempotent).
 */
async function backfillOne(
  env: Env,
  orgId: string,
  txId: string,
  curClsId: string | null,
  curCatId: string | null,
  input: CorrectionInput,
  appliedBy: string,
): Promise<boolean> {
  let didUpdate = false;

  await withOrg(env, orgId, appliedBy, async (q) => {
    // Re-read with lock to guard against concurrent corrections.
    const rows = await q(
      `SELECT tc.id, tc.source, tc.category_id
       FROM transactions t
       LEFT JOIN transaction_classifications tc ON tc.id = t.current_classification_id
       WHERE t.id = $1 AND t.organization_id = $2
       FOR UPDATE OF t`,
      [txId, orgId],
    );
    if (!rows.length) return;

    const r = rows[0];
    const lockedSource = r.source as string | null;
    const lockedClsId = r.id as string | null;
    const lockedCatId = r.category_id as string | null;

    // Invariant: never overwrite source='user'.
    if (lockedSource === "user") return;

    // Idempotent: already classified with the same category.
    if (lockedClsId && lockedCatId === input.category_id) return;

    // Insert new classification row.
    const newClsId = crypto.randomUUID();
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

    // Flip old is_current.
    if (lockedClsId) {
      await q(
        `UPDATE transaction_classifications SET is_current = FALSE WHERE id = $1`,
        [lockedClsId],
      );
    }

    // Update transactions pointer.
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

    // Record the backfill correction.
    await q(
      `INSERT INTO classification_corrections
         (id, organization_id, transaction_id, merchant_normalized,
          old_category_id, new_category_id, old_source,
          old_classification_id, new_classification_id,
          corrected_by, created_at)
       VALUES ($1, $2, $3,
         (SELECT merchant_normalized FROM transactions WHERE id = $3),
         $4, $5, $6, $7, $8, $9, NOW())`,
      [
        crypto.randomUUID(),
        orgId,
        txId,
        curCatId,
        input.category_id || null,
        curClsId ? (await q(`SELECT source FROM transaction_classifications WHERE id = $1`, [curClsId]))[0]?.source ?? null : null,
        curClsId,
        newClsId,
        appliedBy,
      ],
    );

    didUpdate = true;
  });

  return didUpdate;
}

export { getTransactionMerchantNorm };
