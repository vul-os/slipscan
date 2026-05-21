# slip/scan Deploy Runbook

This runbook covers the exact commands to run locally, migrate dev/main,
build the frontend, and deploy to Firebase Hosting.

---

## 1. Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Go | ≥ 1.22 | `brew install go` or https://go.dev/dl |
| Node.js | ≥ 20 | `brew install node` |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| `psql` or `pgx` | for manual DB checks | optional |

---

## 2. Secrets you must supply

Create `.env`, `.env.dev`, and `.env.main` at the repo root (gitignored).
Copy `.env.example` as a template. Fill in every value below.

### 2a. Neon database connection strings

Neon provides two URLs per project: **direct** (for migrations) and **pooled**
(for the runtime server). Use the **direct** URL in `DATABASE_URL` for
migrations; you can use either for the server, but pooled is preferred.

| Var | env file | Where to get it |
|-----|----------|-----------------|
| `DATABASE_URL` | `.env` | Local Postgres — e.g. `postgres:///slipscan?sslmode=disable` |
| `DATABASE_URL` | `.env.dev` | Neon dev project → Connection Details → **Direct** string |
| `DATABASE_URL` | `.env.main` | Neon prod project → Connection Details → **Direct** string |

### 2b. JWT secrets

Generate a separate secret for each environment:

```sh
openssl rand -hex 32   # run once for dev, once for main
```

Put the result in `JWT_SECRET` in the appropriate env file.

### 2c. Backblaze B2

Create one bucket per environment (`slipscan-receipts-dev`, `slipscan-receipts-main`).
Create a bucket-scoped (non-master) application key for each.

| Var | Source |
|-----|--------|
| `B2_KEY_ID` | Backblaze → App Keys → Key ID |
| `B2_APPLICATION_KEY` | Backblaze → App Keys → Application Key |
| `B2_BUCKET` | Bucket name |
| `B2_REGION` | Bucket region (e.g. `us-east-005`) |
| `B2_ENDPOINT` | `https://s3.<region>.backblazeb2.com` |

### 2d. Google Gemini

| Var | Source |
|-----|--------|
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |

### 2e. Resend (email)

| Var | Source |
|-----|--------|
| `RESEND_API_KEY` | https://resend.com → API Keys |
| `RESEND_FROM` | Verified sender, e.g. `slip/scan <noreply@slipscan.app>` |

### 2f. Exchange rates

| Var | Source |
|-----|--------|
| `EXCHANGE_RATE_API_KEY` | https://www.exchangerate-api.com → Dashboard |
| `EXCHANGE_RATE_BASE` | Base currency, e.g. `USD` |

### 2g. URLs (per-environment)

Set these in each env file to match the deployed backend URL and Firebase
Hosting site URL:

```
# .env.dev
APP_BASE_URL=https://dev-api.slipscan.app
FRONTEND_BASE_URL=https://slipscan-staging.web.app
CORS_ALLOWED_ORIGINS=https://slipscan-staging.web.app,http://localhost:5173
VITE_API_URL=https://dev-api.slipscan.app

# .env.main
APP_BASE_URL=https://api.slipscan.app
FRONTEND_BASE_URL=https://slipscan-main.web.app
CORS_ALLOWED_ORIGINS=https://slipscan-main.web.app
VITE_API_URL=https://api.slipscan.app
```

---

## 3. Local development

```sh
# 1. Start local Postgres (adjust for your setup)
createdb slipscan

# 2. Copy the template and fill in DATABASE_URL (local Postgres), JWT_SECRET,
#    and any third-party keys you need for local testing.
cp .env.example .env
$EDITOR .env

# 3. Run all migrations against local DB
cd backend
go run ./cmd/migrate

# 4. Start the backend server
go run ./cmd/server
# → listening on :8080

# 5. In another terminal, start the Vite dev server
cd ..
npm install
npm run dev
# → http://localhost:5173
```

---

## 4. Database migrations

The migrate tool reads `DATABASE_URL` from the env file for the selected
environment and applies any pending `.sql` files in `backend/migrations/`
in lexicographic order. It is idempotent: already-applied files are skipped.

