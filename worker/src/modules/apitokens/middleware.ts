/**
 * API-token authentication middleware for the public /v1 surface.
 *
 * Mirrors Go apitokens.(*Store).Middleware + RequireScope:
 *   1. Extract "Bearer sk_..." from Authorization header.
 *   2. Compute 12-char prefix (prefixOf) + SHA-256 hex hash.
 *   3. Look up api_tokens by prefix + hash.
 *   4. Check revoked / expired.
 *   5. Validate path orgID == token.organization_id (cross-org fence).
 *   6. Check KV rate limit (env.RATE_LIMIT optional; bypassed if absent).
 *   7. Check scope.
 *   8. Stash ApiToken in Hono context variables for downstream handlers.
 *
 * Usage:
 *   import { requireApiToken } from "./middleware";
 *   router.post("/v1/orgs/:orgID/documents", requireApiToken("documents:write"), handler);
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/app";
import { hashToken } from "../../lib/crypto";
import { writeError } from "../../lib/errors";
import { authenticateApiToken, prefixOf } from "./queries";
import { checkRateLimit } from "./ratelimit";
import type { ApiToken } from "./types";

// Extend AppEnv variables with the stashed API token.
export type ApiTokenEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    apiToken: ApiToken;
  };
};

/**
 * Returns a Hono middleware that authenticates via sk_... Bearer token and
 * enforces the given scope. The validated ApiToken is stashed in c.var.apiToken.
 * Integrator mounts: router.use("/v1/*", requireApiToken("scope")).
 */
export function requireApiToken(scope: string): MiddlewareHandler<ApiTokenEnv> {
  return async (c, next) => {
    // 1. Extract Bearer token.
    const raw = bearerToken(c.req.header("Authorization"));
    if (!raw) {
      return writeError(c, 401, "missing_token", "API token required");
    }
    if (!raw.startsWith("sk_")) {
      return writeError(c, 401, "invalid_token", "invalid API token");
    }

    // 2. Compute prefix + hash.
    const prefix = prefixOf(raw);
    const hash = hashToken(raw);

    // 3. Client IP for audit / last_used_ip.
    const sourceIp = clientIp(c.req.header("X-Forwarded-For"), c.req.header("CF-Connecting-IP"));

    // 4. Look up + validate.
    let tok: ApiToken | null;
    try {
      tok = await authenticateApiToken(c.env, prefix, hash, sourceIp);
    } catch (err) {
      console.error("apitokens: authenticate error:", err);
      return writeError(c, 401, "invalid_token", "invalid API token");
    }

    if (!tok) {
      return writeError(c, 401, "invalid_token", "invalid API token");
    }

    // 5. Cross-org fence: path orgID must match the token's organization_id.
    const pathOrgId = c.req.param("orgID");
    if (pathOrgId && pathOrgId !== tok.organization_id) {
      return writeError(c, 403, "forbidden", "token does not belong to this organization");
    }

    // 6. KV rate limit check.
    let allowed: boolean;
    try {
      allowed = await checkRateLimit(c.env, tok.id, tok.rate_limit_per_minute);
    } catch {
      // If KV fails, allow (fail open — mirrors Go's non-fatal design).
      allowed = true;
    }
    if (!allowed) {
      c.header("Retry-After", "60");
      return writeError(c, 429, "rate_limited", "rate limit exceeded; retry after 60 seconds");
    }

    // 7. Scope check.
    if (!tok.scopes.includes(scope)) {
      return writeError(c, 403, "insufficient_scope", `token does not have the '${scope}' scope`);
    }

    // 8. Stash token for downstream handlers.
    c.set("apiToken", tok);
    // Also populate userId when the token carries a user_id (mirrors Go WithToken).
    if (tok.user_id) c.set("userId", tok.user_id);

    await next();
  };
}

// ---------------------------------------------------------------------------
// Helpers (mirrors Go bearerToken / clientIP)
// ---------------------------------------------------------------------------

function bearerToken(h: string | undefined): string {
  if (!h) return "";
  const prefix = "Bearer ";
  if (h.length <= prefix.length || h.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return "";
  }
  return h.slice(prefix.length).trim();
}

function clientIp(xff: string | undefined, cfIp: string | undefined): string {
  if (cfIp) return cfIp.trim();
  if (xff) {
    const first = xff.split(",")[0];
    return first ? first.trim() : "";
  }
  return "";
}
