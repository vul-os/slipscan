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

### 2.14 Invoicing (business orgs)
Schema: `sales_invoices`, `sales_invoice_lines`, `bills`, `bill_lines`, `contacts`, `tax_rates`.
- [ ] Sales invoice CRUD + PDF generation + send via Resend
- [ ] Bill CRUD + payment recording
- [ ] Contacts (customers/suppliers)

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

Suite plumbing improvements:
- [ ] Per-test cleanup (currently the seed wipes transactions; add a teardown hook for tests that insert their own rows)
- [ ] `--seed-only` flag (seed and exit, useful for poking at data manually)
- [ ] Optional `--db-url=<dsn>` override so a CI run can target a throwaway branch
- [ ] Capture each test's stdout/stderr to `tmp/tests/<name>.log` for easier diffing
- [ ] Group/tag tests (e.g. `auth`, `documents`, `reports`) so `make test TAG=auth` runs a slice
- [ ] JSON output mode (`--json`) for CI parsing

---

## 3. Phasing

**Phase 1 — foundation** (unblocks everything else)
- 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 (user accounts/keys)
- 2.1 env files, 2.2 Firebase, 2.3 cmd layout, 2.4 migrations, 2.5 base email templates

**Phase 2 — core flow**
- 2.6 mailrx, 2.7 deploy.sh (1 combined VM), 2.8 registration, 2.9 ingestion, 2.10 classification baseline (rules+LLM, no global learning yet)

**Phase 3 — value & assistant**
- 2.12 reports (personal first → vault22 parity), 2.11 fx cron, 2.13 ledger, 2.10 global learning, 2.17 notifications, **2.19 right-side chat panel**

**Phase 4 — business + monetization + WhatsApp**
- 2.12 reports (business → Xero parity), 2.14 invoicing, 2.15 billing/Paystack, 2.18 audit log, **2.20 WhatsApp webhooks**

**Phase 5 — polish**
- 2.16 i18n, advanced insights, mobile PWA, public API + webhooks

---

## 4. Open questions for the user

- [ ] Final domain — `slipscan.app` or other?
- [ ] Frontend repo layout: keep root or move under `frontend/`?
- [ ] Single Firebase project with two sites confirmed (vs. two projects)?
- [ ] Default currency — `ZAR` per schema, confirm
- [ ] Free-tier limits per plan (drives `plan_quotas`)
- [ ] Brand color / logo timeline
