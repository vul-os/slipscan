/**
 * Recon store queries — exact port of backend/internal/recon/store.go.
 *
 * All SQL is ported 1:1 from Go. Every org query includes
 * WHERE organization_id=$. We connect as table owner (RLS bypassed).
 * Amount columns are NUMERIC — returned as strings by the Neon driver.
 */
import type { Query } from "../../db/client";
import type {
  TxCandidate,
  LineCandidate,
  CandidateMatch,
  MatchRecord,
  MatchState,
  ReconConfig,
} from "./types";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("23505") || msg.includes("unique") || msg.includes("duplicate");
}

function rowToMatchRecord(r: Record<string, unknown>): MatchRecord {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    transaction_id: r.transaction_id as string,
    statement_line_id: r.statement_line_id as string,
    state: r.state as MatchState,
    confidence: Number(r.confidence),
    amount_delta: String(r.amount_delta ?? "0"),
    date_delta_days: Number(r.date_delta_days ?? 0),
    merchant_score: Number(r.merchant_score ?? 0),
    actioned_by: (r.actioned_by as string | null) ?? null,
    actioned_at: (r.actioned_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// ─── Candidate fetching ────────────────────────────────────────────────────────

/**
 * unmatchedTransactions — port of Store.UnmatchedTransactions.
 * Returns document-derived transactions for orgID with no active
 * (non-rejected) reconciliation match.
 */
export async function unmatchedTransactions(
  q: Query,
  orgId: string,
): Promise<TxCandidate[]> {
  const rows = await q(
    `SELECT t.id, t.organization_id, t.document_id,
            COALESCE(t.posted_date::text, ''),
            COALESCE(t.amount::text, '0'),
            COALESCE(t.currency, ''),
            COALESCE(t.merchant, ''),
            COALESCE(t.merchant_normalized, '')
     FROM transactions t
     WHERE t.organization_id = $1
       AND t.document_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM reconciliation_matches m
           WHERE m.transaction_id = t.id
             AND m.organization_id = $1
             AND m.state <> 'rejected'
       )
     ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC`,
    [orgId],
  );

  return rows.map((r) => ({
    id: r[0] as string,
    organizationId: r[1] as string,
    documentId: (r[2] as string | null) ?? null,
    postedDate: (r[3] as string) || null,
    amount: r[4] as string,
    currency: r[5] as string,
    merchant: r[6] as string,
    merchantNormalized: r[7] as string,
  }));
}

/**
 * unmatchedLines — port of Store.UnmatchedLines.
 * Returns statement_lines for orgID with no active (non-rejected) match.
 */
export async function unmatchedLines(
  q: Query,
  orgId: string,
): Promise<LineCandidate[]> {
  const rows = await q(
    `SELECT sl.id, sl.organization_id,
            COALESCE(sl.line_date::text, ''),
            COALESCE(sl.description, ''),
            COALESCE(sl.amount::text, '0')
     FROM statement_lines sl
     WHERE sl.organization_id = $1
       AND NOT EXISTS (
           SELECT 1 FROM reconciliation_matches m
           WHERE m.statement_line_id = sl.id
             AND m.organization_id = $1
             AND m.state <> 'rejected'
       )
     ORDER BY sl.line_date DESC NULLS LAST, sl.created_at DESC`,
    [orgId],
  );

  return rows.map((r) => ({
    id: r[0] as string,
    organizationId: r[1] as string,
    lineDate: (r[2] as string) || null,
    description: r[3] as string,
    amount: r[4] as string,
  }));
}

// ─── Match persistence ─────────────────────────────────────────────────────────

/**
 * insertMatch — port of Store.InsertMatch.
 * Persists a single CandidateMatch. Returns null on ErrDoubleMatch
 * (unique-constraint violation — callers should silently skip).
 * Throws on other DB errors.
 */
export async function insertMatch(
  q: Query,
  orgId: string,
  c: CandidateMatch,
  cfg: ReconConfig,
): Promise<MatchRecord | null> {
  const state: MatchState = c.confidence >= cfg.autoConfidenceThreshold ? "auto" : "suggested";

  try {
    const rows = await q(
      `INSERT INTO reconciliation_matches
           (organization_id, transaction_id, statement_line_id,
            state, confidence, amount_delta, date_delta_days, merchant_score)
       VALUES ($1, $2, $3, $4::recon_match_state, $5, $6, $7, $8)
       RETURNING id, organization_id, transaction_id, statement_line_id,
                 state, confidence, amount_delta, date_delta_days, merchant_score,
                 actioned_by, actioned_at, created_at, updated_at`,
      [
        orgId,
        c.tx.id,
        c.line.id,
        state,
        c.confidence,
        c.amountDelta,
        c.dateDeltaDays,
        c.merchantScore,
      ],
    );
    return rows.length ? rowToMatchRecord(rows[0]) : null;
  } catch (e) {
    if (isUniqueViolation(e)) return null; // ErrDoubleMatch — caller skips
    throw e;
  }
}

// ─── Listing ───────────────────────────────────────────────────────────────────

/**
 * listByState — port of Store.ListByState.
 */
export async function listByState(
  q: Query,
  orgId: string,
  state: MatchState,
): Promise<MatchRecord[]> {
  const rows = await q(
    `SELECT id, organization_id, transaction_id, statement_line_id,
            state, confidence, amount_delta, date_delta_days, merchant_score,
            actioned_by, actioned_at, created_at, updated_at
     FROM reconciliation_matches
     WHERE organization_id = $1 AND state = $2
     ORDER BY confidence DESC, created_at DESC`,
    [orgId, state],
  );
  return rows.map(rowToMatchRecord);
}

/**
 * listUnmatchedTxIds — port of Store.ListUnmatchedTxIDs.
 */
export async function listUnmatchedTxIds(q: Query, orgId: string): Promise<string[]> {
  const rows = await q(
    `SELECT t.id
     FROM transactions t
     WHERE t.organization_id = $1
       AND t.document_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM reconciliation_matches m
           WHERE m.transaction_id = t.id
             AND m.organization_id = $1
             AND m.state <> 'rejected'
       )
     ORDER BY t.posted_date DESC NULLS LAST`,
    [orgId],
  );
  return rows.map((r) => r.id as string);
}

/**
 * listUnmatchedLineIds — port of Store.ListUnmatchedLineIDs.
 */
export async function listUnmatchedLineIds(q: Query, orgId: string): Promise<string[]> {
  const rows = await q(
    `SELECT sl.id
     FROM statement_lines sl
     WHERE sl.organization_id = $1
       AND NOT EXISTS (
           SELECT 1 FROM reconciliation_matches m
           WHERE m.statement_line_id = sl.id
             AND m.organization_id = $1
             AND m.state <> 'rejected'
       )
     ORDER BY sl.line_date DESC NULLS LAST`,
    [orgId],
  );
  return rows.map((r) => r.id as string);
}

// ─── Actions ───────────────────────────────────────────────────────────────────

/**
 * getMatch — port of Store.GetMatch.
 * Returns null when the match does not exist or doesn't belong to orgId.
 */
export async function getMatch(
  q: Query,
  orgId: string,
  matchId: string,
): Promise<MatchRecord | null> {
  const rows = await q(
    `SELECT id, organization_id, transaction_id, statement_line_id,
            state, confidence, amount_delta, date_delta_days, merchant_score,
            actioned_by, actioned_at, created_at, updated_at
     FROM reconciliation_matches
     WHERE id = $1 AND organization_id = $2`,
    [matchId, orgId],
  );
  return rows.length ? rowToMatchRecord(rows[0]) : null;
}

/**
 * transitionMatch — port of Store.transition.
 * Allowed-from states are validated in the handler (mirrors Go).
 */
export async function transitionMatch(
  q: Query,
  orgId: string,
  matchId: string,
  userId: string,
  toState: MatchState,
): Promise<MatchRecord | null> {
  const rows = await q(
    `UPDATE reconciliation_matches
     SET state        = $1::recon_match_state,
         actioned_by  = $2,
         actioned_at  = NOW(),
         updated_at   = NOW()
     WHERE id = $3 AND organization_id = $4
     RETURNING id, organization_id, transaction_id, statement_line_id,
               state, confidence, amount_delta, date_delta_days, merchant_score,
               actioned_by, actioned_at, created_at, updated_at`,
    [toState, userId, matchId, orgId],
  );
  return rows.length ? rowToMatchRecord(rows[0]) : null;
}
