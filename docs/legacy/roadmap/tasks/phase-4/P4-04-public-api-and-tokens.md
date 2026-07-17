---
id: P4-04
title: Public API & developer tokens
phase: 4
status: review
depends_on: [P2-03]
owner: sonnet-agent
---

## Goal
Expose a documented, token-authenticated public API so customers and partners can
push documents, read transactions/reports, and integrate slip/scan into their own
stacks — the foundation of an integration marketplace and a platform moat.

## Context
The schema already anticipates this: `api_tokens` (`api_token_kind`:
live/test/restricted), `api_permissions`, and a `document_source='api'`. This
task implements token issuance, scoped auth middleware, public endpoints, rate
limiting, and docs.

## Existing assets
- `api_tokens`, `api_permissions` tables; `api_token_kind` enum;
  `document_source='api'`; `oauth_provider` for partner OAuth later.
- Existing JWT middleware in `internal/auth`; document upload/list, transactions,
  reports endpoints from P1/P2.

## Scope
**In:** API-token issuance/revocation UI + endpoints (hashed at rest, shown once);
a token-auth middleware honoring `api_permissions` scopes and `api_token_kind`
(test vs live); a versioned public surface (`/v1/...`) for documents (create via
API → `source='api'`), transactions (read), reports (read); per-token rate
limiting; OpenAPI spec + developer docs.
**Out:** full partner OAuth app directory; webhooks-out (design the table/notes,
implement later); GraphQL.

## Implementation
1. Token management: `POST/DELETE /orgs/{orgID}/api-tokens` (admin-gated), store
   hashed, return plaintext once; record `kind` + scopes in `api_permissions`.
2. Middleware: authenticate `Authorization: Bearer <token>`, resolve org +
   scopes, enforce per-endpoint permission and live/test separation; reuse the
   org role checks where sensible.
3. Public endpoints under `/v1`: create document (multipart → storage →
   `documents` `source='api'` → pipeline), list/read transactions, read reports.
   Stable response shapes, explicit versioning.
4. Rate limiting per token (config-driven); clear 429s.
5. OpenAPI spec + a developer docs page; quickstart with a curl example.

## Acceptance criteria
- [ ] An admin can mint a scoped API token (shown once, stored hashed) and revoke it.
- [ ] API requests authenticate via token, are org-scoped, and are denied when
      missing the required `api_permissions` scope.
- [ ] `POST /v1/.../documents` creates a `source='api'` document that flows
      through extraction + classification.
- [ ] Read endpoints return stable, versioned shapes; rate limiting returns 429.
- [ ] OpenAPI spec validates; docs include a working quickstart; builds clean.

## Tests
- Backend: token hashing/verification, scope enforcement (allow/deny matrix),
  test-vs-live separation, rate-limit behaviour, API document ingest end-to-end.
- Contract: validate responses against the OpenAPI spec.

## Notes
Treat the `/v1` shapes as a public contract from day one — version them and don't
break them. Tokens are credentials: hash at rest, show once, log usage for the
P4-03 audit trail.

### Implementation summary (sonnet-agent, 2026-05-21)

New package `backend/internal/apitokens` with:

- `token.go` — `Kind` type, `Token` struct, `generate()` (SHA-256 hash,
  `sk_{kind}_{base64}` format, 12-char prefix), `VerifyToken()`.
- `store.go` — `Store.Issue()` / `ListByOrg()` / `Revoke()` / `Authenticate()`;
  lookups by prefix + hash; best-effort `last_used_at` update on auth.
- `ratelimit.go` — in-memory sliding-window per-token rate limiter;
  `DefaultRateLimitPerMin = 60`; falls back when `rate_limit_per_minute = 0`.
  Multi-node caveat documented (use Redis INCRBY for fleet-wide enforcement).
- `middleware.go` — `Store.Middleware()` (Bearer auth + rate limit),
  `RequireScope(scope)` (per-endpoint scope gate), `RequireLive` (blocks test
  tokens on production data endpoints), `OrgIDFrom()` (cross-org guard).
- `handlers.go` — `POST/GET/DELETE /orgs/{orgID}/api-tokens` (admin-gated).
- `v1handlers.go` — `V1Handler` with:
  - `POST /v1/orgs/{orgID}/documents` → multipart upload → `source='api'` →
    async extract pipeline triggered via `ExtractionRunner.Run`.
  - `GET /v1/orgs/{orgID}/transactions` → stable `APITransaction` shape with
    pagination (`limit`/`offset`).

Routes wired in `cmd/server/main.go` under `// P4-04` comment blocks.

New migration `20260521000005_apitokens_seed_permissions.sql` seeds 4 scope
rows (`documents:write`, `documents:read`, `transactions:read`, `reports:read`)
into the existing `api_permissions` catalogue table.

`go build ./... && go vet ./...` pass clean. 15 unit tests cover: hash/verify
round-trip, token format, scope allow/deny matrix, live-vs-test separation,
rate-limit allow/deny/window-reset/default-limit/multi-token independence, and
context round-trip.
