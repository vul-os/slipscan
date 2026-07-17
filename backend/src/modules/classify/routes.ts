/**
 * Classify module HTTP routes — port of Go handlers.go + handler.go.
 *
 * Routes:
 *   POST   /orgs/:orgID/documents/:docID/classify
 *   GET    /orgs/:orgID/transactions
 *   GET    /orgs/:orgID/categories
 *   PATCH  /orgs/:orgID/transactions/:txID/classification
 *
 * All routes are protected by requireMember. The router is default-exported and
 * mounted by the integrator (do not edit index.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { RateLimitedError } from "../../lib/gemini";

import { classifyDocument } from "./service";
import { applyCorrection, applyToExisting, getTransactionMerchantNorm } from "./corrections";
import { NotFoundError } from "./corrections";
import { listTransactions, listCategories } from "./queries";
import { emitAudit } from "../audit/emit";
import type {
  TransactionResponse,
  TransactionListItem,
  TransactionRow,
  CategoryItem,
} from "./types";

// ─── Response builders (mirrors Go txnToResponse + rowToListItem) ─────────────

function txnToResponse(t: {
  id: string;
  organization_id: string;
  document_id: string | null;
  merchant: string;
  merchant_normalized: string;
  amount: number | null;
  currency: string;
  tax: number | null;
  posted_date: string | null;
  direction: string;
  status: string;
  current_classification_id: string | null;
}): TransactionResponse {
  const r: TransactionResponse = {
    id: t.id,
    organization_id: t.organization_id,
    direction: t.direction,
    status: t.status,
  };
  if (t.document_id) r.document_id = t.document_id;
  if (t.merchant) r.merchant = t.merchant;
  if (t.merchant_normalized) r.merchant_normalized = t.merchant_normalized;
  if (t.amount !== null) r.amount = t.amount;
  if (t.currency) r.currency = t.currency;
  if (t.tax !== null) r.tax = t.tax;
  if (t.posted_date) r.posted_date = t.posted_date;
  if (t.current_classification_id) r.current_classification_id = t.current_classification_id;
  return r;
}

function rowToListItem(row: TransactionRow): TransactionListItem {
  const item: TransactionListItem = {
    id: row.id,
    organization_id: row.organization_id,
    direction: row.direction,
    status: row.status,
  };
  if (row.document_id) item.document_id = row.document_id;
  if (row.merchant) item.merchant = row.merchant;
  if (row.merchant_normalized) item.merchant_normalized = row.merchant_normalized;
  if (row.description) item.description = row.description;
  if (row.amount !== null) item.amount = row.amount;
  if (row.currency) item.currency = row.currency;
  if (row.posted_date) item.posted_date = row.posted_date;
  if (row.class_source) item.classification_source = row.class_source;
  if (row.class_confidence !== null) item.classification_confidence = row.class_confidence;
  if (row.class_category_id) item.category_id = row.class_category_id;
  if (row.category_name) item.category_name = row.category_name;
  return item;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = new Hono<AppEnv>();

// POST /orgs/:orgID/documents/:docID/classify
router.post("/orgs/:orgID/documents/:docID/classify", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const docId = c.req.param("docID");

  let txns: Awaited<ReturnType<typeof classifyDocument>>;
  try {
    txns = await classifyDocument(c.env, orgId, docId);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return writeError(c, 429, "rate_limited", "classification rate limited, try again shortly");
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no current extraction")) {
      return writeError(c, 422, "no_extraction", msg);
    }
    console.error("classify: classify handler error:", e);
    return writeError(c, 500, "classify_failed", "classification failed");
  }

  const out = txns.map(txnToResponse);
  return c.json({ transactions: out }, 200);
});

// GET /orgs/:orgID/transactions
router.get("/orgs/:orgID/transactions", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const documentIdParam = c.req.query("document_id");

  let limit = 50;
  let offset = 0;
  if (limitParam) {
    const n = parseInt(limitParam, 10);
    if (!isNaN(n)) limit = n;
  }
  if (offsetParam) {
    const n = parseInt(offsetParam, 10);
    if (!isNaN(n)) offset = n;
  }

  let documentId: string | null = null;
  if (documentIdParam) {
    // Validate UUID shape.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentIdParam)) {
      return writeError(c, 400, "invalid_document_id", "document_id must be a valid UUID");
    }
    documentId = documentIdParam;
  }

  let rows: TransactionRow[];
  try {
    rows = await listTransactions(c.env, orgId, limit, offset, documentId);
  } catch (e) {
    console.error("classify: list transactions error:", e);
    return writeError(c, 500, "list_failed", "could not list transactions");
  }

  const out = rows.map(rowToListItem);
  return c.json({ transactions: out }, 200);
});

// GET /orgs/:orgID/categories
router.get("/orgs/:orgID/categories", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let cats: CategoryItem[];
  try {
    cats = await listCategories(c.env, orgId);
  } catch (e) {
    console.error("classify: list categories error:", e);
    return writeError(c, 500, "list_failed", "could not list categories");
  }

  return c.json({ categories: cats }, 200);
});

// PATCH /orgs/:orgID/transactions/:txID/classification
router.patch("/orgs/:orgID/transactions/:txID/classification", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const txId = c.req.param("txID");
  const userId = c.get("userId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return writeError(c, 400, "invalid_body", "invalid JSON body");
  }

  const categoryId = body["category_id"];
  if (typeof categoryId !== "string" || !categoryId) {
    return writeError(c, 400, "invalid_category_id", "category_id must be a valid UUID");
  }
  // Validate UUID format.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId)) {
    return writeError(c, 400, "invalid_category_id", "category_id must be a valid UUID");
  }

  const accountId = body["account_id"];
  let validAccountId: string | undefined;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (typeof accountId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      return writeError(c, 400, "invalid_account_id", "account_id must be a valid UUID");
    }
    validAccountId = accountId;
  }

  const input = {
    category_id: categoryId,
    ...(validAccountId !== undefined ? { account_id: validAccountId } : {}),
  };

  // Capture before-state: current category on the transaction
  let beforeState: { category_id?: string | null; classification_source?: string | null } | null = null;
  try {
    const { queryRows } = await import("../../db/client");
    const rows = await queryRows(c.env,
      `SELECT t.current_classification_id, cl.category_id, cl.source
         FROM transactions t
         LEFT JOIN classifications cl ON cl.id = t.current_classification_id
        WHERE t.id = $1 AND t.organization_id = $2`,
      [txId, orgId],
    );
    if (rows.length > 0) {
      beforeState = {
        category_id: (rows[0].category_id as string | null) ?? null,
        classification_source: (rows[0].source as string | null) ?? null,
      };
    }
  } catch {
    // Non-fatal: proceed even if before-state fetch fails
  }

  let result: Awaited<ReturnType<typeof applyCorrection>>;
  try {
    result = await applyCorrection(c.env, orgId, txId, userId, input);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "transaction not found");
    }
    console.error("classify: patch classification error:", e);
    return writeError(c, 500, "internal_error", "failed to apply correction");
  }

  // P4-03: audit classification correction
  emitAudit(c.env, {
    organization_id: orgId,
    actor_user_id: userId,
    entity_type: "transaction",
    entity_id: txId,
    action: "classification.corrected",
    before: beforeState,
    after: { category_id: categoryId, account_id: validAccountId ?? null },
  }, c.executionCtx);

  const resp: Record<string, unknown> = {
    correction_id: result.correction_id,
    classification_id: result.classification_id,
    rule_promoted: result.rule_promoted,
  };
  if (result.rule_promoted && result.rule_id) {
    resp["rule_id"] = result.rule_id;
  }

  // Optional backfill: reclassify past non-user transactions for the same merchant.
  if (c.req.query("apply_to_existing") === "true") {
    const merchantNorm = await getTransactionMerchantNorm(c.env, orgId, txId).catch(() => null);
    if (merchantNorm) {
      let bf;
      try {
        bf = await applyToExisting(c.env, orgId, txId, merchantNorm, input, userId);
      } catch (e) {
        console.error("classify: backfill error:", e);
        return writeError(c, 500, "backfill_error", "correction recorded but backfill failed");
      }
      resp["backfill"] = bf;
    }
  }

  return c.json(resp, 200);
});

export default router;
