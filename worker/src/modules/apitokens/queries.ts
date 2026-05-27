/**
 * Raw parameterized SQL — ported 1:1 from Go internal/apitokens/store.go.
 * Every org query includes WHERE organization_id = $ (belt-and-suspenders).
 * Token hash is SHA-256 hex; prefix is first 12 chars of plaintext token.
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";
import type { TokenMeta, ApiToken } from "./types";

// ---------------------------------------------------------------------------
// Token generation helpers (mirrors Go apitokens/token.go)
// ---------------------------------------------------------------------------

/**
 * Generate a new API token in format sk_{kind}_{randomBase64url}.
 * Returns plaintext, prefix (first 12 chars), and SHA-256 hex hash.
 * Mirrors Go generate(kind).
 */
export function generateToken(kind: string): { plaintext: string; prefix: string } {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const raw = base64UrlNoPad(b);
  const plaintext = `sk_${kind}_${raw}`;
  const prefix = prefixOf(plaintext);
  return { plaintext, prefix };
}

/** Returns first 12 chars of token (matches Go prefixOf). */
export function prefixOf(plaintext: string): string {
  return plaintext.length <= 12 ? plaintext : plaintext.slice(0, 12);
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Issue (INSERT)
// ---------------------------------------------------------------------------

/**
 * Insert a new api_tokens row. Returns the created row's id + created_at.
 * Mirrors Go (*Store).Issue (sans token generation, done by caller).
 */
export async function insertApiToken(
  env: Env,
  orgId: string,
  createdBy: string,
  name: string,
  kind: string,
  tokenHash: string,
  tokenPrefix: string,
  scopes: string[],
  rateLimitPerMin: number | null,
  expiresAt: string | null,
): Promise<{ id: string; created_at: string }> {
  const scopesJson = JSON.stringify(scopes);
  const rows = await queryRows(
    env,
    `INSERT INTO api_tokens
       (organization_id, created_by, name, kind, token_hash, token_prefix,
        scopes, rate_limit_per_minute, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text, created_at`,
    [orgId, createdBy, name, kind, tokenHash, tokenPrefix, scopesJson, rateLimitPerMin, expiresAt],
  );
  const row = rows[0];
  return {
    id: row.id as string,
    created_at: row.created_at instanceof Date
      ? (row.created_at as Date).toISOString()
      : String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// List (SELECT meta — no hash)
// ---------------------------------------------------------------------------

/**
 * List active (non-revoked) tokens for an org, newest-first.
 * Never returns the hash. Mirrors Go (*Store).ListByOrg.
 */
export async function listApiTokens(env: Env, orgId: string): Promise<TokenMeta[]> {
  const rows = await queryRows(
    env,
    `SELECT id::text, organization_id::text, created_by::text,
            name, kind, token_prefix,
            scopes, rate_limit_per_minute,
            last_used_at, expires_at, created_at
     FROM api_tokens
     WHERE organization_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [orgId],
  );

  return rows.map((r): TokenMeta => {
    let scopes: string[] = [];
    if (r.scopes) {
      if (typeof r.scopes === "string") {
        try { scopes = JSON.parse(r.scopes as string); } catch { /* ignore */ }
      } else if (Array.isArray(r.scopes)) {
        scopes = r.scopes as string[];
      }
    }
    const m: TokenMeta = {
      id: r.id as string,
      organization_id: r.organization_id as string,
      name: r.name as string,
      kind: r.kind as TokenMeta["kind"],
      prefix: r.token_prefix as string,
      scopes,
      rate_limit_per_minute: r.rate_limit_per_minute ? Number(r.rate_limit_per_minute) : 0,
      created_at: r.created_at instanceof Date
        ? (r.created_at as Date).toISOString()
        : String(r.created_at),
    };
    if (r.created_by != null) m.created_by = r.created_by as string;
    if (r.last_used_at != null) {
      m.last_used_at = r.last_used_at instanceof Date
        ? (r.last_used_at as Date).toISOString()
        : String(r.last_used_at);
    }
    if (r.expires_at != null) {
      m.expires_at = r.expires_at instanceof Date
        ? (r.expires_at as Date).toISOString()
        : String(r.expires_at);
    }
    return m;
  });
}

// ---------------------------------------------------------------------------
// Revoke (UPDATE)
// ---------------------------------------------------------------------------

/**
 * Mark a token as revoked. Returns false if not found / already revoked.
 * Mirrors Go (*Store).Revoke.
 */
export async function revokeApiToken(
  env: Env,
  tokenId: string,
  orgId: string,
  revokedBy: string,
): Promise<boolean> {
  const rows = await queryRows(
    env,
    `UPDATE api_tokens
     SET revoked_at = NOW(), revoked_by = $3
     WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [tokenId, orgId, revokedBy],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Authenticate (lookup by prefix + hash)
// ---------------------------------------------------------------------------

/**
 * Look up a token by prefix + hash, validate revoked/expired, update last_used_at.
 * Returns the decoded ApiToken or null on invalid/not-found.
 * Mirrors Go (*Store).Authenticate.
 */
export async function authenticateApiToken(
  env: Env,
  tokenPrefix: string,
  tokenHash: string,
  sourceIp: string,
): Promise<ApiToken | null> {
  const row = await queryOne(
    env,
    `SELECT id::text, organization_id::text, user_id::text,
            name, kind, scopes,
            rate_limit_per_minute, expires_at, revoked_at, created_at
     FROM api_tokens
     WHERE token_prefix = $1 AND token_hash = $2
     LIMIT 1`,
    [tokenPrefix, tokenHash],
  );

  if (!row) return null;
  if (row.revoked_at != null) return null;
  if (row.expires_at != null) {
    const exp = new Date(row.expires_at as string);
    if (Date.now() > exp.getTime()) return null;
  }

  let scopes: string[] = [];
  if (row.scopes) {
    if (typeof row.scopes === "string") {
      try { scopes = JSON.parse(row.scopes as string); } catch { /* ignore */ }
    } else if (Array.isArray(row.scopes)) {
      scopes = row.scopes as string[];
    }
  }

  // Best-effort last_used_at update — fire-and-forget (mirrors Go).
  void queryRows(
    env,
    `UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1`,
    [row.id, sourceIp],
  ).catch(() => {});

  const tok: ApiToken = {
    id: row.id as string,
    organization_id: row.organization_id as string,
    name: row.name as string,
    kind: row.kind as ApiToken["kind"],
    scopes,
    rate_limit_per_minute: row.rate_limit_per_minute ? Number(row.rate_limit_per_minute) : 0,
    created_at: row.created_at instanceof Date
      ? (row.created_at as Date).toISOString()
      : String(row.created_at),
  };
  if (row.user_id != null) tok.user_id = row.user_id as string;
  if (row.expires_at != null) {
    tok.expires_at = row.expires_at instanceof Date
      ? (row.expires_at as Date).toISOString()
      : String(row.expires_at);
  }
  return tok;
}
