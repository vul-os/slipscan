---
id: P0-01
title: mailrx — inbound SMTP receiver service
phase: 0
status: review
depends_on: [P0-03]
owner: sonnet-agent
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

### What was built

- **`backend/internal/mailrx/`** — core logic package (no live socket needed):
  - `store.go` — `Store` with `InsertInboundEmail`, `InsertDocument`, `MarkEmailProcessed`; also `storageKeyForEmail` / `storageKeyForAttachment` helpers.
  - `mime.go` — `ParseMessage` using `github.com/emersion/go-message/mail`; buffers the full message, parses MIME parts, applies content-type allow-list, returns `ParsedMessage{MessageID, FromAddress, Subject, Attachments}`.
  - `backend.go` — `Backend` implementing `github.com/emersion/go-smtp.Backend`; `session` implementing `gosmtp.Session` with `Mail`/`Rcpt`/`Data`/`Reset`/`Logout`. `Rcpt` validates recipient domain and looks up org by `rx_local_part`; returns `550` for unknown. `Data` buffers raw bytes → stores to B2 → inserts `inbound_emails` → stores attachments → inserts `documents` → marks email `processed`/`rejected`.

- **`backend/cmd/mailrx/main.go`** — thin entrypoint: loads dotenv, opens DB + B2, wires stores, starts `gosmtp.Server` on `MAILRX_ADDR`, graceful shutdown on SIGTERM with 30 s drain.

- **`backend/internal/org/store.go`** — added `ByRxLocalPart(ctx, localPart)` method (case-insensitive lookup via `LOWER($1)`).

- **`backend/internal/config/config.go`** — added `RxDomain`, `MailrxAddr`, `MailrxMaxBytes`, `MailrxAllowedTypes` fields + `mailrxMaxBytes()` / `mailrxAllowedTypes()` loader helpers.

- **`backend/Makefile`** — added `mailrx`, `mailrx-dev`, `mailrx-main`, `build-mailrx` targets.

- **`.env.example`** — added `RX_DOMAIN`, `MAILRX_ADDR`, `MAILRX_MAX_MESSAGE_BYTES`, `MAILRX_ALLOWED_TYPES`.

- **Unit tests** (`backend_test.go`, `mime_test.go`): 9 tests covering `splitAddress`, `Rcpt` validation (known/unknown/case-insensitive/wrong-domain/malformed), multi-attachment MIME parse with type filter, size limit, no-attachment message, `normalizeMIME`, `extForMIME`. All pass.

- **Integration test** (`integration_test.go`, `//go:build integration`): end-to-end deliver → rows, gated on `DATABASE_URL` + `B2_*` env vars.

### SMTP library choice

`github.com/emersion/go-smtp` v0.24.0 — the task specification listed it explicitly. It implements the standard `Backend`/`Session` interface pattern, has graceful `Shutdown(ctx)`, and is widely used in Go mail tooling. Paired with `github.com/emersion/go-message` v0.18.2 for RFC 2045/2822 MIME parsing.

### New env vars required

| Var | Default | Purpose |
|---|---|---|
| `RX_DOMAIN` | `mail.slipscan.app` | Domain half of inbound addresses |
| `MAILRX_ADDR` | `:2525` | TCP listen address (port 25 needs root) |
| `MAILRX_MAX_MESSAGE_BYTES` | `26214400` (25 MB) | Hard message-size cap |
| `MAILRX_ALLOWED_TYPES` | _(pdf/jpeg/png/heic defaults)_ | Comma-separated MIME allow-list |

### Needs live infra before acceptance criteria can be fully checked

1. **MX record**: `RX_DOMAIN` must have an MX record pointing to the VM IP.
2. **Port 25**: the Makefile default is `:2525`; production needs `MAILRX_ADDR=:25` (requires root or `CAP_NET_BIND_SERVICE`).
3. **Database + B2**: integration test and live `swaks` smoke test need real credentials.
4. **`documents` table note**: the existing `document` package writes to the legacy `transactions` table; `cmd/mailrx` correctly targets the new `documents` table from migration 2. No conflict — they are separate write paths.

Keep the org-lookup and document-creation logic in `internal/` so `cmd/mailrx`
stays thin and the same code is unit-testable without a live socket.
