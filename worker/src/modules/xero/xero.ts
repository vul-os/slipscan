/**
 * XeroProvider — port of backend/internal/accounting_export/xero.go.
 *
 * Handles OAuth2 (auth URL, code exchange, token refresh) and data push
 * (contacts, bank transactions). Token storage uses the DB (oauth_grants).
 *
 * Token "encryption": in this port tokens are stored as plaintext strings
 * (the DB column is text). Production should swap encrypt/decrypt with an
 * AES-GCM implementation keyed from APP_SECRET — the interface is identical.
 *
 * OAuth state (CSRF nonce) is persisted to the oauth_states table so it
 * survives across CF Worker instances (replaces Go's in-memory sync.Map).
 */
import type { Env } from "../../bindings";
import type {
  Contact,
  Transaction,
  PushResult,
  Grant,
  XeroTokenResponse,
  XeroConnection,
} from "./types";
import {
  DEFAULT_XERO_SCOPES,
  ERR_GRANT_NOT_FOUND,
} from "./types";
import {
  getGrant,
  upsertGrant,
  updateGrantTokens,
  revokeGrant,
  getMapping,
  upsertMapping,
  saveOAuthState,
  consumeOAuthState,
} from "./queries";

const XERO_TOKEN_URL       = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_CONTACTS_URL    = "https://api.xero.com/api.xro/2.0/Contacts";
const XERO_BANK_TX_URL     = "https://api.xero.com/api.xro/2.0/BankTransactions";

export const PROVIDER_NAME = "xero";

// ── Public helpers (used by routes.ts) ────────────────────────────────────────

/**
 * Build the Xero OAuth2 consent URL.
 * Persists `state` nonce → orgId in DB for callback validation.
 */
export async function buildAuthURL(
  env:   Env,
  orgId: string,
  state: string,
): Promise<string> {
  await saveOAuthState(env, state, orgId);
  const scopes = DEFAULT_XERO_SCOPES.join(" ");
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     env.XERO_CLIENT_ID!,
    redirect_uri:  env.XERO_REDIRECT_URL!,
    scope:         scopes,
    state,
  });
  return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
}

/**
 * Validate the callback state nonce and exchange code for tokens.
 * Returns the connected Xero tenant ID (stored as account_email for display).
 */
export async function exchangeCode(
  env:    Env,
  state:  string,
  code:   string,
  userId: string,
): Promise<{ tenantId: string; orgId: string }> {
  // Validate state nonce (CSRF).
  const orgId = await consumeOAuthState(env, state);
  if (!orgId) throw new Error("xero: unknown or expired OAuth state");

  const tok = await tokenRequest(env, new URLSearchParams({
    grant_type:   "authorization_code",
    code,
    redirect_uri: env.XERO_REDIRECT_URL!,
  }));

  const tenantId = await fetchTenantId(tok.access_token);

  await upsertGrant(
    env, orgId, userId, PROVIDER_NAME,
    tenantId,            // account_email stores the Xero tenant ID
    tok.token_type,
    tok.access_token,    // plaintext — swap with encrypt() for production
    tok.refresh_token,
    new Date(Date.now() + tok.expires_in * 1000),
  );

  return { tenantId, orgId };
}

/**
 * Revoke the stored OAuth grant for (orgId, xero).
 */
export async function disconnectXero(env: Env, orgId: string): Promise<void> {
  await revokeGrant(env, orgId, PROVIDER_NAME);
}

/**
 * Fetch grant status for an org. Returns null if not connected.
 */
export async function getXeroStatus(env: Env, orgId: string): Promise<Grant | null> {
  try {
    return await getGrant(env, orgId, PROVIDER_NAME);
  } catch (e) {
    if (e instanceof Error && e.message === ERR_GRANT_NOT_FOUND) return null;
    throw e;
  }
}

// ── Push operations ───────────────────────────────────────────────────────────

