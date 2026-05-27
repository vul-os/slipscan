/**
 * Bankfeed HTTP routes — port of backend/internal/bankfeed/handlers.go.
 *
 * Routes (absolute paths from root — integrator mounts at "/"):
 *
 *   requireMember:
 *     GET    /orgs/:orgID/integrations/bankfeed/connections
 *     GET    /orgs/:orgID/integrations/bankfeed/connections/:connID
 *     POST   /orgs/:orgID/integrations/bankfeed/connections/:connID/sync
 *
 *   requireAdmin:
 *     GET    /orgs/:orgID/integrations/bankfeed/connect   (start OAuth + PKCE)
 *     DELETE /orgs/:orgID/integrations/bankfeed/connections/:connID
 *
 *   public:
 *     GET    /integrations/bankfeed/callback              (OAuth code exchange)
 *     POST   /integrations/bankfeed/webhook               (HMAC-SHA256 validated)
 *
 * OAuth state storage:
 *   Short-lived CSRF state is persisted via saveOAuthState / consumeOAuthState
 *   in queries.ts. If env.RATE_LIMIT KV is available it is used (15-min TTL
 *   via KV expirationTtl). Otherwise the oauth_pkce_states DB table is used.
 *   The Go in-memory map is not viable on stateless Workers.
 *
 * 503 gating: when STITCH_CLIENT_ID is unset, connect + sync routes return 503.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember, requireAdmin } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnectionStatus,
  saveOAuthState,
  consumeOAuthState,
} from "./queries";
import {
  stitchConfigured,
  linkURL,
  exchangeCode,
  validateWebhook,
  webhookEventType,
} from "./stitch";
import { syncConnection } from "./syncer";
import type { Connection } from "./types";

const router = new Hono<AppEnv>();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 15-minute consent expiry ceiling (mirrors Go consentExpiry). */
function consentExpiry(tokenExpiresAt: string): string {
  const d = new Date(tokenExpiresAt);
  d.setDate(d.getDate() + 90);
  return d.toISOString();
}

function connectionToJSON(c: Connection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    provider: c.provider,
    institution_name: c.institutionName,
    institution_id: c.institutionId,
    mask: c.mask,
    status: c.status,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
  if (c.lastSyncedAt) out.last_synced_at = c.lastSyncedAt;
  if (c.errorCode) out.error_code = c.errorCode;
  if (c.errorMessage) out.error_message = c.errorMessage;
  return out;
}

// ─── GET /orgs/:orgID/integrations/bankfeed/connect ───────────────────────────

router.get("/orgs/:orgID/integrations/bankfeed/connect", requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");

  if (!stitchConfigured(c.env)) {
    return writeError(c, 503, "not_configured", "bank-feed provider is not configured");
  }

  const state = generateNonce();
  try {
    await saveOAuthState(c.env, state, orgId);
  } catch (e) {
    console.error("bankfeed: save oauth state:", e);
    return writeError(c, 500, "nonce_error", "could not generate state");
  }

  const url = linkURL(c.env, orgId, state);
  return c.json({ link_url: url }, 200);
});

// ─── GET /integrations/bankfeed/callback (public) ─────────────────────────────

router.get("/integrations/bankfeed/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const errParam = c.req.query("error") ?? "";

  if (errParam) {
    return writeError(c, 400, "oauth_denied", `bank-feed authorisation was denied: ${errParam}`);
  }
  if (!state || !code) {
    return writeError(c, 400, "missing_params", "state and code are required");
  }

  const orgId = await consumeOAuthState(c.env, state);
  if (!orgId) {
    return writeError(c, 400, "invalid_state", "unknown or expired OAuth state");
  }

  // userId is not set on public routes; use empty string (matches Go: identity.UserIDFrom may be zero).
  const userId = c.get("userId") ?? "";

  let result: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    result = await exchangeCode(c.env, code);
  } catch (e) {
    console.error("bankfeed: exchange code:", e);
    return writeError(c, 500, "exchange_failed", String(e instanceof Error ? e.message : e));
  }

  const { accounts, accessToken, refreshToken, expiresAt } = result;
  const connIds: string[] = [];

  for (const la of accounts) {
    try {
      const conn = await createConnection(
        c.env, orgId, userId, "stitch", la,
        accessToken, refreshToken,
        consentExpiry(expiresAt),
      );
      await updateConnectionStatus(c.env, conn.id, "connected", "", "");

      // Background initial sync — fire-and-forget (no await: matches Go goroutine).
      c.executionCtx?.waitUntil(
        syncConnection(c.env, { ...conn, accessTokenEncrypted: accessToken })
          .catch((e) => console.error(`bankfeed: initial sync ${conn.id}:`, e)),
      );

      connIds.push(conn.id);
    } catch (e) {
      console.error(`bankfeed: create connection for account ${la.providerAccountId}:`, e);
    }
  }

  return c.json({ connected: true, provider: "stitch", connection_ids: connIds }, 200);
});

// ─── GET /orgs/:orgID/integrations/bankfeed/connections ───────────────────────

