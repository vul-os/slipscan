---
id: P1-01
title: Extraction hardening — slips, invoices, bank statements
phase: 1
status: todo
depends_on: [P0-01]
owner: unassigned
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
