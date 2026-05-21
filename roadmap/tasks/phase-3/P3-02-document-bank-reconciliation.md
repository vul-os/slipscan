---
id: P3-02
title: Document ↔ bank-feed auto-reconciliation
phase: 3
status: todo
depends_on: [P3-01]
owner: unassigned
---

## Goal
Automatically match ingested documents (slips/invoices) to imported bank
transactions, so a bank line and its receipt are linked with no user action —
and surface the unmatched residue for review. This pairing of feeds **and**
documents is the platform's signature feature; no competitor does both.

## Context
P3-01 brings bank lines in; P1-01/P1-02 bring documents + their transactions. A
slip for R250 at "Woolworths" should auto-link to the R250 Woolworths bank line.
Use an LLM/heuristic matcher and let users confirm/override (which itself becomes
training signal, echoing P1-03).

## Existing assets
- `transactions`, `statement_lines`, `documents`, `document_extractions`,
  `transaction_classifications`; `transfers` table for inter-account moves.
- `internal/classify` + merchant normalizer; `internal/ocr` LLM client.

## Scope
**In:** a matcher that links document-derived transactions to imported bank
`statement_lines`/`transactions` by amount + date-window + normalized merchant
(with an LLM tie-breaker for fuzzy cases); a confidence + state on each match;
a reconciliation UI (matched / suggested / unmatched); user confirm/reject that
feeds back; surface a "missing receipt" / "missing bank line" list.
**Out:** auto-creating bank lines from documents; multi-currency settlement edge
cases (flag, don't solve fully); statutory reconciliation reports (P2-04 owns reports).

## Implementation
1. Matching key: normalized merchant + amount (within tolerance) + date window
   (configurable, e.g. ±5 days for card settlement lag). Candidate generation in
   `internal/recon` (new package).
2. Scoring: deterministic score from the above; LLM tie-breaker when multiple
   candidates or low score; produce a match confidence.
3. Persistence: a reconciliation/match record linking document-transaction ↔
   bank line with state (`auto`, `suggested`, `confirmed`, `rejected`) and
   confidence (new small migration for a `reconciliation_matches` table if none
   fits; check existing tables first).
4. Auto-apply high-confidence matches; queue mid-confidence as suggestions.
5. UI: three-bucket reconciliation view; confirm/reject; "unmatched bank lines"
   and "documents without a bank line" lists.
6. Feedback: confirm/reject adjusts matcher thresholds + can strengthen merchant
   normalization (reuse the P1-03 learning ethos).

## Acceptance criteria
- [ ] A document and a bank line for the same purchase auto-link above the
      confidence threshold, with no user action.
- [ ] Mid-confidence pairs appear as suggestions the user can confirm/reject;
      confirming persists the link, rejecting removes it.
- [ ] Unmatched bank lines and receipt-less documents are each listed.
- [ ] No double-matching (a line/document links to at most one counterpart unless
      explicitly split).
- [ ] `go build` + `npm run build` clean.

## Tests
- Unit: candidate generation + scoring (amount/date/merchant tolerances),
  no-double-match invariant, date-window edges.
- Integration: seeded documents + imported lines → expected auto-matches and
  suggestions; LLM tie-breaker gated on `GEMINI_API_KEY`.

## Notes
This is the Phase 3 payoff and a core moat. Track the auto-match rate (a P3
success metric). Confirm/reject is both UX and training data — wire it so the
matcher improves over time.
