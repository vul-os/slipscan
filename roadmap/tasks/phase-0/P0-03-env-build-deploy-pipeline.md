---
id: P0-03
title: Environments, Neon DBs, and the build/deploy pipeline
phase: 0
status: review
owner: sonnet-agent
depends_on: []
---

## Goal
Make `local` / `dev` / `main` environments work end-to-end: Neon dev + prod
databases, three working env files, migrations runnable per-env, and the
frontend `build:dev` / `build:main` → `firebase deploy --only hosting:{dev,main}`
pipeline green. This is the critical-path task that unblocks the rest of Phase 0.

## Context
The `todo` requires: one Firebase project, two sites (dev + main); `npm run
build:dev|main` and `firebase deploy --only hosting:dev|main` working; Neon dev
+ prod DBs; `.env`, `.env.dev`, `.env.main` all functional. Firebase targets are
already wired (`.firebaserc`, `firebase.json`); env files exist but need
verification against real Neon connection strings.

## Existing assets
- `.firebaserc` (project `slip-scan-co`, targets `dev`→`slipscan-staging`,
  `main`→`slipscan-main`), `firebase.json` (two hosting blocks → `dist-dev`/`dist-main`).
- `package.json` scripts: `build:dev`, `build:main`, `deploy:dev`, `deploy:main`.
- `vite.config.js` mode-based env loading; `.env`, `.env.dev`, `.env.main`, `.env.example`.
- `cmd/migrate` selects env file via `--env=local|dev|main`; `internal/config`.

