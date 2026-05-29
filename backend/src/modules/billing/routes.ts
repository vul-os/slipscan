/**
 * Billing routes.
 *
 *   GET  /orgs/:orgID/billing/usage          — usage stats for the current period
 *   GET  /orgs/:orgID/billing/models         — active extraction models with metadata
 *   POST /orgs/:orgID/billing/model          — set org's preferred extraction model
 *   GET  /orgs/:orgID/billing/plans          — plan catalog with pricing + configured flag
 *   GET  /orgs/:orgID/billing/subscription   — current plan + subscription status
 *   POST /orgs/:orgID/billing/subscribe      — initiate Paystack subscription (or downgrade)
 *   POST /billing/verify                     — verify Paystack reference after redirect
 *   POST /webhooks/paystack                  — Paystack event webhook (NO auth middleware)
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
  getOrgSubscription,
  setOrgPlan,
  setOrgPaystackData,
  getOrgByCustomerCode,
  getOrgOwnerEmail,
} from "./queries";
import { MODEL_META, costPerExtraction } from "./config";
import { getPlans } from "./plans";
import {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
} from "../../lib/paystack";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST /webhooks/paystack — NO auth, must be mounted BEFORE auth middleware
// Signature verification gate replaces auth. Raw body required.
// ---------------------------------------------------------------------------
router.post("/webhooks/paystack", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-paystack-signature") ?? "";

  const valid = await verifyWebhookSignature(c.env, rawBody, signature);
  if (!valid) {
    return writeError(c, 401, "invalid_signature", "webhook signature mismatch");
  }

  let event: { event: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return writeError(c, 400, "invalid_body", "invalid JSON");
  }

  const { event: eventType, data } = event;

  // Helper to resolve org from event metadata or customer code.
  async function resolveOrgId(): Promise<string | null> {
    const meta = data?.metadata as Record<string, unknown> | undefined;
    const orgIdFromMeta = meta?.orgId as string | undefined;
    if (orgIdFromMeta && UUID_RE.test(orgIdFromMeta)) return orgIdFromMeta;

    const customer = data?.customer as Record<string, unknown> | undefined;
    const custCode = customer?.customer_code as string | undefined;
    if (custCode) return getOrgByCustomerCode(c.env, custCode);

    return null;
  }

  try {
    switch (eventType) {
      case "charge.success": {
        const orgId = await resolveOrgId();
        if (!orgId) break;

        const sub = data?.subscription as Record<string, unknown> | undefined;
        const subCode = sub?.subscription_code as string | undefined;
        const nextPayment = sub?.next_payment_date as string | undefined;

        await setOrgPaystackData(c.env, orgId, {
          subscription_status: "active",
          ...(subCode ? { paystack_subscription_code: subCode } : {}),
          ...(nextPayment ? { subscription_renews_at: nextPayment } : {}),
        });
        break;
      }

      case "subscription.create": {
        const orgId = await resolveOrgId();
        if (!orgId) break;

        const subCode = data?.subscription_code as string | undefined;
        const nextPayment = data?.next_payment_date as string | undefined;

        const planData = data?.plan as Record<string, unknown> | undefined;
        const planName = (planData?.name as string | undefined)?.toLowerCase();
        const planCode =
          planName === "team" ? "team" :
          planName === "business" ? "business" :
          undefined;

        await setOrgPaystackData(c.env, orgId, {
          subscription_status: "active",
          ...(subCode ? { paystack_subscription_code: subCode } : {}),
          ...(nextPayment ? { subscription_renews_at: nextPayment } : {}),
          ...(planCode ? { plan: planCode } : {}),
        });
        break;
      }

      case "subscription.disable":
      case "subscription.not_renew": {
        const orgId = await resolveOrgId();
        if (!orgId) break;
        await setOrgPaystackData(c.env, orgId, { subscription_status: "cancelled" });
        break;
      }

      case "invoice.payment_failed": {
        const orgId = await resolveOrgId();
        if (!orgId) break;
        await setOrgPaystackData(c.env, orgId, { subscription_status: "past_due" });
        break;
      }

      default:
        // Unknown event — log and ignore.
        console.log("paystack webhook: unhandled event", eventType);
    }
  } catch (err) {
    console.error("paystack webhook processing error:", err);
    // Return 200 anyway so Paystack doesn't retry on our processing error.
  }

  return c.body(null, 200);
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/billing/plans
// ---------------------------------------------------------------------------
router.get("/orgs/:orgID/billing/plans", requireAuth, requireMember, async (c) => {
  const plans = getPlans(c.env);
  return c.json({ plans });
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/billing/subscription
// ---------------------------------------------------------------------------
router.get("/orgs/:orgID/billing/subscription", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const sub = await getOrgSubscription(c.env, orgId);
  return c.json({
    plan:                     sub.plan,
    subscription_status:      sub.subscription_status,
    paystack_customer_code:   sub.paystack_customer_code,
    renews_at:                sub.subscription_renews_at,
  });
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgID/billing/subscribe
// ---------------------------------------------------------------------------
router.post("/orgs/:orgID/billing/subscribe", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");

  let body: { plan_code?: string };
  try {
    body = await c.req.json<{ plan_code?: string }>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const planCode = (body.plan_code ?? "").trim();
  if (!planCode || !["free", "team", "business"].includes(planCode)) {
    return writeError(c, 400, "invalid_plan", "plan_code must be 'free', 'team', or 'business'");
  }

  // Free plan downgrade — no Paystack call needed.
  if (planCode === "free") {
    await setOrgPlan(c.env, orgId, "free", "inactive");
    return c.json({ plan: "free", downgraded: true });
  }

  // Paid plan — need Paystack.
  const plans = getPlans(c.env);
  const plan = plans.find((p) => p.code === planCode);
  if (!plan) {
    return writeError(c, 404, "plan_not_found", "plan not found");
  }
  if (!plan.configured || !plan.paystack_plan_code) {
    return writeError(c, 503, "plan_not_configured", "billing is not yet configured for this plan");
  }

  // Get caller email (from JWT claim, fallback to org owner lookup).
  let email = c.get("email") ?? "";
  if (!email) {
    const ownerEmail = await getOrgOwnerEmail(c.env, orgId);
    email = ownerEmail ?? "";
  }
  if (!email) {
    return writeError(c, 500, "missing_email", "could not resolve email for payment");
  }

  const frontendBase = c.env.FRONTEND_BASE_URL ?? "";

  const tx = await initializeTransaction(c.env, {
    email,
    amount_kobo: plan.price_zar_cents,
    plan_code: plan.paystack_plan_code,
    // Paystack appends ?reference=… and ?trxref=… to the callback URL.
    callback_url: `${frontendBase}/billing`,
    metadata: { orgId, planCode },
  });

  return c.json({
    authorization_url: tx.authorization_url,
    reference: tx.reference,
  });
});

// ---------------------------------------------------------------------------
// POST /billing/verify  (not under /orgs/:orgID — reference is lookup key)
// ---------------------------------------------------------------------------
router.post("/billing/verify", requireAuth, async (c) => {
  let body: { reference?: string };
  try {
    body = await c.req.json<{ reference?: string }>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const reference = (body.reference ?? "").trim();
  if (!reference) {
    return writeError(c, 400, "missing_reference", "reference is required");
  }

  const result = await verifyTransaction(c.env, reference);

  if (result.status !== "success") {
    return writeError(c, 402, "payment_failed", `transaction status: ${result.status}`);
  }

  // Resolve org from metadata.
  const orgId = (result.metadata?.orgId as string | undefined) ?? null;
  if (!orgId || !UUID_RE.test(orgId)) {
    return writeError(c, 400, "missing_org", "could not resolve organization from transaction metadata");
  }

  // Determine which plan was paid for.
  const planCode = (result.metadata?.planCode as string | undefined) ?? null;
  const validPlan = planCode && ["team", "business"].includes(planCode) ? planCode : null;

  await setOrgPaystackData(c.env, orgId, {
    ...(validPlan ? { plan: validPlan } : {}),
    subscription_status: "active",
    paystack_customer_code: result.customer?.customer_code ?? null,
    ...(result.subscription?.subscription_code
      ? { paystack_subscription_code: result.subscription.subscription_code }
      : {}),
    ...(result.subscription?.next_payment_date
      ? { subscription_renews_at: result.subscription.next_payment_date }
      : {}),
  });

  return c.json({
    plan: validPlan ?? "team",
    subscription_status: "active",
    customer_code: result.customer?.customer_code ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/billing/usage
// ---------------------------------------------------------------------------
router.get("/orgs/:orgID/billing/usage", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  const [stats, sub] = await Promise.all([
    getUsageStats(c.env, orgId),
    getOrgSubscription(c.env, orgId),
  ]);

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const INPUT_RATE  = 0.075 / 1_000_000;
  const OUTPUT_RATE = 0.30  / 1_000_000;
  const estimated_cost_usd = Math.round(
    (stats.input_tokens_this_month  * INPUT_RATE +
     stats.output_tokens_this_month * OUTPUT_RATE) * 100_000,
  ) / 100_000;

  const storage_mb = Math.round((stats.storage_bytes / (1024 * 1024)) * 100) / 100;

  return c.json({
    plan: sub.plan,
    subscription_status: sub.subscription_status,
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
      is_active_for_org: activeModelId
        ? m.id === activeModelId
        : m.is_default,
      cost_per_1k_input:  meta.cost_per_1k_input,
      cost_per_1k_output: meta.cost_per_1k_output,
      speed:       meta.speed,
      quality:     meta.quality,
      description: meta.description,
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

  const models = await listExtractionModels(c.env);
  const found = models.find((m) => m.id === modelRowId);
  if (!found) {
    return writeError(c, 404, "model_not_found", "model not found or not available for extraction");
  }

  await setOrgModelId(c.env, orgId, modelRowId);

  return c.json({ model_id: modelRowId, model_name: found.model_id, display_name: found.display_name });
});

export default router;
