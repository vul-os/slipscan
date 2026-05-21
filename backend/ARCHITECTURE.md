# Slipscan Backend Architecture

Last reviewed: 2026-04-30 · Branch: `new-slip`

This document is the canonical description of how the backend is deployed, why it is shaped this way, and the contracts between components. The schema in `migrations/20260430120000_core.sql` is the data-model source of truth and is referenced throughout.

---

## 1. One-page overview

```
                          ┌─────────────────────────────────────┐
                          │   Firebase Hosting (slipscan.app)   │
                          │   sites: slipscan-main / slipscan-  │
                          │   dev — static SPA, immutable cache │
                          └───────────────┬─────────────────────┘
                                          │ HTTPS (TLS terminates at Firebase)
                                          ▼
                          ┌─────────────────────────────────────┐
                          │  Hetzner Cloud Load Balancer (LB11) │
                          │  api.slipscan.app  → :443 HTTPS     │
                          │  health check: GET /healthz         │
                          └───────────────┬─────────────────────┘
                                          │ round-robin, sticky off
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
        ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
        │     VM-1      │         │     VM-2      │   ...   │     VM-N      │
        │  Hetzner CX22 │         │  Hetzner CX22 │         │  Hetzner CX22 │
        │  Ubuntu 24.04 │         │               │         │               │
        │               │         │               │         │               │
        │ caddy :443    │         │ caddy :443    │         │ caddy :443    │
        │ slipscan-     │         │ slipscan-     │         │ slipscan-     │
        │  server :8080 │         │  server       │         │  server       │
        │ slipscan-     │         │ slipscan-     │         │ slipscan-     │
        │  mailrx :25   │         │  mailrx       │         │  mailrx       │
        │       :587    │         │               │         │               │
        │               │         │               │         │               │
        │ rDNS:         │         │ rDNS:         │         │ rDNS:         │
        │ rx1.rx.       │         │ rx2.rx.       │         │ rxN.rx.       │
        │ slipscan.app  │         │ slipscan.app  │         │ slipscan.app  │
        └──────┬────────┘         └──────┬────────┘         └──────┬────────┘
               │                          │                         │
               └──────────────┬───────────┴─────────────────────────┘
                              │
                              │  state lives only here:
                              ▼
            ┌──────────────────────────────────────────────────┐
            │   Neon Postgres (main + dev branches)            │
            │   — RLS-tenanted via app_current_organization_id │
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │   Backblaze B2 (slipscan-docs-main / -dev)       │
            │   — original docs + raw RFC822 emails            │
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │   Redis VM (cache only, Hetzner CX22)            │
            │   — private network, redis.internal.slipscan.app │
            │   — rate limit, idempotency, wallet cache, queue │
            │   — fail-open; Postgres is source of truth       │
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │   Hetzner DNS (slipscan.app authoritative)       │
            │   — managed by deploy.sh via DNS API             │
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │   External APIs                                  │
            │   — Gemini (OCR/extraction/classification)       │
            │   — Resend (outbound transactional email)        │
            │   — Paystack (billing)                           │
            │   — Meta WhatsApp Cloud API                      │
            │   — Frankfurter / openexchangerates (FX)         │
            └──────────────────────────────────────────────────┘

         Inbound mail path (NOT through LB):
         sender ──MX:rx.slipscan.app──► VM-N:25 ──► slipscan-mailrx
         (LB does not proxy SMTP — SMTP needs the real source IP for SPF/DKIM)
```

---

## 2. Compute model

### 2.1 Why Hetzner VMs, not serverless

| Concern | Hetzner combined VMs | AWS/GCP serverless |
|---|---|---|
| Cost at steady traffic | 1× | 5–10× |
| SMTP on :25 | Native | Not possible (Lambda) / SES inbound (proprietary, per-msg cost, S3+Lambda glue) |
| IP reputation control | Owned IPs, rDNS settable | Shared SES IPs |
| Cold starts | None | 100 ms–2 s, hurts chat streaming UX |
| Background workers (OCR, FX cron, learning) | Already warm | Need EventBridge + Lambda + DLQs |
| Egress cost | Hetzner: 20 TB/mo included per VM | AWS: paid per GB |
| Operational simplicity | One artifact, systemd, one deploy script | Many services, IaC sprawl |

