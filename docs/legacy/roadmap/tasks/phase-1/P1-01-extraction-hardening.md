---
id: P1-01
title: Extraction hardening — slips, invoices, bank statements
phase: 1
status: review
depends_on: [P0-01]
owner: sonnet-agent
---

## Goal
Turn the Gemini OCR call into a robust, typed extraction pipeline that reliably
produces structured line-items + totals + merchant + date + currency for the
three `document_kind`s (slip, invoice, bank_statement), with a confidence score
and a recorded model run. Accuracy here gates everything in Phase 1.

## Context
`internal/ocr/gemini.go` exists and is wired into `document.Handler`. We need
document-kind detection, structured field extraction, currency detection, and
persistence into `document_extractions` with confidences — feeding the
classification engine (P1-02).

## Existing assets
- `internal/ocr/gemini.go` (+ integration test) — the LLM call.
- `documents`, `document_extractions` tables; `ai_models`, `ai_runs`
  (`extraction` kind) for the model-run trail; `document_kind`/`document_status` enums.
- `internal/document` store/handler.

## Scope
**In:** prompt + schema for each `document_kind`; auto-detect kind when `unknown`;
parse to typed Go structs; persist `document_extractions` with per-field
confidence; record an `ai_runs` row; transition `documents.status`
pending→processing→extracted/failed; retry/timeout handling.
**Out:** classification of the resulting transactions (P1-02); the review UI (P1-05).

## Implementation
1. Define extraction schemas (Go structs + JSON schema sent to Gemini): merchant,
   date, currency, subtotal/tax/total, line items `[{description, qty, unit, amount}]`,
   plus statement-specific lines for `bank_statement`.
2. Kind detection: if `document_kind='unknown'`, a first cheap classify pass sets
   it before the detailed extraction.
3. Extraction service in `internal/ocr` (or new `internal/extract`) returning the
   typed result + overall + per-field confidence; record token usage.
4. Persist into `document_extractions` (one row per extraction run, link
   `ai_runs`); set `documents.status` accordingly; on parse failure record
   `failed` with the raw response for debugging.
5. Currency: detect from symbols/locale; default to org currency when ambiguous;
   store ISO code so P0-04 rates apply.
6. Backpressure: timeouts, one retry on transient error, structured logs.

## Acceptance criteria
- [ ] A slip, an invoice, and a bank-statement fixture each extract to the correct
      typed structure with totals that reconcile (sum of lines ≈ total within tolerance).
- [ ] `document_kind='unknown'` documents get a detected kind before extraction.
- [ ] Every extraction writes one `document_extractions` row + one `ai_runs` row
      with confidence and token usage.
- [ ] Status transitions are correct; failures are recoverable (raw response stored).
- [ ] Currency is detected and stored as an ISO code.

## Tests
- Golden-file tests: fixtures → expected structured output (allow confidence
  tolerance). Build-tagged live test gated on `GEMINI_API_KEY`.
- Unit: total/line reconciliation, currency detection, status transitions.

## Notes
Keep prompts versioned (string consts with a version tag) so we can A/B and so
`ai_runs.model`/version is meaningful. This feeds P1-02 directly — agree the
output struct shape with that task.

### Implementation (sonnet-agent, 2026-05-21)

**Files added:**
- `backend/internal/extract/types.go` — `Extracted`, `LineItem`, `StatementLine`, `DocumentKind`, `DocumentStatus` types.
- `backend/internal/extract/prompts.go` — versioned prompt consts (`slip-v1`, `invoice-v1`, `bank-statement-v1`, `kind-detect-v1`), Gemini JSON schemas, `geminiRaw` unmarshalling structs, `mapToExtracted`.
- `backend/internal/extract/currency.go` — `NormalizeCurrency` (symbol/alias → ISO code, with org default fallback).
- `backend/internal/extract/store.go` — DB layer: `GetDocument`, `OrgCurrency`, `EnsureAIModel`, `CreateAIRun`, `FinishAIRun`, `CreateExtraction`, `CompleteExtraction` (transactional is_current flip + `documents.current_extraction_id`), `FailExtraction`.
- `backend/internal/extract/service.go` — orchestration pipeline: status transitions pending→processing→extracted/failed; kind detection when `unknown`; `StorageGetter` interface.
- `backend/internal/extract/handler.go` — `POST /orgs/{orgID}/documents/{docID}/extract` HTTP handler.
- `backend/internal/extract/extract_test.go` — 8 golden-file unit tests (slip, invoice, bank statement fixtures; currency normalization; JSON shape binding).
- `backend/internal/extract/testdata/{slip,invoice,bank_statement}_raw.json` — fixture files.

**Files modified:**
- `backend/internal/ocr/gemini.go` — added `ExtractWithSchema` (image bytes + custom prompt + schema).
- `backend/internal/storage/storage.go` — added `Get(ctx, key) ([]byte, error)` for re-fetching uploaded files.
- `backend/cmd/server/main.go` — wired `extractStore`, `extractSvc`, `extractH`; registered `POST /orgs/{orgID}/documents/{docID}/extract` (authedMember).

**Contract compliance:** `Extracted.extracted` JSONB exactly matches PHASE1-CONTRACT.md §2:
```json
{
  "kind": "slip|invoice|bank_statement",
  "merchant": "WOOLWORTHS PTY LTD #4021",
  "date": "2026-05-18",
  "currency": "ZAR",
  "subtotal": 210.00, "tax": 31.50, "total": 241.50,
  "confidence": 0.94,
  "line_items": [{"description":"Milk 2L","qty":1,"unit":24.99,"amount":24.99}],
  "statement_lines": [{"date":"2026-05-01","description":"...","amount":-120.00,"balance":880.00}]
}
```
`statement_lines` omitted for slip/invoice; `line_items` omitted for bank_statement (omitempty).

**Test results:** `go test ./... ` — 8/8 pass. `go build ./...` and `go vet ./...` clean. No live Gemini calls (LLM tests would be behind `//go:build llm` if added).
