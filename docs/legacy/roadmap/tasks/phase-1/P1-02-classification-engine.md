---
id: P1-02
title: Transaction classification engine
phase: 1
status: review
depends_on: [P1-01]
owner: sonnet-agent
---

## Goal
Turn extracted documents into classified `transactions`: assign a category (and,
for business orgs, an account) with a confidence and a recorded source. Apply
rules first, then merchant signals, then LLM fallback — writing the result to
`transaction_classifications`. This is the core of the "win the wedge" phase.

## Context
The schema already models the entire classification stack — rules, per-transaction
classifications with a `source`, corrections, and cross-tenant merchant signals.
This task wires the **forward path** (classify on ingest); P1-03 adds the
**learning path** (corrections feed back).

## Existing assets
- `transactions`, `transaction_classifications`, `transaction_splits` tables.
- `classification_rules` (`match_type`: merchant_exact/contains/regex),
  `merchant_signals`, `categories` (`category_kind`), `accounts` (`account_type`).
- Enums `classification_source` (user/rule/llm/merchant_signal/system),
  `classification_match_type`.
- `ai_models`/`ai_runs` (`classification` kind); `internal/ocr` LLM client.

## Scope
**In:** new `internal/classify` package; create `transactions` from
`document_extractions`; a classification cascade (rules → merchant_signals →
LLM); persist `transaction_classifications` with `source` + confidence; seed a
default category set per org kind on org creation.
**Out:** the correction/learning loop (P1-03); cross-tenant aggregation training
(P1-04); reconciliation against bank lines (P3).

## Implementation
1. **Seed categories:** on org create (extend `org.Store.Create` or a hook), seed
   a Vault22-style category tree for personal and a Xero-style chart-of-accounts +
   categories for business. Idempotent seed function.
2. **Transaction creation:** map each extracted document/line into `transactions`
   (direction, amount, currency, merchant, date), status `pending`.
3. **Cascade** in `internal/classify`:
   a. `classification_rules` for the org (exact → contains → regex), source `rule`.
   b. `merchant_signals` lookup (normalized merchant), source `merchant_signal`.
   c. LLM classify with the org's category list, source `llm`, store confidence.
   Record one `transaction_classifications` row with the winning category/account,
   `source`, and confidence; lower-confidence alternates may be stored for the UI.
4. Record an `ai_runs` row for LLM calls.
5. Expose `POST /orgs/{orgID}/documents/{docID}/classify` (re-run) and ensure the
   ingest pipeline (upload + mailrx) triggers classification after extraction.

## Acceptance criteria
- [ ] New personal and business orgs get a sensible default category/account set.
- [ ] An extracted slip produces `transactions` with a `transaction_classifications`
      row whose `source` reflects which stage matched.
- [ ] A matching `classification_rules` row wins over the LLM; a `merchant_signals`
      hit wins when no rule matches.
- [ ] LLM classification is constrained to the org's categories (no free-text
      categories invented).
- [ ] Confidence is stored and exposed via the document/transaction API.

## Tests
- Unit: cascade precedence (rule > signal > llm), category-constraint enforcement,
  default-seed shape per org kind.
- Integration: extraction fixture → transactions → classifications (LLM stage
  gated on `GEMINI_API_KEY`).

## Notes
Normalize merchant strings consistently (lowercase, strip store-number suffixes)
— P1-03/P1-04 rely on the same normalization to match signals. Factor it into a
shared helper.

### Implementation notes (sonnet-agent, 2026-05-21)

**Files added:**
- `backend/internal/classify/classify.go` — main cascade engine (`Classifier`, `ClassifyDocument`, cascade stages, `Extracted` shape)
- `backend/internal/classify/seed.go` — idempotent default-category seeding (personal Vault22 tree; business Xero chart-of-accounts + categories)
- `backend/internal/classify/signals.go` — `LookupSignal` (see contract below) + `mapSignalToCategory`
- `backend/internal/classify/store.go` — `ListTransactions` DB query (joined with classifications)
- `backend/internal/classify/handlers.go` — HTTP handlers: `POST /orgs/{orgID}/documents/{docID}/classify`, `GET /orgs/{orgID}/transactions`
- `backend/internal/classify/classify_test.go` — unit tests for cascade precedence, LLM constraint, seed shape, merchant normalization parity

**Files modified:**
- `backend/internal/org/store.go` — added `CategorySeeder` func type + `WithCategorySeeder()`; seeder called inside `Create` tx
- `backend/cmd/server/main.go` — wired classify routes (authedMember), wired `classify.SeedDefaultCategories` into orgStore

**`LookupSignal` signature (P1-04 must match):**
```go
// signals.go in internal/classify
func LookupSignal(ctx context.Context, db *sql.DB, merchantNormalized string) (*Signal, error)

type Signal struct {
    CategoryLabel string  // TEXT from merchant_signals — NOT a per-org UUID
    VoteCount     int
}
```
P1-04 populates `merchant_signals (merchant_normalized, category_label, vote_count)`; P1-02 reads from it via `LookupSignal`. Privacy invariant: no org_id/user_id/amounts in merchant_signals.

**Seed contents:**
- Personal: 12 top-level expense/income/transfer categories (Income, Housing, Groceries & Food, Transport, Health & Wellness, Personal Care, Education, Entertainment, Financial Services, Savings & Investments, Giving, Travel & Accommodation) each with 4-7 children.
- Business: 36 Xero-coded accounts (090-800 range, asset/liability/equity/income/expense) + 28 named categories linked to account codes by code.

**Test results:** `go test ./...` — all 12 tests in `internal/classify` pass; `go build ./...` and `go vet ./...` clean.