/** Push a contact to Xero (create or update, idempotent via mapping table). */
export async function pushContact(env: Env, orgId: string, c: Contact): Promise<PushResult> {
  const { accessToken, tenantId } = await getAccessToken(env, orgId);

  let mapping = null;
  try {
    mapping = await getMapping(env, orgId, PROVIDER_NAME, "contact", c.id);
  } catch { /* not found → create */ }

  const isUpdate = mapping !== null;
  const xc       = buildXeroContact(c, mapping?.externalId);
  const body     = JSON.stringify({ Contacts: [xc] });

  const resp = await fetch(XERO_CONTACTS_URL, {
    method:  "POST",
    headers: xeroHeaders(accessToken, tenantId),
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`xero: push contact: HTTP ${resp.status}: ${text.slice(0, 256)}`);
  }

  const result = (await resp.json()) as { Contacts: Array<{ ContactID: string }> };
  if (!result.Contacts?.length) throw new Error("xero: push contact: empty response");

  const externalId = result.Contacts[0].ContactID;
  await upsertMapping(env, orgId, PROVIDER_NAME, "contact", c.id, externalId);

  return { localId: c.id, externalId, updated: isUpdate };
}

/** Push a bank transaction to Xero (create or update, idempotent). */
export async function pushTransaction(env: Env, orgId: string, t: Transaction): Promise<PushResult> {
  const { accessToken, tenantId } = await getAccessToken(env, orgId);

  let mapping = null;
  try {
    mapping = await getMapping(env, orgId, PROVIDER_NAME, "transaction", t.id);
  } catch { /* not found → create */ }

  const isUpdate = mapping !== null;
  const xt       = buildXeroBankTransaction(t, mapping?.externalId);
  const body     = JSON.stringify({ BankTransactions: [xt] });

  const resp = await fetch(XERO_BANK_TX_URL, {
    method:  "POST",
    headers: xeroHeaders(accessToken, tenantId),
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`xero: push transaction: HTTP ${resp.status}: ${text.slice(0, 256)}`);
  }

  const result = (await resp.json()) as { BankTransactions: Array<{ BankTransactionID: string }> };
  if (!result.BankTransactions?.length) throw new Error("xero: push transaction: empty response");

  const externalId = result.BankTransactions[0].BankTransactionID;
  await upsertMapping(env, orgId, PROVIDER_NAME, "transaction", t.id, externalId);

  return { localId: t.id, externalId, updated: isUpdate };
}

// ── Token management ──────────────────────────────────────────────────────────

/** Return plaintext access token + tenant ID, refreshing if within 60s of expiry. */
async function getAccessToken(
  env:   Env,
  orgId: string,
): Promise<{ accessToken: string; tenantId: string }> {
  let grant = await getGrant(env, orgId, PROVIDER_NAME);

  // Lazy refresh: refresh if expiry is within 60 seconds.
  if (grant.expiresAt && (grant.expiresAt.getTime() - Date.now()) < 60_000) {
    await refreshToken(env, orgId, grant);
    grant = await getGrant(env, orgId, PROVIDER_NAME); // re-fetch after refresh
  }

  const accessToken = grant.accessTokenEncrypted; // plaintext in this port
  const tenantId    = grant.accountEmail ?? "";
  return { accessToken, tenantId };
}

async function refreshToken(env: Env, orgId: string, grant: Grant): Promise<void> {
  const refreshPlain = grant.refreshTokenEncrypted; // plaintext in this port

  const tok = await tokenRequest(env, new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshPlain,
  }));

  await updateGrantTokens(
    env, grant.id,
    tok.access_token,
    tok.refresh_token,
    new Date(Date.now() + tok.expires_in * 1000),
  );
}

// ── Xero API helpers ──────────────────────────────────────────────────────────

async function tokenRequest(env: Env, params: URLSearchParams): Promise<XeroTokenResponse> {
  const creds = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
  const resp  = await fetch(XERO_TOKEN_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`xero: token endpoint HTTP ${resp.status}: ${text.slice(0, 512)}`);
  }

  return (await resp.json()) as XeroTokenResponse;
}