Conclusion: combined Hetzner VMs are the cheapest *and* simplest fit for our shape (steady traffic, SMTP ingress, LLM fan-out). Serverless wins only for near-zero or wildly spiky workloads, which a finance SaaS is not.

### 2.2 Why combine API + RX on the same VMs

- **State is external** (Neon + B2). Compute is interchangeable. Splitting buys nothing while we have one role.
- **Fleet is small** (1–N VMs). At 1 VM, splitting doubles infra. At 10 VMs, splitting may make sense — see §6.
- **Both processes are mostly idle** at our scale and share resources well. SMTP bursts and HTTP bursts are uncorrelated, so they smooth each other.
- **Risk** — SMTP flood starving HTTP CPU. Mitigated by:
  - systemd `MemoryMax=512M`, `CPUQuota=50%` on `slipscan-mailrx.service`
  - Hetzner Cloud Firewall: rate-limit :25 connections per source IP
  - mailrx drops oversize / wrong-recipient at handshake (cheap)
- **Splittable later** with zero rewrite: same Go binary set, role chosen via `--role api|rx|both` (default `both`).

### 2.3 VM sizing (initial)

| VM | Hetzner type | vCPU | RAM | Disk | Monthly |
|---|---|---|---|---|---|
| Production VM-1 | CX22 | 2 | 4 GB | 40 GB | ~€4.50 |
| Dev VM-1 | CX22 | 2 | 4 GB | 40 GB | ~€4.50 |
| LB main | LB11 | — | — | — | ~€5 |
| LB dev | LB11 | — | — | — | ~€5 |

Total starting infra: **~€19/mo** plus Neon, B2, and provider fees. Scale by adding VMs (one `deploy.sh provision` call) until a single VM tops 70% sustained CPU, then split roles (§6).

---

## 3. Process layout per VM

Each VM runs three systemd units under `/etc/systemd/system/`:

### 3.1 `slipscan-server.service`
- Binary: `/usr/local/bin/slipscan-server` (built from `cmd/server`)
- Listens: `127.0.0.1:8080` (Caddy reverse-proxies `:443`)
- Reads: `/etc/slipscan/env`
- Resource caps: `MemoryMax=2G`, `CPUQuota=150%`
- Dependencies: Postgres, B2, Gemini, Resend, Paystack, WhatsApp Cloud API
- Background tasks (in-process goroutines, gated by leader-election in Postgres advisory lock so only one VM runs each):
  - FX rate sync (hourly)
  - Document extraction worker (claims `documents WHERE status='pending'`)
  - Classification worker (`transactions` without classification)
  - Recurring transaction generator
  - Daily digest sender
  - Subscription/usage settler

### 3.2 `slipscan-mailrx.service`
- Binary: `/usr/local/bin/slipscan-mailrx` (built from `cmd/mailrx`)
- Listens: `:25` and `:587` on the VM's public IP (Caddy does not touch SMTP)
- Reads: `/etc/slipscan/env`
- Resource caps: `MemoryMax=512M`, `CPUQuota=50%`
- Hot path: see §4.2

### 3.3 `caddy.service`
- TLS termination + automatic Let's Encrypt for the per-VM hostname (`api-N.slipscan.app`)
- Reverse-proxies `:443` → `127.0.0.1:8080`
- Sets `X-Forwarded-For` etc. for the API to log real client IPs
- Note: the LB also terminates TLS for `api.slipscan.app`. Caddy on the VM is for direct hits (`api-N.slipscan.app`) used by health checks and emergency direct access.

---

## 4. Hot paths

### 4.1 HTTP API request

```
client → DNS api.slipscan.app → Hetzner LB → VM:443 (caddy) → :8080 (slipscan-server)
                                                                    │
                                       JWT verify ◄─────────────────┤
                                       SET LOCAL app.organization_id│ (via app_current_organization_id())
                                       SET LOCAL app.user_id        │
                                       handler                      │
                                       Postgres (RLS enforced)      │
                                       B2 (presigned URLs)          │
                                       LLM provider                 │
                                                                    ▼
                                                                  response
```

Auth: JWT in `Authorization: Bearer`. Refresh tokens in httpOnly cookie. See `internal/auth`.

Tenant isolation: Postgres RLS using `app_current_organization_id()` set per-request via `SET LOCAL`. Connection pool returns connections to pool with `RESET ALL`. **Never** disable RLS in app code; admin tasks use a separate dedicated role.

