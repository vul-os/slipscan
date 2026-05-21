# slip/scan — Product Roadmap

> The big-picture vision and the phased plan to get there. Engineering tickets
> live in `roadmap/tasks/`; conventions for agents live in `roadmap/README.md`.

## 1. Vision

**One financial vault for every kind of money — personal and business — built
around an LLM that reads your documents, classifies your money, and gets
smarter the more you use it.**

slip/scan ingests slips, invoices, and bank statements (uploaded or emailed
in), extracts and classifies every transaction with an LLM, lets the user
correct it, and learns from those corrections — per-org and across the whole
platform. The same engine powers a **Vault22-style spending breakdown** for
personal users and a **Xero-style ledger** for businesses, in a single
multi-tenant product priced for the African market (Paystack, ZAR-first).

## 2. Positioning — who we beat and how

| Competitor class | Examples | How we win |
| --- | --- | --- |
| Document automation | Dext, Hubdoc, AutoEntry, Veryfi | Cheaper, LLM-native extraction + classification that **learns from corrections** |
| Personal finance | Vault22, YNAB, Monarch | We add **document ingestion** and a **business mode** they don't have |
| Business accounting | Xero, QuickBooks, Sage | **Integrate first** (capture layer → push to Xero), become the ledger later |
| Expense / spend | Expensify, Ramp | One product spanning **personal + business** at local pricing |

**The two things only we do, done well together:**
1. A **classification-learning loop** (per-org + cross-tenant). — Phase 1
2. **Document ↔ bank-feed auto-reconciliation**. — Phase 3

Everything else, an incumbent already does. These two are the moat.

## 3. Strategic decision: integrate before replace

We launch as the **LLM-native capture-and-reconcile layer** and **push to
Xero/QuickBooks** rather than replacing them. This gets us to revenue in months
and rides the incumbents' ecosystem. The full-ledger "replace Xero" path is a
Phase 4 option, not a launch requirement. The schema already supports both — we
choose ordering, not architecture.

## 4. What already exists (as of this roadmap)

- **Backend (Go):** auth (JWT, email verify, password reset), orgs +
  memberships + invitations, document upload/list/get, Gemini OCR, B2 storage,
  insights "Ask". Compiles clean.
- **Schema:** 5 migrations covering a remarkably complete domain — identity/RLS,
  documents/chat/queries, full accounting (personal + business), billing/metering.
  Most roadmap tables **already exist** (see each task's "Existing assets").
- **Frontend (React/Vite/Tailwind/Firebase):** Landing, auth, onboarding,
  dashboard, receipts, ask, members, settings. Firebase dev+main hosting wired.

### Not yet built (the roadmap)
mailrx SMTP receiver · Hetzner deploy fleet · exchange-rate cron ·
classification engine + learning loop · personal/business reporting ·
Xero export · bank feeds · reconciliation · accountant workspace · public API.

## 5. Phases

Each phase has a single competitive goal. Don't start a phase before the prior
phase's **exit criteria** are met — that's what keeps scope from exploding.

### Phase 0 — Ship the foundation
*Goal: a user can register, email in a slip, and see it processed in prod.*
mailrx · Hetzner deploy + DNS + LB · Neon + env + Firebase pipeline ·
exchange-rate cron.
**Exit:** end-to-end document-in-to-processed works on a deployed environment.

### Phase 1 — Win the wedge (capture + learning classification)
*Goal: classification beats Dext out-of-the-box and visibly improves with use.*
Extraction hardening · classification engine · correction-learning loop ·
cross-tenant merchant signals · document review UI.
**Exit:** corrections measurably raise accuracy; the loop is the demo.

### Phase 2 — One vault (personal + business)
*Goal: one login serves a freelancer's personal + business money; SMB feeds Xero.*
Onboarding by org-kind · Vault22 spending breakdown · business ledger + manual
journals · reporting that diverges by kind · Xero/QuickBooks export.
**Exit:** both org kinds have a complete, distinct, useful product surface.

### Phase 3 — Completeness (bank feeds + reconciliation)
*Goal: the financial picture is complete without manual upload — and reconciled.*
Bank-feed aggregator (Stitch/Mono/Plaid) · document↔bank auto-reconciliation.
**Exit:** transactions auto-import and auto-match to documents.

### Phase 4 — Depth + durable moat
*Goal: defend, go upmarket, become indispensable.*
Accountant multi-client workspace · cross-org intelligence (forecasting,
anomalies, tax-readiness) · compliance/audit trail · public API · optional
full-ledger "replace Xero" pivot.

## 6. Dependency graph (high level)

```
P0-03 env/deploy ─┬─> P0-01 mailrx ──┐
                  ├─> P0-02 hetzner ─┤
                  └─> P0-04 fx-cron ─┘
P0-01 ──> P1-01 extraction ──> P1-02 classify ──> P1-03 learn ──> P1-04 cross-tenant
                                      └──> P1-05 review UI
P1-02 ──> P2-01 onboarding ─┬─> P2-02 personal breakdown
                            ├─> P2-03 business ledger ──> P2-05 Xero export
                            └─> P2-04 reporting
P2-03 + bank_feed schema ──> P3-01 bank feeds ──> P3-02 reconciliation
P2 done ──> P4-01 accountant · P4-02 intelligence · P4-03 compliance · P4-04 API
```

## 7. Success metrics per phase

- **P0:** time from email-in to extracted < 60s; deploy is one command.
- **P1:** auto-classification precision on a labelled SA slip set; correction
  rate trending down per active org over time.
- **P2:** % of orgs that complete onboarding; business orgs exporting to Xero.
- **P3:** % of bank lines auto-matched to a document with no user action.
- **P4:** multi-client accountants onboarded; forecast accuracy.
