/**
 * Xero integration routes — port of backend/internal/accounting_export/handlers.go.
 *
 * Routes (mounted at "/" from index.ts):
 *   GET    /orgs/:orgID/integrations/xero/status      — requireMember
 *   GET    /orgs/:orgID/integrations/xero/sync-status — requireMember
 *   POST   /orgs/:orgID/integrations/xero/push        — requireMember
 *   GET    /orgs/:orgID/integrations/xero/connect     — requireAdmin
 *   DELETE /orgs/:orgID/integrations/xero/connect     — requireAdmin
 *   GET    /integrations/xero/callback                — public (OAuth callback)
 *
 * When XERO_CLIENT_ID is unset all routes return 503.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { writeError } from "../../lib/errors";
import { requireAdmin, requireMember } from "../../middleware/org";
import {
  buildAuthURL,
  exchangeCode,
  disconnectXero,
  getXeroStatus,
  pushContact,
  pushTransaction,
  PROVIDER_NAME,
} from "./xero";
import {
  listUnexportedContacts,
  listUnexportedTransactions,
  getContact,
  getTransaction,
  listMappings,
  recordSyncError,
} from "./queries";

// ── Nonce generator ───────────────────────────────────────────────────────────

function generateNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Router factory ────────────────────────────────────────────────────────────

const r = new Hono<AppEnv>();

/** 503 guard for missing Xero credentials. */
r.use("*", async (c, next) => {
  if (!c.env.XERO_CLIENT_ID) {
    return writeError(c, 503, "xero_not_configured", "Xero integration is not configured");
  }
  await next();
});

// ── GET /orgs/:orgID/integrations/xero/status ─────────────────────────────────

r.get("/orgs/:orgID/integrations/xero/status", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const grant = await getXeroStatus(c.env, orgId);

  if (!grant) {
    return c.json({ connected: false, provider: PROVIDER_NAME });
  }

  const body: Record<string, unknown> = {
    connected: true,
    provider:  PROVIDER_NAME,
  };
  if (grant.accountEmail) body.account_email = grant.accountEmail;
  return c.json(body);
});

// ── GET /orgs/:orgID/integrations/xero/sync-status ───────────────────────────

r.get("/orgs/:orgID/integrations/xero/sync-status", requireMember, async (c) => {
  const orgId    = c.req.param("orgID");
  const mappings = await listMappings(c.env, orgId, PROVIDER_NAME);

  const out = mappings.map((m) => ({
    local_type:    m.localType,
    local_id:      m.localId,
    external_id:   m.externalId,
    last_synced_at: m.lastSyncedAt ?? null,
    sync_error:    m.syncError    ?? null,
  }));

  return c.json({ mappings: out });
});

// ── POST /orgs/:orgID/integrations/xero/push ─────────────────────────────────

interface PushRequestBody {
  contact_ids?:     string[];
  transaction_ids?: string[];
}

r.post("/orgs/:orgID/integrations/xero/push", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let body: PushRequestBody = {};
  try {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      body = await c.req.json<PushRequestBody>();
    }
  } catch {
    return writeError(c, 400, "invalid_body", "invalid JSON body");
  }

  const report = {
    contacts_pushed:     0,
    transactions_pushed: 0,
    errors:              [] as string[],
  };

  // ── Push contacts ─────────────────────────────────────────────────────────
  let contacts = [];
  if (body.contact_ids?.length) {
    for (const idStr of body.contact_ids) {
      try {
        const contact = await getContact(c.env, orgId, idStr);
        contacts.push(contact);
      } catch (e) {
        report.errors.push(`contact ${idStr}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    try {
      contacts = await listUnexportedContacts(c.env, orgId, PROVIDER_NAME);
    } catch (e) {
      return writeError(c, 500, "list_contacts_failed", e instanceof Error ? e.message : String(e));
    }
  }

  for (const contact of contacts) {
    try {
      await pushContact(c.env, orgId, contact);
      report.contacts_pushed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordSyncError(c.env, orgId, PROVIDER_NAME, "contact", contact.id, msg).catch(() => {});
      report.errors.push(`contact ${contact.id}: ${msg}`);
    }
  }

  // ── Push transactions ─────────────────────────────────────────────────────
  let transactions = [];
  if (body.transaction_ids?.length) {
    for (const idStr of body.transaction_ids) {
      try {
        const tx = await getTransaction(c.env, orgId, idStr);
        transactions.push(tx);
      } catch (e) {
        report.errors.push(`transaction ${idStr}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    try {
      transactions = await listUnexportedTransactions(c.env, orgId, PROVIDER_NAME);
    } catch (e) {
      return writeError(c, 500, "list_transactions_failed", e instanceof Error ? e.message : String(e));
    }
  }

  for (const tx of transactions) {
    try {
      await pushTransaction(c.env, orgId, tx);
      report.transactions_pushed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordSyncError(c.env, orgId, PROVIDER_NAME, "transaction", tx.id, msg).catch(() => {});
      report.errors.push(`transaction ${tx.id}: ${msg}`);
    }
  }

  const allFailed =
    report.errors.length > 0 &&
    report.contacts_pushed === 0 &&
    report.transactions_pushed === 0;

  return c.json(report, allFailed ? 422 : 200);
});

// ── GET /orgs/:orgID/integrations/xero/connect (OAuth start) ─────────────────

r.get("/orgs/:orgID/integrations/xero/connect", requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  const state = generateNonce();

  const authURL = await buildAuthURL(c.env, orgId, state);
  return c.redirect(authURL, 302);
});

// ── DELETE /orgs/:orgID/integrations/xero/connect ────────────────────────────

r.delete("/orgs/:orgID/integrations/xero/connect", requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  await disconnectXero(c.env, orgId);
  return c.json({ disconnected: true });
});

// ── GET /integrations/xero/callback (public) ─────────────────────────────────

r.get("/integrations/xero/callback", async (c) => {
  const state    = c.req.query("state")  ?? "";
  const code     = c.req.query("code")   ?? "";
  const errParam = c.req.query("error")  ?? "";

  if (errParam) {
    return writeError(c, 400, "oauth_denied", `Xero authorisation was denied: ${errParam}`);
  }
  if (!state || !code) {
    return writeError(c, 400, "missing_params", "state and code are required");
  }

  // userId may be absent when the callback arrives without a session cookie.
  const userId = c.get("userId") ?? "";

  try {
    const { tenantId } = await exchangeCode(c.env, state, code, userId);
    return c.json({
      connected:     true,
      provider:      PROVIDER_NAME,
      account_email: tenantId,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("expired OAuth state")) {
      return writeError(c, 400, "invalid_state", "unknown or expired OAuth state");
    }
    return writeError(c, 500, "exchange_failed", e instanceof Error ? e.message : String(e));
  }
});

export default r;
