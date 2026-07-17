---
id: P3-01
title: Bank-feed aggregator integration (Stitch / Mono / Plaid)
phase: 3
status: review
depends_on: [P2-03]
owner: sonnet-agent
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

### Implementation summary (sonnet-agent, 2026-05-21)

**Provider recommendation: Stitch (https://stitch.money)**

Comparison:

| Criterion | Stitch | Mono | Plaid |
|---|---|---|---|
| SA bank coverage | 11 SA banks (FNB, ABSA, Std, Nedbank, Capitec, Investec, Tymebank, Discovery, African, Bidvest, Grindrod) | FNB, Nedbank, Absa (growing) | No SA banks |
| API style | GraphQL + OAuth2/PKCE | REST + OAuth2 | REST + OAuth2 |
| Sandbox | Full mock sandbox, no live bank needed | Partial sandbox | Yes |
| Pricing | Per linked account/month | Per linked account/month | Per connection/month (higher) |
| Data scopes | accounts, balances, transactions, merchantName, merchantCategory | accounts, balances, transactions | Similar |
| POPIA / SA compliance | Yes, SA data residency | Yes | No SA residency |
| Webhook support | Yes (HMAC-SHA256) | Yes | Yes |
| Recommendation | ✅ SA-first choice | Runner-up (fewer banks) | International fallback only |

**Stitch** chosen: broadest SA bank coverage, mature GraphQL API, full sandbox,
POPIA-compliant, webhook support with HMAC verification.

**Package: `internal/bankfeed`**

Files:
- `provider.go` — Provider interface + ProviderName, LinkedAccount, ProviderTransaction, FeedStatus types.
- `mock.go` — MockProvider (always compiled; deterministic for tests).
- `stitch.go` — Live Stitch implementation (gated: `//go:build live`).
- `store.go` — DB layer: CreateConnection, GetConnection, ListConnections, ListDueConnections, UpdateConnectionStatus, MarkSynced, UpdateTokens, EnsureStatement, UpsertLine, LinkTransaction, CreateTransaction.
- `handlers.go` — HTTP handlers: Connect, Callback, ListConnections, GetConnection, Disconnect, TriggerSync, Webhook.
- `syncer.go` — Syncer: SyncAll, SyncConnection, upsertBatch with dedup + token-refresh re-auth handling.
- `cascade.go` — FeedCascader: rule→signal cascade for feed-imported transactions (no LLM stage; no doc context available).
- `scheduler.go` — Leader-guarded periodic scheduler (BANKFEED_SYNC_ENABLED=true on exactly one fleet member).
- `bankfeed_test.go` — 25 unit tests: MockProvider compliance, dedup sentinels, payload mapping, status transitions, auth-error keywords, Scheduler construction.

**Routes added (P3-01 block in main.go):**
- `GET  /orgs/{orgID}/integrations/bankfeed/connect` (authedAdmin)
- `GET  /integrations/bankfeed/callback` (public, HMAC-validated)
- `GET  /orgs/{orgID}/integrations/bankfeed/connections` (authedMember)
- `GET  /orgs/{orgID}/integrations/bankfeed/connections/{connID}` (authedMember)
- `DELETE /orgs/{orgID}/integrations/bankfeed/connections/{connID}` (authedAdmin)
- `POST /orgs/{orgID}/integrations/bankfeed/connections/{connID}/sync` (authedMember)
- `POST /integrations/bankfeed/webhook` (public, HMAC-validated)

**New migration: `20260521000003_bankfeed_provider_txn_id.sql`**
- Adds `bank_feed_connections` FK + `provider_txn_id` column to `statement_lines`.
- Adds unique partial index `statement_lines_feed_dedup_idx` (provider_txn_id IS NOT NULL).
- Adds `stitch` to `bank_feed_provider` enum.

**Required environment variables:**
- `STITCH_CLIENT_ID` — OAuth2 client ID from Stitch developer portal (enables live integration).
- `STITCH_CLIENT_SECRET` — OAuth2 client secret.
- `STITCH_REDIRECT_URL` — Callback URL (default: `http://localhost:8080/integrations/bankfeed/callback`).
- `STITCH_WEBHOOK_SECRET` — Shared secret for HMAC webhook validation.
- `BANKFEED_SYNC_ENABLED=true` — Set on EXACTLY ONE fleet member to enable the 4-hour poll scheduler.

All env vars are optional; when absent the mock provider runs (safe for dev/CI).

**Test results:** 25/25 unit tests pass; `go build ./... && go vet ./...` clean.
