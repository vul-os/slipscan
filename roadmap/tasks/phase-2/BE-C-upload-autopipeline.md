---
id: BE-C
title: Upload auto-pipeline + transactions document_id filter
phase: 2
status: review
depends_on: [P1-01, P1-02]
owner: sonnet-agent
---

## Goal

Two small, related backend improvements that close the last manual steps in the
scan-to-classification path.

1. **Auto-trigger extraction + classification on document upload.**  
   Previously, `POST /orgs/{orgID}/documents` stored the file and returned;
   operators had to call `/extract` then `/classify` manually.  Now a successful
   upload kicks off the full pipeline asynchronously.

2. **`?document_id=<uuid>` filter on `GET /orgs/{orgID}/transactions`.**  
   The detail view was filtering client-side after fetching all transactions.
   The new query parameter lets the frontend (or API consumer) fetch exactly one
   document's transactions server-side.

## Context

The `internal/document` package was a legacy shim that wrote directly to the
`transactions` table using columns (`document_url`, `raw_extraction`) that do
not exist in the current schema.  This cleanup migrates it to the canonical
`documents` table so `internal/extract.Service.Run` can find the row.

## Existing assets

- `backend/internal/extract/service.go` — `Service.Run(ctx, docID, orgID)`
- `backend/internal/classify/classify.go` — `Classifier.ClassifyDocument(...)`
- `backend/internal/classify/store.go` — `ListTransactions(...)` (extended here)
- `backend/internal/document/handlers.go` — `Handler.Upload` (modified here)
- `backend/migrations/20260430000002_documents_chat.sql` — `documents` table DDL

## Scope (in)

- `internal/document/store.go` — migrated from `transactions` to `documents` table
- `internal/document/handlers.go` — removed inline OCR; added `PipelineFn` type
- `internal/classify/store.go` — added optional `documentID *uuid.UUID` parameter
- `internal/classify/handlers.go` — parses `?document_id=` and forwards it
- `cmd/server/main.go` — wires `autoPipeline` closure into `document.NewHandler`
- New tests: `internal/document/pipeline_test.go`, `internal/classify/store_filter_test.go`

## Scope (out)

- No schema migrations required (uses existing `documents` table)
- No frontend changes in this task
- No changes to extract or classify internal logic

## Implementation

### Auto-pipeline wiring

`document.PipelineFn` is a `func(ctx, docID, orgID, uploadedBy)` type defined in
`internal/document/handlers.go`.  The production closure lives in
`cmd/server/main.go`:

```go
autoPipeline := document.PipelineFn(func(ctx context.Context, docID, orgID uuid.UUID, uploadedBy uuid.NullUUID) {
    if err := extractSvc.Run(ctx, docID, orgID); err != nil {
        log.Printf("auto-pipeline: extraction failed doc=%s: %v", docID, err)
        return
    }
    if _, err := classifyEngine.ClassifyDocument(ctx, orgID, docID, uploadedBy); err != nil {
        log.Printf("auto-pipeline: classification failed doc=%s: %v", docID, err)
    }
})
docH := document.NewHandler(docStore, storageClient, autoPipeline)
```

Inside `Upload`, after `store.Create` succeeds:

```go
if h.pipeline != nil {
    go func() {
        bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
        defer cancel()
        slog.InfoContext(bgCtx, "auto-pipeline: starting", ...)
        h.pipeline(bgCtx, docID, orgID, uploadedBy)
    }()
}
```

The goroutine uses a **fresh context** (5-minute budget, independent of the HTTP
request lifecycle).  Any failure is logged at ERROR level and does not affect the
upload response.

### Transactions filter

`ListTransactions` signature extended from:

```go
func ListTransactions(ctx, db, orgID, limit, offset) ([]TransactionRow, error)
```

to:

```go
func ListTransactions(ctx, db, orgID, limit, offset int, documentID *uuid.UUID) ([]TransactionRow, error)
```

When `documentID != nil` the query gains `AND t.document_id = $4`.

The handler reads `?document_id=<uuid>` and returns 400 on a malformed UUID.

## Acceptance criteria

- [x] `POST /orgs/{orgID}/documents` returns 201 immediately; pipeline runs async
- [x] Pipeline failure (e.g. Gemini down) does NOT fail the upload (logged only)
- [x] `GET /orgs/{orgID}/transactions?document_id=<uuid>` filters by document
- [x] Invalid `document_id` value returns 400 `invalid_document_id`
- [x] `cd backend && go build ./... && go vet ./...` clean (excluding pre-broken `bankfeed`)
- [x] Tests pass: `pipeline_test.go` (3 tests), `store_filter_test.go` (4 tests)

## Tests

```
go test ./internal/document/... ./internal/classify/... -v
```

New tests:

| File | Test | Covers |
|---|---|---|
| `internal/document/pipeline_test.go` | `TestUploadTriggersPipeline` | goroutine fires with correct IDs |
| `internal/document/pipeline_test.go` | `TestNilPipelineDoesNotPanic` | nil pipeline is safe |
| `internal/document/pipeline_test.go` | `TestPipelineFnType` | type is nil-able |
| `internal/classify/store_filter_test.go` | `TestListTransactionsDocumentIDFilter` | 4 sub-tests for arg/filter building |

## Notes

- The `ocr.Client` field and `applyReceipt` function were removed from
  `internal/document`.  The handler no longer runs Gemini inline; that is now
  the job of `internal/extract.Service`.
- `document.Store` now writes to `documents` (source='upload', kind='unknown').
  The `internal/extract` pipeline transitions status and kind as it processes.
- `cmd/server/main.go` no longer passes `ocrClient` to `document.NewHandler`.
- `bankfeed` package has a pre-existing syntax error in its test file
  (`bankfeed_test.go:360`) and `recon` has a floating-point precision bug —
  both pre-date this task.
