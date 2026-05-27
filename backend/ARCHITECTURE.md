# Slipscan Backend Architecture

Last reviewed: 2026-05-27 · Branch: `new-slip`

This document is the canonical description of how the backend is deployed, why
it is shaped this way, and the contracts between components. The stack is
**Cloudflare** (frontend, backend, inbound mail, object storage) + **Neon**
(database). The only non-Cloudflare dependencies are outbound HTTPS calls to
SaaS APIs (Gemini, Amazon SES, Stitch, Xero) — none require servers we operate.

---

## 1. One-page overview

```
Users
  │
  ├─ HTTPS ─► app.slipscan.app (Cloudflare Pages)
  │               Static SPA (Vite build)
  │
  ├─ HTTPS ─► api.slipscan.app/* ──► Cloudflare Worker (Router)
  │                                       │
  │                                  GoBackend DO stub
  │                                       │
  │                                  Cloudflare Container
  │                                  (Go monolith, $PORT=8080)
  │                                  GET /healthz → 200
  │
  └─ SMTP  ─► *@mail.slipscan.app ──► Cloudflare Email Routing
                                           │
                                       Email Worker (slipscan-email-ingest)
                                           │
                                       POST /internal/inbound-email
                                         ?recipient=<to>
                                         X-Inbound-Secret: <secret>
                                           │
                                       Go monolith

  Outbound email:
    Go monolith ─► email_outbox (Neon)
                       │
                   Email retry worker (goroutine, EMAIL_WORKER_ENABLED=true)
                       │
                   Amazon SES v2 HTTPS API ──► Recipient inbox
                       │
                   Bounce/complaint events ──► SNS → POST /webhooks/ses

  State:
    ┌─────────────────────────────────────────────────────────────────┐
    │  Neon Postgres (main + dev branches)                            │
    │  — RLS-tenanted via app_current_organization_id()              │
    └─────────────────────────────────────────────────────────────────┘
    ┌─────────────────────────────────────────────────────────────────┐
    │  Cloudflare R2  (slipscan-docs-main / -dev)                     │
    │  — original docs + raw RFC822 emails                            │
    │  — S3-compatible; standard Go AWS SDK S3 client (no code change) │
    └─────────────────────────────────────────────────────────────────┘

  External APIs (outbound HTTPS only — nothing self-hosted):
    — Gemini (OCR / extraction / classification)
    — Amazon SES (outbound transactional email delivery)
    — Stitch (bank-feed aggregator, SA-first)
    — Xero / QuickBooks (accounting export)
    — Frankfurter / openexchangerates (FX rates)
```

Why email is split across two transports: Cloudflare cannot originate
outbound SMTP (port 25 is blocked) and Email Routing only **receives**. So
**receiving** is fully Cloudflare-native (Email Routing → Email Worker → our
HTTP ingest), while **sending** delegates delivery to Amazon SES over HTTPS —
an API call, not a host. See `backend/docs/EMAIL_SENDING.md`.

---

## 2. Compute model

### 2.1 Why Cloudflare Containers

The backend is a stateful Go monolith: in-process background workers,
per-request `SET LOCAL` RLS, and SSE streaming. A Container runs that binary
unchanged, fronted by a router Worker — no rewrite, no VMs to operate.

| Concern | Cloudflare Container + Worker |
|---|---|
| Infra ops | Zero VM management; CF handles host, TLS, CDN, DDoS |
| SMTP ingress | Cloudflare Email Routing replaces port-25 servers |
| Cold starts | ~3–8 s first request; subsequent requests warm |
| Background workers | In-process goroutines gated by env vars |
| Egress cost | Included in the Workers plan for typical traffic |
| Scaling | `max_instances` in `wrangler.toml`; no provisioning scripts |
| Deployment | `wrangler deploy` from the repo |

### 2.2 Container sizing

Declared in `infra/cloudflare/wrangler.toml`:

| Parameter | Value | Notes |
|---|---|---|
| `instance_type` | `standard-2` | 2 vCPU / 4 GB RAM |
| `max_instances` | 5 | scale up to 5 containers |
| `sleepAfter` | `10m` | container idles after 10 min of no traffic |

Adjust `instance_type` and `max_instances` in `wrangler.toml` as load grows.

---

## 3. Process layout

The Go monolith (`cmd/server`) runs as a single process inside a Cloudflare
Container. It listens on `$PORT` (default `8080`) and exposes `GET /healthz`.

Background goroutines run in-process, gated by env vars (single-runner guard):

