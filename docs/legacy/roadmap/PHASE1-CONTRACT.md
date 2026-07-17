# Phase 1 integration contract

Phase 1 is a dependency chain (P1-01 → P1-02 → P1-03 → P1-04; P1-05 off P1-02).
To let agents build **in parallel** without colliding, every handoff goes
through the **database schema** (already defined in migrations 1–3) and the
**shared helpers below** — never through another agent's un-merged Go code.

Each agent works in its own git worktree branched from the same base, which
**already contains** `internal/merchant` (the shared normalizer). Read this
file before coding. If you need to change a shared contract, note it loudly in
your final summary so integration can reconcile it.

## 1. Shared code (already on the base branch — import, don't reinvent)

- **`backend/internal/merchant`** — `merchant.Normalize(raw string) string`.
  The ONE canonical merchant normalizer. P1-02 (cascade matching + writing
  `transactions.merchant_normalized`), P1-03 (`classification_corrections.
  merchant_normalized` + rule promotion), and P1-04 (signal aggregation) MUST
  all key on the output of this function. Do not write your own.

## 2. Data handoffs (the contract is the table)

### P1-01 → P1-02 : `document_extractions.extracted` (JSONB)
P1-01 writes the active extraction (`is_current=true`, pointer in
`documents.current_extraction_id`) with `extracted` in this shape:

```json
{
  "kind": "slip|invoice|bank_statement",
  "merchant": "WOOLWORTHS PTY LTD #4021",
  "date": "2026-05-18",
  "currency": "ZAR",
  "subtotal": 210.00, "tax": 31.50, "total": 241.50,
  "confidence": 0.94,
  "line_items": [
    {"description": "Milk 2L", "qty": 1, "unit": 24.99, "amount": 24.99}
  ],
  "statement_lines": [
    {"date":"2026-05-01","description":"...","amount":-120.00,"balance":880.00}
  ]
}
```
- `statement_lines` present only for `kind=bank_statement`; `line_items` for slip/invoice.
- Amounts are decimal numbers in the document currency. `confidence` ∈ [0,1].
- P1-02 reads this row; it does NOT call P1-01 Go code. If the shape must
  change, both tasks update this section.

### P1-02 → ledger/UI : `transactions` + `transaction_classifications`
- P1-02 creates `transactions` (one per extraction, or per `statement_line`),
  setting `merchant`, `merchant_normalized = merchant.Normalize(merchant)`,
  `amount`, `currency`, `posted_date`, `direction`, `status='pending'`.
- It writes the winning `transaction_classifications` row (`is_current=true`,
  pointer in `transactions.current_classification_id`) with `source` ∈
  `rule|merchant_signal|llm`, `confidence`, and `category_id`/`account_id`.
- Cascade precedence (highest first): **user > rule > merchant_signal > llm**.
  LLM categories MUST be constrained to the org's `categories` (no invented labels).

### P1-03 : corrections + rule promotion
- A user recategorization writes `classification_corrections` (old/new category,
  `merchant_normalized`, `corrected_by`) and a new `transaction_classifications`
  row with `source='user'`, `confidence=1.0`, flips `is_current`.
- After ≥ N (default 2) identical corrections for the same `merchant_normalized`
  → category, upsert a `classification_rules` row (`merchant_exact` or
  `merchant_contains`, `source='user'`). NEVER overwrite a `source='user'`
  classification during backfill.

### P1-04 : cross-tenant signals (`merchant_signals`)
- Keyed `(merchant_normalized, category_label)` — `category_label` is the
  category **name** (TEXT), NOT a per-org UUID. Aggregate
  `classification_corrections` across all orgs into vote counts.
- Privacy invariant (test it): only `merchant_normalized`, `category_label`,
  `vote_count`, timestamps may be written — never amounts, org id, or user id.
- P1-02's `merchant_signal` cascade stage looks up the top signal by
  `merchant_normalized`, then maps `category_label` → the org's category by name.

## 3. HTTP route ownership (avoid `main.go` collisions)
Each agent adds ONLY its routes, following the existing `authed` /
`authedMember` / `authedAdmin` pattern in `backend/cmd/server/main.go`.
Conflicts in `main.go` are expected and reconciled at merge; keep additions
grouped and clearly commented with the task id.

| Task | Routes (under `/orgs/{orgID}`) |
|---|---|
| P1-01 | `POST /documents/{docID}/extract` (re-run); ingest hook triggers extraction |
| P1-02 | `POST /documents/{docID}/classify`; `GET /transactions`; seed categories on org create |
| P1-03 | `PATCH /transactions/{txID}/classification` (`?apply_to_existing=`) |
| P1-04 | internal job (cron/leader-guarded, like `internal/fx`); no public route |
| P1-05 | frontend only — consumes P1-01/02/03 routes via `src/lib/api.js` |

## 4. File-ownership map (minimize merge conflicts)
- **P1-01**: `internal/extract` (or extend `internal/ocr`), extraction persistence.
- **P1-02**: `internal/classify` (cascade + tx creation + category seeding).
- **P1-03**: extend `internal/classify` (corrections + promotion) — coordinate
  package layout with P1-02 by using separate files (`corrections.go`).
- **P1-04**: `internal/classify/signals.go` or `internal/signals` + a cmd hook.
- **P1-05**: `src/pages/Receipts.jsx`, `ReceiptDetail.jsx`, `src/lib/queries.js`.
- Shared, do-not-fork: `internal/merchant`, the migrations, `config.go`
  (additions only, grouped).

## 5. Definition of done (all tasks)
`cd backend && go build ./... && go vet ./...` clean; `npm run build` clean if
frontend touched; unit tests for your logic; key on `merchant.Normalize`; no
edits to applied migrations (new timestamped migration if schema truly needed —
but Phase 1 should need none, the tables exist). Set `status: review`,
`owner: sonnet-agent`, append a Notes section to your task file.
