/**
 * Org membership middleware — port of Go internal/org RequireMember/RequireAdmin.
 * Validates the {orgID} path param against the caller's memberships and stashes
 * the role. Routes mounted under these still pass orgID into every query
 * (app-layer isolation) and run inside withOrg() (DB RLS) — defense in depth.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/app";
import type { Env } from "../bindings";
import type { Role } from "../types/schema";
import { roleAtLeastAdmin } from "../types/schema";
import { queryRows } from "../db/client";
import { writeError } from "../lib/errors";
import { authenticate } from "./auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the caller's role in the org, or null if not a member. */
export async function memberRole(env: Env, orgId: string, userId: string): Promise<Role | null> {
  const rows = await queryRows(
    env,
    "SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2",
    [orgId, userId],
  );
  return rows.length ? (rows[0].role as Role) : null;
}

export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgId = c.req.param("orgID");
  if (!orgId || !UUID_RE.test(orgId)) return writeError(c, 400, "invalid_org_id", "invalid organization id");
  if ((await authenticate(c)) !== "ok") return writeError(c, 401, "unauthorized", "missing identity");
  const userId = c.get("userId");
  const role = await memberRole(c.env, orgId, userId);
  if (!role) return writeError(c, 403, "forbidden", "not a member of this organization");
  c.set("orgRole", role);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgId = c.req.param("orgID");
  if (!orgId || !UUID_RE.test(orgId)) return writeError(c, 400, "invalid_org_id", "invalid organization id");
  if ((await authenticate(c)) !== "ok") return writeError(c, 401, "unauthorized", "missing identity");
  const userId = c.get("userId");
  const role = await memberRole(c.env, orgId, userId);
  if (!role) return writeError(c, 403, "forbidden", "not a member of this organization");
  if (!roleAtLeastAdmin(role)) return writeError(c, 403, "forbidden", "admin role required");
  c.set("orgRole", role);
  await next();
};
