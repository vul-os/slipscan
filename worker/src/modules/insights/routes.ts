/**
 * Insights routes — port of Go backend/internal/insights/handler.go.
 *
 * Implements (requireMember):
 *   POST /orgs/:orgID/ask  { "question": "how much did I spend on Uber last month?" }
 *
 * NL→structured-query flow:
 *   1. Gemini.generateJSON translates question → { intent, filters }
 *   2. Type-safe parameterized SQL executes (no SQL injection possible)
 *   3. Returns { intent, filters, summary, rows }
 *
 * ROUTING: absolute paths from root; integrator mounts this router at "/".
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { RateLimitedError } from "../../lib/gemini";
import { translate } from "./translate";
import { run } from "./run";

const router = new Hono<AppEnv>();

// POST /orgs/:orgID/ask
// Returns the parsed Query, a deterministic summary, and the result rows
// the chosen intent produced.
router.post("/orgs/:orgID/ask", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const raw = typeof body.question === "string" ? body.question.trim() : "";
  if (raw === "") {
    return writeError(c, 400, "empty_question", "question is required");
  }
  if (raw.length > 500) {
    return writeError(c, 400, "question_too_long", "question must be under 500 characters");
  }

  let parsed;
  try {
    parsed = await translate(c.env.GEMINI_API_KEY, raw);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return writeError(c, 429, "rate_limited", "AI search is busy right now. Try again in a moment.");
    }
    return writeError(c, 502, "translate_failed", "Couldn't understand the question — try rephrasing.");
  }

  let result;
  try {
    result = await run(c.env, orgId, parsed);
  } catch (e) {
    return writeError(c, 500, "run_failed", e instanceof Error ? e.message : "query failed");
  }

  return c.json(result, 200);
});

export default router;
