---
id: T2
title: Phase 1 pipeline end-to-end integration test harness
phase: 1
status: review
depends_on: [P1-01, P1-02, P1-03, P1-04]
owner: sonnet-agent
---

## Goal

Provide a build-tagged (`//go:build integration`) test harness that asserts the
full Phase 1 pipeline end-to-end once implementation tasks integrate:
extract → classify → correct → rule-promote → auto-classify via rule.

## File

`backend/internal/testsuite/pipeline_e2e_test.go`

## How to run

```sh
DATABASE_URL="postgres:///slipscan?host=/var/run/postgresql" \
  go test -tags=integration -v ./internal/testsuite/... -run TestPhase1PipelineE2E
```

Replace the DSN with any migrated Postgres instance. The test skips cleanly if
`DATABASE_URL` is not set, so `go test ./...` (no tag) is unaffected.

## What it asserts (once impl integrates)

| Sub-test | Route / table | Assertion |
|---|---|---|
| `P1-02_classify` | `POST /orgs/{orgID}/documents/{docID}/classify` | `transactions` row created; `merchant_normalized = merchant.Normalize(raw)`; `transaction_classifications` row with `is_current=true` and `source` ∈ `rule\|merchant_signal\|llm` |
| `P1-02_list_transactions` | `GET /orgs/{orgID}/transactions` | Classified tx appears; `merchant_normalized` matches |
| `P1-03_correction_1` | `PATCH /orgs/{orgID}/transactions/{txID}/classification` | `classification_corrections` row written; new classification with `source='user'`, `confidence=1.0`; **no rule promoted** (1 < threshold) |
| `P1-03_correction_2_promotes_rule` | same PATCH on a second tx for same merchant | After 2 identical corrections → `classification_rules` row upserted with `source='user'`, `match_value = merchant.Normalize(raw)` |
| `P1-02_auto_classify_via_rule` | `POST .../classify` on a third doc for same merchant | New classification has `source='rule'` (cascade matched the promoted rule) |
| `P1-04_merchant_signals_privacy` | `information_schema.columns` | `merchant_signals` has no `organization_id`, `user_id`, or `corrected_by` columns |
| `merchant_normalize_consistency` | `transactions` table | Every row: `merchant_normalized = merchant.Normalize(merchant)` end-to-end |

## Pending behaviour on base branch

All Phase 1 HTTP endpoints skip with a clear "pending Pxx" message because
they return 404 until implementation agents register their routes. The test
still PASSES (as SKIP) on the base branch.

Steps that depend on previous steps cascade-skip: if `P1-02_classify` skips,
`P1-03_correction_1` also skips with "txID not set (classify step skipped)".

Steps that do not require HTTP (privacy invariant, normalize consistency) run
and pass immediately.

## Seed strategy

Each run creates an isolated personal org+user via direct SQL inserts
(no HTTP auth for setup). A `documents` row and a `document_extractions` row
are seeded with the Phase 1 §2 `extracted` JSONB shape (`kind=slip`,
`merchant="WOOLWORTHS PTY LTD #4021"`, etc.). A `t.Cleanup` removes all rows
via cascade delete on the org.

## Notes

### Design decisions

- **In-process `httptest.Server`** — no external running server required.
  The test builds a `http.ServeMux` wiring only the auth+org routes that
  exist on the base branch. Phase 1 routes added by implementation agents
  (in `cmd/server/main.go`) must also be added to `newTestMux` in this file,
  or the sub-tests will continue to skip.
- **Direct SQL for seeding** — mirrors the existing `testsuite/seed.go`
  pattern; avoids the `storage` / `ocr` dependency chain that would require
  live B2 / Gemini credentials.
- **JWT issued directly** — `auth.NewSigner.Issue()` is called in-process so
  Bearer tokens work without a real login endpoint hitting the DB.
- **No edits to implementation packages** — the file only imports
  `internal/auth`, `internal/db`, `internal/email`, `internal/httpx`,
  `internal/merchant`, `internal/org` — all stable packages on the base branch.
- **Threshold N=2** — the promotion test seeds exactly 2 corrections and
  asserts a rule exists. If the implementation uses a different threshold,
  update `seedTransactions` in this file accordingly (it is the only
  threshold-sensitive assertion).

### What implementation agents must do to make tests go green

1. **P1-02** registers `POST /orgs/{orgID}/documents/{docID}/classify` and
   `GET /orgs/{orgID}/transactions` in `cmd/server/main.go` **and** in
   `newTestMux` in this file (or the tests will keep skipping).
2. **P1-03** registers `PATCH /orgs/{orgID}/transactions/{txID}/classification`
   in both places.
3. The classify response must include `{"transaction_id": "<uuid>"}`.
4. `merchant_normalized` must equal `merchant.Normalize(raw_merchant_string)`.

### Verification on base branch

```
DATABASE_URL="postgres:///slipscan?host=/var/run/postgresql" \
  go test -tags=integration -v ./internal/testsuite/... -run TestPhase1PipelineE2E

=== RUN   TestPhase1PipelineE2E
--- SKIP: TestPhase1PipelineE2E/P1-02_classify           (pending P1-02)
--- SKIP: TestPhase1PipelineE2E/P1-02_list_transactions  (pending P1-02)
--- SKIP: TestPhase1PipelineE2E/P1-03_correction_1       (pending P1-02)
--- SKIP: TestPhase1PipelineE2E/P1-03_correction_2...    (pending P1-02)
--- SKIP: TestPhase1PipelineE2E/P1-02_auto_classify...   (pending P1-03)
--- PASS: TestPhase1PipelineE2E/P1-04_merchant_signals_privacy
--- PASS: TestPhase1PipelineE2E/merchant_normalize_consistency
PASS
```

`go build ./...` and `go vet ./...` (with and without `-tags=integration`) are
both clean.