| Goroutine | Env var guard | Default interval |
|---|---|---|
| Email outbox delivery | `EMAIL_WORKER_ENABLED=true` | 5 s |
| FX rate sync | `FX_SYNC_ENABLED=true` | 1 h |
| Merchant signal aggregation | `SIGNALS_AGG_ENABLED=true` | 24 h |
| Document extraction worker | always on | polls `status='pending'` |
| Classification worker | always on | polls unclassified transactions |
| Bank-feed sync | `BANKFEED_SYNC_ENABLED=true` | 4 h |

In a multi-instance container deployment, set each guarded env var to `true`
on exactly one instance. Postgres `FOR UPDATE SKIP LOCKED` ensures correct
single-worker semantics even if multiple instances accidentally run the same
worker — no duplicate sends, just wasted polling.

---

## 4. Hot paths

### 4.1 HTTP API request

```
client → DNS api.slipscan.app
       → Cloudflare Worker (index.ts)
       → GoBackend DO stub (getContainer)
       → Go monolith :8080
           │
           JWT verify
           SET LOCAL app.organization_id (app_current_organization_id())
           SET LOCAL app.user_id
           handler
           Postgres (RLS enforced)
           R2 (presigned URLs)
           LLM provider (Gemini)
           │
           ▼
         response (streamed back through DO stub → Worker → client)
```

SSE and chunked streaming work end-to-end: the DO stub forwards the response
stream without buffering.

Auth: JWT in `Authorization: Bearer`. Refresh tokens in httpOnly cookie.
See `internal/auth`.

Tenant isolation: Postgres RLS using `app_current_organization_id()` set
per-request via `SET LOCAL`. Connection pool resets with `RESET ALL`.

### 4.2 Inbound email path

```
sender
  │ SMTP
  ▼
Cloudflare Email Routing MX (mail.slipscan.app)
  │ catch-all rule → Email Worker
  ▼
Email Worker (infra/cloudflare/src/email.ts)
  │ size check (25 MB limit)
  │ read raw RFC-822 stream → ArrayBuffer
  ▼
POST /internal/inbound-email?recipient=<encoded-to>
  Header: X-Inbound-Secret: <INBOUND_INGEST_SECRET>
  Header: Content-Type: message/rfc822
  Body:   raw RFC-822 bytes
  │
  ▼
Go monolith: parse recipient → lookup org → INSERT inbound_emails
  │
  │ parse MIME → for each attachment (PDF/img):
  │   INSERT documents (org_id, source='email', status='pending', sha256)
  │   upload to R2 (path: documents/<org_id>/<doc_id>.<ext>)
  ▼
extraction worker picks up pending documents
```

The HTTP ingest handler (`POST /internal/inbound-email`) and the SMTP path
(`cmd/mailrx`, used only for local development) share one parser/store code
path via `internal/mailrx` `Ingester` — there is a single implementation.

Why Email Routing instead of a port-25 server:
- No VM to manage; CF handles MX, TLS, delivery retries.
- The Go monolith receives a clean HTTP POST — same code path as web uploads.
- SPF/DKIM/DMARC for inbound is handled by CF Email Routing; for outbound by
  Amazon SES (see `backend/docs/EMAIL_SENDING.md`).

### 4.3 Document extraction

```
documents (status='pending')
  │ worker claims via advisory lock on document_id
  ▼
ai_runs INSERT (kind='ocr', status='running')
  │
  ▼
download from R2 → Gemini OCR → raw text + structured guess
  │
  ▼
ai_runs INSERT (kind='extraction') → document_extractions
  │
  ▼
derive transactions / bank_statements + statement_lines
  │
  ▼
classification: rule → merchant_signal → LLM
  writes transaction_classifications
  │
  ▼
documents.status='extracted'
```

All ai_runs are billed via `usage_events` → `usage_charges`.

### 4.4 Outbound email path

```
Application handler
  │ INSERT email_outbox (status='pending')
  ▼
Email retry worker (EMAIL_WORKER_ENABLED=true)
  │ FOR UPDATE SKIP LOCKED on email_outbox
  │ ses:SendEmail (AWS SES v2 HTTPS API)
  ▼
Amazon SES ──► Recipient inbox

Bounce/complaint events:
Amazon SES → SNS topic → POST /webhooks/ses → email_suppressions
```

See `backend/docs/EMAIL_SENDING.md` for the full SES setup runbook.

---

## 5. Deploys

### 5.1 Cloudflare deploy

