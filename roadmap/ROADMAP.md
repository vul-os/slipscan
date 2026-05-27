# slip/scan — Product Roadmap

> Big-picture vision and the forward plan. Historical engineering tickets for
> the delivered phases live in `roadmap/tasks/` (kept as an archive); agent
> conventions live in `roadmap/README.md`.

Last updated: 2026-05-27

## 1. Vision

**One financial vault for every kind of money — personal and business — built
around an LLM that reads your documents, classifies your money, and gets
smarter the more you use it.**

slip/scan ingests slips, invoices, and bank statements (uploaded or emailed
in), extracts and classifies every transaction with an LLM, lets the user
correct it, and learns from those corrections — per-org and across the whole
platform. The same engine powers a **Vault22-style spending breakdown** for
personal users and a **Xero-style ledger** for businesses, in a single
multi-tenant product priced for the African market (ZAR-first).

## 2. Positioning — who we beat and how

| Competitor class | Examples | How we win |
| --- | --- | --- |
| Document automation | Dext, Hubdoc, AutoEntry, Veryfi | Cheaper, LLM-native extraction + classification that **learns from corrections** |
| Personal finance | Vault22, YNAB, Monarch | We add **document ingestion** and a **business mode** they don't have |
| Business accounting | Xero, QuickBooks, Sage | **Integrate first** (capture layer → push to Xero), become the ledger later |
| Expense / spend | Expensify, Ramp | One product spanning **personal + business** at local pricing |

**The two things only we do, done well together:**
1. A **classification-learning loop** (per-org + cross-tenant).
2. **Document ↔ bank-feed auto-reconciliation**.

These two are the moat; everything else an incumbent already does.

## 3. Strategic decision: integrate before replace

We launch as the **LLM-native capture-and-reconcile layer** and **push to
Xero/QuickBooks** rather than replacing them. The schema already supports the
full-ledger "replace Xero" path — that's an ordering choice, not an
architecture change.

## 4. The stack (current)

Everything runs on **Cloudflare + Neon**. The only external dependencies are
outbound HTTPS API calls — no servers we operate.

| Layer | Service |
| --- | --- |
| Frontend | **Cloudflare Pages** (Vite SPA, dev + main) |
| Backend (API + background workers) | **Cloudflare Container** running the Go `cmd/server` binary, fronted by a router Worker |
| Inbound mail | **Cloudflare Email Routing → Email Worker** → `POST /internal/inbound-email` (reuses the Go MIME parser) |
| Outbound mail | **Amazon SES** (HTTPS) via the durable Postgres outbox worker |
| Object storage | **Cloudflare R2** (S3-compatible) |
| Database | **Neon Postgres** (main + dev branches, RLS-tenanted) |
| AI | **Google Gemini** (OCR / extraction / classification) |
| Integrations | **Xero/QuickBooks** (export), **Stitch** (SA bank feeds) |

Canonical deploy runbook: `docs/DEPLOY_CLOUDFLARE.md`. Backend design:
`backend/ARCHITECTURE.md`. Email: `backend/docs/EMAIL_SENDING.md`.

## 5. Delivered (Phases 0–4 — the product is built)

All twenty feature tickets are implemented and green locally (`go build/vet/
test`, `npm build/test`). Tickets archived under `roadmap/tasks/`.

| Phase | Outcome | Status |
| --- | --- | --- |
| **0 — Foundation** | Email-in → processed pipeline, exchange-rate cron, env/build | ✅ built (infra re-platformed to Cloudflare; the old Hetzner/Firebase P0 tickets are superseded by `docs/DEPLOY_CLOUDFLARE.md`) |
| **1 — Capture + learning** | Extraction hardening, classification engine, correction-learning loop, cross-tenant merchant signals, document review UI | ✅ built |
| **2 — One vault** | Onboarding by org-kind, Vault22 personal breakdown, business ledger + manual journals, kind-aware reporting, Xero/QuickBooks export | ✅ built |
| **3 — Completeness** | Stitch bank-feed aggregator, document ↔ bank auto-reconciliation | ✅ built |
| **4 — Depth** | Accountant multi-client workspace, cross-org intelligence (forecast/anomalies/tax-readiness), compliance audit trail, public API + tokens | ✅ built |

## 6. Forward roadmap — Now / Next / Later

The frontier is no longer "build features" — it's **ship, harden, and turn on
the integrations**.

### Phase 5 — Go live on Cloudflare  *(Now — the only thing blocking revenue)*
*Goal: real users hit the product on the Cloudflare stack.*
- Provision CF account + move `slipscan.app` zone to Cloudflare.
- Neon dev + main branches; run migrations.
- R2 buckets + **migrate documents/raw emails from B2 → R2** (`rclone`).
- Deploy: container Worker, Email Worker, Pages (dev first).
- Enable Email Routing catch-all on `mail.slipscan.app`.
- **Dev cutover → smoke test (upload, email-in, invite send) → main cutover.**
- **Exit:** a user registers, emails a slip to `<slug>@mail.slipscan.app`, and
  sees it processed in production; an invite email is delivered.

### Phase 6 — Operational hardening  *(Next — make it trustworthy)*
*Goal: the live system is observable, recoverable, and email is reliable.*
- **SES bounce/complaint webhook** (`POST /webhooks/ses`) + populate
  `email_suppressions` (currently unimplemented — see EMAIL_SENDING.md).
- Move SES out of the sandbox (production sending access).
- Monitoring/alerting: CF Container analytics, SES bounce-rate alarm, Neon
  query volume; structured logs.
- Fix the **Reports CSV download** (shared `request()` JSON-parses; needs a
  raw-text path for `format=csv`).
- Backups/DR: confirm Neon PITR; R2 lifecycle; secret rotation runbook.
- **Exit:** known failure modes alert; no silent data loss; clean email reputation.

### Phase 7 — Activate integrations & billing  *(Next)*
*Goal: turn on the revenue + data-completeness surfaces that are coded but dark.*
- **Xero/QuickBooks**: live OAuth app + end-to-end export test.
- **Stitch bank feeds**: live OAuth + webhook signature validation in prod.
- **Billing**: Paystack (schema/metering exist; webhook + wallet settlement
  not yet wired — scope and build).
- **WhatsApp channel**: designed in schema/architecture but not wired (no creds
  yet) — decide if in-scope, then build the webhook + send client.
- **Exit:** at least Xero export + bank feeds working against live accounts.

### Phase 8 — Growth & depth  *(Later)*
*Goal: defend the moat, go upmarket.* Sharpen the classification-learning loop
and reconciliation accuracy with live data; accountant/multi-client growth;
optional full-ledger "replace Xero" pivot. **Open for new product bets — add
priorities here.**

## 7. Success metrics

- **P5 (live):** email-in → extracted < 60 s in prod; deploy is one command.
- **P6 (trust):** email bounce rate < 2%; every known failure mode alerts.
- **P7 (integrations):** business orgs exporting to Xero; % bank lines
  auto-imported and auto-matched to a document with no user action.
- **P8 (depth):** correction rate trending down per active org; multi-client
  accountants onboarded; forecast accuracy.
