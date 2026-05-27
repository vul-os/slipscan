/**
 * Classification service — port of Go internal/classify/classify.go.
 *
 * Cascade precedence (highest first): user > rule > merchant_signal > llm.
 * "user" corrections are written by the corrections handler.
 * This service handles rule → merchant_signal → llm.
 *
 * classifyDocument is the main entry point (exported for the route handler
 * and for testing).
 */
import type { Env } from "../../bindings";
import { normalizeMerchant } from "../../lib/merchant";
import { Gemini, RateLimitedError } from "../../lib/gemini";
import { withOrg } from "../../db/client";
import {
  loadCurrentExtraction,
  insertTransaction,
  fetchRules,
  bumpRule,
  lookupSignal,
  mapSignalToCategory,
  loadOrgKind,
  loadCategoryNames,
  findCategoryByName,
  writeClassification,
  recordAIRunStart,
  finishAIRun,
} from "./queries";
import type { Extracted, Transaction, StatementLine } from "./types";

// ─── Environment config ───────────────────────────────────────────────────────

const CLASSIFY_PROMOTION_THRESHOLD =
  parseInt(process.env?.CLASSIFY_PROMOTION_THRESHOLD ?? "2") || 2;

// ─── Extraction → Transaction ─────────────────────────────────────────────────

function extractionToTransaction(
  ext: Extracted,
  orgId: string,
  docId: string,
  extractionId: string,
  uploadedBy: string | null,
  line: StatementLine | null,
): Omit<Transaction, "id" | "current_classification_id"> {
  const t: Omit<Transaction, "id" | "current_classification_id"> = {
    organization_id: orgId,
    document_id: docId,
    document_extraction_id: extractionId,
    uploaded_by: uploadedBy,
    merchant: "",
    merchant_normalized: "",
    description: "",
    amount: null,
    currency: (ext.currency ?? "").toUpperCase(),
    tax: null,
    posted_date: null,
    direction: "debit",
    status: "pending",
  };

  if (line !== null) {
    // Bank statement line
    t.amount = line.amount;
    t.description = line.description;
    t.merchant = line.description;
    if (line.amount > 0) t.direction = "credit";
    if (line.date) t.posted_date = line.date.slice(0, 10);
  } else {
    // Slip / invoice
    t.merchant = ext.merchant ?? "";
    t.amount = ext.total ?? null;
    t.tax = ext.tax ?? null;
    if (ext.date) t.posted_date = ext.date.slice(0, 10);
  }

  t.merchant_normalized = normalizeMerchant(t.merchant);
  return t;
}

// ─── Cascade stages ───────────────────────────────────────────────────────────

type Q = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Stage 1: classification_rules — exact → contains → regex.
 * Returns the matched rule info, or null if no match.
 */
async function tryRules(
  q: Q,
  orgId: string,
  merchantNorm: string,
): Promise<{
  rule_id: string;
  category_id: string | null;
  account_id: string | null;
  confidence: number;
} | null> {
  if (!merchantNorm) return null;

  const rules = await fetchRules(q, orgId);

  for (const pass of ["merchant_exact", "merchant_contains", "merchant_regex"] as const) {
    for (const r of rules) {
      if (r.match_type !== pass) continue;
      let matched = false;
      switch (r.match_type) {
        case "merchant_exact":
          matched = merchantNorm === r.match_value;
          break;
        case "merchant_contains":
          matched = merchantNorm.includes(r.match_value);
          break;
        case "merchant_regex":
          try {
            matched = new RegExp(r.match_value).test(merchantNorm);
          } catch {
            matched = false;
          }
          break;
      }
      if (matched) {
        // Bump applied_count in background — non-critical bookkeeping.
        bumpRule(q, r.id).catch(() => {});
        return {
          rule_id: r.id,
          category_id: r.category_id,
          account_id: r.account_id,
          confidence: r.confidence,
        };
      }
    }
  }
  return null;
}

/**
 * Stage 2: merchant_signals (cross-tenant).
 * Looks up the top-voted category label, maps it to an org category by name.
 */
