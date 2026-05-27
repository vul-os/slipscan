/**
 * Recon HTTP routes — port of backend/internal/recon/handlers.go.
 *
 * Routes (absolute paths from root — integrator mounts at "/"):
 *   POST /orgs/:orgID/reconcile                      → run matcher
 *   GET  /orgs/:orgID/reconcile                      → 3-bucket view
 *   POST /orgs/:orgID/reconcile/:matchID/confirm     → confirm match
 *   POST /orgs/:orgID/reconcile/:matchID/reject      → reject match
 *
 * All routes: requireMember.
 * No-double-match invariant enforced via unique DB constraint + in-memory
 * used-tx/line sets during a single run (mirrors Go RunMatcher).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { withOrg } from "../../db/client";
import { generateCandidates, sortByConfidence } from "./matcher";
import {
  unmatchedTransactions,
  unmatchedLines,
  insertMatch,
  listByState,
  listUnmatchedTxIds,
  listUnmatchedLineIds,
  getMatch,
  transitionMatch,
} from "./queries";
import { defaultConfig } from "./types";
import type { RunResult, Buckets, MatchRecord, MatchState } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cfg = defaultConfig();

const router = new Hono<AppEnv>();

// ─── POST /orgs/:orgID/reconcile — run matcher ─────────────────────────────────

router.post("/orgs/:orgID/reconcile", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let result: RunResult;
  try {
    result = await withOrg(c.env, orgId, c.get("userId"), async (q) => {
      const txs = await unmatchedTransactions(q, orgId);
      if (txs.length === 0) return { auto_matched: 0, suggested: 0, skipped: 0 };

      const lines = await unmatchedLines(q, orgId);
      if (lines.length === 0) return { auto_matched: 0, suggested: 0, skipped: 0 };

      const candidates = generateCandidates(txs, lines, cfg);
      sortByConfidence(candidates);

      const usedTx = new Set<string>();
      const usedLine = new Set<string>();
      const res: RunResult = { auto_matched: 0, suggested: 0, skipped: 0 };

      for (const cand of candidates) {
        if (usedTx.has(cand.tx.id) || usedLine.has(cand.line.id)) {
          res.skipped++;
          continue;
        }

        const m = await insertMatch(q, orgId, cand, cfg);
        if (m === null) {
          // null = ErrDoubleMatch (unique constraint fired)
          res.skipped++;
          continue;
        }

        usedTx.add(cand.tx.id);
        usedLine.add(cand.line.id);

        if (m.state === "auto") res.auto_matched++;
        else res.suggested++;
      }

      return res;
    });
  } catch (e) {
    console.error("recon: run matcher:", e);
    return writeError(c, 500, "matcher_error", "reconciliation run failed");
  }

  return c.json(result, 200);
});

// ─── GET /orgs/:orgID/reconcile — 3-bucket view ────────────────────────────────

router.get("/orgs/:orgID/reconcile", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let buckets: Buckets;
  try {
    buckets = await withOrg(c.env, orgId, c.get("userId"), async (q) => {
      const [auto, confirmed, suggested, txIds, lineIds] = await Promise.all([
        listByState(q, orgId, "auto"),
        listByState(q, orgId, "confirmed"),
        listByState(q, orgId, "suggested"),
        listUnmatchedTxIds(q, orgId),
        listUnmatchedLineIds(q, orgId),
      ]);

      const matched: MatchRecord[] = [...auto, ...confirmed];

      return {
        matched,
        suggested,
        unmatched: {
          transaction_ids: txIds,
          statement_line_ids: lineIds,
        },
      } satisfies Buckets;
    });
  } catch (e) {
    console.error("recon: get buckets:", e);
    return writeError(c, 500, "fetch_error", "failed to fetch reconciliation data");
  }

  return c.json(buckets, 200);
});

// ─── POST /orgs/:orgID/reconcile/:matchID/confirm ──────────────────────────────

router.post("/orgs/:orgID/reconcile/:matchID/confirm", requireMember, async (c) => {
  return handleMatchAction(c, "confirmed", ["auto", "suggested"]);
});

// ─── POST /orgs/:orgID/reconcile/:matchID/reject ───────────────────────────────

router.post("/orgs/:orgID/reconcile/:matchID/reject", requireMember, async (c) => {
  return handleMatchAction(c, "rejected", ["auto", "suggested", "confirmed"]);
});

// ─── Shared action helper ──────────────────────────────────────────────────────

async function handleMatchAction(
  c: Context<AppEnv>,
  toState: MatchState,
  allowedFrom: MatchState[],
): Promise<Response> {
  const orgId = c.req.param("orgID") ?? "";
  const matchId = c.req.param("matchID") ?? "";
  const userId = c.get("userId") ?? "";

  if (!matchId || !UUID_RE.test(matchId)) {
    return writeError(c, 400, "invalid_match_id", "invalid match id");
  }
  if (!userId) {
    return writeError(c, 401, "unauthorized", "missing identity");
  }

  let m: MatchRecord;
  try {
    m = await withOrg(c.env, orgId, userId, async (q) => {
      const existing = await getMatch(q, orgId, matchId);
      if (!existing) {
        throw Object.assign(new Error("not_found"), { code: "not_found" });
      }
      if (!allowedFrom.includes(existing.state)) {
        throw Object.assign(new Error("already_actioned"), { code: "already_actioned" });
      }
      const updated = await transitionMatch(q, orgId, matchId, userId, toState);
      if (!updated) {
        throw Object.assign(new Error("not_found"), { code: "not_found" });
      }
      return updated;
    });
  } catch (e) {
    if (e instanceof Error) {
      const code = (e as Error & { code?: string }).code;
      if (code === "not_found") {
        return writeError(c, 404, "not_found", "match not found");
      }
      if (code === "already_actioned") {
        return writeError(c, 409, "already_actioned", "match is already confirmed or rejected");
      }
    }
    console.error("recon: action match:", e);
    return writeError(c, 500, "internal_error", "action failed");
  }

  return c.json(m, 200);
}

export default router;
