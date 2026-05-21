---
id: P0-04
title: Exchange-rate provider + 24×/day cron into fx_rates
phase: 0
status: todo
depends_on: [P0-03]
owner: unassigned
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
Free tiers (e.g. frankfurter.app) may suffice and cost R0 — call that out. The
"only 24×/day" rule is about cost; the single-runner guard is what actually
enforces it on a multi-VM fleet.
