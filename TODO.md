# Slipscan — Build TODO

Structured plan derived from `todo` (raw notes) and the schema already shipped in `backend/migrations/` (`20260430000001_foundation.sql`, `20260430000002_documents_chat.sql`, `20260430000003_accounting.sql`, `20260430000004_billing.sql`). **The migrations are the source of truth** — every UI screen, API endpoint, and worker below maps to specific tables/columns/enums in those files. **Before implementing any task, read the migration sections it references** so the code, types, and naming flow together with the schema. Most domain concepts (orgs, profiles, documents, inbound_emails, transactions, classifications, ledger, invoices/bills, budgets, goals, recurring, plans/subscriptions, wallets, AI runs, fx_rates, chats/queries, api_tokens with scopes, whatsapp_sessions) already exist.

Legend: `[ ]` not done · `[x]` done · `[~]` in progress · `[!]` blocked

---

## 0. Conventions & architecture

- **Two environments**: `dev` (preview / staging) and `main` (production). No third env.
- **Env files**:
  - Backend: `backend/.env` (local), `backend/.env.dev`, `backend/.env.main`
  - Frontend: `.env` (local), `.env.dev`, `.env.main` (Vite mode files)
- **Domains** (placeholder — confirm with user):
  - Frontend dev → `dev.slipscan.app` · main → `slipscan.app`
  - API dev → `api-dev.slipscan.app` · main → `api.slipscan.app`
  - Inbound mail → `rx.slipscan.app` (org address: `<rx_local_part>@rx.slipscan.app`)

### Architecture decision: combined API + RX VMs on Hetzner

```
                     ┌──────────────────────────────────┐
   slipscan.app ───► │  Firebase Hosting (dev + main)   │
                     └──────────────────────────────────┘
                                    │ HTTPS
                                    ▼
                     ┌──────────────────────────────────┐
   api.slipscan.app ►│  Hetzner Cloud LB (HTTP)         │
                     └────────┬─────────────────────────┘
                              │ round-robin
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
            ┌─────────┐   ┌─────────┐   ┌─────────┐
            │  VM-1   │   │  VM-2   │   │  VM-N   │   each VM runs:
            │         │   │         │   │         │     • slipscan-server (HTTP)
            │ rx1 MX  │   │ rx2 MX  │   │ rxN MX  │     • slipscan-mailrx (SMTP :25/:587)
            │ api-1   │   │ api-2   │   │ api-N   │     • caddy (TLS)
            └─────────┘   └─────────┘   └─────────┘     state in Neon + B2 only
                              │
                              ▼
              MX records on rx.slipscan.app (priority 10, 20, …)
              point directly at each VM's public IP
              (LB does not proxy SMTP — SMTP needs the real source IP)
```

**Why combined VMs (not split, not serverless):**
- Hetzner VMs are 5–10× cheaper than equivalent serverless (Lambda+APIGW+SES) at any non-trivial steady traffic. SMTP requires port 25 and IP reputation, which serverless can't give you on its own.
- Stateless app code + state in Neon + B2 → any VM can serve any role. Same binary set, role chosen at boot.
- LB handles HTTP only. SMTP goes direct to VM IPs via MX records — load-balancing is implicit in MX priorities, and the SMTP server sees the real source IP for SPF/DKIM.
- Splittable later by passing `--role api|rx|both` (default `both`) without code changes.

**Hetzner DNS is authoritative for the domain** — `deploy.sh` uses Hetzner DNS API to manage:
- `A`  records: `api-N.slipscan.app`, `rxN.rx.slipscan.app` per VM
- `MX` records: `rx.slipscan.app → rxN.rx.slipscan.app` priority 10/20/…
- `TXT` records: SPF, DKIM (per outbound provider), DMARC
- `PTR` (rDNS): set via Hetzner Cloud API per VM IP for SMTP deliverability
- LB target attach/detach happens in the same script call

**Redis VM** (cache only, see §2.34) — one CX22 per environment in the Hetzner private network. Used by every API/RX VM for rate limiting, idempotency keys, wallet/quota hot-path cache, webhook delivery queue, WhatsApp dedup. Source of truth stays in Postgres; Redis is fail-open. Self-hosted, **not Upstash** — at our shape it's ~10–100× cheaper and ~10× faster on the same private network.

---

## 1. USER tasks (accounts, billing, secrets — only the user can do these)

### 1.1 Firebase
- [ ] Create Firebase project on the **slipscan** Google account
- [ ] Inside that project, create **two Hosting sites**: `slipscan-dev` and `slipscan-main`
- [ ] Run `firebase login` locally (or provide a CI service account JSON)
- [ ] Hand over the project ID and both site IDs

### 1.2 NeonDB
- [ ] Create Neon project on slipscan account
- [ ] Create two branches/databases: `main` (prod) and `dev`
- [ ] Provide both connection strings (pooled + direct) — direct URL is needed for `migrate`

### 1.3 Hetzner
- [ ] Hetzner Cloud account on slipscan billing
- [ ] Generate **Cloud API token** (read+write) → put in local secret store
- [ ] Generate **DNS API token** (slipscan.app zone managed in Hetzner DNS)
- [ ] Confirm domain registrar nameservers point to Hetzner DNS
- [ ] Choose initial datacenter region (e.g. `nbg1` / `fsn1`)

### 1.4 Email / SMTP
- [ ] Resend account → API key + verified sending domain (`mail.slipscan.app`)
- [ ] DNS records for outbound (SPF, DKIM, DMARC) added in Hetzner DNS
- [ ] DNS MX records for `rx.slipscan.app` will be set by `deploy.sh` — confirm zone token has permission

### 1.5 Storage
- [ ] Backblaze B2 bucket(s): `slipscan-docs-main`, `slipscan-docs-dev`
- [ ] Application key scoped to those buckets → key ID + key + endpoint + region

### 1.6 LLM / AI
- [ ] Gemini API key (already configured for OCR) — confirm quota tier
- [ ] (Later) WhatsApp Business API access — schema ready in `whatsapp_sessions`

### 1.7 Exchange rate provider
- [ ] Pick cheapest provider that covers ZAR + majors (candidates: openexchangerates.org free, exchangerate.host, currencylayer, frankfurter.app — frankfurter is free no key)
- [ ] Sign up + get key (if needed)
- [ ] Confirm rate-limit allows ≥24 calls/day

### 1.8 Payments
- [ ] Paystack account + secret key + public key (schema already has `paystack_events`, `subscription_invoices`)
- [ ] Webhook endpoint will be `https://api.slipscan.app/webhooks/paystack`

### 1.9 Brand assets
- [ ] Final logo (SVG, light + dark) and wordmark
- [ ] Brand color palette (one accent + neutrals)
- [ ] Email-safe PNG logo for templates

---

## 2. CLAUDE tasks (code & automation)

### 2.1 Repo / env plumbing
- [ ] Restructure root: confirm frontend lives at repo root (current state) vs. moving under `frontend/` — decide before Firebase config
- [ ] `backend/.env.example` (rebuild — was deleted) listing every var read by `internal/config/config.go`
- [ ] `backend/.env.dev`, `backend/.env.main` templates (placeholders, not real secrets)
- [ ] Frontend `.env.example`, `.env.dev`, `.env.main` (`VITE_API_URL`, `VITE_APP_ENV`, etc.)
- [ ] Update `.gitignore` to ignore real `.env`/`.env.local` but commit `.env.example`/`.env.dev`/`.env.main` templates
- [ ] Verify `internal/config/dotenv.go` loads the right file based on `APP_ENV`

### 2.2 Frontend Firebase deploy
- [ ] Add `firebase.json` with two hosting targets (`dev`, `main`) — each a separate `public` dir or shared with target rewrites
- [ ] Add `.firebaserc` with project + target alias map
- [ ] `package.json` scripts:
  - `build:dev` → `vite build --mode dev` → outputs to `dist-dev/`
  - `build:main` → `vite build --mode main` → outputs to `dist-main/`
- [ ] `vite.config.js` reads mode + sets correct `outDir`
- [ ] Verify locally: `npm run build:dev && npx firebase deploy --only hosting:dev` and same for `main`
- [ ] Add SPA rewrite rule (all routes → `/index.html`)
- [ ] Add cache headers (immutable for hashed assets, no-cache for `index.html`)

