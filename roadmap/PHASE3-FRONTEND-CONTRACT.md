# Phase 3 frontend — integration contract

Shared layer (api/query hooks), routes, nav, and stub pages are committed on the
base branch. Each agent owns ONE page and only *reads* `src/lib/*`. Never edit
`src/lib/*`, `src/routes/AppRoutes.jsx`, `src/components/Sidebar.jsx`,
`package.json`, or the other agent's page.

## Shared layer — already done (import, don't edit)

`src/lib/api.js` + `src/lib/queries.js`:
- **Bank feeds:** `useBankConnections(orgId)` → connection rows; `api.bankfeedConnect(orgId)`
  → `{ link_url }` (caller does `window.location.href = link_url`);
  `api.triggerBankSync(orgId, connId)`, `api.disconnectBank(orgId, connId)`,
  `api.getBankConnection(orgId, connId)`.
- **Reconciliation:** `useReconcile(orgId)` → `{ matched, suggested, unmatched }`;
  `api.runReconcile(orgId)` → `{ auto_matched, suggested, skipped }`;
  `api.confirmMatch(orgId, matchId)`, `api.rejectMatch(orgId, matchId)`.
- Wrap mutations with `useOrgMutation(orgId, api.fn, [qk.bankConnections(orgId)])`
  / `[qk.reconcile(orgId)]` (import `qk` from `@/lib/queries`).
- `useOrgStore().activeOrgId`; `formatMoney`/`formatDate` from format.js;
  UI primitives `src/components/ui/*`, `PageHeader`, `StatusPill`, `sonner`.

## Backend response shapes (real; code defensively)

- `GET …/integrations/bankfeed/connections` → `{ connections: [ {id, provider,
  institution_name, institution_id, mask, status, created_at, updated_at,
  last_synced_at?, error_code?, error_message?} ] }`. `status` ∈
  pending|connected|reauth_required|error|disconnected.
- `GET …/integrations/bankfeed/connect` → `{ link_url }` (navigate to it).
- `POST …/connections/{connID}/sync` → `{ syncing:true, connection_id }` (202).
- `DELETE …/connections/{connID}` → `{ disconnected:true }`.
- `POST /orgs/{orgID}/reconcile` → `{ auto_matched, suggested, skipped }`.
- `GET /orgs/{orgID}/reconcile` → `{ matched: MatchRecord[], suggested: MatchRecord[],
  unmatched: { transaction_ids: [...], statement_line_ids: [...] } }`.
  MatchRecord has id, transaction_id, statement_line_id, state
  (auto|suggested|confirmed|rejected), confidence, amount_delta,
  date_delta_days, merchant_score (code defensively — render what's present).
- `POST /orgs/{orgID}/reconcile/{matchID}/confirm|reject` → the updated MatchRecord.

## Page ownership (one agent each — edit only this file)

| Agent | Owns | Purpose |
|---|---|---|
| P3-FE-A Bank feeds | `src/pages/BankFeeds.jsx` | "Connect a bank" (navigate to `link_url`); list connections with status badges + last-synced; per-connection Sync + Disconnect; re-auth-needed call-out. If feeds not configured (provider mock / 503), show a friendly "connect to import transactions automatically" state. |
| P3-FE-B Reconciliation | `src/pages/Reconcile.jsx` | "Run reconciliation" button (calls runReconcile, toasts the counts); three buckets — Matched (auto+confirmed), Suggested (with Confirm/Reject actions per row showing confidence + amount/date deltas), Unmatched (counts/lists of tx & bank lines without a counterpart). Optimistic-ish: invalidate `qk.reconcile` after actions. |

Stub pages exist for both — replace the stub. `npm run build` MUST pass; no npm
deps added; match Tailwind + Radix conventions in existing pages.
