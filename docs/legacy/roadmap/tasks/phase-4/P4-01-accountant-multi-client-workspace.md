---
id: P4-01
title: Accountant multi-client workspace
phase: 4
status: review
depends_on: [P2-04]
owner: sonnet-agent
---

## Goal
Let an accountant/bookkeeper manage many client orgs from one login, switching
between them and acting within their granted role. Accountants are Xero's
distribution channel — copying it gives us a viral B2B growth loop.

## Context
The membership model already supports this: `membership_role` includes
`accountant`, and a user can belong to many orgs (`org.Store.ListForUser`). This
task builds the multi-client surface, an invite-as-accountant flow, and a
consolidated cross-client view.

## Existing assets
- `memberships` + `membership_role` (`accountant`); `invitations` + `internal/invite`.
- `org.Store.ListForUser`, org switcher concepts in `src/stores/org.js`.
- `RequireMember`/`RequireAdmin` middleware in `internal/org`.

## Scope
**In:** a practice/workspace view listing all client orgs an accountant belongs
to with status (e.g. unreviewed docs, unreconciled lines); fast org switching;
an "invite my accountant" flow from the client side and an accountant-initiated
client onboarding; cross-client task list (what needs attention).
**Out:** billing the accountant for clients (Phase-4 billing follow-up);
white-label branding; bulk operations across clients beyond the task list.

## Implementation
1. Workspace endpoint: for an accountant user, list their orgs + per-org
   attention metrics (unverified transactions, unmatched bank lines, pending docs).
2. Invite flow: client admin invites a user as `accountant` (reuse `internal/invite`
   with the role); accountant accepts and the org appears in their workspace.
3. Org switching: ensure all client data access goes through role checks
   (`accountant` has appropriate read/write per the role's intent).
4. UI: a practice dashboard (client list + attention badges), quick switcher,
   cross-client "needs attention" queue.

## Acceptance criteria
- [ ] An accountant belonging to multiple orgs sees them all with per-client
      attention metrics and can switch quickly.
- [ ] A client can invite an accountant by email; on accept the org joins the
      accountant's workspace with the `accountant` role.
- [ ] All access respects role middleware (no cross-client data leakage).
- [ ] Cross-client "needs attention" queue aggregates correctly.
- [ ] `go build` + `npm run build` clean.

## Tests
- Backend: role-scoped access (accountant can/can't do X), workspace aggregation.
- Frontend: manual multi-client walkthrough; verify isolation between clients.

## Notes
Define exactly what `accountant` can do vs `admin`/`owner` before building UI —
that role's permissions are the contract. This is a growth lever: every
accountant brings multiple client orgs.

### Implementation (sonnet-agent, 2026-05-21)
Backend of P4-01 implemented in `backend/internal/workspace` (new package).

**`GET /workspace`** — user-scoped (authed/JWT only). Single-query aggregation
using four CTEs (unverified, unmatched, pending_docs, suggested) joined back
to member_orgs. Returns `{"orgs":[{id,name,kind,role,attention:{...}}]}`.

**Attention metric queries:**
- `unverified_transactions`: `transactions WHERE status <> 'verified'`
- `unmatched_lines`: `statement_lines` with no active (non-rejected)
  `reconciliation_matches` row
- `pending_documents`: `documents WHERE status IN ('pending','processing')`
- `suggested_matches`: `reconciliation_matches WHERE state = 'suggested'`

**Route wired** in `cmd/server/main.go` as `GET /workspace` under `authed`
(grouped `// P4-01`).

**Invitation role fix** — `internal/invite/handlers.go`: the `Create` handler
already passes `role` through to the DB correctly; fixed the misleading error
message that said "must be 'admin' or 'member'" (accountant is also valid).

**Tests**: `go test ./internal/workspace/... -v` — 3 tests pass:
- `TestAggregationQueryShape` (live DB query-shape against local postgres)
- `TestOrgEntryShape` (struct field / value checks)
- `TestAttentionZeroValues` (zero-value sanity)

`go build ./... && go vet ./...` both clean.
