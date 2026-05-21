---
id: P3-01
title: Bank-feed aggregator integration (Stitch / Mono / Plaid)
phase: 3
status: todo
depends_on: [P2-03]
owner: unassigned
---

## Goal
Connect bank accounts via an aggregator and auto-import transactions, so the
financial picture is complete without manual upload. Buy, don't build — pick an
SA-first aggregator (Stitch or Mono) with Plaid for non-SA. This closes the
completeness gap vs Vault22/Xero.

## Context
The schema already models feeds: `bank_feed_provider`
(plaid/yodlee/truelayer/salt_edge/manual), `bank_feed_status`, plus
`bank_statements` / `statement_lines`. Imported lines become `transactions` and
flow through the existing classification cascade (P1-02). Reconciliation against
documents is the next task (P3-02).

## Existing assets
- Enums `bank_feed_provider`, `bank_feed_status`; `bank_statements`,
  `statement_lines`, `transactions` tables.
- `oauth_grants` for provider tokens; P1-02 classification cascade.
- `internal/classify`; org context + handler patterns.

## Scope
**In:** evaluate Stitch vs Mono (SA) + Plaid (intl) for coverage/cost/compliance,
recommend one; provider-agnostic feed interface; connect/link flow + token
storage; periodic + webhook-driven transaction sync into `statement_lines` →
`transactions`; dedupe; re-auth handling; classify imported transactions.
**Out:** reconciliation/matching to documents (P3-02); investment account
aggregation; the manual `bank_statements` upload path (already exists via
documents — keep working).

## Implementation
1. Provider comparison + recommendation (SA coverage, pricing per linked account,
   data scopes, compliance). Document in PR.
2. `internal/bankfeed` interface (`Link`, `Accounts`, `FetchTransactions`,
   `Status`), first provider implemented; tokens in `oauth_grants`, feed state in
   the bank-feed tables.
3. Link flow: `…/integrations/bankfeed/connect` → provider widget → callback
   stores connection (`bank_feed_status='connected'`).
4. Sync: webhook endpoint + periodic poll (leader-guarded like P0-04); upsert
   `statement_lines`, create `transactions` (dedupe on provider txn id), then run
   the P1-02 classification cascade.
5. Re-auth: surface `reauth_required`/`error` states to the UI; refresh tokens.
6. UI: connect/manage linked accounts in Settings; show sync status.

## Acceptance criteria
- [ ] A user can link a bank account via the chosen provider; status becomes
      `connected` and tokens persist.
- [ ] Transactions import into `statement_lines` + `transactions`, deduped on
      provider id (re-sync creates no duplicates).
- [ ] Imported transactions are auto-classified via the P1-02 cascade.
- [ ] Re-auth-required / error states surface to the UI and recover on reconnect.
- [ ] Webhook + poll paths both work; poll is single-runner across the fleet.

## Tests
- Unit: dedupe, provider-payload → `statement_lines`/`transactions` mapping,
  status transitions.
- Integration: against the provider sandbox, gated on credentials; documented in PR.

## Notes
Recommend buying coverage rather than building scrapers. Keep the interface clean
so a second provider (international) drops in. This + P3-02 is the killer combo:
feeds *and* documents, auto-reconciled — which neither Vault22 nor Dext does.