### 2.3 Backend cmd layout
Already present: `cmd/server`, `cmd/migrate`, `cmd/preview-email`, `cmd/insights-test`.
- [ ] Create `cmd/mailrx/main.go` (SMTP receiver — see §2.6)
- [ ] Verify all four `cmd/*` build with `go build ./...`
- [ ] `backend/Makefile` targets: `build-server`, `build-mailrx`, `build-migrate`, `migrate-dev`, `migrate-main`, `run-server`

### 2.4 Migrations
- [ ] Confirm `cmd/migrate` runs `20260430120000_core.sql` cleanly against an empty Neon dev DB
- [ ] Add idempotency: re-running migrate should be safe (check whether current implementation tracks applied versions)
- [ ] Run against `dev` and `main` Neon DBs once URLs are provided
- [ ] (Future) New migrations go in `backend/migrations/<timestamp>_<name>.sql` — never edit applied ones

### 2.5 Email templates (`internal/email`)
Pattern already exists in `invite_template.go` + `cmd/preview-email`. Extend:
- [ ] Shared layout with header (logo) + footer (address, unsubscribe placeholder)
- [ ] Templates needed:
  - [ ] Verify email
  - [ ] Welcome (after verification)
  - [ ] Password reset
  - [ ] Invitation (exists — restyle with new logo)
  - [ ] Document processed (success summary)
  - [ ] Document failed (with reason)
  - [ ] Weekly report (vault22-style breakdown digest)
  - [ ] Subscription receipt / payment failed
- [ ] Render preview gallery via `cmd/preview-email`
- [ ] Plain-text alternative for every HTML template

### 2.6 Mail receiver (`cmd/mailrx`)
- [ ] SMTP listener on :25 (and :587 with STARTTLS) using a vetted Go SMTP server lib
- [ ] On `RCPT TO`: parse local-part, lookup `organizations.rx_local_part`. Reject 550 if no match
- [ ] On `DATA`: stream raw RFC822 to B2 → insert `inbound_emails` row with `status='received'`
- [ ] Parse MIME, write each attachment (PDF/img) → B2 → `documents` row linked to `inbound_email_id`, `source='email'`, `status='pending'`
- [ ] Push processing job (Gemini OCR + extraction) — reuse the upload pipeline
- [ ] SPF/DKIM verification → store result on `inbound_emails`
- [ ] Size cap (e.g. 25 MB), attachment count cap, malware-scan stub
- [ ] Health endpoint on a separate port for the LB / monitoring
- [ ] **Multi-IP / multi-VM ready**: stateless — only Postgres + B2 — so any VM behind the MX records can accept

### 2.7 Hetzner deploy (`backend/deploy.sh`)
Single shell script (or thin Go binary if it gets gnarly) using `hcloud` CLI + Hetzner DNS API. Each VM runs **both** `slipscan-server` (HTTP API) and `slipscan-mailrx` (SMTP) — see Architecture in §0.
- [ ] `deploy.sh provision` — creates a combined API+RX VM:
  - cloud-init installs Go binaries (`server`, `mailrx`), Caddy (TLS for HTTP), systemd units with `MemoryMax`/`CPUQuota` so SMTP floods can't starve API
  - **Hetzner DNS auto-config** (DNS API token):
    - `A` `api-<idx>.slipscan.app` → VM public IP
    - `A` `rx<idx>.rx.slipscan.app` → VM public IP
    - `MX` `rx.slipscan.app` priority `10*idx` → `rx<idx>.rx.slipscan.app`
    - `PTR` (rDNS) on the VM IP → `rx<idx>.rx.slipscan.app` (Hetzner Cloud API, critical for SMTP deliverability)
    - On first VM only: `SPF` TXT, `DMARC` TXT, `DKIM` TXT (key from Resend)
  - adds VM to HTTP load balancer (target by IP, port 443)
  - opens firewall: 80, 443, 25, 587 (and locks SSH to known IPs)
- [ ] `deploy.sh provision --replace <vm-name>` — replaces an existing VM:
  - finds all VMs currently attached to the LB
  - new name: `slip-<YYYYMMDD>-<index>` where index increments if multiple replacements happen the same day (e.g. `slip-20260430-1`, `slip-20260430-2`)
  - drains old: deregister from LB → SMTP graceful shutdown (stop accepting, finish in-flight) → delete DNS records → wait for MX TTL → destroy VM
- [ ] `deploy.sh dns-sync` — reconciles `MX` priorities + LB targets against current VM list (idempotent)
- [ ] `deploy.sh status` — prints VMs, LB targets, DNS records side-by-side
- [ ] **Start with 1 VM**, but the script handles N>1 from day one (priority list, indexed names)
- [ ] Secrets to VM via cloud-init userdata (env file written to `/etc/slipscan/env`, mode 0600)
- [ ] Re-deployable: rerunning `provision` for the same name is a no-op or upgrade
- [ ] Optional `--role api|rx|both` flag (default `both`) to support future split if SMTP and API ever need different fleets

### 2.8 Auth & registration flow
Schema: `users`, `organizations`, `personal_profiles`, `business_profiles`, `memberships`. Trigger `enforce_profile_kind` already validates kind matches.
- [ ] Backend: `POST /auth/register` accepts `{kind: 'personal'|'business', ...}` payload and creates user + org + matching profile + `owner` membership in one tx
- [ ] Auto-generate `slug` and `rx_local_part` from name, with collision suffix
- [ ] `PATCH /org/{id}` allows changing `slug` and `rx_local_part` (re-check uniqueness)
- [ ] Frontend signup wizard:
  - Step 1: email + password
  - Step 2: choose Personal vs Business (toggle)
  - Step 3a (personal): full name → `personal_profiles.full_name`
  - Step 3b (business): legal name, reg number, tax number, industry, address → `business_profiles`
  - Step 4: confirm slug + inbound email address (editable)

### 2.9 Document ingestion pipeline
- [ ] HTTP upload (already partial in `internal/document`) → B2 → `documents` row
- [ ] Email ingestion (via §2.6) writes the same `documents` row shape
- [ ] Worker: claim `documents` where `status='pending'` → Gemini OCR → `document_extractions` → derive `transactions` (and `bank_statements`/`statement_lines` for statement PDFs) → `status='extracted'`
- [ ] Failure path: `status='failed'` + reason on `documents.metadata`
- [ ] Idempotency: `(organization_id, sha256)` dedupe on `documents`

### 2.10 Classification & learning
Schema: `classification_rules`, `transaction_classifications`, `classification_corrections`, `merchant_signals`, `categories`.
- [ ] On extraction: classify in this order, stop at first hit:
  1. `classification_rules` (exact / contains / regex on merchant)
  2. `merchant_signals` (community-aggregated category for normalized merchant)
  3. LLM fallback (Gemini) → write `transaction_classifications` with `source='llm'` + confidence
- [ ] User edit on a transaction's category → `classification_corrections` row + bump `merchant_signals` for that org
- [ ] Daily aggregator job: roll classification_corrections across **all orgs** (using only normalized merchant, no PII) → update global `merchant_signals` to improve baseline
- [ ] Per-org learning: when ≥N corrections agree, auto-create a `classification_rule` for that org
- [ ] LLM-assisted re-classification of historical "uncategorized" transactions on demand

### 2.11 FX rates (24×/day cron)
- [ ] Worker / cron in `cmd/server` (or a tiny `cmd/fxsync`) hits chosen provider hourly
- [ ] Writes one row per `(base, quote, as_of)` into `fx_rates`
- [ ] Skip if last fetch < 55 min ago (provider-friendly)
- [ ] Used by reports + multi-currency conversions

### 2.12 Reports & vault22-style insights — **must match or beat 22seven/Vault22**
- [ ] **22seven/Vault22 parity (personal)**:
  - [ ] Linked-account-style consolidated dashboard (we use email-in + statement upload instead of screen-scraping)
  - [ ] Spend by category (donut + month-over-month)
  - [ ] Income vs expense waterfall
  - [ ] Net worth tracker (assets − liabilities) over time
  - [ ] Monthly trends with anomaly callouts ("spent 40% more on groceries than your 6mo avg")
  - [ ] Goals UI (`goals` table) — savings, debt payoff, spending caps with progress bars
  - [ ] Budgets UI (`budgets`, `budget_lines`) — period-based with rollover support
  - [ ] Recurring/subscription detection (`recurring_transactions`) with cancel-this-much-money insights
  - [ ] Top merchants list, category drill-down
  - [ ] Cashflow forecast (next 30/60/90 days based on recurring + scheduled)
  - [ ] Shareable monthly report PDF + email digest