router.get("/orgs/:orgID/integrations/bankfeed/connections", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let conns;
  try {
    conns = await listConnections(c.env, orgId);
  } catch (e) {
    console.error("bankfeed: list connections:", e);
    return writeError(c, 500, "list_failed", String(e instanceof Error ? e.message : e));
  }

  const rows = conns.map((conn) => ({
    id: conn.id,
    provider: conn.provider,
    institution_name: conn.institutionName,
    mask: conn.mask,
    status: conn.status,
    ...(conn.lastSyncedAt ? { last_synced_at: conn.lastSyncedAt } : {}),
    ...(conn.errorMessage ? { error_message: conn.errorMessage } : {}),
  }));

  return c.json({ connections: rows }, 200);
});

// ─── GET /orgs/:orgID/integrations/bankfeed/connections/:connID ───────────────

router.get(
  "/orgs/:orgID/integrations/bankfeed/connections/:connID",
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");
    const connId = c.req.param("connID");

    let conn;
    try {
      conn = await getConnection(c.env, orgId, connId);
    } catch (e) {
      console.error("bankfeed: get connection:", e);
      return writeError(c, 500, "get_failed", String(e instanceof Error ? e.message : e));
    }

    if (!conn) return writeError(c, 404, "not_found", "connection not found");
    return c.json(connectionToJSON(conn), 200);
  },
);

// ─── DELETE /orgs/:orgID/integrations/bankfeed/connections/:connID ────────────

router.delete(
  "/orgs/:orgID/integrations/bankfeed/connections/:connID",
  requireAdmin,
  async (c) => {
    const orgId = c.req.param("orgID");
    const connId = c.req.param("connID");

    const conn = await getConnection(c.env, orgId, connId);
    if (!conn) return writeError(c, 404, "not_found", "connection not found");

    try {
      await updateConnectionStatus(c.env, connId, "disconnected", "", "");
    } catch (e) {
      console.error("bankfeed: disconnect:", e);
      return writeError(c, 500, "disconnect_failed", String(e instanceof Error ? e.message : e));
    }

    return c.json({ disconnected: true }, 200);
  },
);

// ─── POST /orgs/:orgID/integrations/bankfeed/connections/:connID/sync ─────────

router.post(
  "/orgs/:orgID/integrations/bankfeed/connections/:connID/sync",
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");
    const connId = c.req.param("connID");

    if (!stitchConfigured(c.env)) {
      return writeError(c, 503, "not_configured", "bank-feed provider is not configured");
    }

    let conn;
    try {
      conn = await getConnection(c.env, orgId, connId);
    } catch (e) {
      console.error("bankfeed: get connection for sync:", e);
      return writeError(c, 500, "get_failed", String(e instanceof Error ? e.message : e));
    }

    if (!conn) return writeError(c, 404, "not_found", "connection not found");

    if (conn.status !== "connected") {
      return writeError(
        c, 409, "not_connected",
        `connection is not in 'connected' state (status: ${conn.status})`,
      );
    }

    // Fire-and-forget background sync (mirrors Go goroutine).
    c.executionCtx?.waitUntil(
      syncConnection(c.env, conn)
        .catch((e) => console.error(`bankfeed: manual sync ${conn!.id}:`, e)),
    );

    return c.json({ syncing: true, connection_id: connId }, 202);
  },
);

// ─── POST /integrations/bankfeed/webhook (public) ─────────────────────────────

router.post("/integrations/bankfeed/webhook", async (c) => {
  const bodyBuf = await c.req.arrayBuffer();
  const payload = new Uint8Array(bodyBuf);

  const secret = c.env.STITCH_WEBHOOK_SECRET ?? "";
  const sig = c.req.header("x-stitch-signature") ?? c.req.header("X-Stitch-Signature") ?? "";

  if (!secret) {
    return writeError(c, 503, "not_configured", "webhook secret not configured");
  }

  let valid: boolean;
  try {
    valid = await validateWebhook(payload, sig, secret);
  } catch (e) {
    console.error("bankfeed: webhook validate:", e);
    return writeError(c, 401, "invalid_signature", "signature validation error");
  }

  if (!valid) {
    return writeError(c, 401, "invalid_signature", "stitch: invalid webhook signature");
  }

  let evtType: string;
  try {
    evtType = webhookEventType(payload);
  } catch (e) {
    return writeError(c, 400, "parse_error", String(e instanceof Error ? e.message : e));
  }

  console.log(`bankfeed: webhook event=${evtType}`);

  switch (evtType) {
    case "transaction.settled":
    case "payment.initiated":
    case "transactions":
      // Best-effort re-sync all due connections.
      c.executionCtx?.waitUntil(
        (async () => {
          const { syncBankFeeds } = await import("./cron");
          await syncBankFeeds(c.env).catch((e) =>
            console.error("bankfeed: webhook-triggered sync:", e),
          );
        })(),
      );
      break;
    case "reauth_required":
    case "identity.verification_required":
      console.log("bankfeed: reauth required from webhook");
      break;
    default:
      break;
  }

  return c.body(null, 204);
});

export default router;
