/**
 * Extraction service — port of backend/internal/extract/service.go.
 *
 * Pipeline:
 *  1. Fetch the document row (org-filtered).
 *  2. Transition status → processing.
 *  3. Detect kind (slip/invoice/bank_statement) if unknown via a cheap Gemini call.
 *  4. Fetch the file bytes from R2.
 *  5. Run the kind-specific extraction prompt+schema via Gemini.extractWithSchema.
 *  6. INSERT document_extractions + ai_runs rows.
 *  7. Update documents.current_extraction_id + status='extracted'.
 *  On failure, set status='failed' and record the error (matches Go behavior).
 */
import { Gemini } from "../../lib/gemini";
import { getObject } from "../../lib/r2";
import type { Env } from "../../bindings";
import type { DocumentKind, Extracted, GeminiRaw, GeminiKind, RichItem, DiscountItem, ExtractionValidation } from "./types";
import { normalizeCurrency } from "./currency";
import { kindDetectPrompt, kindDetectSchema, promptVersionFor, promptSchemaFor } from "./prompts";
import {
  getDocument,
  getOrgCurrency,
  setDocumentStatus,
  ensureAIModel,
  createAIRun,
  createExtraction,
  finishAIRun,
  completeExtraction,
  failExtraction,
  getExtraction,
} from "./queries";
import { resolveOrgModelName } from "../billing/queries";

// ---- helpers ----

function deref(v: number | null | undefined): number {
  return v ?? 0;
}

function derefStr(v: string | null | undefined): string {
  return v ?? "";
}

/**
 * Compute validation block from items, discounts, tax, and total.
 * items_sum + discounts_sum + tax = computed_total.
 * sum_matches = abs(total - computed_total) < 0.05 (5 cent tolerance).
 */
function computeValidation(
  items: RichItem[],
  discounts: DiscountItem[],
  tax: number,
  total: number,
): ExtractionValidation {
  const itemsSum     = items.reduce((acc, it) => acc + it.amount, 0);
  const discountsSum = discounts.reduce((acc, d) => acc + d.amount, 0);
  const computedTotal = Math.round((itemsSum + discountsSum + tax) * 100) / 100;
  const delta         = Math.round((total - computedTotal) * 100) / 100;
  return {
    sum_matches:     Math.abs(delta) < 0.05,
    computed_total:  computedTotal,
    delta,
  };
}

/**
 * Defensive coercion: any item with a negative amount that ended up in items[]
 * gets moved to discounts[].
 */
function coerceNegativeItemsToDiscounts(
  items: RichItem[],
  discounts: DiscountItem[],
): { items: RichItem[]; discounts: DiscountItem[] } {
  const overflowDiscounts: DiscountItem[] = [];
  const cleanItems = items.filter((it) => {
    if (it.amount < 0) {
      overflowDiscounts.push({
        raw_text: it.raw_text,
        label:    it.normalized_name || it.raw_text,
        amount:   it.amount,
        source:   "other",
      });
      return false;
    }
    return true;
  });
  return { items: cleanItems, discounts: [...discounts, ...overflowDiscounts] };
}

/**
 * Maps a raw Gemini response to the canonical Extracted struct.
 * Port of Go mapToExtracted — extended for slip-v2 rich fields.
 */
function mapToExtracted(kind: DocumentKind, raw: GeminiRaw, orgCurrency: string): Extracted {
  const e: Extracted = {
    kind,
    merchant:   derefStr(raw.merchant),
    date:       derefStr(raw.date),
    currency:   normalizeCurrency(derefStr(raw.currency), orgCurrency),
    subtotal:   deref(raw.subtotal),
    tax:        deref(raw.tax),
    total:      deref(raw.total),
    confidence: deref(raw.confidence),
  };

  if (kind === "bank_statement") {
    e.statement_lines = (raw.statement_lines ?? []).map((l) => ({
      date:        derefStr(l.date),
      description: derefStr(l.description),
      amount:      deref(l.amount),
      balance:     deref(l.balance),
    }));
    return e;
  }

  // slip or invoice — check for v2 fields (items array indicates slip-v2 response)
  if (raw.items && raw.items.length > 0) {
    // v2 rich extraction path
    const rawItems: RichItem[] = (raw.items ?? []).map((it) => ({
      raw_text:        derefStr(it.raw_text),
      normalized_name: derefStr(it.normalized_name),
      category:        derefStr(it.category) || "other",
      qty:             deref(it.qty) || 1,
      unit_price:      deref(it.unit_price),
      amount:          deref(it.amount),
      vat_status:      (it.vat_status as RichItem["vat_status"]) ?? "unknown",
      confidence:      deref(it.confidence),
    }));

    const rawDiscounts: DiscountItem[] = (raw.discounts ?? []).map((d) => ({
      raw_text: derefStr(d.raw_text),
      label:    derefStr(d.label),
      amount:   deref(d.amount),
      source:   (d.source as DiscountItem["source"]) ?? "other",
    }));

    // Defensive: move any negative-amount items to discounts
    const { items, discounts } = coerceNegativeItemsToDiscounts(rawItems, rawDiscounts);

    e.receipt_type       = raw.receipt_type ?? undefined;
    e.merchant_normalized = raw.merchant_normalized ?? undefined;
    e.discount_total     = raw.discount_total ?? discounts.reduce((acc, d) => acc + d.amount, 0);
    e.payment_method     = raw.payment_method ?? undefined;
    e.receipt_number     = raw.receipt_number ?? null;
    e.items              = items;
    e.discounts          = discounts;
    e.validation         = computeValidation(items, discounts, e.tax, e.total);
  } else {
    // v1 legacy path (no items array — old prompt or invoice without rich data)
    e.line_items = (raw.line_items ?? []).map((l) => ({
      description: derefStr(l.description),
      qty:         deref(l.qty),
      unit:        deref(l.unit),
      amount:      deref(l.amount),
    }));
  }

  return e;
}