- [ ] **Xero parity (business)**:
  - [ ] P&L (income statement) by period, comparative
  - [ ] Balance sheet
  - [ ] Trial balance
  - [ ] Cash flow statement
  - [ ] AR aging from `sales_invoices`, AP aging from `bills`
  - [ ] VAT/tax report driven by `tax_rates`
  - [ ] General ledger drill-down per account
  - [ ] Bank reconciliation (statement_lines ↔ transactions matching UI)
  - [ ] Lock-date enforcement on edits (`organizations.financial_lock_date`)
  - [ ] Multi-currency with FX gain/loss (uses `fx_rates`)
  - [ ] Customer / supplier statements
  - [ ] Quote → invoice conversion
- [ ] All reports tenanted via the `app_current_organization_id()` GUC already in the schema
- [ ] Both kinds: export every report as CSV + PDF

### 2.13 Manual journals & ledger (business orgs)
Schema: `manual_journals`, `ledger_entries`, `accounts`, `transfers`.
- [ ] CRUD for manual journals (debit/credit balanced)
- [ ] Transaction → ledger_entries projection (one-to-many)
- [ ] Lock-date enforcement (`organizations.financial_lock_date`)
- [ ] Reconciliation UI: match `statement_lines` against `transactions`

### 2.14 Invoicing, POs, credit notes, expense claims, fixed assets (business orgs)
Schema: `sales_invoices`/`sales_invoice_lines`, `bills`/`bill_lines`, `purchase_orders`/`purchase_order_lines`, `credit_notes`/`credit_note_lines`, `expense_claims`/`expense_claim_lines`, `fixed_assets`/`fixed_asset_depreciation_schedule`, `contacts`, `tax_rates`. The `bills.purchase_order_id` and `credit_notes.{sales_invoice_id,bill_id}` FKs link the document chain.

**Sales / AR**
- [ ] Sales invoice CRUD + PDF generation + send via Resend (existing scope)
- [ ] Sales credit notes (`credit_notes.kind = 'sales'`) — issue against an invoice; CHECK constraint blocks crossing into purchase
- [ ] Apply a credit note to one or more invoices (track `amount_applied`); on full apply set `status = 'applied'`

**Purchases / AP**
- [ ] Bill CRUD + payment recording (existing scope)
- [ ] Purchase orders — create, approve, partially_billed → billed lifecycle. `purchase_order_lines.quantity_billed` accumulates as bills land
- [ ] PO → bill conversion: open bill prefilled from PO lines, sets `bills.purchase_order_id`
- [ ] Purchase credit notes (`credit_notes.kind = 'purchase'`) — issue against a bill (refund from supplier)

**Expense claims (employee reimbursement)**
- [ ] Submit flow: employee picks one or more `transactions` (their own receipts) → bundled into `expense_claims` + lines (each line FKs the underlying transaction so OCR'd amount + tax flow through)
- [ ] Approval flow (admin/accountant role): approve / reject with note, sets `approved_at` / `approved_by`
- [ ] Payment: settle via `paid_by_account_id`, post matching `ledger_entries` (debit expense, credit cash), stamp `paid_at`
- [ ] PDF render of the claim summary for record-keeping

**Fixed asset register**
- [ ] Register flow: from a bill line, "Treat as fixed asset" creates `fixed_assets` row (links `bill_id`, `asset_account_id`, `expense_account_id`)
- [ ] Pre-compute `fixed_asset_depreciation_schedule` rows on register based on `method`, `useful_life_months`, `salvage_value`, `depreciation_start`
- [ ] Periodic cron: post each due schedule row to `manual_journals` + `ledger_entries`, stamp `posted_at` and `posted_journal_id`, update `fixed_assets.accumulated_dep`
- [ ] Disposal flow: stamp `disposed_at` / `disposed_amount`, post gain/loss journal, mark `status = 'disposed'`

**Cross-cutting**
- [ ] Contacts (customers/suppliers) — already has a UI placeholder (§2.28); ensure detail page surfaces invoices, bills, POs, credit notes, expense claims attributed to that contact
- [ ] Lock-date enforcement on every mutation in this section (`organizations.financial_lock_date` — read-side check + 403 with override permission)
- [ ] Numbering sequences per org (next-invoice-number, next-PO-number, next-credit-note-number) — store on the org or a small `numbering_sequences` table; pick one before this work starts

### 2.15 Subscriptions & billing
Schema: `plans`, `plan_prices`, `subscriptions`, `payment_methods`, `subscription_invoices`, `paystack_events`, `usage_counters`, `billing_wallets`, `wallet_topups`, `wallet_ledger`, `usage_charges`, `plan_quotas`, `organization_quotas`, `usage_events`.
- [ ] Paystack webhook handler
- [ ] Plan + price seed
- [ ] Wallet top-up flow (for AI usage overage)
- [ ] Usage metering: every `ai_runs` row → `usage_events` → settled into `usage_charges` nightly
- [ ] Quota enforcement middleware

### 2.16 i18n
Schema: `translations` (resource-linked, locale-keyed).
- [ ] Wire backend translator helper to fetch by `(resource_type, resource_id, locale)`
- [ ] Frontend i18n loader (default `en`, future locales)

### 2.17 Notifications
Schema: `notifications`.
- [ ] In-app notification center
- [ ] Email digest via Resend
- [ ] WhatsApp delivery via the chat layer (§2.19)

### 2.19 Right-side chat panel — robust assistant
Schema already in place: `chats`, `chat_messages`, `whatsapp_sessions`, `queries`, `query_versions`, `query_runs`, `dashboards`, `dashboard_versions`. This panel is a first-class part of the product, not an add-on.
- [ ] **Frontend**: persistent right-rail panel on every authenticated page (collapsible, remembers state per user)
  - [ ] Streaming responses (SSE or WebSocket from `/api/chats/{id}/stream`)
  - [ ] Markdown + code + table rendering
  - [ ] Inline result widgets: tables, charts, "open as dashboard tile" button → writes to `dashboards`/`dashboard_versions`
  - [ ] Slash commands: `/upload`, `/report <name>`, `/find <merchant>`, `/categorize <txn>`, `/budget`
  - [ ] Citations: every claim links back to source `transactions` / `documents`
  - [ ] Follow-up suggestions
  - [ ] Voice-to-text input (Web Speech API)
  - [ ] Keyboard shortcut to focus (e.g. `⌘K` opens, `⌘/` toggles)
- [ ] **Backend**: chat orchestrator
  - [ ] Tool calls available to the LLM:
    - `query_transactions(filters)` — generates safe SQL via `queries`/`query_runs`
    - `aggregate(metric, group_by, range)` — pre-built aggregates
    - `get_documents(filter)` — fetch source docs
    - `categorize(txn_id, category_id)` — applies user correction → feeds learning loop
    - `create_invoice(...)`, `create_bill(...)`, `record_manual_journal(...)` (business orgs)
    - `set_budget(...)`, `set_goal(...)`
    - `generate_report(name, range)` — returns rendered report + PDF link
  - [ ] All tool outputs are RLS-scoped via `app_current_organization_id()`
  - [ ] Streaming via channel `web` writes to `chat_messages` with role `user|assistant|tool`
  - [ ] Per-message cost recorded in `usage_events` (model, tokens, cost) → settles into `usage_charges`
- [ ] Conversation memory: summary stored in `chats.metadata`; long histories use embeddings (model_kind `embedding`) for retrieval
- [ ] Chat history list, archive/unarchive, rename, delete

### 2.20 WhatsApp integration with webhooks
Schema: `whatsapp_sessions`, `chat_messages.channel = 'whatsapp'`.
- [ ] Pick provider: Meta Cloud API (free tier) **or** 360dialog/Twilio (BSP). Default to Meta Cloud API for cost.
- [ ] **Verification flow**: user adds WhatsApp number in settings → backend sends 6-digit code → user replies with code on WhatsApp → `whatsapp_sessions.status = 'verified'`
- [ ] **Webhook**: `POST /webhooks/whatsapp` (Meta verification challenge handled)
  - [ ] HMAC signature verification on every payload (`X-Hub-Signature-256`)
  - [ ] Match incoming number → `whatsapp_sessions` → `organization_id`
  - [ ] Map to a `chats` row (one per phone number per org) and append to `chat_messages` with `channel='whatsapp'`
  - [ ] Trigger same chat orchestrator as web chat — same tools, same RLS
  - [ ] Send response back via WhatsApp Cloud API send-message endpoint
- [ ] **Inbound media**: photo/PDF of a slip → store on B2 → create `documents` row → run extraction → reply with extracted total + category
- [ ] **Outbound use cases**:
  - [ ] Daily/weekly summary digest opt-in
  - [ ] Budget alerts ("you've used 90% of your Groceries budget")
  - [ ] Recurring charge detected
  - [ ] Document failed to process
- [ ] Rate limiting + abuse protection (block on `whatsapp_sessions.status = 'blocked'`)
- [ ] Opt-out keyword handling ("STOP")
- [ ] Same chat history visible in web right-rail panel — channel-agnostic UX

### 2.18 Audit log
Schema: `audit_log`.
- [ ] Middleware that records mutating requests (`actor_user_id`, `entity_type`, `entity_id`, diff)

### 2.22 Public API & API keys
Schema: `api_permissions` (catalogue), `api_tokens` (per-org, with `kind`, `scopes`, `allowed_ip_cidrs`, `rate_limit_per_minute`), `audit_log.actor_token_id`, `usage_events` (metric `api_requests`).

**Backend (`internal/apikeys`, `internal/apiauth`)**
- [ ] Seed `api_permissions` on startup from a canonical Go list (`<resource>:<action>`). Cover every resource we expose: `transactions`, `documents`, `categories`, `accounts`, `tax_rates`, `contacts`, `sales_invoices`, `bills`, `budgets`, `goals`, `chats`, `dashboards`, `queries`, `webhooks`, `billing`, `members`, `org`. Reconcile on each boot (deactivate removed codes, never delete).
- [ ] Token format: `sk_live_<24 random base62>` / `sk_test_…` / `sk_rk_…` (restricted). Hash with SHA-256 before storing as `token_hash`; `token_prefix` = first 12 chars (visible in UI).
- [ ] `POST /apikeys` → mint a token (admin/owner role only), accepts `name`, `kind`, `scopes[]` (validated against `api_permissions`), optional `allowed_ip_cidrs[]`, `rate_limit_per_minute`, `expires_at`. Returns plaintext **once** in the response body — never persisted.
- [ ] `GET /apikeys` → list (no plaintext, only prefix + metadata).
- [ ] `PATCH /apikeys/{id}` → edit scopes / IP allowlist / rate limit / name (cannot rotate token; revoke + reissue).
- [ ] `DELETE /apikeys/{id}` → set `revoked_at` and `revoked_by`. Never hard-delete (preserve audit trail).
- [ ] `POST /apikeys/{id}/rotate` → issue new token, mark old `revoked_at = now() + grace_period`.
- [ ] **Authentication middleware**: parse `Authorization: Bearer <token>`, hash, look up by `token_hash`. Reject if `revoked_at` set, expired, or kind doesn't match endpoint (e.g. `test` keys can't hit live billing endpoints).
- [ ] **IP allowlist check**: if `allowed_ip_cidrs` non-empty, require client IP to match one CIDR. Honor `X-Forwarded-For` only behind the LB (configured trusted-proxy list).
- [ ] **Scope check**: each route declares its required permission code; middleware verifies token's `scopes` JSONB contains it (GIN index makes this fast).
- [ ] **RLS context**: `SET LOCAL app.organization_id = <token.organization_id>` and `app.user_id = <token.user_id>` for the request transaction.
- [ ] **Rate limiter**: token-bucket keyed on `(token_id, minute)` in Redis or in-memory ring, falling back to plan default when token's `rate_limit_per_minute` is null. Return `429` with `Retry-After` and `RateLimit-*` headers.
- [ ] **Last-used tracking**: async update `last_used_at`/`last_used_ip` (debounced, e.g. once per 60s per token) so it doesn't dominate write load.
- [ ] **Audit hook**: every mutating API call writes `audit_log` with `actor_token_id` set; reads optional but useful for billing keys.
- [ ] **Metering**: emit `usage_events` with metric `api_requests` per call (org-scoped), so quota / wallet billing kicks in.
- [ ] **Restricted-key enforcement**: `kind='restricted'` tokens cannot grant `*:admin` permissions; check at create time.
- [ ] **Webhook signing boundary**: inbound webhook endpoints (Paystack, WhatsApp) authenticate by HMAC, NOT by API tokens — keep the two systems separate; document where each applies.
- [ ] **Public API documentation**: OpenAPI spec generated from route metadata, hosted at `https://api.slipscan.app/docs`. Include scope per endpoint.

