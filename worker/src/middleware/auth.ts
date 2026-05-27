/**
 * Auth middleware — port of Go internal/auth/middleware.go.
 * Validates the Bearer access token, stashes userId/email in the Hono context.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/app";
import { parseToken } from "../lib/jwt";
import { writeError } from "../lib/errors";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = bearerToken(c.req.header("Authorization"));
  if (!raw) return writeError(c, 401, "missing_token", "authorization header required");
  try {
    const claims = await parseToken(c.env.JWT_SECRET, raw, "access");
    c.set("userId", claims.uid);
    if (claims.email) c.set("email", claims.email);
  } catch {
    return writeError(c, 401, "invalid_token", "invalid or expired token");
  }
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