```sh
cd backend

# Apply pending migrations to local DB
go run ./cmd/migrate

# Apply to dev (reads .env.dev)
go run ./cmd/migrate --env=dev

# Apply to prod (reads .env.main)
go run ./cmd/migrate --env=main

# Show migration status (local)
go run ./cmd/migrate --status

# Show migration status (dev)
go run ./cmd/migrate --env=dev --status

# Reset local DB and re-run all migrations (DESTRUCTIVE — local only)
go run ./cmd/migrate --reset

# Explicit env file path (overrides --env lookup)
go run ./cmd/migrate --env-file=/path/to/custom.env
```

> **Safety:** `--reset` with `--env=main` is blocked. To run a destructive
> operation on production you must pass `--env-file` explicitly.

---

## 5. Frontend builds

```sh
npm install        # first time only

# Build for dev (outputs to dist-dev/, embeds VITE_API_URL from .env.dev)
npm run build:dev

# Build for main (outputs to dist-main/, embeds VITE_API_URL from .env.main)
npm run build:main
```

Vite reads `VITE_*` variables from `.env.<mode>` where `<mode>` is `dev` or
`main`. The value is baked into the JS bundle at build time.

---

## 6. Firebase Hosting deploy

### One-time setup

```sh
# Install Firebase CLI
npm install -g firebase-tools

# Authenticate
firebase login

# Or use a CI token (see §7 below)
firebase login:ci
```

The Firebase project `slip-scan-co` has two hosting targets:
- `dev` → `slipscan-staging` (served from `dist-dev/`)
- `main` → `slipscan-main` (served from `dist-main/`)

These are configured in `.firebaserc` and `firebase.json`.

### Deploy

```sh
# Deploy dev (build + upload dist-dev/ to slipscan-staging)
npm run deploy:dev

# Deploy main (build + upload dist-main/ to slipscan-main)
npm run deploy:main

# Deploy without rebuilding (if you've already run the build)
firebase deploy --only hosting:dev
firebase deploy --only hosting:main
```

---

## 7. Firebase CI token (for automated deploys)

```sh
# Generate a long-lived CI token
firebase login:ci
# Copy the printed token.

# Store it as FIREBASE_TOKEN in your CI secret store.
# Use it like:
firebase deploy --only hosting:dev --token "$FIREBASE_TOKEN"
```

---

## 8. Backend server deploy (Hetzner — see P0-02)

The backend binary is built and deployed to Hetzner VMs. This is covered in
the P0-02 task. The short version:

```sh
cd backend
go build -o bin/server ./cmd/server
# SCP / rsync bin/server to the target VM.
# The VM reads DATABASE_URL and other vars from its process environment
# (not from a .env file — those are local only).
```

---

## 9. Full env-file reference

See `.env.example` at the repo root for every supported variable with inline
documentation.

```
DATABASE_URL          — Postgres connection string (Neon for dev/main)
JWT_SECRET            — ≥32-char random secret (generate per env)
JWT_ACCESS_TTL        — Access token lifetime (default: 15m)
JWT_REFRESH_TTL       — Refresh token lifetime (default: 168h)
INVITATION_TTL        — Org invitation lifetime (default: 168h)
PORT                  — HTTP listen port (default: 8080)
APP_BASE_URL          — Backend public URL
FRONTEND_BASE_URL     — Frontend public URL (for email links)
CORS_ALLOWED_ORIGINS  — Comma-separated CORS origins
VITE_API_URL          — Backend URL baked into the frontend bundle
B2_KEY_ID             — Backblaze B2 key ID
B2_APPLICATION_KEY    — Backblaze B2 application key
B2_BUCKET             — Backblaze B2 bucket name
B2_REGION             — B2 region (e.g. us-east-005)
B2_ENDPOINT           — B2 S3-compatible endpoint URL
GEMINI_API_KEY        — Google Gemini API key (OCR)
RESEND_API_KEY        — Resend email API key
RESEND_FROM           — From address for transactional email
RX_DOMAIN             — SMTP-receive subdomain (P0-01 mailrx)
EXCHANGE_RATE_API_KEY — exchangerate-api.com API key
EXCHANGE_RATE_BASE    — Base currency for FX rates (e.g. USD)
```
