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
import orgsRouter, { inviteAcceptRouter } from "./modules/orgs/routes";
import documentsRouter from "./modules/documents/routes";
import extractRouter from "./modules/extract/routes";
import classifyRouter from "./modules/classify/routes";
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
app.route("/orgs", orgsRouter); // POST /orgs, /:orgID/members, /:orgID/invitations
app.route("/invitations", inviteAcceptRouter); // POST /invitations/accept
app.route("/orgs", extractRouter); // /:orgID/documents/:docID/extract
app.route("/", documentsRouter); // /orgs/:orgID/documents, /internal/inbound-email
app.route("/", classifyRouter); // /orgs/:orgID/{documents/:docID/classify,transactions,categories}

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
