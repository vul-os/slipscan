# Phase 2 frontend + Phase 3 backend batch — integration contract

The shared layer (api client, query hooks), the new routes, the nav links, and
**stub page files** are already committed on the base branch. Frontend agents
each own ONE page file and only *read* `src/lib/*`. Backend agents each own ONE
new package. Never edit `src/lib/*`, `src/routes/AppRoutes.jsx`,
`src/components/Sidebar.jsx`, or another agent's file.

## Shared frontend layer — already done (import, don't edit)

`src/lib/api.js` + `src/lib/queries.js` already expose everything below.
`src/lib/format.js`: `formatMoney`, `formatDate`, `formatConfidence`, `confidenceLevel`.
Active org: `useOrgStore().activeOrgId`. UI primitives: `src/components/ui/*`,
`PageHeader`, `StatusPill`, `sonner` toasts. Charts: none bundled — use simple
CSS/SVG bars or add a tiny lib only if essential.

**Hooks (read):** `useSpending(orgId,{from,to})`, `useBudgets`, `useGoals`,
`useNetWorth`, `useNetWorthHistory`, `useAccounts`, `useTrialBalance(orgId,{from,to})`,
`useJournals`, `useContacts`, `useReport(orgId,name,{from,to})`, `useXeroStatus`,
`useAudit(orgId,{entity_type,action})`. Plus Phase 1: `useTransactions`,
`useCategories`, `useDocuments`, `useDocument`, `usePatchClassification`.
**Mutations:** use `useOrgMutation(orgId, api.<fn>, [invalidateKeys])` or call
`api.*` directly. e.g. `api.createBudget`, `api.createGoal`, `api.createAccount`,
`api.createJournal`, `api.createContact`, `api.postTransaction`,
`api.deleteBudget/Goal/Account/Journal/Contact`, `api.xeroPush`,
`api.xeroConnectURL(orgId)` (a URL string to redirect to).

## Backend response shapes (real routes; code defensively)

- `GET /spending?from&to` → category breakdown w/ totals + share %.
  `GET /spending/{categoryID}?from&to` → transactions in that category.
- `GET /net-worth` → headline (assets/liabilities/holdings, FX-normalized).
  `GET /net-worth/history` → time series.
- `GET /budgets`, `POST /budgets`, `GET /budgets/{id}/progress`, `DELETE …`.
- `GET /goals`, `POST /goals`, `PATCH /goals/{id}`, `DELETE …`.
- `GET /accounts` (+POST/PATCH/DELETE), `GET /accounts/{id}/ledger?from&to`,
  `GET /trial-balance?from&to`, `POST /transactions/{txID}/post`.
- `GET /journals` (+POST/DELETE) — POST body must balance (Σdebit=Σcredit).
- `GET /contacts` (+POST/PATCH/DELETE).
- `GET /reports/{name}?from&to[&format=csv]` — name ∈ `profit-and-loss`,
  `balance-sheet`, `vat-summary` (business) · `cash-flow`, `spending-trend`,
  `net-worth` (personal). Wrong-kind → 403; unknown → 404.
- `GET /audit?entity_type&action&limit` → audit entries (admin only).
- Xero: `GET /integrations/xero/status`, `POST …/push`; connect via redirect to
  `api.xeroConnectURL(orgId)`. Returns 503 when XERO_* unset — handle gracefully.

Org kind: `useOrgs()` items have `kind` ("personal"|"business"). Gate
business-only pages (Ledger/Reports business reports) vs personal (Budgets/NetWorth).

## Frontend page ownership (one agent each — edit only this file)

| Agent | Owns | Purpose |
|---|---|---|
| FE-A | `src/pages/Dashboard.jsx` | Personal overview: net-worth headline + spending breakdown (donut/bars) + recent activity |
| FE-B | `src/pages/Budgets.jsx` | Budgets + goals: create, list, progress bars |
| FE-C | `src/pages/NetWorth.jsx` | Net-worth detail: headline + history chart + assets/liabilities/holdings |
| FE-D | `src/pages/Ledger.jsx` | Business: chart of accounts, manual journal entry (balanced), trial balance, account drill-down |
| FE-E | `src/pages/Reports.jsx` | Report picker (kind-gated) + rendered report + CSV download |
| FE-F | `src/pages/Settings.jsx` (rewrite) + `src/pages/Audit.jsx` | Settings: inbound email + org info + Xero connect/status; Audit: log viewer |

Stub pages exist for Budgets/NetWorth/Ledger/Reports/Audit — replace the stub.
`npm run build` MUST pass. Match Tailwind + Radix conventions in existing pages.

## Backend agents (one new package each — schema-mediated, additive main.go routes)

| Agent | Task | Package |
|---|---|---|
| BE-A | P3-01 bank feeds | `internal/bankfeed` |
| BE-B | P3-02 reconciliation | `internal/recon` |
| BE-C | cleanup | auto-trigger extract+classify on upload (`internal/document` + call into extract/classify); add `?document_id=` filter to `GET /transactions` |
| BE-D | P4-04 public API & tokens | `internal/apitokens` |