async function trySignal(
  env: Env,
  q: Q,
  orgId: string,
  merchantNorm: string,
): Promise<{
  category_id: string;
  confidence: number;
} | null> {
  if (!merchantNorm) return null;

  const sig = await lookupSignal(env, merchantNorm);
  if (!sig) return null;

  const catId = await mapSignalToCategory(q, orgId, sig.category_label);
  if (!catId) return null;

  // Confidence: 0.6 + 0.01 per vote, capped at 0.85 (noisy signal).
  const conf = Math.min(0.6 + sig.vote_count * 0.01, 0.85);
  return { category_id: catId, confidence: conf };
}

/** LLM classify prompt — mirrors Go classifyPromptTemplate. */
const CLASSIFY_PROMPT_TEMPLATE = `You are a transaction classifier for a %s organisation.

Transaction:
- Merchant: %s
- Amount: %s
- Currency: %s
- Date: %s

Available categories (you MUST pick one exactly as listed, or "uncategorised" if truly none fit):
%s

Respond with JSON matching the schema. category must be one of the listed names verbatim.`;

/**
 * Stage 3: Gemini LLM fallback.
 * Calls Gemini with the org's categories; maps the result back to a category id.
 * Returns null if no Gemini key, or if the LLM picks an invalid category.
 * Throws RateLimitedError on quota exhaustion.
 */
async function tryLLM(
  env: Env,
  q: Q,
  orgId: string,
  tx: Omit<Transaction, "id" | "current_classification_id"> & { id: string },
): Promise<{
  ai_run_id: string | null;
  category_id: string;
  confidence: number;
  reasoning?: string;
} | null> {
  if (!env.GEMINI_API_KEY) return null;

  const orgKind = await loadOrgKind(q, orgId);
  const catNames = await loadCategoryNames(q, orgId);
  if (!catNames.length) return null;

  const amtStr = tx.amount !== null ? tx.amount.toFixed(2) : "unknown";
  const dateStr = tx.posted_date ?? "unknown";
  const catList = catNames.map((n) => `- ${n}`).join("\n");
  const prompt = CLASSIFY_PROMPT_TEMPLATE
    .replace("%s", orgKind)
    .replace("%s", tx.merchant)
    .replace("%s", amtStr)
    .replace("%s", tx.currency)
    .replace("%s", dateStr)
    .replace("%s", catList);

  const schema = {
    type: "object",
    properties: {
      category: { type: "string" },
      confidence: { type: "number" },
      reasoning: { type: "string", nullable: true },
    },
    required: ["category", "confidence"],
  };

  // Record the AI run start (non-fatal if it fails).
  let aiRunId: string | null = null;
  try {
    aiRunId = await recordAIRunStart(q, orgId, tx.id);
  } catch {
    aiRunId = null;
  }

  const gemini = new Gemini(env.GEMINI_API_KEY);
  const start = Date.now();
  let raw: string | null = null;
  let llmError: Error | null = null;

  try {
    raw = await gemini.generateJSON(prompt, schema, 0.1);
  } catch (e) {
    llmError = e instanceof Error ? e : new Error(String(e));
  }

  const latencyMs = Date.now() - start;

  if (aiRunId) {
    finishAIRun(q, aiRunId, raw, llmError, latencyMs).catch(() => {});
  }

  if (llmError) throw llmError;  // Re-throw so handler can handle RateLimitedError
  if (!raw) return null;

  let result: { category: string; confidence: number; reasoning?: string };
  try {
    result = JSON.parse(raw) as typeof result;
  } catch {
    return null;
  }

  // LLM must pick a category from the provided list.
  const lower = result.category?.trim().toLowerCase();
  const validName = catNames.find((n) => n.toLowerCase() === lower);
  if (!validName) return null;

  const catId = await findCategoryByName(q, orgId, validName);
  if (!catId) return null;

  return {
    ai_run_id: aiRunId,
    category_id: catId,
    confidence: clampConfidence(result.confidence ?? 0.5),
    reasoning: result.reasoning,
  };
}

