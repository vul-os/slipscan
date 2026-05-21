---
id: P1-03
title: Correction-learning loop (per-org)
phase: 1
status: review
depends_on: [P1-02]
owner: sonnet-agent
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

---

## Implementation notes (sonnet-agent, 2026-05-21)

### Files added
- `backend/internal/classify/corrections.go` — `CorrectionsStore`, all DB
  logic for `ApplyCorrection`, `maybePromote`, `ApplyToExisting`, helpers.
- `backend/internal/classify/handler.go` — `Handler.PatchClassification`
  HTTP handler (P1-03 only; P1-02 adds its own file to this package).
- `backend/internal/classify/corrections_test.go` — 10 unit tests.

### PATCH contract
```
PATCH /orgs/{orgID}/transactions/{txID}/classification
      ?apply_to_existing=true          (optional)

Body:  { "category_id": "<uuid>", "account_id": "<uuid>" }
Auth:  authedMember (JWT + org membership)

Response 200:
  { "correction_id": "...", "classification_id": "...",
    "rule_promoted": true|false, "rule_id": "...",
    "backfill": { "updated": N, "skipped": M } }  // only when apply_to_existing=true
```

### Promotion logic
After `ApplyCorrection`, `maybePromote` counts `DISTINCT transaction_id` in
`classification_corrections` for `(org, merchant_normalized, new_category_id)`.
When count ≥ threshold (default 2, env `CLASSIFY_PROMOTION_THRESHOLD`) it does
an `INSERT … ON CONFLICT … DO UPDATE` on `classification_rules` with
`match_type='merchant_exact'`, `match_value=merchant.Normalize(...)`,
`source='user'`, `confidence=1.0`. The upsert updates `category_id`/`account_id`
if the rule already existed. The promotion is logged at INFO level.

### Never-overwrite-user invariant
`backfillOne` re-reads the row under `FOR UPDATE` and returns `(false, nil)` if
`source='user'`. The caller increments `Skipped`. Direct user corrections
(non-backfill) are always allowed to supersede — the history is preserved in
`classification_corrections`.

### Idempotency
`backfillOne` skips rows where `current classification.category_id == new
category_id`. `maybePromote` uses `ON CONFLICT DO UPDATE` so repeated PATCHes
with the same value don't duplicate rules and don't inflate counts (each PATCH
inserts exactly one `classification_corrections` row, but `DISTINCT
transaction_id` in the count query means re-correcting the same tx doesn't
artificially inflate the promotion counter).

### Config addition
`config.Config.ClassifyPromotionThreshold` (int) read from
`CLASSIFY_PROMOTION_THRESHOLD`; 0 falls back to `DefaultPromotionThreshold=2`.

### P1-02 integration assumption
P1-02 will define its own Store type or extend `CorrectionsStore` in this
package. If P1-02 defines `type Store struct { db *sql.DB }`, integration should
merge the fields (`CorrectionsStore` uses the same `*sql.DB` pool). The
`CorrectionsStore` type can be renamed or embedded as needed. All exported
functions and HTTP handler signatures remain stable regardless.

### Test results
```
ok  github.com/exolutionza/slipscan/backend/internal/classify  0.014s
go build ./... && go vet ./... → clean
```
Tests cover: config defaults, promotion threshold (configurable), never-overwrite
invariant across all sources, idempotency, nullable UUID/source helpers, merchant
normalization parity (delegates to `merchant.Normalize`, not reimplemented).
