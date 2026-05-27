/**
 * API-token admin management router.
 *
 * Mounts at "/" (integrator mounts at "/"):
 *   POST   /orgs/:orgID/api-tokens              — issue (admin-gated)
 *   GET    /orgs/:orgID/api-tokens              — list meta, no hash (admin-gated)
 *   DELETE /orgs/:orgID/api-tokens/:tokenID     — revoke (admin-gated)
 *
 * Shapes/status/error codes match Go internal/apitokens/handlers.go exactly.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/org";
import { hashToken } from "../../lib/crypto";
import { writeError } from "../../lib/errors";
import {
  generateToken,
  prefixOf,
  insertApiToken,
  listApiTokens,
  revokeApiToken,
} from "./queries";
import type { IssueRequest, TokenMetaResponse } from "./types";
import { VALID_KINDS } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = new Hono<AppEnv>();

// ---- POST /orgs/:orgID/api-tokens (issue) ----
router.post(
  "/orgs/:orgID/api-tokens",
  requireAuth,
  requireAdmin,
  async (c) => {
    const orgId = c.req.param("orgID");
    const userId = c.get("userId");
    if (!userId) {
      return writeError(c, 401, "unauthorized", "missing identity");
    }

    let req: IssueRequest;
    try {
      req = await c.req.json<IssueRequest>();
    } catch {
      return writeError(c, 400, "invalid_body", "request body must be valid JSON");
    }

    if (!req.name || req.name.trim() === "") {
      return writeError(c, 400, "missing_name", "name is required");
    }
    if (!VALID_KINDS.has(req.kind)) {
      return writeError(c, 400, "invalid_kind", "kind must be 'live', 'test', or 'restricted'");
    }
    if (!Array.isArray(req.scopes) || req.scopes.length === 0) {
      return writeError(c, 400, "missing_scopes", "at least one scope is required");
    }

    // Generate token.
    const { plaintext, prefix } = generateToken(req.kind);
    const hash = hashToken(plaintext);

    // Compute expiry.
    let expiresAt: string | null = null;
    if (req.expires_in_days && req.expires_in_days > 0) {
      const exp = new Date();
      exp.setUTCDate(exp.getUTCDate() + req.expires_in_days);
      expiresAt = exp.toISOString();
    }

    const rateLimitPerMin =
      req.rate_limit_per_minute && req.rate_limit_per_minute > 0
        ? req.rate_limit_per_minute
        : null;

    let created: { id: string; created_at: string };
    try {
      created = await insertApiToken(
        c.env,
        orgId,
        userId,
        req.name.trim(),
        req.kind,
        hash,
        prefix,
        req.scopes,
        rateLimitPerMin,
        expiresAt,
      );
    } catch (err) {
      console.error("apitokens issue:", err);
      return writeError(c, 500, "issue_failed", "could not issue token");
    }

    return c.json(
      {
        id: created.id,
        name: req.name.trim(),
        kind: req.kind,
        scopes: req.scopes,
        prefix: prefixOf(plaintext),
        token: plaintext, // shown exactly once
        created_at: created.created_at,
      },
      201,
    );
  },
);

// ---- GET /orgs/:orgID/api-tokens (list) ----
router.get(
  "/orgs/:orgID/api-tokens",
  requireAuth,
  requireAdmin,
  async (c) => {
    const orgId = c.req.param("orgID");

    let metas;
    try {
      metas = await listApiTokens(c.env, orgId);
    } catch (err) {
      console.error("apitokens list:", err);
      return writeError(c, 500, "list_failed", "could not list tokens");
    }

    const out: TokenMetaResponse[] = metas.map((m) => {
      const resp: TokenMetaResponse = {
        id: m.id,
        name: m.name,
        kind: m.kind,
        scopes: m.scopes,
        prefix: m.prefix,
        created_at: m.created_at,
      };
      if (m.rate_limit_per_minute) resp.rate_limit_per_minute = m.rate_limit_per_minute;
      if (m.last_used_at) resp.last_used_at = m.last_used_at;
      if (m.expires_at) resp.expires_at = m.expires_at;
      return resp;
    });

    return c.json({ api_tokens: out });
  },
);

// ---- DELETE /orgs/:orgID/api-tokens/:tokenID (revoke) ----
router.delete(
  "/orgs/:orgID/api-tokens/:tokenID",
  requireAuth,
  requireAdmin,
  async (c) => {
    const orgId = c.req.param("orgID");
    const tokenId = c.req.param("tokenID");
    const userId = c.get("userId");

    if (!UUID_RE.test(tokenId)) {
      return writeError(c, 400, "invalid_token_id", "invalid token id");
    }
    if (!userId) {
      return writeError(c, 401, "unauthorized", "missing identity");
    }

    let found: boolean;
    try {
      found = await revokeApiToken(c.env, tokenId, orgId, userId);
    } catch (err) {
      console.error("apitokens revoke:", err);
      return writeError(c, 500, "revoke_failed", "could not revoke token");
    }

    if (!found) {
      return writeError(c, 404, "not_found", "token not found or already revoked");
    }

    return c.json({ status: "revoked" });
  },
);

export default router;
