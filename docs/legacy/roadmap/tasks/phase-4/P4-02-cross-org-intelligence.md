---
id: P4-02
title: Cross-org intelligence — forecasting, anomalies, tax-readiness
phase: 4
status: review
depends_on: [P2-04, P3-02]
owner: sonnet-agent
---

## Goal
Build the AI insight layer on top of the now-complete, reconciled financial data:
cash-flow forecasting, anomaly/duplicate detection, and tax-readiness checks —
plus a natural-language "Ask" that answers questions over an org's finances. This
is the value incumbents with static tooling can't match.

## Context
The `insights` package + `chats`/`queries`/`query_runs`/`dashboards` schema
already exist for conversational + query-driven analytics. With Phases 1–3
delivering clean classified, reconciled, multi-source data, this turns it into
forward-looking intelligence.

## Existing assets
- `internal/insights` (Ask handler, translator, query/run/summary) +
  `chats`/`chat_messages`/`queries`/`query_runs`/`dashboards` tables.
- `ai_models` (`insights` kind), `transactions`, `ledger_entries`, reports (P2-04).
- `src/pages/Ask.jsx`.

## Scope
**In:** cash-flow forecast (from recurring + historical patterns;
`recurring_transactions` exists); anomaly detection (unusual spend, possible
duplicates, missing-receipt high-value lines); tax-readiness summary (VAT
position, deductible coverage, unreconciled count); enrich the "Ask" NL interface
to answer over this data with cited figures.
**Out:** statutory tax filing/submission; bespoke ML model training infra
(heuristics + LLM first); fully custom user-built dashboards (defer).

## Implementation
1. Forecasting: project cash-flow from `recurring_transactions` + seasonal
   historical averages; expose `GET /orgs/{orgID}/forecast?horizon`.
2. Anomalies: rules + statistical checks (z-score on category spend, duplicate
   amount+merchant+date, high-value lines lacking a reconciled document from P3-02);
   surface as an alerts feed.
3. Tax-readiness: compute VAT position + % of expenses with supporting documents
   + unreconciled count; a readiness score.
4. Ask: extend `internal/insights` so NL questions resolve to safe aggregate
   queries over transactions/ledger and answer with cited numbers (reuse the
   `queries`/`query_runs` machinery; keep generated SQL sandboxed/read-only).
5. UI: insights/alerts panel on the dashboard; forecast chart; richer Ask answers.

## Acceptance criteria
- [ ] Forecast endpoint returns a horizon projection grounded in recurring +
      historical data, with the assumptions surfaced.
- [ ] Anomaly feed flags duplicates, unusual spend, and high-value unreconciled
      items, with low false-positive noise on fixtures.
- [ ] Tax-readiness score reflects VAT position + document coverage + reconciliation.
- [ ] Ask answers a finance question with correct, cited figures over real org data.
- [ ] Generated queries are read-only/sandboxed; `go build` + `npm run build` clean.

## Tests
- Backend: forecast/anomaly math on fixtures; query sandbox safety (no writes,
  org-scoped); tax-readiness computation.
- Frontend: manual walkthrough of insights panel + Ask.

## Notes
This is the "smarter than the incumbents" payoff and only works because Phases
1–3 produced clean, reconciled, classified data. Keep every AI answer grounded in
real figures with citations — trust is the product here.

### Implementation (sonnet-agent, 2026-05-21)
Created `backend/internal/intelligence` package with store/handler/compute split:
- **store.go**: DB queries for recurring transactions, historical monthly totals,
  category spend history (grouped), reconciled transaction IDs, and tax readiness
  aggregates (VAT position, document coverage, unreconciled count).
- **compute.go**: Pure functions for forecast (historical avg + recurring blend),
  anomaly detection (duplicate by merchant+amount+date-window, unusual spend via
  z-score ≥ 2.5, missing receipt for high-value debits ≥ 500 lacking confirmed/auto
  recon match), and tax readiness (40pt VAT + 40pt doc coverage + 20pt recon score).
- **handlers.go**: Three authedMember handlers wired in `main.go` grouped `// P4-02`.
- **compute_test.go**: 23 pure-function unit tests (no DB/network); all pass.
- `go build ./... && go vet ./...` clean. No applied migrations changed.
