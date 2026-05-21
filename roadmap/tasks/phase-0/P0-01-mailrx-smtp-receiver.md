---
id: P0-01
title: mailrx — inbound SMTP receiver service
phase: 0
status: todo
depends_on: [P0-03]
owner: unassigned
---

## Goal
Stand up `cmd/mailrx`: an SMTP server that accepts inbound mail addressed to
`<org-slug>@<RX_DOMAIN>`, stores the raw message + attachments, and creates an
`inbound_emails` row plus a `documents` row per attachment so the existing
extraction pipeline picks them up. This is table-stakes vs Dext/Hubdoc.

## Context
Each org already has a unique `rx_local_part` (see `organizations` table and
`org.Store.Create` in `backend/internal/org/store.go`). A user emails a slip to
their address and it lands as a document. The SMTP server runs **directly on the
VM public IP** (not behind the load balancer) — see ROADMAP §Phase 0 and the
`todo` file.

## Existing assets
- `organizations.rx_local_part` (migration `…0001_foundation.sql`)
- `inbound_emails`, `documents`, `document_extractions` tables
  (`…0002_documents_chat.sql`); enums `document_source` (`email`),
  `inbound_email_status`, `document_kind`, `document_status`.
- `internal/storage` (B2/S3) for attachment bytes.
- `internal/document` store/handler — reuse the create-document path.
- `RX_DOMAIN` env var is already read in `cmd/server/main.go`.

## Scope
**In:** new `backend/cmd/mailrx/main.go`; SMTP listener; recipient→org lookup by
`rx_local_part`; MIME parse; attachment → B2 + `documents`; raw email →
`inbound_emails`; reject unknown recipients; size/type limits; structured logs.
**Out:** outbound mail (Resend already handles that); spam scoring beyond basic
SPF/recipient validation; multi-VP fan-out logic (that's P0-02 infra).

## Implementation
1. Add an SMTP server library to `go.mod` (e.g. `github.com/emersion/go-smtp`
   + `github.com/emersion/go-message` for MIME). Justify choice in PR.
2. New package `internal/mailrx` with a `Backend` implementing the library's
   session interface: `Mail`, `Rcpt` (validate recipient against
   `org.Store` by `rx_local_part`, reject `550` if unknown), `Data` (parse).
3. On `Data`: persist raw RFC822 to B2; insert `inbound_emails`
   (status `received`, link org); for each attachment of an allowed type
   (pdf/jpg/png/heic) insert a `documents` row (`source='email'`,
   `status='pending'`) referencing the stored object; mark email `processed`.
4. `cmd/mailrx/main.go`: load env via `config.LoadDotenv` like `cmd/server`,
   open DB, construct storage + stores, bind `:25` (configurable
   `MAILRX_ADDR`), graceful shutdown on SIGTERM.
5. Add `MAILRX_*` vars to `config` and all `.env*` + `.env.example`
   (`RX_DOMAIN`, `MAILRX_ADDR`, max message size, allowed MIME types).
6. Makefile target `make mailrx` to build/run locally.

## Acceptance criteria
- [ ] `go build ./...` builds `cmd/mailrx`.
- [ ] Sending a message with a PDF to `<existing-slug>@RX_DOMAIN` (via `swaks`
      or `nc` locally) creates one `inbound_emails` row and one `documents` row
      per attachment, with bytes retrievable from B2.
- [ ] Mail to an unknown local-part is rejected with `550` and no rows written.
- [ ] Oversized / disallowed-type attachments are skipped with a logged reason;
      the email still records `status='processed'` (or `rejected` if nothing usable).
- [ ] Graceful shutdown drains in-flight sessions.

## Tests
- Unit: recipient validation (known/unknown/case-insensitivity), MIME parse of a
  multi-attachment fixture, type/size filtering.
- Integration (build-tagged like `storage_integration_test.go`): end-to-end
  deliver→rows, gated on DB + B2 env.

## Notes
Keep the org-lookup and document-creation logic in `internal/` so `cmd/mailrx`
stays thin and the same code is unit-testable without a live socket.
