/**
 * Workspace routes — port of Go backend/internal/workspace/handler.go.
 *
 * Implements (requireAuth only — NO org context):
 *   GET /workspace
 *
 * Response: { "orgs": [ { "id", "name", "kind", "role", "attention": { ... } } ] }
 *
 * ROUTING: absolute paths from root; integrator mounts this router at "/".
 * NOTE: /workspace is USER-SCOPED (authed/JWT only, not requireMember).
 *       There is no :orgID in the path — it lists all the user's orgs.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { writeError } from "../../lib/errors";
import { forUser } from "./queries";

const router = new Hono<AppEnv>();

// GET /workspace
// User-scoped: returns every org the caller belongs to with per-org attention counts.
router.get("/workspace", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return writeError(c, 401, "unauthorized", "missing identity");
  }

  let entries;
  try {
    entries = await forUser(c.env, userId);
  } catch {
    return writeError(c, 500, "workspace_failed", "could not load workspace");
  }

  // Never return a JSON null for the array — callers expect an empty slice.
  return c.json({ orgs: entries }, 200);
});

export default router;
