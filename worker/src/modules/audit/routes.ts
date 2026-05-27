/**
 * Audit module — Hono router.
 *
 * Mounts at /orgs/:orgID/audit (integrator mounts at "/"):
 *   GET /orgs/:orgID/audit   — filterable list, admin-gated
 *
 * Query params (all optional):
 *   actor_user_id  — filter by actor UUID
 *   entity_type    — filter by entity class (e.g. "transaction")
 *   entity_id      — filter by entity UUID
 *   action         — filter by exact action string
 *   since          — RFC3339 lower bound (exclusive)
 *   until          — RFC3339 upper bound (inclusive)
 *   limit          — max rows (default 100, max 1000)
 *   offset         — pagination offset
 *
 * Shapes/status/error codes match Go internal/audit/handler.go exactly.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/org";
import { withOrg } from "../../db/client";
import { writeError } from "../../lib/errors";
import { listAuditLog } from "./queries";
import type { ListFilter } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function parseQueryInt(val: string | undefined, def: number): number {
  if (!val) return def;
  const n = parseInt(val, 10);
  return isNaN(n) ? def : n;
}

const router = new Hono<AppEnv>();

// GET /orgs/:orgID/audit
router.get(
  "/orgs/:orgID/audit",
  requireAuth,
  requireAdmin,
  async (c) => {
    const orgId = c.req.param("orgID");

    const f: ListFilter = {};

    const actorUserIdParam = c.req.query("actor_user_id");
    if (actorUserIdParam) {
      if (!UUID_RE.test(actorUserIdParam)) {
        return writeError(c, 400, "invalid_actor_user_id", "actor_user_id must be a valid UUID");
      }
      f.actor_user_id = actorUserIdParam;
    }

    const entityTypeParam = c.req.query("entity_type");
    if (entityTypeParam) f.entity_type = entityTypeParam;

    const entityIdParam = c.req.query("entity_id");
    if (entityIdParam) {
      if (!UUID_RE.test(entityIdParam)) {
        return writeError(c, 400, "invalid_entity_id", "entity_id must be a valid UUID");
      }
      f.entity_id = entityIdParam;
    }

    const actionParam = c.req.query("action");
    if (actionParam) f.action = actionParam;

    const sinceParam = c.req.query("since");
    if (sinceParam) {
      if (!RFC3339_RE.test(sinceParam)) {
        return writeError(c, 400, "invalid_since", "since must be RFC3339");
      }
      f.since = sinceParam;
    }

    const untilParam = c.req.query("until");
    if (untilParam) {
      if (!RFC3339_RE.test(untilParam)) {
        return writeError(c, 400, "invalid_until", "until must be RFC3339");
      }
      f.until = untilParam;
    }

    f.limit = parseQueryInt(c.req.query("limit"), 100);
    f.offset = parseQueryInt(c.req.query("offset"), 0);

    let entries;
    try {
      entries = await withOrg(c.env, orgId, c.get("userId"), async (q) => {
        return listAuditLog(q, orgId, f);
      });
    } catch (err) {
      console.error("audit list:", err);
      return writeError(c, 500, "list_failed", "could not list audit entries");
    }

    return c.json({ audit_log: entries ?? [] });
  },
);

export default router;