// ---- main service function ----

/**
 * Execute the full extraction pipeline for one document.
 * Safe to call multiple times (re-run): old extraction rows are preserved;
 * is_current is flipped to the new row.
 *
 * @returns The UUID of the new document_extractions row on success.
 * @throws  On unrecoverable error (doc not found, R2 failure, DB failure).
 */
export async function extractDocument(
  env: Env,
  orgId: string,
  docId: string,
): Promise<string> {
  const startMs = Date.now();

  // Resolve the org's preferred extraction model (or the global default).
  const modelName = await resolveOrgModelName(env, orgId);
  const g = new Gemini(env.GEMINI_API_KEY, modelName);

  // 1. Fetch document (org-filtered).
  const doc = await getDocument(env, docId, orgId);
  if (!doc) throw Object.assign(new Error("document not found"), { code: "not_found" });

  // 2. Org default currency (fallback for ambiguous symbols).
  const orgCurrency = await getOrgCurrency(env, orgId);

  // 3. Ensure the AI model row exists.
  const modelUUID = await ensureAIModel(env, g.getModel());

  let kind: DocumentKind = (doc.kind as DocumentKind) ?? "unknown";

  // 4. Transition document to 'processing'.
  await setDocumentStatus(env, docId, "processing", kind, "");

  // 5. Fetch file bytes from R2.
  const mime = doc.mime_type && doc.mime_type !== "" ? doc.mime_type : "image/jpeg";
  const fileBytes = await getObject(env, doc.storage_url);
  if (!fileBytes) {
    await setDocumentStatus(env, docId, "failed", kind, "storage fetch failed: object not found");
    throw new Error("fetch file: object not found in R2");
  }

  // 6. Determine prompt version (may update after kind detection).
  let promptVersion = promptVersionFor(kind);

  // 7. Create ai_run + extraction rows upfront (mirrors Go sequencing).
  const aiRunId = await createAIRun(env, orgId, modelUUID, docId, promptVersion);
  const extractionId = await createExtraction(env, docId, orgId, aiRunId, modelUUID);

  // 8. Detect kind if unknown.
  if (kind === "unknown" || kind === ("" as DocumentKind)) {
    try {
      const rawKind = await g.extractWithSchema(fileBytes, mime, kindDetectPrompt, kindDetectSchema);
      const kd = JSON.parse(rawKind) as GeminiKind;
      switch (kd.kind) {
        case "slip":           kind = "slip"; break;
        case "invoice":        kind = "invoice"; break;
        case "bank_statement": kind = "bank_statement"; break;
        default:               kind = "slip"; break;
      }
    } catch (e) {
      console.warn(`extract: kind detection failed (docId=${docId}): ${String(e)} — defaulting to slip`);
      kind = "slip";
    }
    // Update prompt version now that we know the kind.
    promptVersion = promptVersionFor(kind);
  }

  // 9. Run kind-specific extraction.
  const [prompt, schema] = promptSchemaFor(kind);
  let rawJSON: string | null = null;
  let extracted: Extracted | null = null;
  let extractErr: Error | null = null;

  try {
    rawJSON = await g.extractWithSchema(fileBytes, mime, prompt, schema);
    const gr = JSON.parse(rawJSON) as GeminiRaw;
    extracted = mapToExtracted(kind, gr, orgCurrency);
  } catch (e) {
    extractErr = e instanceof Error ? e : new Error(String(e));
  }

  const latencyMs = Date.now() - startMs;

  // 10. Persist result or failure.
  if (extractErr || !extracted) {
    const msg = extractErr?.message ?? "extraction produced no result";
    await finishAIRun(env, aiRunId, "failed", latencyMs, 0, 0, msg);
    await failExtraction(env, orgId, extractionId, docId, rawJSON, msg);
    throw new Error(`extraction failed: ${msg}`);
  }

  await finishAIRun(env, aiRunId, "succeeded", latencyMs, 0, 0, "").catch((e) =>
    console.warn("extract: finish ai_run:", e),
  );
  await completeExtraction(env, orgId, extractionId, docId, extracted, kind);

  console.log(
    `extract: doc=${docId} kind=${kind} confidence=${extracted.confidence.toFixed(2)} latency=${latencyMs}ms`,
  );

  return extractionId;
}

/**
 * Fetch the current extraction row for a document and return it as a plain
 * object suitable for JSON serialisation. Used by the route handler.
 */
export async function getExtractionForDoc(
  env: Env,
  orgId: string,
  extractionId: string,
): Promise<Record<string, unknown> | null> {
  return getExtraction(env, extractionId, orgId);
}
