---
id: P0-03
title: Environments, Neon DBs, and the build/deploy pipeline
phase: 0
status: todo
owner: unassigned
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
This is the unblocker — finish it first. Use Neon's pooled connection string for
the serverless/VM runtime and the direct string for migrations.