```bash
cd infra/cloudflare
npm run deploy          # Router Worker + Container (wrangler.toml)
npm run deploy:email    # Email Worker (wrangler.email.toml)
```

Frontend Pages deploy from the repo root:

```bash
npm run deploy:dev      # build dist-dev → wrangler pages deploy (slipscan-staging)
npm run deploy:main     # build dist-main → wrangler pages deploy (slipscan-main)
```

DNS records:
```bash
backend/scripts/cloudflare-app-dns.sh   # app/api CNAME + Email Routing MX
backend/scripts/cloudflare-ses-dns.sh   # SES SPF/DKIM/DMARC
```

Full runbook: `docs/DEPLOY_CLOUDFLARE.md`.

### 5.2 Failure modes & recovery

| Failure | Detection | Recovery |
|---|---|---|
| Container crash / restart | CF container analytics; `/healthz` failing | CF restarts automatically; check logs in CF dashboard |
| Postgres down | Every request 5xx | Neon outage; read-only mode behind flag (future) |
| R2 down | Document upload fails | Retry via worker (`documents.status='pending'`) |
| SES down / paused | `email_outbox` rows stuck in `sending` | Check SES console; rows retry on next worker tick |
| Email Worker fails | CF retries; sender gets transient SMTP error | Check Worker logs; fix and redeploy |
| Bad deploy | Errors after `wrangler deploy` / Pages build | `wrangler rollback` (Worker) or redeploy the previous Pages build; revert DNS if changed (TTL ~5 min) |

---

## 6. Code map

```
backend/
  cmd/
    server/        HTTP API + background workers (one binary, leader-elected jobs)
    mailrx/        Standalone SMTP receiver — local-dev / alternative ingest
    migrate/       SQL migrations runner
  internal/
    auth/          JWT, password, middleware
    classify/      Rule → merchant_signal → LLM classification + correction loop
    config/        env loading (.env / .env.dev / .env.main)
    db/            pgx pool + RLS helpers
    document/      upload, list, signed-URL handlers
    email/         outbound email transport (SES) + templates
    extract/       structured extraction pipeline (Gemini)
    mailout/       email_outbox store + retry worker
    mailrx/        SMTP MIME parser, recipient resolver, shared Ingester
    ocr/           Gemini OCR integration
    org/           org create/update, slug + rx_local_part management
    storage/       S3-compatible client (R2; same code worked with B2)
    ... (see full list: accounting_export, apitokens, audit, bankfeed, etc.)
  migrations/      SQL migration files (applied via cmd/migrate)
  Dockerfile       Container image for cmd/server
  docs/
    EMAIL_SENDING.md   Amazon SES setup runbook
  scripts/
    cloudflare-ses-dns.sh   Create SES SPF/DKIM/DMARC records in CF
    cloudflare-app-dns.sh   Create app/api CNAME + Email Routing records in CF
  ARCHITECTURE.md  this file
infra/
  cloudflare/
    wrangler.toml         Router Worker + Container config
    wrangler.email.toml   Email Worker config
    src/index.ts          Router Worker source
    src/email.ts          Email Worker source
docs/
  DEPLOY_CLOUDFLARE.md  Canonical Cloudflare deployment runbook
```

---

## 7. Security posture

- All DB access RLS-tenanted; app role has no `BYPASSRLS`.
- Secrets injected as Cloudflare Worker/Container secrets (`wrangler secret
  put`), never committed.
- TLS everywhere: Cloudflare terminates TLS for all external traffic.
- Inbound email: Cloudflare Email Routing validates SPF/DKIM before delivery.
  The Go handler additionally checks `X-Inbound-Secret` to reject forged POSTs,
  and the route is disabled entirely when that secret is unset.
- WhatsApp webhook verifies HMAC before any DB lookup.
- Paystack webhook verifies HMAC.
- R2 bucket is private; downloads are presigned, short-lived.
- Audit log (`audit_log`) records all mutating API requests.
- JWT secrets ≥32 chars, rotation via overlapping keys.

---

## 8. Open architecture questions

- Cloudflare Containers is in beta (2026-05): the `envVars` injection API,
  health-check config, and `instance_type` values may change. Pin the wrangler
  version and test upgrades carefully.
- Single-runner jobs on multi-instance deployments: currently controlled by
  env vars. Postgres advisory locks (already used for extraction) provide a
  stronger guarantee if env-var coordination proves error-prone.
- R2 vs B2 migration: once the Cloudflare stack is verified green, the old B2
  buckets can be set to read-only and eventually deleted.
