/**
 * Recon scorer — exact port of backend/internal/recon/matcher.go.
 *
 * Weights: amount 45 %, date 30 %, merchant 25 %.
 *
 * Amount: linear decay inside tolerance band; exact → 1.0; outside both
 *   absolute AND percentage tolerance → 0.
 * Date: linear decay from 1.0 (same-day) to 0 (dateWindowDays apart);
 *   >window → hard-reject. Both-unknown → 0.5 neutral.
 * Merchant: Jaccard token-overlap on normalized strings; either empty → 0.3
 *   neutral; exact match → 1.0.
 *
 * NUMERIC amounts arrive as strings; we convert to JS number only for
 * arithmetic here (the differences are tiny: tolerance is 2 cents / 0.5 %,
 * so float precision is adequate for scoring — exact equality comparison still
 * uses Decimal via the queries layer).
 */
import type { TxCandidate, LineCandidate, CandidateMatch, ReconConfig } from "./types";

// ─── Sub-scorers ───────────────────────────────────────────────────────────────

/**
 * scoreAmount — port of Go scoreAmount().
 * Returns 1.0 for exact match; 0 when outside both tolerances; linear decay
 * inside the widest applicable band.
 */
export function scoreAmount(txAmt: number, lineAmt: number, cfg: ReconConfig): number {
  const diff = Math.abs(txAmt - lineAmt);
  if (diff === 0) return 1.0;

  let base = Math.abs(txAmt);
  if (base === 0) base = Math.abs(lineAmt);

  const withinAbs = diff <= cfg.amountToleranceAbs;
  const withinPct = base > 0 && diff / base <= cfg.amountTolerancePct;

  if (!withinAbs && !withinPct) return 0;

  // Use the widest ceiling.
  let ceiling = cfg.amountToleranceAbs;
  if (base > 0) {
    const pctCeiling = base * cfg.amountTolerancePct;
    if (pctCeiling > ceiling) ceiling = pctCeiling;
  }
  if (ceiling <= 0) return 1.0;

  const score = 1.0 - diff / ceiling;
  return score < 0 ? 0 : score;
}

/**
 * scoreDate — port of Go scoreDate().
 * Returns 1.0 for same-day, linear decay to 0 at the window boundary.
 * deltaDays > dateWindowDays → 0.
 */
export function scoreDate(deltaDays: number, cfg: ReconConfig): number {
  if (cfg.dateWindowDays <= 0) return deltaDays === 0 ? 1.0 : 0;
  if (deltaDays > cfg.dateWindowDays) return 0;
  return 1.0 - deltaDays / cfg.dateWindowDays;
}

/**
 * scoreMerchant — port of Go scoreMerchant().
 * Jaccard token-overlap ratio over unigrams of normalized strings.
 * Either empty → 0.3 (neutral); exact match → 1.0.
 */
export function scoreMerchant(normA: string, normB: string): number {
  if (!normA || !normB) return 0.3;
  if (normA === normB) return 1.0;

  const setA = tokenSet(normA);
  const setB = tokenSet(normB);

  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

// ─── Date utilities ────────────────────────────────────────────────────────────

/** Convert an ISO date string to an integer epoch-day (days since 1970-01-01). */
function epochDay(iso: string): number {
  const ms = Date.parse(iso);
  if (isNaN(ms)) return -1; // invalid → treated as unknown
  return Math.floor(ms / 86_400_000);
}

/**
 * absDays — port of Go absDays().
 * Returns dateWindowDays + 1 (i.e. "outside window") when either date is
 * unknown/invalid so the pair fails the hard-cutoff test.
 */
function absDays(
  txDate: string | null | undefined,
  lineDate: string | null | undefined,
  cfg: ReconConfig,
): { delta: number; bothKnown: boolean } {
  const outside = cfg.dateWindowDays + 1;
  if (!txDate || !lineDate) return { delta: outside, bothKnown: false };
  const td = epochDay(txDate);
  const ld = epochDay(lineDate);
  if (td < 0 || ld < 0) return { delta: outside, bothKnown: false };
  return { delta: Math.abs(td - ld), bothKnown: true };
}

// ─── Candidate generation ──────────────────────────────────────────────────────

/**
 * generateCandidates — port of Go GenerateCandidates().
 *
 * Cross-joins every tx with every line, scoring pairs and collecting those
 * that exceed suggestConfidenceThreshold. Amount-zero fast-rejects, and both-
 * known date pairs that exceed dateWindowDays are hard-rejected.
 */
export function generateCandidates(
  txs: TxCandidate[],
  lines: LineCandidate[],
  cfg: ReconConfig,
): CandidateMatch[] {
  const out: CandidateMatch[] = [];

  for (const tx of txs) {
    const txAmt = parseFloat(tx.amount);

    for (const line of lines) {
      // Amount score — fast reject.
      const lineAmt = parseFloat(line.amount);
      const amtScore = scoreAmount(txAmt, lineAmt, cfg);
      if (amtScore === 0) continue;

      // Date delta — hard cutoff when both dates are known.
      const { delta, bothKnown } = absDays(tx.postedDate, line.lineDate, cfg);
      if (bothKnown && delta > cfg.dateWindowDays) continue;

      const dateScore = scoreDate(delta, cfg);

      // Merchant score.
      const mScore = scoreMerchant(tx.merchantNormalized, line.description);

      // Composite confidence.
      const confidence = 0.45 * amtScore + 0.30 * dateScore + 0.25 * mScore;
      if (confidence < cfg.suggestConfidenceThreshold) continue;

      out.push({
        tx,
        line,
        amountDelta: Math.abs(txAmt - lineAmt),
        dateDeltaDays: delta,
        merchantScore: mScore,
        confidence,
      });
    }
  }

  return out;
}

/**
 * sortByConfidence — port of Go sortByConfidence (descending).
 */
export function sortByConfidence(candidates: CandidateMatch[]): void {
  candidates.sort((a, b) => b.confidence - a.confidence);
}
