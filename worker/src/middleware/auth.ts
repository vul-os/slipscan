/**
 * Auth middleware — port of Go internal/auth/middleware.go.
 * Validates the Bearer access token, stashes userId/email in the Hono context.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/app";
import { parseToken } from "../lib/jwt";
import { writeError } from "../lib/errors";

export type AuthResult = "ok" | "missing" | "invalid";

/**
 * Authenticate the request from the Bearer access token, setting userId/email
 * on the context. Idempotent (no-op if userId already set). Returns a status
 * so callers can pick the right error. Used by requireAuth AND by
 * requireMember/requireAdmin so org routes work whether or not requireAuth was
 * explicitly chained.
 */
export async function authenticate(c: Context<AppEnv>): Promise<AuthResult> {
  if (c.get("userId")) return "ok";
  const raw = bearerToken(c.req.header("Authorization"));
  if (!raw) return "missing";
  try {
    const claims = await parseToken(c.env.JWT_SECRET, raw, "access");
    c.set("userId", claims.uid);
    if (claims.email) c.set("email", claims.email);
    return "ok";
  } catch {
    return "invalid";
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await authenticate(c);
  if (r === "missing") return writeError(c, 401, "missing_token", "authorization header required");
  if (r === "invalid") return writeError(c, 401, "invalid_token", "invalid or expired token");
  await next();
};

function bearerToken(h: string | undefined): string {
  if (!h) return "";
  const prefix = "Bearer ";
  if (h.length <= prefix.length || h.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return "";
  }
  return h.slice(prefix.length).trim();
}
