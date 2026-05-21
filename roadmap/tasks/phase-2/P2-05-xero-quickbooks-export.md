---
id: P2-05
title: Xero / QuickBooks export (integrate-first go-to-market)
phase: 2
status: todo
depends_on: [P2-03]
owner: unassigned
---

## Goal
Let a business org connect Xero (and/or QuickBooks) via OAuth and push
classified transactions / bills / contacts into it. This is the strategic
"integrate before replace" move — we ride the incumbent's ecosystem to get to
revenue instead of replacing the ledger on day one.

## Context
ROADMAP §3 makes this the launch wedge for business: slip/scan is the LLM-native
capture layer that feeds Xero, competing directly with Dext/Hubdoc. The schema
already anticipates it — `oauth_provider` includes `xero`, and `oauth_grants`
stores tokens.

## Existing assets
- `oauth_provider` enum (`xero`), `oauth_grants` table (`…0001_foundation.sql`).
- P2-03 ledger / contacts / classified transactions as the data to push.
- `internal/org` for org context; existing handler/middleware patterns.

## Scope
**In:** Xero OAuth2 connect flow + token storage/refresh in `oauth_grants`; map
slip/scan contacts → Xero contacts and classified transactions/bills → Xero
bank-transactions or bills; a "push to Xero" action (manual first) with idempotent
external-id mapping; sync status + error surfacing.
**Out:** two-way sync (pull from Xero) beyond what's needed for de-duping; full
invoice lifecycle; QuickBooks can be a fast-follow (design the provider interface
so it's pluggable, implement Xero first).

## Implementation
1. Provider-agnostic `internal/accounting_export` interface (`Connect`,
   `RefreshToken`, `PushContact`, `PushTransaction/Bill`), Xero impl first.
2. OAuth: `GET /orgs/{orgID}/integrations/xero/connect` → consent → callback
   stores tokens in `oauth_grants`; scheduled/lazy refresh.
3. Mapping + idempotency: store the Xero external id alongside our records (new
   small migration if needed, or a mapping table) so re-push updates rather than
   duplicates; map categories→accounts and tax→Xero tax rates.
4. Action: `POST /orgs/{orgID}/integrations/xero/push` (selected or all
   unsynced); record per-record sync status + errors.
5. UI: connect/disconnect in Settings (business-gated); push action + sync status
   in the receipts/ledger views.

## Acceptance criteria
- [ ] A business org can connect Xero via OAuth; tokens persist and auto-refresh.
- [ ] Pushing a classified transaction creates the matching record in Xero with
      the right account + tax, and re-pushing updates (no duplicates).
- [ ] Contacts sync; mapping handles missing accounts/tax gracefully with clear errors.
- [ ] The provider interface is implemented for Xero and structured so QuickBooks
      can be added without touching callers.
- [ ] `go build` + `npm run build` clean; secrets configured via env.

## Tests
- Unit: mapping (category→account, tax→rate), idempotent external-id handling,
  token-refresh logic (mocked).
- Integration: against Xero's demo company, gated on credentials; documented in PR.

## Notes
This is the revenue path — "use us to capture, keep using Xero." Build it
pluggable; QuickBooks and the eventual "become the ledger" pivot (Phase 4) both
hinge on this interface being clean.