**Frontend (`/settings/api-keys`)**
- [ ] List page: table of active + revoked keys with name, prefix, kind badge, scopes summary, last used, created. Filter by kind.
- [ ] Create modal:
  - Name field
  - Kind selector (live / test / restricted)
  - Scope picker — grouped by resource, with "select all read" / "select all write" shortcuts; restricted-mode disables admin scopes
  - IP allowlist input (multi-CIDR with validation)
  - Rate limit override (number, optional)
  - Expires-at picker (optional)
- [ ] One-time reveal screen: shows full token with copy button, "I've copied it" confirmation before allowing list to be viewed. Token is never available again.
- [ ] Rotate flow: confirms rotation, displays new token same way, schedules old key's revoke time.
- [ ] Revoke flow: confirm dialog with name + prefix.
- [ ] Per-key activity panel: recent `audit_log` entries + `usage_events` summary (last 24h / 7d / 30d), opens from row click.
- [ ] Empty state with link to API docs.
- [ ] Permission gate: only `owner` / `admin` roles see the page.

**Test suite coverage (cross-link to §2.21)** — listed alongside other test items below.

### 2.32 Net worth backend (assets, liabilities, holdings)
Schema: `assets` + `asset_valuations`, `liabilities` + `liability_balances`, `holdings`. Frontend in §2.27.

- [ ] **CRUD**:
  - `assets` — kind, name, current_value (denormalized — also written as a fresh `asset_valuations` row), purchased_at, purchase_value, optional `account_id` link to a GL account so balance flows through to net worth
  - `liabilities` — kind, principal, current_balance, interest_rate, minimum_payment, payment_frequency, matures_at; same valuation-history pattern via `liability_balances`
  - `holdings` — symbol, quantity, cost_basis (cost_currency), current_price (price_currency), grouped under an optional parent `asset` (e.g. one retirement asset, many holdings inside)
- [ ] **Valuation update endpoint**: `POST /assets/{id}/valuations` writes `asset_valuations` and updates `assets.current_value`. Same for liabilities. UNIQUE `(asset_id, as_of)` guards against accidental dupes.
- [ ] **Net-worth aggregator** (`GET /reports/net-worth?from=…&to=…`): sums latest valuation per asset + latest balance per liability, bucketed by month. Personal-org default report.
- [ ] **Holdings pricing job** (optional, second pass): if a `symbol` is set, fetch latest market price into `holdings.current_price` + `last_priced_at` from a free provider (Yahoo, Alpha Vantage). Skip if `holding_kind = 'cash'` or no symbol.
- [ ] **Cost-basis math**: when `cost_currency != price_currency`, convert via latest `fx_rates` for the unrealized gain/loss display.
- [ ] **Manual entry forms** drive most of this — no aggregator needed for v1. Bank feeds (§2.33) hydrate cash + credit-card liabilities automatically once integrated.
- [ ] **Migration of existing "asset accounts"**: any `accounts` row with `account_type = 'asset'` that's user-tracked (not a bank account) should optionally project into an `assets` row so net-worth charts pick it up — wizard in settings.

### 2.33 Bank feed connections (Plaid / Yodlee / Truelayer / Salt Edge)
Schema: `bank_feed_connections`, `bank_statements.bank_feed_connection_id`. Stays optional behind a feature flag — emails-in + statement upload remain the default.