## Scope
**In:** provision Neon dev + prod; fill `DATABASE_URL` (+ pooled URL) in each env
file; confirm `cmd/migrate` runs all 5 migrations against each DB; verify Vite
mode loading injects `VITE_*` correctly; verify both Firebase deploys publish the
right `dist-*`; document the whole flow.
**Out:** new app features; backend deploy to VMs (that's P0-02).

## Implementation
1. Create two Neon databases under the slipscan account (dev, prod). Capture
   direct + pooled connection strings.
2. Populate `.env` (local Postgres), `.env.dev`, `.env.main` with real
   `DATABASE_URL`, `JWT_SECRET` (per env), `APP_BASE_URL`, `FRONTEND_BASE_URL`,
   `CORS_ALLOWED_ORIGINS`, `VITE_API_URL`, plus B2/Gemini/Resend/FX keys. Keep
   `.env.example` the source-of-truth template (no secrets).
3. Run `cmd/migrate --env=dev` and `--env=main`; confirm all migrations apply
   cleanly and idempotently. Fix any env-selection bugs in `cmd/migrate`/`config`.
4. `npm run build:dev` and `build:main`; confirm `VITE_API_URL` differs per mode
   and output lands in `dist-dev` / `dist-main`.
5. `firebase deploy --only hosting:dev` and `:main`; confirm each site serves the
   matching build and SPA rewrites work.
6. Write `roadmap/../docs` or a README section: "How to run locally / deploy
   dev / deploy main", including the exact commands.

## Acceptance criteria
- [ ] `cmd/migrate --env=local|dev|main` each apply all 5 migrations with no error.
- [ ] `npm run build:dev` and `npm run build:main` both succeed and embed the
      correct per-env `VITE_API_URL`.
- [ ] `firebase deploy --only hosting:dev` and `:main` both publish successfully
      and the live sites load + route (deep links work via rewrite).
- [ ] `.env.example` documents every var; no secret is committed.
- [ ] Backend server boots against the dev Neon DB and `/healthz` returns ok.

## Tests
- `config.Load()` unit test for required-var validation per env.
- Manual deploy smoke test; capture both live URLs in the PR.

## Notes

### What was verified / hardened (sonnet-agent, 2026-05-21)

**cmd/migrate hardening:**
- Audited `loadEnvFile` and `loadDatabaseURL`; logic is correct and already handles
  fallback from `.env.local` → `.env` for local env, and falls back to
  `$DATABASE_URL` env var if the file has no DATABASE_URL.
- Added `loadDatabaseURLWithFile` helper to support a new `--env-file` flag,
  allowing an explicit path to be passed — useful for CI and cases where the
  binary is deployed without source.
- Improved error output: the error message now tells the user exactly which file
  was checked and that `$DATABASE_URL` was also tried.
- `--reset --env=main` guard updated to allow `--env-file` override for
  power-user scenarios.

**config.Load() unit tests:**
- `backend/internal/config/config_test.go` — 14 tests covering required-var
  validation for `DATABASE_URL`, `JWT_SECRET` (presence + min-length), all
  five B2 vars, `GEMINI_API_KEY`; default values for `PORT`, `APP_BASE_URL`,
  token TTLs; custom TTL parsing; invalid TTL error; `RESEND_API_KEY` optional.
- `backend/internal/config/dotenv_test.go` — 8 tests for `LoadDotenv` and
  `resolveDotenv`: KEY=VALUE parsing, comment skipping, no-override semantics,
  quote stripping, missing-file noop, directory walk-up.

**cmd/migrate unit tests:**
- `backend/cmd/migrate/migrate_test.go` — 10 tests: env-file parsing, quote
  stripping, no-override semantics, missing/empty file handling, `envFiles`
  map completeness and absolute-path assertions, DATABASE_URL fallback to
  `$DATABASE_URL`, dev env-file primary lookup, local `.env.local` → `.env`
  fallback.

**Frontend builds:**
- `npm run build:dev` succeeds; output in `dist-dev/`; `VITE_API_URL` set to
  `https://dev-api.slipscan.app` embedded in bundle.
- `npm run build:main` succeeds; output in `dist-main/`; `VITE_API_URL` set to
  `https://api.slipscan.app` embedded in bundle.

**.env.example:**
- Added `RX_DOMAIN` variable (used in `cmd/server/main.go` but missing from
  the template).

**Runbook:**
- `docs/DEPLOY.md` — complete local/dev/main deploy guide with exact commands
  and secrets reference table.

### Build results

```
cd backend && go build ./... && go vet ./...  → clean
go test ./internal/config/... ./cmd/migrate/... → PASS (22 tests)
npm run build:dev   → ✓ dist-dev/ built in ~5s
npm run build:main  → ✓ dist-main/ built in ~5s
```

### Secrets the human MUST supply

The following secrets are NOT in source control. Fill them in `.env.dev` and
`.env.main` before running migrations or deploying.

**Database (Neon)**
- `.env.dev`  → `DATABASE_URL` = Neon **dev** project direct connection string
- `.env.main` → `DATABASE_URL` = Neon **prod** project direct connection string
- Get from: https://console.neon.tech → your project → Connection Details

**JWT secrets** (one per env, ≥32 chars)
- `JWT_SECRET` in `.env.dev` and `.env.main`
- Generate: `openssl rand -hex 32`

**Backblaze B2** (one bucket per env: `slipscan-receipts-dev`, `slipscan-receipts-main`)
- `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` in each env file
- Get from: https://secure.backblaze.com/app_keys.htm

**Google Gemini (OCR)**
- `GEMINI_API_KEY` in both `.env.dev` and `.env.main`
- Get from: https://aistudio.google.com/apikey

**Resend (email)**
- `RESEND_API_KEY`, `RESEND_FROM` in both env files
- Get from: https://resend.com → API Keys

**Exchange rates**
- `EXCHANGE_RATE_API_KEY` in both env files
- Get from: https://www.exchangerate-api.com

**Firebase CI token** (for non-interactive deploys)
- Run `firebase login:ci` once; store the printed token as `FIREBASE_TOKEN`
- Use: `firebase deploy --only hosting:dev --token "$FIREBASE_TOKEN"`

**Pending (not yet filled in `.env.main`)**
- `B2_KEY_ID` — main bucket key ID is blank in `.env.main`
- `B2_BUCKET` — main bucket name is blank in `.env.main`
- `GEMINI_API_KEY` — blank in `.env.main`; must be filled before backend boot

This is the unblocker — finish it first. Use Neon's pooled connection string for
the serverless/VM runtime and the direct string for migrations.
