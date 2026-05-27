/**
 * slip/scan API Worker — entry point.
 * Hono app with the Go middleware chain (CORS, security headers, logger) and
 * an error envelope identical to Go's httpx. Feature modules mount their
 * routes here wave-by-wave. scheduled() (cron) and email() (inbound) handlers
 * are added in later waves.
 */
import { Hono } from "hono";
import type { Env } from "./bindings";
import { ApiError, writeError } from "./lib/errors";
import authRouter from "./modules/auth/routes";
import googleAuthRouter from "./modules/auth/google";
import orgsRouter, { inviteAcceptRouter } from "./modules/orgs/routes";
import documentsRouter from "./modules/documents/routes";
import extractRouter from "./modules/extract/routes";
import classifyRouter from "./modules/classify/routes";
import ledgerRouter from "./modules/ledger/routes";
import financeRouter from "./modules/finance/routes";
import reportingRouter from "./modules/reporting/routes";
import reconRouter from "./modules/recon/routes";
import bankfeedRouter from "./modules/bankfeed/routes";
import intelligenceRouter from "./modules/intelligence/routes";
import workspaceRouter from "./modules/workspace/routes";
import insightsRouter from "./modules/insights/routes";
import auditRouter from "./modules/audit/routes";
import apiTokensRouter from "./modules/apitokens/routes";
import apiV1Router from "./modules/apitokens/v1routes";
import xeroRouter from "./modules/xero/routes";
import { handleScheduled } from "./cron/scheduled";

const app = new Hono<{ Bindings: Env }>();

// --- global middleware (ported from internal/httpx/middleware.go) ---
app.use("*", async (c, next) => {
  // security headers
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // CORS
  const allowed = c.env.CORS_ALLOWED_ORIGINS ?? "*";
  const origin = c.req.header("Origin");
  if (allowed === "*") {
    c.header("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.split(/[,\s]+/).includes(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
  }
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/healthz", (c) => c.text("ok"));

// Wave 1 feature modules.
app.route("/auth", authRouter); // /auth/register, /login, /me, ...
app.route("/auth", googleAuthRouter); // /auth/google, /auth/google/callback
app.route("/orgs", orgsRouter); // POST /orgs, /:orgID/members, /:orgID/invitations
app.route("/invitations", inviteAcceptRouter); // POST /invitations/accept
app.route("/orgs", extractRouter); // /:orgID/documents/:docID/extract
app.route("/", documentsRouter); // /orgs/:orgID/documents, /internal/inbound-email
app.route("/", classifyRouter); // /orgs/:orgID/{documents/:docID/classify,transactions,categories}
// Wave 2 feature modules (absolute paths from root).
app.route("/", ledgerRouter); // /orgs/:orgID/{accounts,journals,contacts,trial-balance,transactions/:id/post}
app.route("/", financeRouter); // /orgs/:orgID/{spending,budgets,goals,net-worth}
app.route("/", reportingRouter); // /orgs/:orgID/reports/:name
// Wave 3 feature modules (absolute paths from root).
app.route("/", reconRouter); // /orgs/:orgID/reconcile*
app.route("/", bankfeedRouter); // /orgs/:orgID/integrations/bankfeed/*, /integrations/bankfeed/{callback,webhook}
app.route("/", intelligenceRouter); // /orgs/:orgID/{forecast,anomalies,tax-readiness}
app.route("/", workspaceRouter); // /workspace (user-scoped)
app.route("/", insightsRouter); // /orgs/:orgID/ask
app.route("/", auditRouter); // /orgs/:orgID/audit
app.route("/", apiTokensRouter); // /orgs/:orgID/api-tokens*
app.route("/", apiV1Router); // /v1/orgs/:orgID/*
app.route("/", xeroRouter); // /orgs/:orgID/integrations/xero/*, /integrations/xero/callback

app.notFound((c) => writeError(c, 404, "not_found", "not found"));
app.onError((err, c) => {
  if (err instanceof ApiError) return writeError(c, err.status, err.code, err.message, err.details);
  console.error("unhandled error:", err);
  return writeError(c, 500, "internal_error", "internal server error");
});

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
