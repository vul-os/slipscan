/**
 * Recon domain types — exact port of backend/internal/recon/types.go.
 *
 * Key design decisions:
 * - Amount fields are `string` (NUMERIC from Postgres arrives as string; never
 *   coerce to JS number — use lib/money for arithmetic).
 * - Dates are ISO-8601 strings (Neon driver returns timestamps as strings).
 * - MatchState mirrors the recon_match_state DB enum.
 */

// ─── Match state ───────────────────────────────────────────────────────────────

export type MatchState = "auto" | "suggested" | "confirmed" | "rejected";

// ─── Config ────────────────────────────────────────────────────────────────────

export interface ReconConfig {
  /** ± calendar-day tolerance between document tx date and bank line date. */
  dateWindowDays: number;
  /** Max absolute amount difference before amount score → 0. */
  amountToleranceAbs: number;
  /** Fraction of document amount (0.005 = 0.5 %). */
  amountTolerancePct: number;
  /** Confidence at or above → state=auto. */
  autoConfidenceThreshold: number;
  /** Confidence at or above → state=suggested; below → discarded. */
  suggestConfidenceThreshold: number;
}

export function defaultConfig(): ReconConfig {
  return {
    dateWindowDays: 5,
    amountToleranceAbs: 0.02,
    amountTolerancePct: 0.005,
    autoConfidenceThreshold: 0.85,
    suggestConfidenceThreshold: 0.55,
  };
}

// ─── Candidate types (internal to the matcher) ────────────────────────────────

export interface TxCandidate {
  id: string;
  organizationId: string;
  documentId: string | null;
  /** ISO-8601 date string, or empty/null when unknown. */
  postedDate: string | null;
  /** Numeric string from Postgres NUMERIC column. */
  amount: string;
  currency: string;
  merchant: string;
  merchantNormalized: string;
}

export interface LineCandidate {
  id: string;
  organizationId: string;
  /** ISO-8601 date string, or empty/null when unknown. */
  lineDate: string | null;
  description: string;
  /** Numeric string from Postgres NUMERIC column. */
  amount: string;
}

export interface CandidateMatch {
  tx: TxCandidate;
  line: LineCandidate;
  /** Absolute difference as a JS number (safe: already computed from Decimal). */
  amountDelta: number;
  dateDeltaDays: number;
  merchantScore: number;
  confidence: number;
}

// ─── Persisted row ─────────────────────────────────────────────────────────────

export interface MatchRecord {
  id: string;
  organization_id: string;
  transaction_id: string;
  statement_line_id: string;
  state: MatchState;
  confidence: number;
  amount_delta: string;
  date_delta_days: number;
  merchant_score: number;
  actioned_by: string | null;
  actioned_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── HTTP response shapes ──────────────────────────────────────────────────────

export interface Buckets {
  matched: MatchRecord[];
  suggested: MatchRecord[];
  unmatched: {
    transaction_ids: string[];
    statement_line_ids: string[];
  };
}

export interface RunResult {
  auto_matched: number;
  suggested: number;
  skipped: number;
}
