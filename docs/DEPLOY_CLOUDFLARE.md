# slip/scan — Cloudflare Deployment Runbook

Last updated: 2026-05-27

This is the canonical deployment runbook for the Cloudflare-hosted stack.
The Hetzner VM / Firebase Hosting design described in `backend/DEPLOY.md` and
`backend/ARCHITECTURE.md` (legacy sections) remains as a rollback path until
the new stack is verified green end-to-end.

---

## 1. Target Architecture

```
Users
  │
  ├─ HTTPS ─► app.slipscan.app (Cloudflare Pages)
  │               Static SPA (Vite build)
  │               VITE_API_URL=https://api.slipscan.app
  │               VITE_RX_DOMAIN=mail.slipscan.app
  │
  ├─ HTTPS ─► api.slipscan.app/* (Cloudflare Worker — Router)
  │               infra/cloudflare/src/index.ts
  │               │
  │               └─► GoBackend Durable Object
  │                       │
  │                   Cloudflare Container
  │                   (Go monolith, $PORT=8080)
  │                   GET /healthz → 200
  │
  └─ SMTP  ─► *@mail.slipscan.app (Cloudflare Email Routing)
                  │
              Email Worker (slipscan-email-ingest)
              infra/cloudflare/src/email.ts
                  │
              POST /internal/inbound-email?recipient=<to>
              Header: X-Inbound-Secret: <secret>
                  │
              Go monolith (via api.slipscan.app)

Outbound email:
  Go monolith ──► email_outbox (Neon) ──► Email retry worker
                                              │
                                          Amazon SES v2 HTTPS API
                                              │
                                          Recipient inbox

Storage:
  Go monolith ──► Cloudflare R2 (S3-compatible)
  (same storage.Client code; only STORAGE_* env vars change)

Database:
  Go monolith ──► Neon Postgres (main + dev branches, RLS-tenanted)
```

---

## 2. Prerequisites

### 2.1 Cloudflare account

- Zone `slipscan.app` on Cloudflare with nameservers pointed to Cloudflare.
- Cloudflare account ID (visible in the dashboard sidebar).
- API token with **Zone:Edit DNS** and **Workers:Edit** permissions, or use
  `wrangler login` for interactive auth.

### 2.2 Wrangler

```bash
cd infra/cloudflare
npm install          # installs wrangler as a dev-dependency
npx wrangler login   # or: export CLOUDFLARE_API_TOKEN=<token>
```

Wrangler v4+ is required (pinned in `infra/cloudflare/package.json`).

### 2.3 Neon project and branches

- Production branch: `main` — connection string in `DATABASE_URL`.
- Dev/staging branch: `dev` — separate `DATABASE_URL`.
- Run migrations against both branches before deploy:
  ```bash
  cd backend
  DATABASE_URL=<neon-main-url> go run ./cmd/migrate
  DATABASE_URL=<neon-dev-url>  go run ./cmd/migrate
  ```

### 2.4 Cloudflare R2 buckets

Create two R2 buckets (one per environment) in the Cloudflare dashboard:

| Environment | Bucket name          |
|-------------|----------------------|
| Production  | `slipscan-docs-main` |
| Dev/staging | `slipscan-docs-dev`  |

Generate an R2 API token with **Object Read & Write** scope.  This token
yields `STORAGE_KEY_ID` and `STORAGE_SECRET`.

### 2.5 Amazon SES (outbound email)

Follow `backend/docs/EMAIL_SENDING.md` in full.  Key outputs needed here:

- SES verified identity for `mail.slipscan.app`
- IAM key pair (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Configuration set name (`SES_CONFIGURATION_SET`)
- DNS records added via `backend/scripts/cloudflare-ses-dns.sh`

---

## 3. Secret / Environment Variable Inventory

Single source of truth.  All secrets are injected at runtime — nothing is
committed to the repository.

### 3.1 Go container secrets (Router Worker / Container)

Set with: `wrangler secret put <NAME> --config infra/cloudflare/wrangler.toml`

| Variable | Example / Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `JWT_SECRET` | ≥32 chars; `openssl rand -hex 32` |
| `JWT_ACCESS_TTL` | `15m` (optional, defaults to 15m) |
| `JWT_REFRESH_TTL` | `168h` (optional, defaults to 7d) |
| `INVITATION_TTL` | `168h` (optional, defaults to 7d) |
| `GEMINI_API_KEY` | Google AI Studio key |
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | SES IAM key |
| `AWS_SECRET_ACCESS_KEY` | SES IAM secret |
| `EMAIL_FROM` | `slip/scan <noreply@mail.slipscan.app>` |
| `SES_CONFIGURATION_SET` | `slipscan-transactional` |
| `EMAIL_WORKER_ENABLED` | `true` on exactly one container instance |
| `INBOUND_INGEST_SECRET` | Shared with Email Worker; `openssl rand -hex 32` |
| `STORAGE_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `STORAGE_KEY_ID` | R2 API key ID (was `B2_KEY_ID`) |
| `STORAGE_SECRET` | R2 API secret (was `B2_APPLICATION_KEY`) |
| `STORAGE_BUCKET` | `slipscan-docs-main` or `slipscan-docs-dev` |
| `STORAGE_REGION` | `auto` (R2 does not use AWS regions) |
| `APP_BASE_URL` | `https://api.slipscan.app` |
| `FRONTEND_BASE_URL` | `https://app.slipscan.app` |
| `CORS_ALLOWED_ORIGINS` | `https://app.slipscan.app` |
| `RX_DOMAIN` | `mail.slipscan.app` |

> **Note on storage env var names:** The Go binary reads `B2_KEY_ID`,
> `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_REGION`, `B2_ENDPOINT` from
> `config.go`. When targeting R2, set these to the R2 values — the storage
> client is S3-compatible and requires no code change.  Future cleanup may
> rename these to `STORAGE_*`; until then use the `B2_*` names.

Optional feature-gating variables (set on exactly one instance per pattern):

| Variable | Notes |
|---|---|
| `FX_SYNC_ENABLED` | `true` on one instance only |
| `SIGNALS_AGG_ENABLED` | `true` on one instance only |
| `BANKFEED_SYNC_ENABLED` | `true` on one instance only |
| `STITCH_CLIENT_ID` | Stitch bank-feed OAuth |
| `STITCH_CLIENT_SECRET` | Stitch bank-feed OAuth |
| `STITCH_REDIRECT_URL` | Stitch bank-feed callback URL |
| `STITCH_WEBHOOK_SECRET` | Stitch webhook HMAC |
| `XERO_CLIENT_ID` | Xero integration OAuth |
| `XERO_CLIENT_SECRET` | Xero integration OAuth |
| `XERO_REDIRECT_URL` | Xero callback URL |

### 3.2 Email Worker secrets

Set with: `wrangler secret put <NAME> --config infra/cloudflare/wrangler.email.toml`

| Variable | Notes |
|---|---|
| `INBOUND_INGEST_SECRET` | Must match the value set on the container |
| `INGEST_BASE_URL` | `https://api.slipscan.app` (already in `[vars]`) |

### 3.3 Cloudflare Pages build variables

Set in the Cloudflare dashboard → Pages project → Settings → Environment variables.

| Variable | Production | Dev/staging |
|---|---|---|
| `VITE_API_URL` | `https://api.slipscan.app` | `https://api.slipscan.app` |
| `VITE_RX_DOMAIN` | `mail.slipscan.app` | `mail.slipscan.app` |

---

## 4. Deploy Steps

### 4.1 Build and deploy the Router Worker + Container

```bash
cd infra/cloudflare

# Set secrets on the production Worker
wrangler secret put DATABASE_URL
wrangler secret put JWT_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put AWS_REGION
wrangler secret put EMAIL_FROM
wrangler secret put SES_CONFIGURATION_SET
wrangler secret put EMAIL_WORKER_ENABLED
wrangler secret put INBOUND_INGEST_SECRET
wrangler secret put B2_KEY_ID          # R2 key ID
wrangler secret put B2_APPLICATION_KEY  # R2 secret
wrangler secret put B2_BUCKET
wrangler secret put B2_REGION          # "auto"
wrangler secret put B2_ENDPOINT        # R2 endpoint URL
wrangler secret put APP_BASE_URL
wrangler secret put FRONTEND_BASE_URL
wrangler secret put CORS_ALLOWED_ORIGINS
wrangler secret put RX_DOMAIN

# Deploy (builds the Dockerfile from backend/ and uploads container image)
npm run deploy
# or:
npx wrangler deploy --config infra/cloudflare/wrangler.toml
```

The first deploy creates the Durable Object migration and uploads the container
image. Verify health:

```bash
curl -I https://api.slipscan.app/healthz
# Expected: HTTP/2 200
```

### 4.2 Deploy the Email Worker

```bash
cd infra/cloudflare

# Set secrets for the email worker
wrangler secret put INBOUND_INGEST_SECRET \
  --config infra/cloudflare/wrangler.email.toml
# INGEST_BASE_URL is already set in wrangler.email.toml [vars]; override if needed.

npm run deploy:email
# or:
npx wrangler deploy --config infra/cloudflare/wrangler.email.toml
```

### 4.3 Enable Email Routing

In the Cloudflare dashboard:

1. Navigate to your account → **Email** → **Email Routing**.
2. Select the `mail.slipscan.app` zone (or `slipscan.app` if routing at apex).
3. Enable Email Routing — Cloudflare automatically adds the required MX records.
4. Under **Routing rules** → **Catch-all address**:
   - Action: **Send to a Worker**
   - Worker: `slipscan-email-ingest`
5. Verify the catch-all rule is active (green dot).

The DNS records Cloudflare adds automatically for Email Routing are:

| Type | Name | Value | Notes |
|---|---|---|---|
| MX | `mail.slipscan.app` | `route1.mx.cloudflare.net` | Priority 82 |
| MX | `mail.slipscan.app` | `route2.mx.cloudflare.net` | Priority 37 |
| MX | `mail.slipscan.app` | `route3.mx.cloudflare.net` | Priority 14 |
| TXT | `mail.slipscan.app` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | CF Email Routing ownership |

> These MX records are on `mail.slipscan.app` (inbound routing).  The SES
> MAIL FROM MX record lives on `bounce.mail.slipscan.app` — no conflict.

### 4.4 Deploy Cloudflare Pages

#### Production (main branch → `app.slipscan.app`)

1. In the Cloudflare dashboard → **Pages** → **Create a project**.
2. Connect to the git repository; set:
   - **Production branch:** `main`
   - **Build command:** `npm run build:main` (or `vite build --mode main`)
   - **Build output directory:** `dist-main`
3. Add environment variables (see §3.3).
4. Add custom domain: `app.slipscan.app` (or apex `slipscan.app`).
5. Deploy.

#### Dev/staging (dev branch → staging URL)

1. Add a **preview deployment** or a second Pages project.
2. Branch: `dev` (or `new-slip` during migration).
3. Custom domain: `staging.slipscan.app` (optional).
4. Same build settings, same env vars (pointed at dev Neon branch and
   `slipscan-docs-dev` R2 bucket).

---

## 5. R2 Data Migration from Backblaze B2

The storage client (`backend/internal/storage/storage.go`) is S3-compatible
and requires no code changes — only the `B2_*` environment variables change to
point at R2.

### 5.1 rclone setup

Install rclone (v1.65+):

```bash
# macOS
brew install rclone

# Linux
curl https://rclone.org/install.sh | sudo bash
```

Configure two remotes — one for B2 and one for R2:

```ini
# ~/.config/rclone/rclone.conf

[b2]
type = b2
account = <B2_ACCOUNT_ID>
key = <B2_MASTER_OR_BUCKET_KEY>

[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_KEY_ID>
secret_access_key = <R2_SECRET>
endpoint = https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
```

### 5.2 Sync commands

Run a dry run first, then the live sync:

```bash
# Dry run — no data transferred
rclone sync b2:slipscan-docs-main r2:slipscan-docs-main \
  --dry-run \
  --progress \
  --transfers 16

# Live sync
rclone sync b2:slipscan-docs-main r2:slipscan-docs-main \
  --progress \
  --transfers 16 \
  --checksum

# Dev bucket
rclone sync b2:slipscan-docs-dev r2:slipscan-docs-dev \
  --progress \
  --transfers 16 \
  --checksum
```

The `--checksum` flag computes MD5/SHA1 checksums for verification rather than
relying on size+mtime only.

### 5.3 Verification

```bash
# Object count comparison
B2_COUNT=$(rclone size b2:slipscan-docs-main --json | jq '.count')
R2_COUNT=$(rclone size r2:slipscan-docs-main --json | jq '.count')
echo "B2: ${B2_COUNT}  R2: ${R2_COUNT}"
# Both counts must match.

# Checksum spot-check (10 random objects)
rclone check b2:slipscan-docs-main r2:slipscan-docs-main \
  --one-way \
  --max-backlog 1000 2>&1 | tail -20
# Expected: "0 differences found"
```

### 5.4 Cutover

The migration is zero-downtime because reads/writes go to B2 until the env
vars are updated:

1. Complete the `rclone sync` (may take minutes to hours depending on volume).
2. Set the container secrets to the R2 values:
   ```bash
   wrangler secret put B2_ENDPOINT  # https://<accountid>.r2.cloudflarestorage.com
   wrangler secret put B2_KEY_ID    # R2 key
   wrangler secret put B2_APPLICATION_KEY  # R2 secret
   wrangler secret put B2_BUCKET    # slipscan-docs-main
   wrangler secret put B2_REGION    # auto
   ```
3. Trigger a container restart (redeploy the Worker) so the new env takes effect.
4. Upload a test document through the app; confirm it appears in R2.
5. After 48 hours of clean operation, disable the B2 bucket (read-only or delete).

---

## 6. DNS Records

All records are on the `slipscan.app` zone in Cloudflare.

### 6.1 Application records

| Type | Name | Value | Proxy | Notes |
|---|---|---|---|---|
| CNAME | `app` | `<pages-project>.pages.dev` | Proxied | Pages custom domain |
| CNAME | `api` | `slipscan-api.workers.dev` | Proxied | Worker custom domain (set automatically by `wrangler deploy`) |

> `api.slipscan.app` is registered as a custom domain in `wrangler.toml`
> (`routes = [{pattern = "api.slipscan.app/*", custom_domain = true}]`).
> Wrangler creates the DNS record automatically on first deploy.

### 6.2 Email Routing (inbound — Cloudflare-managed)

Cloudflare adds these automatically when Email Routing is enabled:

| Type | Name | Value | Proxy | Notes |
|---|---|---|---|---|
| MX | `mail` | `route1.mx.cloudflare.net` | DNS only | Priority 82 |
| MX | `mail` | `route2.mx.cloudflare.net` | DNS only | Priority 37 |
| MX | `mail` | `route3.mx.cloudflare.net` | DNS only | Priority 14 |
| TXT | `mail` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | DNS only | CF ownership proof |

### 6.3 SES sending records (outbound — created by script)

See `backend/docs/EMAIL_SENDING.md` §3 for the full table.
Run `backend/scripts/cloudflare-ses-dns.sh` to create them:

| Type | Name | Value | Proxy |
|---|---|---|---|
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` | DNS only |
| TXT | `_dmarc.mail` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@slipscan.app; fo=1` | DNS only |
| MX | `bounce.mail` | `feedback-smtp.us-east-1.amazonses.com` (pri 10) | DNS only |
| TXT | `bounce.mail` | `v=spf1 include:amazonses.com ~all` | DNS only |
| CNAME | `<token1>._domainkey.mail` | `<token1>.dkim.amazonses.com` | DNS only |
| CNAME | `<token2>._domainkey.mail` | `<token2>.dkim.amazonses.com` | DNS only |
| CNAME | `<token3>._domainkey.mail` | `<token3>.dkim.amazonses.com` | DNS only |

> Run `backend/scripts/cloudflare-app-dns.sh` (§7 below) to create the
> application and Email Routing records, and `cloudflare-ses-dns.sh` for the
> SES sending records.

---

## 7. Cutover Order and Rollback

### 7.1 Cutover phases

**Phase 1 — Dev/staging (do this first)**

1. Provision dev R2 bucket; sync B2 dev → R2 dev.
2. Deploy container Worker to a dev route (or use `wrangler dev --remote`).
3. Deploy Email Worker.
4. Deploy Pages to a staging URL.
5. Enable Email Routing on a test address.
6. Run through the full user journey: register → invite → upload receipt →
   verify OCR/classification → send test email → receive inbound email.
7. Check `GET /healthz` and all key API endpoints.

**Phase 2 — Production flip**

1. Complete prod R2 sync (`rclone sync b2:... r2:... --checksum`).
2. Run migrations against the Neon `main` branch.
3. Deploy prod Worker + Container with prod secrets.
4. Deploy prod Email Worker.
5. Deploy Pages to `app.slipscan.app` / apex.
6. `backend/scripts/cloudflare-app-dns.sh` — apply DNS records.
7. Enable Email Routing catch-all on `mail.slipscan.app`.
8. Smoke-test: upload a document, verify processing, send an invite email,
   forward a receipt to `<slug>@mail.slipscan.app`.

**Phase 3 — Verify green (keep old stack warm)**

- Leave the Hetzner VM fleet running and Firebase Hosting live for at least
  48 hours after the DNS switch.
- Monitor: Cloudflare Container analytics, SES bounce rate, Neon query volume.

### 7.2 Rollback

To revert to the Hetzner + Firebase stack at any point:

1. **DNS:** Change `api.slipscan.app` CNAME from the Worker route back to the
   Hetzner LB IP (A record). TTL is 5 minutes (auto by Cloudflare for proxied
   records — effective immediately once proxied).
2. **MX:** Remove the Cloudflare Email Routing MX records; restore the Hetzner
   VM MX records pointing to `rx.slipscan.app` A records.
3. **Pages:** Re-activate Firebase Hosting via `firebase deploy` (targets
   `slipscan-main` and `slipscan-staging` — see `firebase.json`).
4. **Data:** Any documents uploaded to R2 during the CF window need to be
   synced back to B2 (`rclone sync r2:... b2:...`).

The Hetzner fleet (`backend/deploy.sh`) and Firebase Hosting config
(`firebase.json`, `.firebaserc`) are **legacy — kept for rollback only**.
Do not use them as the active deployment path.

---

## 8. Legacy Files (for rollback only)

| File | Status | Purpose |
|---|---|---|
| `firebase.json` | Legacy | Firebase Hosting multi-site config (rollback) |
| `.firebaserc` | Legacy | Firebase project + target aliases (rollback) |
| `backend/deploy.sh` | Legacy | Hetzner VM provisioning (rollback) |
| `backend/DEPLOY.md` | Legacy | Hetzner deploy runbook (rollback) |
| `.github/workflows/firebase-hosting-merge.yml` | Legacy | CI deploy to Firebase (disabled) |

---

## 9. Operational Notes

### Container cold starts

The Go container sleeps after 10 minutes of inactivity (`sleepAfter = "10m"`
in `wrangler.toml`). Cold starts typically take 3–8 seconds (container boot +
DB pool init). The `/healthz` ping endpoint gates container readiness — CF
holds the first request until the container is healthy.

To reduce cold-start impact for production, consider increasing `sleepAfter`
or pre-warming via a Cloudflare Cron Trigger that hits `/healthz` every 5
minutes.

### Single-runner jobs

The following background jobs must run on exactly one container instance.
Set the controlling env var to `true` on the primary instance and `false`
(or unset) on others:

| Job | Env var | Default interval |
|---|---|---|
| Email outbox delivery | `EMAIL_WORKER_ENABLED` | 5 s |
| FX rate sync | `FX_SYNC_ENABLED` | 1 h |
| Merchant signal aggregation | `SIGNALS_AGG_ENABLED` | 24 h |
| Bank-feed sync | `BANKFEED_SYNC_ENABLED` | 4 h |

In the Cloudflare Container model with `max_instances = 5`, there is no
built-in leader election. The same pattern applies: set the env var on one
specific named instance, or use Postgres advisory locks (already implemented
in the codebase) for coordination.

### Monitoring

- **Container health:** Cloudflare dashboard → Workers & Pages → `slipscan-api`
  → Real-time logs.
- **Email delivery:** AWS SES console → Sending statistics, CloudWatch alarms
  (see `backend/docs/EMAIL_SENDING.md` §7.2).
- **Database:** Neon console → Branches → Metrics.
- **Storage:** Cloudflare dashboard → R2 → Bucket → Metrics.