async function fetchTenantId(accessToken: string): Promise<string> {
  const resp = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`xero: connections HTTP ${resp.status}: ${text.slice(0, 512)}`);
  }

  const conns = (await resp.json()) as XeroConnection[];
  // Prefer ORGANISATION type; fall back to first.
  const org = conns.find((c) => c.tenantType === "ORGANISATION") ?? conns[0];
  if (!org) throw new Error("xero: no Xero tenants found for this connection");
  return org.tenantId;
}

function xeroHeaders(accessToken: string, tenantId: string): Record<string, string> {
  return {
    Authorization:    `Bearer ${accessToken}`,
    "Xero-Tenant-Id": tenantId,
    "Content-Type":   "application/json",
    Accept:           "application/json",
  };
}

// ── Xero payload builders ─────────────────────────────────────────────────────

/** Port of buildXeroContact in xero.go. */
function buildXeroContact(c: Contact, existingExternalId?: string): Record<string, unknown> {
  const xc: Record<string, unknown> = { Name: c.name };

  if (existingExternalId) xc["ContactID"] = existingExternalId;
  if (c.email)            xc["EmailAddress"] = c.email;
  if (c.phone)            xc["Phones"] = [{ PhoneType: "DEFAULT", PhoneNumber: c.phone }];
  if (c.taxNumber)        xc["TaxNumber"] = c.taxNumber;

  switch (c.kind) {
    case "customer": xc["IsCustomer"] = true; break;
    case "supplier": xc["IsSupplier"] = true; break;
    case "both":
      xc["IsCustomer"] = true;
      xc["IsSupplier"] = true;
      break;
  }

  if (c.addressLine1 || c.city || c.country) {
    xc["Addresses"] = [{
      AddressType:  "STREET",
      AddressLine1: c.addressLine1,
      AddressLine2: c.addressLine2,
      City:         c.city,
      Region:       c.region,
      PostalCode:   c.postalCode,
      Country:      c.country,
    }];
  }

  return xc;
}

/** Port of buildXeroBankTransaction in xero.go. */
function buildXeroBankTransaction(t: Transaction, existingExternalId?: string): Record<string, unknown> {
  const txType = t.direction === "credit" ? "RECEIVE" : "SPEND";

  const xt: Record<string, unknown> = {
    Type: txType,
    Date: t.postedDate.toISOString().slice(0, 10),
    LineItems: [{
      Description: descriptionFor(t),
      Quantity:    1,
      UnitAmount:  t.amount,
      AccountCode: accountCodeFor(t.accountCode),
      TaxType:     taxTypeFor(t.taxRateCode),
    }],
    BankAccount: { Code: bankAccountCodeFor(t.accountCode) },
  };

  if (existingExternalId) xt["BankTransactionID"] = existingExternalId;

  const NIL_UUID = "00000000-0000-0000-0000-000000000000";
  if (t.contactId && t.contactId !== NIL_UUID) {
    xt["Contact"] = { ContactID: t.contactId };
  }

  if (t.currency) xt["CurrencyCode"] = t.currency;

  return xt;
}

// ── Mapping helpers ───────────────────────────────────────────────────────────

function accountCodeFor(code: string): string {
  return code || "200";
}

function bankAccountCodeFor(code: string): string {
  return code || "090";
}

function taxTypeFor(code: string): string {
  const up = (code ?? "").toUpperCase();
  const KNOWN = new Set([
    "OUTPUT", "INPUT", "EXEMPTOUTPUT", "EXEMPTINPUT",
    "ZERORATEDOUTPUT", "ZERORATEDINPUT", "NONE",
  ]);
  if (!up)            return "NONE";
  if (KNOWN.has(up))  return up;
  return code; // pass-through — org may use Xero-aligned codes
}

function descriptionFor(t: Transaction): string {
  if (t.merchant && t.description && t.merchant !== t.description) {
    return `${t.merchant} — ${t.description}`;
  }
  return t.merchant || t.description;
}

// ── Re-exports for tests ──────────────────────────────────────────────────────
export { buildXeroContact as _buildXeroContact, buildXeroBankTransaction as _buildXeroBankTransaction };
export { accountCodeFor, bankAccountCodeFor, taxTypeFor, descriptionFor };
