---
id: P2-04
title: Reporting that diverges by org kind
phase: 2
status: todo
depends_on: [P2-02, P2-03]
owner: unassigned
---

## Goal
Deliver the reporting layer, differentiated by org kind: personal gets
cash-flow / spend-trend / net-worth-over-time; business gets P&L (income
statement), balance sheet, and a VAT/tax summary — all built on the same
classification + ledger data.

## Context
Personal aggregations (P2-02) and the business ledger (P2-03) provide the inputs.
This task assembles them into named financial reports and exposes them via API +
UI, gated by org kind. The `insights` package + `queries`/`dashboards` schema can
back custom views later.

## Existing assets
- P2-02 spend/net-worth aggregations; P2-03 `ledger_entries` + trial balance.
- `tax_rates`, `categories`, `accounts`; `fx_rates` (P0-04) for currency.
- `internal/insights`, `queries`/`query_runs`/`dashboards` tables; `src/lib/csv.js`.

## Scope
**In:** report endpoints + UI for — personal: cash-flow, spending trend,
net-worth-over-time; business: profit & loss, balance sheet, VAT/tax summary.
Period selection; CSV export; kind-gating.
**Out:** custom user-defined dashboards/queries (the `dashboards` schema supports
it; defer); scheduled report emails (Phase 4); statutory filing.

## Implementation
1. `internal/reporting` (or extend `insights`): pure functions producing each
   report from transactions/ledger over a period, FX-normalized.
2. Business P&L: income vs expense accounts over period. Balance sheet: assets =
   liabilities + equity at a date (from `ledger_entries`). VAT summary: output
   vs input tax from `tax_rates`-linked lines.
3. Personal: cash-flow (in vs out by month), spend trend by category over time,
   net-worth time series.
4. API: `GET /orgs/{orgID}/reports/{name}?from&to`; reject reports not valid for
   the org kind.
5. CSV export via `src/lib/csv.js`; UI report pages, kind-gated, with period
   picker and charts.

## Acceptance criteria
- [ ] Business P&L and balance sheet reconcile with `ledger_entries` (balance
      sheet balances; P&L net income flows to equity).
- [ ] VAT summary correctly splits output vs input tax for a period.
- [ ] Personal cash-flow / spend-trend / net-worth reports compute correctly and
      match P2-02 figures for the same period.
- [ ] Reports invalid for the org kind return a clear error and aren't shown.
- [ ] CSV export works; `go build` + `npm run build` clean.

## Tests
- Backend: report math against fixtures (balance-sheet balances, P&L ties to
  ledger, VAT split); period-boundary correctness.
- Frontend: manual walkthrough per kind; export sanity check.

## Notes
Keep report functions pure and table-driven so Phase 4 can reuse them for
scheduled emails and forecasting. Reconciliation with the ledger is the
correctness anchor for business reports.
