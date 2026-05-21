---
id: P2-02
title: Personal — Vault22-style spending breakdown, budgets & net worth
phase: 2
status: todo
depends_on: [P2-01]
owner: unassigned
---

## Goal
For personal orgs, deliver the Vault22-style experience: spend-by-category
breakdown over a period, budgets with progress, goals, and a net-worth view
(assets − liabilities + holdings). This is the personal-side product that
Dext/Xero don't have.

## Context
The schema already has the full personal-finance domain: `budgets`,
`budget_lines`, `goals`, `assets`, `asset_valuations`, `liabilities`,
`liability_balances`, `holdings`. Transactions + classifications (P1-02) provide
the spend data. This task builds stores/handlers + UI on top.

## Existing assets
- Tables: `categories`, `transactions`, `transaction_classifications`,
  `budgets`/`budget_lines`, `goals`, `assets`/`asset_valuations`,
  `liabilities`/`liability_balances`, `holdings` (`…0003_accounting.sql`).
- `fx_rates` (P0-04) for multi-currency net worth.
- Frontend `Dashboard.jsx`, `src/lib/format.js`, chart-capable `ui` components.

## Scope
**In:** spend-by-category aggregation API (period, drill-down to transactions);
budget CRUD + progress; goals CRUD + progress; net-worth computation across
assets/liabilities/holdings (FX-normalized to org currency); personal dashboard UI.
**Out:** business reporting (P2-04); investment price feeds (manual valuations
for now); bank feeds (P3).

## Implementation
1. `internal/finance` (or extend `insights`): aggregation queries —
   `GET /orgs/{orgID}/spending?from&to&group=category` returning category totals +
   share-of-spend, drill-down to transactions.
2. Budgets: CRUD on `budgets`/`budget_lines`; a progress endpoint comparing
   actual spend per category against budget for the period.
3. Goals: CRUD on `goals` with computed progress.
4. Net worth: sum latest `asset_valuations` + `holdings` − `liability_balances`,
   FX-converted via `fx_rates`; time series from valuation history.
5. UI: personal dashboard — donut/bar spend breakdown, budget progress bars,
   net-worth headline + trend, goals. Use existing `ui` components + `format.js`.

## Acceptance criteria
- [ ] Spending endpoint returns correct category totals + percentages for a period
      and drills down to the underlying transactions.
- [ ] Budgets can be created and show actual-vs-budget progress per category.
- [ ] Net worth computes from assets/liabilities/holdings, FX-normalized, and
      shows a trend from valuation history.
- [ ] The personal dashboard renders all of the above; `npm run build` clean.
- [ ] Business orgs do not see the personal-only dashboard (kind-gated).

## Tests
- Backend: aggregation correctness (fixture transactions → expected category
  totals), net-worth math incl. FX, budget progress edges (over/under/zero).
- Frontend: manual walkthrough; verify kind-gating.

## Notes
This + P2-03 are the two faces of the same engine. Share aggregation helpers with
P2-04 reporting where possible. Net worth is the Vault22 hero metric — make it the
dashboard headline for personal users.
