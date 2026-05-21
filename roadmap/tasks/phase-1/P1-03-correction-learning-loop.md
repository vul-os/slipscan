---
id: P1-03
title: Correction-learning loop (per-org)
phase: 1
status: review
depends_on: [P1-02]
owner: unassigned
---

## Goal
When a user changes a transaction's category/account, record the correction and
**learn from it within the org**: promote repeated corrections into
`classification_rules` so the same merchant is auto-classified correctly next
time. This is the feature competitors can't trivially copy — make it visible.

## Context
`classification_corrections` and `classification_rules` exist for exactly this.
The forward path (P1-02) writes classifications with a `source`; this task closes
the loop so accuracy climbs with use.

## Existing assets
- `classification_corrections`, `classification_rules`, `transaction_classifications`,
  `merchant_signals` tables; `classification_source` enum (`user`).
- `internal/classify` (from P1-02) — extend it.

## Scope
**In:** `PATCH` endpoint to recategorize a transaction; write a
`classification_corrections` row + update `transaction_classifications`
(source `user`, confidence 1.0); promotion logic that creates/strengthens a
`classification_rules` row after N corrections of the same merchant→category;
optional bulk "apply to all past matching transactions".
**Out:** cross-tenant aggregation (P1-04); the UI affordance (P1-05 builds it,
this exposes the API).

## Implementation
1. `PATCH /orgs/{orgID}/transactions/{txID}/classification` accepting a new
   category (and account for business): insert `classification_corrections`
   (old → new, who, when), update the active `transaction_classifications` to
   `source='user'`, confidence 1.0.
2. **Promotion:** when a normalized merchant has ≥N (configurable, default 2)
   user corrections to the same category, upsert a `classification_rules` row
   (`merchant_exact` or `merchant_contains`) so future ingests auto-match at the
   rule stage. Don't override an existing user-edited rule silently.
3. **Backfill option:** `?apply_to_existing=true` reclassifies past `pending`/
   rule/llm-sourced transactions of the same merchant (never overwrite a `user`
   classification).
4. Update `merchant_signals` confidence for the org's own future use (the
   cross-tenant rollup is P1-04).

## Acceptance criteria
- [ ] Recategorizing a transaction records a `classification_corrections` row and
      flips its classification to `source='user'`, confidence 1.0.
- [ ] After the threshold of identical corrections, a `classification_rules` row
      exists and a newly-ingested transaction for that merchant is auto-classified
      at the `rule` stage (verified end-to-end).
- [ ] `apply_to_existing` reclassifies matching non-user transactions and leaves
      user-classified ones untouched.
- [ ] Corrections are idempotent (re-PATCHing the same value doesn't duplicate rules).

## Tests
- Unit: promotion threshold logic; "never overwrite user" invariant; merchant
  normalization parity with P1-02.
- Integration: correct twice → ingest same merchant → auto-classified correctly.

## Notes
This is the headline demo: "correct it once or twice, it never asks again." Make
the promotion threshold and behaviour easy to tune; log promotions so we can
measure correction-rate decline (a P1 success metric).