- [ ] **Provider abstraction**: one `BankFeedProvider` Go interface (`Link()`, `Sync(cursor)`, `Reauth()`, `Disconnect()`), with implementations behind build tags so the binary doesn't bloat with unused vendor SDKs.
- [ ] **Pick first provider** (recommendation: Plaid for US/CA, Truelayer for EU/UK; for SA there's no first-class option — start with manual + statement upload, integrate Stitch or DirectID later)
- [ ] **Link flow**: backend mints a Link token → frontend opens provider's hosted UI → callback exchanges public_token for `access_token_encrypted`. Encrypt with KMS-backed key (use Hetzner secrets or AWS KMS — pick before this work starts).
- [ ] **Sync worker**: periodic (15 min) call provider's incremental endpoint with stored `cursor`. Insert `bank_statements` + `statement_lines` + `transactions` (status `pending` → `verified` after dedupe). Stamp `last_synced_at`.
- [ ] **Reauth**: on `ITEM_LOGIN_REQUIRED` (Plaid) or expired consent (PSD2 90-day), set `status = 'reauth_required'` and surface a banner.
- [ ] **Webhook receiver**: provider-specific endpoints under `/webhooks/banking/{provider}` — verify signature, queue a sync.
- [ ] **Disconnection**: hard-revoke at the provider, soft-mark `status = 'disconnected'`, never delete (audit + reconnect flow needs the history).
- [ ] **Dedupe**: when a feed-sourced statement arrives for a period that already has an upload-sourced one, mark the upload-sourced one as superseded rather than double-counting. Match on `(account_id, period_start, period_end)`.
- [ ] **PII / compliance**: bank credentials never touch Postgres in plaintext; only `access_token_encrypted` and `refresh_token_encrypted`. Document the threat model alongside the integration.

### 2.34 Redis layer (self-hosted on Hetzner)
**Why it exists**: hot-path caching/counters that would otherwise hammer Postgres. Tight scope — Redis owns nothing durable; Postgres remains the source of truth. **Not Upstash** — at our shape (Hetzner VMs, EU region, steady traffic, latency-sensitive middleware) self-hosted on a CX22 is ~10–100× cheaper and ~10× faster than Upstash. See conversation thread for the full break-even analysis.

**Strict scope — Redis IS used for:**
- [ ] **API rate limiting** — token bucket per `api_tokens.id` enforcing `api_tokens.rate_limit_per_minute` (and per-IP fallback). `INCR` + `EXPIRE` keyed on `rl:tok:<id>:<minute>`. Middleware in `internal/apiauth`.
- [ ] **Idempotency keys** for the public API — `SET NX EX 86400` keyed on `idem:<org>:<key>` storing response hash; replay returns cached response.
- [ ] **Wallet / quota hot-path cache** — cache `billing_wallets.balance_cents` and active `organization_quotas` rows with 30s TTL. Atomic `DECRBY` for chat-message reservations; settle to Postgres asynchronously. Cache invalidation on Postgres update via `LISTEN/NOTIFY` bridge or write-through.
- [ ] **Outbound webhook delivery queue** — pick **Asynq** (Redis-backed) or **river-queue** (Postgres-backed); Asynq if we're already running Redis. Handles retry+backoff+dead-letter for `document.extracted`, `transaction.created`, `invoice.paid`, etc. (cross-link §2.22).
- [ ] **WhatsApp / SMS outbound throttle** — token bucket against Meta's per-business rate limit so we don't get blocked.
- [ ] **Chat tool-call result cache** — short TTL (30–60s) on identical (org, tool, args) tuples so two users asking "spend by category last 30 days" within a minute don't both pay LLM/DB cost.
- [ ] **WhatsApp webhook dedup** — `SET NX EX 600` on `wa:msg:<message_id>` to absorb Meta's webhook retries.

**Strict scope — Redis is NOT used for:**
- Distributed locks → `pg_advisory_lock` (already in architecture)
- Background job queue for document extraction / classification → `documents.status='pending'` + `FOR UPDATE SKIP LOCKED` (already in architecture)
- Sessions → JWT (stateless)
- Webhook deduplication that must be durable forever → unique constraint in Postgres
- Anything that survives a Redis flush — Redis is a cache, never the source of truth
- SSE/WebSocket fanout — solved by Hetzner LB sticky sessions (chat stream lives on the same VM that runs the LLM call)

**Backend (`internal/redis`, `internal/ratelimit`, `internal/idempotency`, `internal/walletcache`, `internal/webhookq`)**
- [ ] `internal/redis` — single shared `*redis.Client` (go-redis), config from `REDIS_URL`, sane pool defaults, health probe wired into `/healthz`
- [ ] **Engine choice**: vanilla **Redis 7+** to start. Consider **Valkey** (Redis fork, BSD-licensed) for license clarity, or **Dragonfly** if memory pressure becomes a concern — all are Redis-protocol-compatible drop-ins.
- [ ] **Persistence**: AOF `everysec` (durable enough for cache; we don't store source-of-truth data anyway) + daily RDB snapshot to `/var/lib/redis/dump.rdb`
- [ ] **Eviction policy**: `allkeys-lru`, `maxmemory` set to ~75% of VM RAM
- [ ] **TLS off on the private network** (Hetzner Cloud private network is not public); auth via `requirepass` in `/etc/redis/redis.conf` (mode 0600)
- [ ] **Failure mode — fail-open with metric**: when Redis is unreachable, rate limiter allows request + emits `redis_unavailable` counter. Idempotency degrades to "best effort" (log + metric). Wallet cache falls back to Postgres read. We never block a paying customer because a cache box rebooted.
- [ ] **Connection limits** — pool per VM tuned for our peak concurrency; Redis VM `maxclients` set generously
- [ ] **Lua scripts** for atomic token-bucket and atomic balance-decrement (avoid round-trips)

**Deployment (`backend/deploy.sh`)**
- [ ] `--role redis` — provisions a Redis VM:
  - Hetzner CX22 (2 vCPU, 4 GB) in same region as API VMs, in the same Hetzner private network
  - cloud-init installs Redis 7+ (or Valkey), writes `/etc/redis/redis.conf` (bind to private IP only, AOF on, requirepass, maxmemory-policy)
  - systemd unit with `Restart=always` and `MemoryMax=3.5G`
  - DNS: `redis.internal.slipscan.app` A → private IP (only resolvable inside the private network)
  - Hetzner Cloud Firewall: ingress 6379 only from API/RX VM tags; SSH from admin IPs
  - Append `REDIS_URL=redis://:password@redis.internal.slipscan.app:6379/0` to each API/RX VM's `/etc/slipscan/env` and reload systemd unit
- [ ] `--role redis --replace` — provision new Redis VM, point DNS, drain old (Redis is cache → no draining needed beyond letting in-flight commands finish), destroy old
- [ ] **One Redis VM per environment**: `dev` and `main` each get their own
- [ ] (Future, Phase 4+) Add a Redis replica + Sentinel only if we need active-passive failover. Single-node is fine to start; a Redis restart is a 30-second cache rewarming, not a customer-impacting outage.

**Dev / local**
- [ ] Local: `docker compose` service for Redis (already common pattern); `REDIS_URL=redis://localhost:6379/0` in `backend/.env`
- [ ] CI / `cmd/tests`: spin a throwaway Redis container via testcontainers-go, or skip Redis-dependent tests when `REDIS_URL` unset (with a loud warning)

**Tests in `cmd/tests` (cross-link §2.21)**
- [ ] **redis-health** — connect, PING, basic SET/GET round-trip
- [ ] **ratelimit-token-bucket** — burst above limit returns 429; per-token override beats default; window resets correctly; fail-open when Redis is killed mid-test
- [ ] **idempotency-replay** — same `Idempotency-Key` returns same response; different bodies with same key rejected; key expires after TTL
- [ ] **wallet-cache** — cache hit returns balance; Postgres update invalidates; concurrent decrements are atomic; cache miss falls back to Postgres
- [ ] **webhook-queue** — enqueue → deliver → retry on 5xx → dead-letter after N attempts; signing secret used; idempotent on consumer side
- [ ] **whatsapp-dedup** — duplicate webhook with same `message_id` is absorbed; different `message_id` processes both
- [ ] **redis-failure-mode** — kill Redis VM mid-flight → rate limiter, idempotency, wallet cache all degrade gracefully (no 5xx, metrics fire)

### 2.21 Operational test suite (`cmd/tests`)
Single binary that exercises real code paths against a real Neon DB. Not `go test` — these are end-to-end smoke/security probes. Each test registers itself in `internal/testsuite`; the runner picks them up.

> **The test suite must cover a LOT.** Treat it as the primary quality gate, not a nice-to-have. Every feature lands with at least one suite test; security-sensitive paths (auth, RLS, scope enforcement, billing math, lock dates, webhook signatures, API-key handling) need adversarial tests in addition to happy-path. Multi-tenant isolation must be retested whenever any new tenanted table is added. The suite is what gives us confidence to deploy without hand-testing — if it's not covered here, assume it's broken.

Already in place:
- [x] `cmd/tests` runner with `--list`, `--org=<uuid>`, `--no-seed`, positional test names
- [x] `internal/testsuite/seed.go` — idempotent test org + user + membership + transaction fixtures
- [x] `insights` test (folded from old `cmd/insights-test`) — adversarial input against insights.Run
- [x] `preview-email` test (folded from old `cmd/preview-email`) — renders invitation HTML
- [x] Makefile: `make tests`, `make test NAME=…`, `make test-list`

Backend-feature tests to add as features land (track with the relevant section):
- [ ] **auth** — register personal + business orgs, login, refresh, logout, invitation accept (§2.8)
- [ ] **rls** — verify `app_current_organization_id()` GUC blocks cross-org reads on every tenanted table
- [ ] **document-upload** — upload → B2 → `documents` row → status transitions (§2.9)
- [ ] **document-extraction** — fixture PDF → Gemini OCR (or stubbed) → `document_extractions` → `transactions` (§2.9)
- [ ] **mailrx** — synthetic SMTP message (with PDF attachment) → `inbound_emails` + `documents` (§2.6)
- [ ] **classification** — rule hit → signal hit → LLM fallback ordering, `classification_corrections` writeback (§2.10)
- [ ] **fx** — fxsync writes a row, conversions use latest rate (§2.11)
- [ ] **reports-personal** — spend-by-category, net-worth, recurring detection (§2.12)
- [ ] **reports-business** — P&L, balance sheet, AR/AP aging (§2.12)
- [ ] **ledger** — manual journal balance check, lock-date enforcement (§2.13)
- [ ] **invoicing** — sales invoice CRUD + PDF round-trip, payment recording (§2.14)
- [ ] **paystack-webhook** — synthetic event → `subscription_invoices`/`paystack_events` (§2.15)
- [ ] **chat-orchestrator** — tool-call flow with stub LLM, ensures RLS on every tool (§2.19)
- [ ] **whatsapp-webhook** — HMAC verification + inbound media → `documents` (§2.20)
- [ ] **email-templates** — render every template (verify, welcome, reset, weekly digest, …) into `/tmp/preview-*.html` (§2.5)
- [ ] **apikeys-crud** — mint token, list, edit, rotate, revoke; verify plaintext only returned on create + rotate (§2.22)
- [ ] **apikeys-auth** — valid token authenticates; hashed token does not; revoked / expired tokens rejected with correct status codes (§2.22)
- [ ] **apikeys-scope** — endpoint requiring `transactions:write` rejects token holding only `transactions:read`; tokens with no scope rejected (§2.22)
- [ ] **apikeys-restricted** — `restricted` token cannot be created with admin scopes; cannot hit endpoints flagged live-only (§2.22)
- [ ] **apikeys-ip-allowlist** — request from disallowed IP rejected; `X-Forwarded-For` honored only behind trusted proxy (§2.22)
- [ ] **apikeys-ratelimit** — burst above limit returns `429` with `Retry-After`; per-token override beats plan default (§2.22)
- [ ] **apikeys-rls** — token for org A cannot read org B data via any route (cross-tenant smoke test) (§2.22)
- [ ] **apikeys-audit-meter** — mutating call appends `audit_log` row with `actor_token_id` and a `usage_events` row with metric `api_requests` (§2.22)
- [ ] **net-worth** — assets + valuations + liabilities + balances → aggregator returns expected month-bucketed totals; `(asset_id, as_of)` UNIQUE prevents dupes (§2.32)
- [ ] **holdings-pricing** — symbol-tagged holding gets `current_price` + `last_priced_at` from stub provider; cash holdings skipped (§2.32)
- [ ] **purchase-orders** — PO → bill conversion bumps `quantity_billed`; status flips to `partially_billed` then `billed` correctly (§2.14)
- [ ] **credit-notes** — sales credit blocks crossing into bill (CHECK constraint); apply to invoice updates `amount_applied`; full apply transitions to `applied` (§2.14)
- [ ] **expense-claims** — submit → approve → pay flow posts balanced `ledger_entries`; lock-date enforced on payment (§2.14)
- [ ] **fixed-assets** — register pre-computes schedule; periodic post creates `manual_journals` + `ledger_entries`; `accumulated_dep` advances (§2.14)
- [ ] **bank-feeds-sync** — stub provider returns batched `statement_lines`; second sync with same cursor is a no-op; reauth status surfaces (§2.33)
- [ ] **bank-feeds-dedupe** — uploaded statement + feed statement for same `(account, period)` don't double-count (§2.33)

Suite plumbing improvements:
- [ ] Per-test cleanup (currently the seed wipes transactions; add a teardown hook for tests that insert their own rows)
- [ ] `--seed-only` flag (seed and exit, useful for poking at data manually)
- [ ] Optional `--db-url=<dsn>` override so a CI run can target a throwaway branch
- [ ] Capture each test's stdout/stderr to `tmp/tests/<name>.log` for easier diffing
- [ ] Group/tag tests (e.g. `auth`, `documents`, `reports`) so `make test TAG=auth` runs a slice
- [ ] JSON output mode (`--json`) for CI parsing

---

## 2.F Frontend (deep, designed, flows together)

> **Read the migrations first.** Every screen here maps to specific tables in `backend/migrations/20260430000001_foundation.sql` (orgs, profiles, memberships, api_tokens), `…0002_documents_chat.sql` (documents, inbound_emails, chats), `…0003_accounting.sql` (accounts, transactions, classifications, ledger, invoices/bills, budgets, goals), `…0004_billing.sql` (plans, subscriptions, wallets, usage). The data model already encodes business rules (RLS, profile-kind enforcement, ledger projections, scope catalog) — the UI must match them exactly, not invent parallel concepts. When in doubt about a column or enum, open the migration before writing the component.

### 2.23 Frontend design system & component library
**Goal**: a UI as crafted as Stripe / Linear / Vault22 / Xero. Not a generic Tailwind dashboard — deep, composable CSS, design tokens, intentional motion, dense data layouts. Every screen feels considered.
- [ ] **Tokens** in `src/styles/tokens.css` (CSS variables): full color scales 50–950 for neutral, brand, success, warning, danger, info; spacing ramp; radii; **layered shadows** (Stripe-style `shadow-xs` → `shadow-2xl` plus inner shadows for inset fields); typography ramp (display, h1–h4, body, mono via Geist Mono, micro); motion durations + easings; z-index ladder
- [ ] **Tailwind config** maps tokens → utilities. No raw hex outside tokens.
- [ ] **Component primitives** (extend existing `src/components/ui/`):
  - Button (primary/secondary/ghost/destructive/link, xs–lg, loading, with-icon)
  - Input, Textarea, NumberInput (currency-aware, locale-formatted), DatePicker, DateRangePicker
  - Select, Combobox, MultiSelect (Radix + virtualized for big lists)
  - Switch, Checkbox, RadioGroup, Toggle
  - Card (header/body/footer slots), Stat, KPI tile
  - Table (sticky header, column resize, sort, multi-select, row actions, virtualized > 1k rows)
  - DataGrid (denser, Xero-style, for ledger views)
  - Tabs, SegmentedControl, Stepper
  - Dialog, Drawer (right + bottom sheet), Popover, Tooltip, Toast (Sonner)
  - DropdownMenu, ContextMenu, CommandPalette (⌘K)
  - Badge, Pill, Tag, StatusDot
  - Avatar, AvatarStack
  - EmptyState, ErrorState, LoadingState, Skeleton
  - Charts: Donut, Bar, Line, Sparkline, AreaStacked, Waterfall (Recharts or visx, dark-mode aware)
  - Money component — renders amount + currency with locale, sign coloring, hover-shows-original-currency
  - JSONViewer (for raw extraction payloads)
- [ ] **Motion**: Framer Motion for page transitions, drawer slide, toast spring, list-item enter/exit. Subtle — never showy.
- [ ] **Dark mode**: full parity, toggle in user menu, persisted per user
- [ ] **Density modes**: comfortable / compact (Xero-style toggle for power users)
- [ ] **Accessibility**: keyboard-navigable, ARIA roles, focus rings, prefers-reduced-motion respect
- [ ] **Storybook (or Ladle)** so each component is reviewed in isolation
- [ ] **Style guide page** at `/style-guide` (dev-only) showing every component + token

### 2.24 First-login onboarding
Tables: `users`, `organizations`, `personal_profiles`, `business_profiles`, `memberships`, `invitations` (foundation migration). The `enforce_profile_kind` trigger requires the org's `kind` and the profile row to match — the backend creates user+org+profile+membership in one tx; the frontend collects the inputs.
- [ ] **Verify-email gate** before any onboarding (existing `users.email_verified_at`)
- [ ] **Step 1 — Account type**: full-bleed split-screen card "Personal" vs "Business" with iconography + plain-language description. Sets `organizations.kind`.
- [ ] **Step 2a — Personal profile**: full name → `personal_profiles.full_name`. Optional avatar upload.
- [ ] **Step 2b — Business profile**: legal name, registration number, tax/VAT number, industry (Combobox with common SIC), website, address (line1/2/city/region/postal_code/country), fiscal year start month → `business_profiles`. Country prefilled from IP.
- [ ] **Step 3 — Workspace identity**: auto-suggest `slug` and `rx_local_part` from name, both editable, live uniqueness debounce check. Show resulting inbound email `<rx_local_part>@rx.slipscan.app` in a copy-to-clipboard pill with "Send test email" link (`mailto:` prefilled).
- [ ] **Step 4 — Choose first action** (entrypoint to home):
  - "Email your first slip" — shows the rx address with `Copy` + `Send test email`
  - "Upload your first document" — opens upload dialog (drag-drop multi-file, PDF/JPG/PNG/HEIC)
  - "Connect a bank statement" — upload a statement PDF/CSV
- [ ] **Step 5 — Invite teammates** (business only, skippable) — emails → `invitations` rows
- [ ] Persist progress on the org row; user can skip and return later
- [ ] On completion: route to home (§2.25) with a celebratory toast

### 2.25 Home / dashboard — org-kind aware
The home page branches on `organizations.kind`. Both kinds get a top "Getting started" panel until the org has ≥1 extracted document, then it collapses to a dismissible nudge.

**Shared header**:
- [ ] Inbound email pill — `<rx_local_part>@rx.slipscan.app` with `Copy`. Tooltip: "Forward bills, slips, statements here. They show up below within seconds."
- [ ] Quick actions row: Upload, Email me a sample, New transaction (manual), Connect WhatsApp
- [ ] Search / ⌘K command palette

**Personal home** (Vault22-style — "where did my money go"):
- [ ] Net worth card (assets − liabilities from `accounts`, sparkline trend)
- [ ] This-month cashflow waterfall: income, expense, net
- [ ] Spend-by-category donut (last 30 days), click → drill to `transactions` filtered by category
- [ ] Top merchants (top 5 by spend this month)
- [ ] Recurring & subscriptions detected (`recurring_transactions`) with cancel-suggestion
- [ ] Budgets progress (`budgets`, `budget_lines`) — only over-90% surfaced
- [ ] Goals progress (`goals`) — only active
- [ ] Recent transactions (last 10) — click → transactions page
- [ ] Anomaly callouts ("Eating out 60% above your 6-month average")

**Business home** (Xero-style — "state of my business"):
- [ ] Cash position card (sum of asset accounts, sparkline)
- [ ] Money in / money out this month with MoM comparison
- [ ] AR aging mini (current / 1–30 / 31–60 / 60+ from `sales_invoices`)
- [ ] AP aging mini (from `bills`)
- [ ] Outstanding invoices count + total
- [ ] Outstanding bills count + total
- [ ] Bank reconciliation status — N statement lines unmatched (`statement_lines.matched_at IS NULL`)
- [ ] VAT due this period (driven by `tax_rates`)
- [ ] Recent documents stream (last 10)
- [ ] **Extras for business**: profit-margin trend (6 months), top customers by revenue, top expense categories, upcoming recurring bills, lock-date warning if `financial_lock_date` is approaching period-end

### 2.26 Transactions — raw + classified UX
Tables: `transactions`, `transaction_classifications`, `categories`, `transaction_splits`, `transaction_tags`, `tags`, `classification_rules`, `classification_corrections`, `merchant_signals` (`…0003_accounting.sql`). Open the migration before wiring fields — confidence, source, status enums must match exactly.
- [ ] **Two views, toggleable**:
  - **Categorized** (Vault22-style): grouped by category with expand/collapse, donut on top, MoM bars
  - **Ledger** (Xero-style): flat virtualized table — date, merchant, description, account, category, debit, credit, balance, status pill (`pending`/`verified`/`rejected`)
- [ ] Filters: date range, account, category, status, amount range, contact, tag, merchant search, classification source (rule/signal/llm/user)
- [ ] **Bulk operations**: select N → categorize, tag, mark verified, delete, split, transfer-pair
- [ ] **Inline classification edit**: click category cell → Combobox with category tree → save creates `classification_corrections` row + bumps `merchant_signals` for this merchant + offers "Apply to all 27 past 'Pick n Pay' transactions" → on accept creates a `classification_rules` row
- [ ] **Confidence badge**: subtle indicator from `transaction_classifications.confidence`, warning if low
- [ ] **Source badge**: where the classification came from (rule / community signal / LLM / you)
- [ ] **Split transaction** dialog: allocate amount across multiple categories → `transaction_splits` rows
- [ ] **Transfer detection**: surface candidate pairs (same amount, opposite direction, ±2 days) → user confirms → `transfers` row
- [ ] **Drilldown to source**: every transaction links to its `documents.id` (preview pane on right with original receipt/statement page)
- [ ] **Raw data drawer** (per transaction, "View raw"): shows `document_extractions.payload` JSON, `transaction_classifications` history, `ledger_entries` projection — for power users / debugging
- [ ] **Manual entry**: "+ New transaction" dialog (date, account, amount, direction, merchant, category, contact, tags, notes)
- [ ] **CSV import** for bank statements not in PDF
- [ ] **Empty state**: hero + "Forward your first slip to <rx>" + Upload CTA

### 2.27 Accounts & assets — net worth, balances, raw ledger
Tables: `accounts` (`account_type` asset/liability/equity/income/expense), `ledger_entries`, `bank_statements`, `statement_lines`, `transfers`, `manual_journals`, **`assets` + `asset_valuations`, `liabilities` + `liability_balances`, `holdings`** (the dedicated net-worth tables — distinct from `accounts`; an asset can optionally link to a GL account but doesn't have to).
- [ ] **Accounts list**: tree (parent → children) with running balance per account from `ledger_entries`, grouped by `account_type`
- [ ] **Net worth page** (personal-emphasis, useful for business owners too):
  - Big number: total `assets.current_value` − total `liabilities.current_balance` (currency-converted via latest `fx_rates`)
  - Trend line over time, sourced from `asset_valuations` + `liability_balances` (month buckets, falls back to current value if no history)
  - Asset breakdown donut driven by `assets.kind` (property, vehicle, cash, investment, retirement, business, collectible, other)
  - Liability breakdown donut driven by `liabilities.kind` (mortgage, credit_card, student_loan, …)
  - **Holdings panel** under "Investments" asset: list of `holdings` rows with quantity × current_price, unrealized gain/loss vs cost_basis (FX-converted)
  - "Add" menu → asset (form per kind), liability (form per kind), holding (symbol lookup), or upload bank statement
- [ ] **Account detail page** per account:
  - Current + opening balance
  - Reconciliation status (matched vs unmatched statement lines)
  - Transactions filtered to this account
  - Statements list (`bank_statements` rows, including `bank_feed_connection_id` source)
  - **Raw data drawer**: underlying `ledger_entries` rows (date, source_type, source_id, debit, credit, running balance) — reads like a real general ledger
- [ ] **Asset entry forms** per `asset_kind`: kind-specific fields (e.g. property → address; vehicle → make/model/year; retirement → fund name + provider). Each save also writes an `asset_valuations` row with `as_of = today`.
- [ ] **Liability entry forms** per `liability_kind`: principal, interest_rate, payment_frequency, minimum_payment, matures_at; payoff-progress chart from `liability_balances` history.
- [ ] **Holdings entry**: symbol search (Yahoo / IEX), quantity, cost_basis, optional grouping under a parent retirement asset.
- [ ] **Bank feed link UI** (§2.33 driven, feature-flagged): "Connect a live feed" button on the account detail page; status pill (connected / reauth_required / error / disconnected) + last_synced_at.
- [ ] **Reconciliation workspace** (business-emphasis, also for zero-based personal):
  - Two-pane: bank `statement_lines` left, candidate `transactions` right
  - One-click match, split-match, create-from-line, mark as transfer
  - Bulk auto-match by amount+date heuristic
  - Persist matches via `statement_lines.matched_transaction_id`

### 2.28 Business-only screens
All gated by `organizations.kind = 'business'`. Use route guards + a shared `useOrgKind()` hook. Tables in `…0003_accounting.sql`.
- [ ] **Sales** — invoice list, create/edit (line items from `sales_invoice_lines`, `tax_rates`), send via Resend, payment recording, statement generation; **sales credit notes** (`credit_notes.kind = 'sales'`) issuable from an invoice with apply-to flow (§2.14)
- [ ] **Purchases** — bill list, create/edit, payment recording, attached document preview; **purchase orders** with PO → bill conversion (`bills.purchase_order_id`); **purchase credit notes** (`credit_notes.kind = 'purchase'`) (§2.14)
- [ ] **Expense claims** — submit / approve / pay workspace (`expense_claims` + lines link `transactions` for the receipt + amount) (§2.14)
- [ ] **Fixed assets register** — list, register-from-bill, depreciation schedule preview, disposal flow (`fixed_assets`, `fixed_asset_depreciation_schedule`) (§2.14)
- [ ] **Contacts** — customers, suppliers, both. Detail page with running balance, transaction history, statement, plus this contact's invoices, bills, POs, credit notes, expense claims
- [ ] **Tax rates** — CRUD on `tax_rates` (effective dates, inclusive/exclusive)
- [ ] **Manual journals** — debit/credit balanced entry form, attach supporting docs, lock-date enforcement
- [ ] **Chart of accounts** — full tree CRUD on `accounts`, archive
- [ ] **Reports hub** (Xero parity, see §2.12):
  - P&L, Balance Sheet, Trial Balance, Cash Flow Statement
  - AR Aging, AP Aging, Customer/Supplier statements
  - VAT Return, General Ledger, Account Transactions
  - Period selector, comparative columns, export CSV/PDF/Excel
- [ ] **Lock dates** — settings UI sets `organizations.financial_lock_date`; warns about edits before that date
- [ ] **Multi-currency** — base currency from org, FX gain/loss on revaluation (uses `fx_rates`)
- [ ] **Fiscal year settings** — `business_profiles.fiscal_year_start_month`
- [ ] **Team & permissions** — uses `memberships.role` (owner/admin/accountant/member/viewer): invite, change role, revoke
- [ ] **Quote → invoice** conversion (future, once schema for quotes lands)

### 2.29 Documentation — public site + in-app help
Two surfaces, both first-class.

**Public docs** (`docs.slipscan.app` — separate Firebase site or `/docs` route):
- [ ] Static doc framework (Nextra / Starlight / Docusaurus — pick lightweight)
- [ ] Sections:
  - Getting started (signup → choose type → first upload / first email-in)
  - Personal guide (every screen explained, vault22 migration tips, CSV export → import)
  - Business guide (Xero migration, COA setup, VAT, invoicing, reconciliation)
  - Email-in guide (forwarding rules, supported document types, what gets extracted)
  - Mobile / WhatsApp guide
  - Categories & classification (how it learns, how to correct it, community signals)
  - Reports reference (every column explained)
  - Accounts & ledger primer (for personal users new to double-entry)
  - Security, privacy, data export, deletion
  - FAQ
  - Changelog
- [ ] Search (Algolia DocSearch or built-in)
- [ ] Dark mode parity with the app
- [ ] Edit-on-GitHub link

**In-app help**:
- [ ] `?` button bottom-right → contextual help drawer (auto-detects current screen)
- [ ] `/help <query>` slash command in chat
- [ ] Empty states link to relevant docs section
- [ ] Keyboard shortcut overlay (`?` while not in input)

**Public API docs** (cross-references §2.22 — keys/scopes):
- [ ] OpenAPI 3.1 spec generated from backend route metadata (single source of truth)
- [ ] Rendered with Scalar / Stoplight Elements / Redocly (Stripe-grade reading experience)
- [ ] Per-endpoint: scope required (matches `api_permissions` codes), rate limit, request/response examples in curl + JS + Python + Go, error codes table
- [ ] Sections: auth, pagination, rate limits, idempotency keys, webhooks reference, changelog
- [ ] Interactive "Try it" using the user's test key
- [ ] Hosted at `https://docs.slipscan.app/api` (matches what §2.22 calls out at `api.slipscan.app/docs` — pick one and stick)

**API status page** (separate, simple): uptime + latency by endpoint group.

### 2.30 Information architecture & navigation — make it flow as one product
Reference the migration files when wiring routes so every screen ties back to its tables. Nothing should be a dead end — every monetary number drills into transactions, every transaction into its document, every document into its inbound email.
- [ ] **Top-level routes** (after auth):
  - `/` → home (org-kind branched, §2.25)
  - `/transactions` → §2.26
  - `/accounts` → §2.27 list; `/accounts/:id` → detail
  - `/documents` → list of `documents`; click → preview + extracted data
  - `/inbox` → `inbound_emails` log + status
  - `/reports/*` → personal reports (always) + business reports (kind=business)
  - `/budgets`, `/goals`, `/recurring` (personal-emphasis)
  - `/sales/*`, `/purchases/*`, `/contacts/*`, `/journals`, `/coa`, `/reconciliation` (business-only)
  - `/settings/*` (org, members, slug + rx, integrations, api keys, webhooks, billing, plan, security, locale)
  - `/help`, `/docs`
- [ ] **Left nav** — collapsible, sections grouped (Money, Documents, Reports, Business, Settings); business-only sections hidden when kind=personal
- [ ] **Right rail** — chat panel (§2.19) on every authenticated route, collapsible, persistent across navigation
- [ ] **Top bar** — org switcher (multi-org users via `memberships`), search/⌘K, notifications, user menu
- [ ] **Breadcrumbs** on detail pages
- [ ] **Cross-links everywhere**: monetary numbers → underlying transactions; transactions → documents; documents → inbound emails (when applicable); reports rows → ledger entries
- [ ] **Consistent empty states**: every list with zero rows links to the action that creates the first row + the relevant docs page

### 2.31 Marketing / landing site (logged-out)
Separate from the docs site. Short and fast. Built with the same design system.
- [ ] Hero: clear value prop ("Send a slip, get your finances sorted")
- [ ] Two persona sections: For You (personal) and For Your Business (business)
- [ ] Feature grid (email-in, OCR, classification, vault22-style breakdowns, Xero-grade reports, WhatsApp, API)
- [ ] "How it works" — 4 steps with screenshots/animation
- [ ] Pricing (driven by `plans` + `plan_prices`)
- [ ] Trust: security, data location (ZA/EU), export-anytime
- [ ] Testimonials / logos (later)
- [ ] CTAs to signup with kind preselected
- [ ] Hosted on the same Firebase project as the app, or `/` rewrite for unauthenticated users

---

## 3. Phasing

**Phase 1 — foundation** (unblocks everything else)
- 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 (user accounts/keys)
- 2.1 env files, 2.2 Firebase, 2.3 cmd layout, 2.4 migrations, 2.5 base email templates
- **2.23 design system** (tokens + primitives — every other UI section depends on this)
- **2.34 Redis layer** (provision the cache VM; rate limiter / idempotency / wallet cache middleware land alongside §2.22 and §2.15)

**Phase 2 — core flow**
- 2.6 mailrx, 2.7 deploy.sh (1 combined VM), 2.8 registration, 2.9 ingestion, 2.10 classification baseline (rules+LLM, no global learning yet)
- **2.24 onboarding**, **2.25 home (personal + business getting-started)**, **2.30 IA / nav scaffold**

**Phase 3 — value & assistant**
- 2.12 reports (personal first → vault22 parity), 2.11 fx cron, 2.13 ledger, 2.10 global learning, 2.17 notifications, **2.19 right-side chat panel**
- **2.26 transactions UI (categorized + ledger views, classification UX)**, **2.27 accounts & assets (net worth, raw ledger)**

**Phase 4 — business + monetization + WhatsApp**
- 2.12 reports (business → Xero parity), 2.14 invoicing, 2.15 billing/Paystack, 2.18 audit log, **2.20 WhatsApp webhooks**
- **2.28 business-only screens** (sales, purchases, contacts, COA, reconciliation, manual journals, lock dates)
- **2.22 API keys/scopes UI + 2.29 API docs** (public API surface)

**Phase 5 — polish**
- 2.16 i18n, advanced insights, mobile PWA, **2.29 public docs site**, **2.31 marketing / landing**

---

## 4. Open questions for the user

- [ ] Final domain — `slipscan.app` or other?
- [ ] Frontend repo layout: keep root or move under `frontend/`?
- [ ] Single Firebase project with two sites confirmed (vs. two projects)?
- [ ] Default currency — `ZAR` per schema, confirm
- [ ] Free-tier limits per plan (drives `plan_quotas`)
- [ ] Brand color / logo timeline
