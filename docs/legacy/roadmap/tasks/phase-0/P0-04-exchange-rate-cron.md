---
id: P0-04
title: Exchange-rate provider + 24×/day cron into fx_rates
phase: 0
status: review
depends_on: [P0-03]
owner: sonnet-agent
---

## Goal
Fetch FX rates from the cheapest viable provider and upsert them into the
existing `fx_rates` table on a schedule that runs **exactly 24 times a day** (the
`todo` constraint — hourly). Multi-currency normalization downstream
(reporting, reconciliation) depends on this.

## Context
The `todo` says: find an exchange-rate provider, get an API key, pick the
cheapest, update only 24×/day on a cron. `.env.example` already references
`EXCHANGE_RATE_API_KEY` + `EXCHANGE_RATE_BASE=USD` and mentions exchangerate-api.com.
The `fx_rates` table already exists in the foundation migration.

## Existing assets
- `fx_rates` and `currencies` tables (`…0001_foundation.sql`).
- `internal/config` for env vars; `cmd/server` boot pattern for wiring.
- `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_BASE` placeholders in `.env.example`.

## Scope
**In:** evaluate 2–3 providers for cost/coverage of ZAR + majors, recommend one,
add `internal/fx` package with a fetch client + upsert into `fx_rates`; an
hourly scheduler (in-process ticker in `cmd/server`, or a `cmd/fxsync` invoked by
system cron — pick and justify); config wiring; backfill on first run.
**Out:** per-transaction conversion logic (that's reporting/reconciliation later);
historical backfill beyond what the free tier allows.

## Implementation
1. Compare providers (exchangerate-api.com, openexchangerates, frankfurter.app
   [free, ECB], apilayer). Recommend cheapest covering ZAR + the currencies in
   the `currencies` table. Document the decision in the PR.
2. `internal/fx`: `Client.Fetch(ctx, base) (map[string]rate, asOf)` and
   `Store.Upsert(ctx, base, rates, asOf)` writing `fx_rates` (respect its unique
   key; upsert, don't duplicate).
3. Scheduling: prefer a single hourly tick to guarantee ≤24 calls/day (stay in
   free tier). If in-process, use a `time.Ticker` with jitter and a startup
   fetch; if `cmd/fxsync`, wire a crontab line in the P0-02 cloud-init. Decide so
   that exactly one fleet member runs it (leader/env flag) to avoid 24×N calls.
4. Config: `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_BASE`, `FX_SYNC_ENABLED`.
5. Metrics/logs: record last-success timestamp; `/healthz` or a log line surfaces
   staleness.

## Acceptance criteria
- [ ] On boot (or first cron run) `fx_rates` is populated for the base currency
      against all rows in `currencies`.
- [ ] The fetch runs at most 24 times per day total across the fleet (verify the
      single-runner guard).
- [ ] Re-running upserts (no duplicate rows; `as_of` advances).
- [ ] Provider + key are configurable via env; missing key disables the job with
      a clear log line rather than crashing.

## Tests
- Unit: parse a recorded provider response → rate map; upsert idempotency against
  a test DB.
- Integration (build-tagged): one live fetch gated on `EXCHANGE_RATE_API_KEY`.

## Notes

### Provider recommendation: frankfurter.app — R0 / $0, no key needed

Four providers were evaluated:

| Provider | Free tier | ZAR? | Key required? | Cost/month |
|---|---|---|---|---|
| frankfurter.app | Unlimited (ECB data, daily) | YES | No | R0 |
| exchangerate-api.com | 1 500 req/month | YES | Yes | R0 on free |
| openexchangerates.org | 1 000 req/month | YES | Yes | R0 on free |
| apilayer/fixer.io | 100 req/month | YES | Yes | $14.99 on paid |

**Decision: frankfurter.app.** It is completely free, requires no account, no
API key, and no secret. It is backed by ECB data and covers ZAR as well as all
majors required by the `currencies` table. 24 req/day is well within its
unofficial rate limit (ECB publishes once per trading day anyway).

If you ever want to switch to exchangerate-api.com for higher frequency or
intraday data, set `EXCHANGE_RATE_API_KEY` and the client auto-switches.
No secret is required for the default Frankfurter path.

### What was built

- `backend/internal/fx/client.go` — `Client.Fetch(ctx, base)` with two
  provider backends: Frankfurter (default, no key) and exchangerate-api.com v6
  (when `EXCHANGE_RATE_API_KEY` is set). Provider base URL is injectable for
  tests.
- `backend/internal/fx/store.go` — `Store.Upsert(ctx, result, source)` writes
  `fx_rates` with `ON CONFLICT (base, quote, as_of) DO UPDATE`, so re-runs
  are idempotent. `Store.LastSync` surfaces staleness.
- `backend/internal/fx/scheduler.go` — in-process `time.Ticker` (1 h) with
  up to 60 s jitter. Performs an immediate startup fetch (backfill on first
  run), then hourly.
- `backend/internal/fx/client_test.go` — 4 unit tests using an httptest server
  and recorded fixtures; exercises both providers, HTTP errors, and error
  response bodies.
- `backend/internal/fx/store_test.go` — 5 unit tests using a minimal
  `database/sql/driver` mock; covers base-pair skip, zero/negative-rate skip,
  nil-result noop, and idempotency.
- `backend/internal/fx/integration_test.go` — build-tagged `integration` live
  fetch test; gated on presence of `EXCHANGE_RATE_API_KEY` (absent = uses
  Frankfurter).

Config fields added to `internal/config/config.go`:
`ExchangeRateAPIKey`, `ExchangeRateBase`, `FXSyncEnabled`.

Scheduler wired into `cmd/server/main.go`; starts only when
`FX_SYNC_ENABLED=true`.

### Single-runner / 24×/day cap

The `FX_SYNC_ENABLED=true` env var must be set on **exactly one** Hetzner VM.
Secondary VMs leave it unset (defaults to `false`). This is the simplest
zero-dependency approach for a small fleet — no Redis, no DB advisory lock.
If the leader reboots the scheduler restarts and does a fresh fetch on startup.

### Secrets required from the human

None for the default Frankfurter path. If you want exchangerate-api.com:
- Sign up at https://www.exchangerate-api.com/ (free tier; no credit card).
- Set `EXCHANGE_RATE_API_KEY=<your-key>` on the leader VM.

### Test results

```
go test ./internal/fx/... -v
--- PASS: TestFrankfurterParse
--- PASS: TestFrankfurterHTTPError
--- PASS: TestERAPIParse
--- PASS: TestERAPIErrorResponse
--- PASS: TestStoreUpsertCallsInsertForEachRate
--- PASS: TestStoreUpsertSkipsBasePair
--- PASS: TestStoreUpsertSkipsNonPositiveRates
--- PASS: TestStoreUpsertNilResultIsNoop
--- PASS: TestStoreUpsertIdempotent
PASS  9/9
```
