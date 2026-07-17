# Phase 4 (P4-01 workspace, P4-02 intelligence) — integration contract

Shared frontend layer (api/hooks), routes, nav, and stub pages are committed on
the base. The endpoint contracts below are BINDING for both the backend agent
(implement exactly these routes/shapes) and the frontend agent (consume them).
Backend agents own a package + additive `main.go` routes; frontend agents own a
page file and only read `src/lib/*`. Never edit `src/lib/*`, routing, Sidebar,
package.json, or another agent's file.

## P4-01 — Accountant multi-client workspace

**Backend (own `internal/workspace` or extend `internal/org`):**
- `GET /workspace` — **user-scoped (authed = JWT only, NOT authedMember)**. For
  the signed-in user, list every org they belong to with per-org attention
  metrics. Response:
  ```json
  { "orgs": [ { "id": "...", "name": "...", "kind": "personal|business",
      "role": "owner|admin|accountant|member|viewer",
      "attention": { "unverified_transactions": N, "unmatched_lines": N,
                     "pending_documents": N, "suggested_matches": N } } ] }
  ```
  Compute metrics with cheap COUNT queries scoped per org (only orgs the user is
  a member of). Reuse `org.Store.ListForUser`.
- Verify the existing `POST /orgs/{orgID}/invitations` accepts `role:"accountant"`
  (membership_role enum already has it). If it doesn't pass the role through, fix
  that surgically in `internal/invite` (one call site, commented `// P4-01`).
- Wire `GET /workspace` in `main.go` under `authed` (grouped `// P4-01`).

**Frontend (own `src/pages/Workspace.jsx`):** practice dashboard — uses
`useWorkspace()` (returns the orgs array). Show a card/row per client org with
name + kind + role badge and attention badges (unverified / unmatched / pending /
suggested); clicking a client sets it active via `useOrgStore().setActiveOrg` and
routes to `/dashboard`. A cross-client "needs attention" summary at top
(totals). Empty state for users with one org. Loading via `Skeleton`.

## P4-02 — Cross-org intelligence (forecasting, anomalies, tax-readiness)

**Backend (own `internal/intelligence`; may read `internal/insights` patterns):**
- `GET /orgs/{orgID}/forecast?horizon=<months>` (authedMember) — cash-flow
  projection from `recurring_transactions` + historical monthly averages.
  Response: `{ horizon, currency, points: [{ month, projected_inflow,
  projected_outflow, projected_net, projected_balance }], assumptions: [...] }`.
- `GET /orgs/{orgID}/anomalies` (authedMember) — `{ anomalies: [{ id, type
  ("duplicate"|"unusual_spend"|"missing_receipt"|...), severity, title,
  description, amount?, currency?, transaction_id?, detected_at }] }`. Use rules
  + simple stats (z-score on category spend; duplicate amount+merchant+date;
  high-value transactions lacking a reconciled document — `reconciliation_matches`).
- `GET /orgs/{orgID}/tax-readiness` (authedMember) — `{ score (0..100),
  vat_position?, documented_expense_pct, unreconciled_count, components: [{ label,
  status, detail }] }`.
- Wire routes in `main.go` grouped `// P4-02`.

**Frontend (own `src/pages/Insights.jsx`):** uses `useForecast(orgId, horizon)`,
`useAnomalies(orgId)`, `useTaxReadiness(orgId)`. Sections: a cash-flow forecast
chart (CSS/SVG, no npm dep), an anomalies feed (severity-coloured cards), and a
tax-readiness score gauge + component checklist. `useOrgStore().activeOrgId`,
`formatMoney`/`formatDate`, defensive against shapes. Loading/empty states.

## Constraints (all four)
`go build ./... && go vet ./...` (backend) and `npm run build` (frontend) MUST
pass. Backend: unit tests for the aggregation/forecast/anomaly math (no live
LLM/network — gate any LLM behind `//go:build llm`); schema-mediated, don't edit
other packages beyond the noted surgical hooks; no edits to applied migrations.
Frontend: no npm deps. Set task `status: review`, `owner: sonnet-agent`, append Notes.
