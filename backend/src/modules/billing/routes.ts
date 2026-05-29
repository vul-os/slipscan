/**
 * Billing routes.
 *
 *   GET  /orgs/:orgID/billing/usage   — usage stats for the current period
 *   GET  /orgs/:orgID/billing/models  — active extraction models with metadata
 *   POST /orgs/:orgID/billing/model   — set org's preferred extraction model
 *
 * Mount via: app.route("/", billingRouter)
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireMember, requireAdmin } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import {
  getUsageStats,
  listExtractionModels,
  getOrgModelId,
  setOrgModelId,
} from "./queries";
import { MODEL_META, costPerExtraction } from "./config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/billing/usage
// ---------------------------------------------------------------------------
router.get("/orgs/:orgID/billing/usage", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  const stats = await getUsageStats(c.env, orgId);

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  // Estimated cost: Gemini 2.5 Flash rates as default.
  // (input * 0.075 + output * 0.30) / 1_000_000  — USD
  const INPUT_RATE  = 0.075 / 1_000_000;
  const OUTPUT_RATE = 0.30  / 1_000_000;
  const estimated_cost_usd = Math.round(
    (stats.input_tokens_this_month  * INPUT_RATE +
     stats.output_tokens_this_month * OUTPUT_RATE) * 100_000,
  ) / 100_000;

  const storage_mb = Math.round((stats.storage_bytes / (1024 * 1024)) * 100) / 100;

  return c.json({
    plan: "free",
    period: { start: periodStart, end: periodEnd },
    extractions: {
      this_month:        stats.extractions_this_month,
      total:             stats.extractions_total,
      failed_this_month: stats.failed_this_month,
    },
    ai_tokens: {
      input_this_month:  stats.input_tokens_this_month,
      output_this_month: stats.output_tokens_this_month,
    },
    storage_mb,
    estimated_cost_usd,
    calls_last_7_days: stats.calls_last_7_days,
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/billing/models
// ---------------------------------------------------------------------------
router.get("/orgs/:orgID/billing/models", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  const [models, activeModelId] = await Promise.all([
    listExtractionModels(c.env),
    getOrgModelId(c.env, orgId),
  ]);

  const result = models.map((m) => {
    const meta = MODEL_META[m.model_id] ?? {
      cost_per_1k_input:  0,
      cost_per_1k_output: 0,
      speed:   "standard",
      quality: "good",
      description: "",
    };
    return {
      id:               m.id,
      model_id:         m.model_id,
      display_name:     m.display_name,
      // is_active_for_org: the org explicitly chose this model, OR (if org has
      // no selection) it is the default model.
      is_active_for_org: activeModelId
        ? m.id === activeModelId
        : m.is_default,
      cost_per_1k_input:  meta.cost_per_1k_input,
      cost_per_1k_output: meta.cost_per_1k_output,
      speed:       meta.speed,
      quality:     meta.quality,
      description: meta.description,
      // Convenience: estimated cost per receipt (~3k input + 1k output tokens)
      cost_per_receipt: costPerExtraction(m.model_id),
    };
  });

  return c.json({ models: result });
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgID/billing/model
// ---------------------------------------------------------------------------
router.post("/orgs/:orgID/billing/model", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");

  let body: { model_id?: string };
  try {
    body = await c.req.json<{ model_id?: string }>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const modelRowId = (body.model_id ?? "").trim();
  if (!modelRowId || !UUID_RE.test(modelRowId)) {
    return writeError(c, 400, "invalid_model_id", "model_id must be a valid UUID (ai_models.id)");
  }

  // Verify the row exists and is an active extraction model.
  const models = await listExtractionModels(c.env);
  const found = models.find((m) => m.id === modelRowId);
  if (!found) {
    return writeError(c, 404, "model_not_found", "model not found or not available for extraction");
  }

  await setOrgModelId(c.env, orgId, modelRowId);

  return c.json({ model_id: modelRowId, model_name: found.model_id, display_name: found.display_name });
});

export default router;