function clampConfidence(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── Main cascade ─────────────────────────────────────────────────────────────

async function runCascade(
  env: Env,
  q: Q,
  orgId: string,
  tx: Omit<Transaction, "id" | "current_classification_id"> & { id: string },
): Promise<void> {
  // Stage 1: rules
  const ruleMatch = await tryRules(q, orgId, tx.merchant_normalized);
  if (ruleMatch) {
    await writeClassification(q, tx.id, orgId, {
      rule_id: ruleMatch.rule_id,
      category_id: ruleMatch.category_id,
      account_id: ruleMatch.account_id,
      source: "rule",
      confidence: ruleMatch.confidence,
    });
    return;
  }

  // Stage 2: merchant signal
  const signalMatch = await trySignal(env, q, orgId, tx.merchant_normalized);
  if (signalMatch) {
    await writeClassification(q, tx.id, orgId, {
      category_id: signalMatch.category_id,
      source: "merchant_signal",
      confidence: signalMatch.confidence,
    });
    return;
  }

  // Stage 3: LLM
  const llmMatch = await tryLLM(env, q, orgId, tx);
  if (llmMatch) {
    await writeClassification(q, tx.id, orgId, {
      ai_run_id: llmMatch.ai_run_id,
      category_id: llmMatch.category_id,
      source: "llm",
      confidence: llmMatch.confidence,
      reasoning: llmMatch.reasoning,
    });
  }
  // No classification — leave unclassified (matches Go behaviour).
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * classifyDocument reads the current extraction for the document, creates
 * transaction row(s), runs the cascade for each, and returns the resulting
 * transactions with current_classification_id populated.
 *
 * Exported for use in the route handler and for integration tests.
 */
export async function classifyDocument(
  env: Env,
  orgId: string,
  docId: string,
): Promise<(Omit<Transaction, "id" | "current_classification_id"> & {
  id: string;
  current_classification_id: string | null;
})[]> {
  return withOrg(env, orgId, null, async (q) => {
    // 1. Load current extraction.
    const extraction = await loadCurrentExtraction(env, docId, orgId);
    if (!extraction) {
      throw new Error("classify: document has no current extraction");
    }
    const { extracted: ext, extractionId } = extraction;

    // 2. Build transaction list from extraction.
    type TxShape = Omit<Transaction, "id" | "current_classification_id"> & {
      id: string;
      current_classification_id: string | null;
    };
    const txInputs: Omit<Transaction, "id" | "current_classification_id">[] = [];

    if (ext.kind === "bank_statement") {
      const lines = ext.statement_lines ?? [];
      if (lines.length > 0) {
        for (const line of lines) {
          txInputs.push(extractionToTransaction(ext, orgId, docId, extractionId, null, line));
        }
      } else {
        txInputs.push(extractionToTransaction(ext, orgId, docId, extractionId, null, null));
      }
    } else {
      txInputs.push(extractionToTransaction(ext, orgId, docId, extractionId, null, null));
    }

    // 3. Persist transactions + run cascade for each.
    const results: TxShape[] = [];
    for (const txInput of txInputs) {
      let txId: string;
      try {
        txId = await insertTransaction(q, txInput);
      } catch (e) {
        throw new Error(`classify: persist transaction: ${String(e)}`);
      }

      const tx = { ...txInput, id: txId, current_classification_id: null as string | null };

      // Run cascade — log but don't fail if it errors (tx row already exists).
      try {
        await runCascade(env, q, orgId, tx);
        // Re-read current_classification_id after cascade.
        const rows = await q(
          `SELECT current_classification_id FROM transactions WHERE id = $1`,
          [txId],
        );
        if (rows.length) {
          tx.current_classification_id = (rows[0].current_classification_id as string) ?? null;
        }
      } catch (e) {
        // Non-fatal cascade error — the transaction row still exists.
        // RateLimitedError is allowed to propagate.
        if (e instanceof RateLimitedError) throw e;
        console.error("classify: cascade error:", e);
      }

      results.push(tx);
    }

    return results;
  });
}

export { CLASSIFY_PROMOTION_THRESHOLD, RateLimitedError };
