---
id: P2-02
title: Personal — Vault22-style spending breakdown, budgets & net worth
phase: 2
status: review
depends_on: [P2-01]
owner: sonnet-agent
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

### Implementation notes (sonnet-agent, 2026-05-21)

New package `backend/internal/finance` (store/handler split mirroring `internal/org`).

**Package layout:**
- `store.go` — all DB aggregation + CRUD; pure Go + database/sql, no external deps.
  Exports: `Store`, `SpendingBreakdown`, `TransactionsByCategory`, `CreateBudget`,
  `ListBudgets`, `GetBudget`, `BudgetProgress`, `DeleteBudget`, `CreateGoal`,
  `ListGoals`, `GetGoal`, `UpdateGoalAmount`, `DeleteGoal`, `NetWorthNow`,
  `NetWorthTimeSeries`.
- `handlers.go` — HTTP handlers wired to the store.
- `finance_test.go` — 17 unit tests (no DB required): aggregation share math,
  net-worth FX normalisation, budget progress edges, goal progress clamping,
  input validation.

**Routes added in `cmd/server/main.go` (all `authedMember`, group `// P2-02`):**
```
GET  /orgs/{orgID}/spending                          spending breakdown
GET  /orgs/{orgID}/spending/{categoryID}             drill-down to transactions
POST /orgs/{orgID}/budgets                           create budget + lines
GET  /orgs/{orgID}/budgets                           list budgets
GET  /orgs/{orgID}/budgets/{budgetID}/progress       actual-vs-budget per line
DELETE /orgs/{orgID}/budgets/{budgetID}              soft-delete (is_active=false)
POST /orgs/{orgID}/goals                             create goal
GET  /orgs/{orgID}/goals                             list goals
GET  /orgs/{orgID}/goals/{goalID}                    get goal
PATCH /orgs/{orgID}/goals/{goalID}                   update current_amount/status
DELETE /orgs/{orgID}/goals/{goalID}                  mark abandoned
GET  /orgs/{orgID}/net-worth                         current headline (FX-normalised)
GET  /orgs/{orgID}/net-worth/history                 time series from valuation history
```

**Test results:** `go test ./internal/finance/...` → 17/17 PASS
`go build ./... && go vet ./...` — clean.