### 4.2 Inbound email path

```
sender ──MX:rx.slipscan.app──► VM:25 (mailrx)
                                  │
                                  │ HELO / EHLO (announce hostname rx<idx>.rx.slipscan.app)
                                  │ MAIL FROM (record envelope sender)
                                  │ RCPT TO  ──► parse local-part, lookup organizations.rx_local_part
                                  │              reject 550 if no match (cheap, before DATA)
                                  │ DATA     ──► stream raw RFC822 to B2 (path: inbound/<org_id>/<msg_id>.eml)
                                  │              SPF + DKIM verify in flight
                                  ▼
                          INSERT inbound_emails (status='received', spf, dkim, raw_path)
                                  │
                                  ▼
                          parse MIME → for each attachment (PDF/img):
                                  INSERT documents (organization_id, source='email',
                                                    inbound_email_id, status='pending', sha256)
                                  upload to B2 (path: documents/<org_id>/<doc_id>.<ext>)
                                  │
                                  ▼
                          NOTIFY documents_pending  (or just rely on worker poll)
                                  │
                                  ▼
                          extraction worker on any VM picks it up (advisory lock claim)
```

Why MX directly to VMs, not through LB:
- LB doesn't proxy TCP/25 (Hetzner LBs are HTTP/HTTPS or TCP, but SMTP needs the source IP visible to the SMTP server for SPF/DKIM/reputation, and some LBs munge it).
- MX records *are* the load-balancer for mail — multiple records with priorities, senders fall through to next on failure.
- Per-VM rDNS makes deliverability work; LB IP rDNS would not help.

### 4.3 Document extraction

```
documents (status='pending')
   │  worker claims via advisory lock keyed on document_id
   ▼
ai_runs INSERT (kind='ocr', model_id, status='running')
   │
   ▼
download from B2 → Gemini OCR → raw text + structured guess
   │
   ▼
ai_runs INSERT (kind='extraction') → document_extractions
   │
   ▼
derive transactions (or bank_statements + statement_lines for statement PDFs)
   │
   ▼
classification: rule → merchant_signal → LLM
   │  writes transaction_classifications
   ▼
documents.status='extracted'
```

All ai_runs are billed via `usage_events` → `usage_charges`.

### 4.4 Right-side chat (web) and WhatsApp (parity)

```
              web                                           whatsapp
              ───                                           ────────
   user types in right-rail panel              user sends WhatsApp message
              │                                           │
              ▼                                           ▼
   POST /chats/{id}/messages              POST /webhooks/whatsapp (HMAC verified)
              │                                           │
              │                              match phone → whatsapp_sessions
              │                                           │   (status='verified')
              │                                           ▼
              │                              upsert chats (channel='whatsapp')
              │                                           │
              └─────────────────────┬───────────────────┘
                                    ▼
                       chat_messages INSERT (role='user')
                                    │
                                    ▼
                       chat orchestrator (internal/chat)
                          - load chats.metadata (summary)
                          - retrieve relevant prior msgs via embeddings
                          - call LLM with tool schema:
                              query_transactions, aggregate, get_documents,
                              categorize, create_invoice, create_bill,
                              record_manual_journal, set_budget, set_goal,
                              generate_report
                          - tools execute under RLS for the chat's org
                          - stream tokens back
                                    │
                  ┌─────────────────┼──────────────────┐
                  ▼                                    ▼
         SSE → web client            send-message → WhatsApp Cloud API
         (incremental render)        (chunk if > 4096 chars)
                  │                                    │
                  └─────────────────┬──────────────────┘
                                    ▼
                       chat_messages INSERT (role='assistant', tool calls in metadata)
                       usage_events INSERT (model, tokens, cost)
```

Both channels share orchestrator, tools, RLS, history. Inbound WhatsApp media (photo of slip) becomes a `documents` row and goes through §4.3 like any other upload.

---

## 5. Deploys

### 5.1 `backend/deploy.sh` responsibilities

The script is the *only* path that mutates infrastructure. It is idempotent and uses two Hetzner tokens (Cloud + DNS) plus the `hcloud` CLI.

Verbs:
- `provision` — create a new VM, register everything, attach to LB
- `provision --replace <vm-name>` — drain old, create replacement with `slip-<YYYYMMDD>-<index>` name
- `dns-sync` — reconcile MX priorities, A records, LB targets against current VM list
- `status` — print VMs, LB targets, DNS records, MX priorities side-by-side

### 5.2 What `provision` does, in order

1. Create Hetzner Cloud VM (`hcloud server create`) with cloud-init userdata containing:
   - install Caddy, Go binaries (downloaded from a release artifact path)
   - write `/etc/slipscan/env` (mode 0600)
   - install systemd units for `slipscan-server`, `slipscan-mailrx`, `caddy`
   - enable + start
2. Wait for VM IP, then via Hetzner DNS API:
   - `A   api-<idx>.slipscan.app        → <ip>`
   - `A   rx<idx>.rx.slipscan.app       → <ip>`
   - `MX  rx.slipscan.app  priority 10*idx  → rx<idx>.rx.slipscan.app`
3. Via Hetzner Cloud API: set rDNS on the VM IP → `rx<idx>.rx.slipscan.app` (critical for SMTP deliverability — without this most providers reject mail).
4. Attach VM to HTTP load balancer target (port 443, health check `GET /healthz`).
5. Wait for VM `:443/healthz` 200 OK.
6. (First VM only) write `SPF`, `DMARC`, `DKIM` TXT records on the apex zone.

### 5.3 What `--replace` does

1. Find LB targets and matching VMs.
2. For the named VM, mark it draining: deregister from LB, set MX priority to a high number so new mail prefers other VMs.
3. Provision a new VM with the next `slip-<YYYYMMDD>-<index>` name (index increments if multiple replacements occur the same day).
4. Wait for the new VM's healthcheck to be green.
5. Wait MX TTL + buffer (typically 5 min).
6. Stop services on old VM, snapshot if requested, destroy.
7. Delete old DNS records.

### 5.4 Failure modes & recovery

| Failure | Detection | Recovery |
|---|---|---|
| VM dies | LB health check fails | LB drops it from rotation; DNS MX still points there → mail to that VM fails-over to next priority. Run `deploy.sh provision --replace`. |
| Mailrx misbehaves | systemd restart; alert if restart count > N/hour | Investigate logs, redeploy binary |
| Postgres down | Every request 5xx | This is a Neon outage. Read-only mode behind a flag (future work). |
| B2 down | Document upload fails | Queue uploads in `documents.metadata.pending_upload=true`, retry via worker |
| LLM down | Extraction fails, marks `ai_runs.status='failed'` | Worker retries with backoff; document stuck `pending` → user-visible "still processing" |
| Redis down | Cache miss on every hot path | **Fail-open**: rate limiter allows, idempotency degrades to best-effort, wallet cache falls back to Postgres. `redis_unavailable` metric fires. No customer-visible 5xx. |
| DNS API failure mid-deploy | `deploy.sh status` shows partial state | Re-run `dns-sync` |

---

## 5.5 Redis (cache layer)

Single Redis VM per environment, sitting on the Hetzner private network alongside the API/RX VMs. Provisioned via `deploy.sh --role redis`. Cache only — never source of truth.

**What it does:**
- API rate limiting (token bucket per `api_tokens.id`, enforces `rate_limit_per_minute`)
- Idempotency keys for the public API (`SET NX EX 86400`)
- Wallet/quota hot-path cache (`billing_wallets.balance_cents` with 30s TTL, atomic `DECRBY` for chat reservations)
- Outbound webhook delivery queue (Asynq — retry/backoff/dead-letter)
- WhatsApp/SMS outbound throttle (Meta rate limit compliance)
- Chat tool-call result cache (short TTL on `(org, tool, args)` tuples)
- WhatsApp inbound webhook dedup (`SET NX` on `message_id`)

**What it does NOT do:**
- Distributed locks → `pg_advisory_lock`
- Document/extraction job queue → `documents.status='pending'` + `FOR UPDATE SKIP LOCKED`
- Sessions → JWT
- Anything that must survive a Redis flush — Postgres only

**Why self-hosted, not Upstash:**
- Latency: ~0.5 ms on the private network vs. 5–30 ms to Upstash. Hits every API request.
- Cost: ~€4.50/mo flat vs. Upstash pay-as-you-go ~$50–500/mo at our expected throughput.
- We already have a VM cluster + `deploy.sh`; adding `--role redis` is a cloud-init template.
- Upstash's HTTP API exists for serverless; we're not serverless.

**Engine**: Redis 7+ (or Valkey for license clarity, or Dragonfly for memory pressure). All Redis-protocol-compatible drop-ins.

**Persistence**: AOF `everysec` + daily RDB snapshot. Loss of <1s of cache data on crash is fine — nothing durable lives here.

**HA**: single node to start. Add replica + Sentinel only when "30 seconds of cache rewarming after a restart" becomes unacceptable. At our scale that's Phase 4+.

**Bind**: private IP only, `requirepass` for auth, Hetzner Cloud Firewall ingress 6379 restricted to API/RX VM tag.

---

## 6. When to split roles

Today: every VM is `--role both`. Triggers to split:

1. **SMTP CPU > 30% sustained** while HTTP CPU is also high → split into `--role api` and `--role rx` fleets.
2. **IP reputation issues** affecting deliverability → dedicated `rx` IPs, possibly with warm-up.
3. **Compliance** wanting mail data isolated from web traffic.
4. **>10 VMs** — operational gain from separating LB-attached vs MX-attached pools.

Mechanic when the time comes:
- Pass `--role api` to `deploy.sh provision` for HTTP-only VMs (added to LB, no MX, no rDNS for mail).
- Pass `--role rx` for SMTP-only VMs (no LB attachment, has MX + rDNS, runs only `slipscan-mailrx`).
- Existing `--role both` VMs phased out via `--replace`.

The Go binary already ignores irrelevant subsystems based on the flag — splitting is config, not code.

---

## 7. Code map

```
backend/
  cmd/
    server/        HTTP API + background workers (one binary, leader-elected jobs)
    mailrx/        SMTP receiver (to be built)
    migrate/       SQL migrations runner
    preview-email/ HTML email preview server for design iteration
    insights-test/ scratchpad for chat/insights tooling
  internal/
    auth/          JWT, password, middleware
    config/        env loading (.env / .env.dev / .env.main)
    db/            pgx pool + RLS helpers
    document/      upload, list, signed-URL handlers
    email/         outbound email + templates (Resend)
    httpx/         JSON, middleware, request id, error mapping
    insights/      query/run/summary for the chat assistant
    invite/        org invitations
    ocr/           Gemini integration
    org/           org create/update, slug + rx_local_part management
    storage/       B2 client wrapper
  migrations/
    20260430120000_core.sql   single source of truth for the schema
  deploy.sh        Hetzner provision/replace/dns-sync/status (to be built)
  ARCHITECTURE.md  this file
```

Future packages to add:
- `internal/mailrx` — SMTP server, MIME parser, recipient resolver
- `internal/chat` — chat orchestrator, tool dispatch, streaming
- `internal/whatsapp` — webhook verifier, send-message client, session management
- `internal/classify` — rules → merchant_signal → LLM ladder + correction-driven learning
- `internal/fx` — provider client + cron
- `internal/billing` — Paystack webhook + wallet/usage settlement
- `internal/report` — P&L, BS, TB, AR/AP, vault22-style breakdowns
- `internal/ledger` — transaction → ledger_entries projection, manual journals

---

## 8. Security posture (summary)

- All DB access RLS-tenanted; app role has no `BYPASSRLS`.
- Secrets only in `/etc/slipscan/env` (mode 0600), never committed.
- TLS everywhere external (Caddy + LB).
- SMTP rejects unknown recipients before DATA (cheap DoS resistance).
- WhatsApp webhook verifies HMAC before any DB lookup.
- Paystack webhook verifies HMAC.
- B2 bucket is private; downloads are presigned, short-lived.
- Audit log (`audit_log`) records all mutating API requests.
- JWT secrets ≥32 chars, rotation via overlapping keys.
- SSH locked to admin IPs in Hetzner Cloud Firewall.

---

## 9. Open architecture questions

- Caddy on each VM vs Caddy only behind LB? Currently both — refine after first deploy.
- Use Postgres `LISTEN/NOTIFY` for worker wakeups vs polling? Polling for now (Neon serverless quirks); revisit if latency matters.
- Single Go binary with `--role` flag vs separate binaries per role? Current plan: separate `server` and `mailrx` binaries (clearer boundaries), shared `internal/` packages.
- Embeddings store: Postgres `pgvector` (Neon supports) vs external? Default to pgvector; revisit if scale requires.
