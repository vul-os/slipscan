# Cloudflare Workers + Containers — slipscan

This directory contains Wrangler config and TypeScript source for the two
Cloudflare Workers that serve slipscan in production.

```
infra/cloudflare/
├── wrangler.toml          # Router Worker + Container (api.slipscan.app)
├── wrangler.email.toml    # Email Worker (inbound RFC-822 ingestion)
├── src/
│   ├── index.ts           # Router Worker — proxies all traffic to Go container
│   └── email.ts           # Email Worker — forwards raw email to Go ingest
├── package.json
├── tsconfig.json
└── README.md
```

---

## Architecture overview

```
Internet
  │
  ├─ HTTPS → api.slipscan.app/* ──► Router Worker (index.ts)
  │                                      │
  │                               getContainer(BACKEND, "singleton")
  │                                      │
  │                               GoBackend DO stub  ──► Cloudflare Container
  │                                                       (Go monolith, :8080)
  │
  └─ SMTP → *@mail.slipscan.app ──► Cloudflare Email Routing
                                        │
                                    Email Worker (email.ts)
                                        │
                                   POST /internal/inbound-email
                                        │
                                   Go monolith (via api.slipscan.app)
```

---

## Prerequisites

1. Node.js ≥ 18 and npm.
2. Wrangler v4+ — installed as a dev-dependency; use `npx wrangler` or
   add `node_modules/.bin` to `$PATH`.
3. `wrangler login` (or `CLOUDFLARE_API_TOKEN` env var).
4. The `api.slipscan.app` and `mail.slipscan.app` DNS zones must be on the
   same Cloudflare account.
5. The **Go backend Dockerfile** must exist at `backend/Dockerfile` relative to
   the repo root (another agent is responsible for this file).  The Docker
   build context CF uses is the directory containing the Dockerfile
   (`backend/`).  The binary must listen on `$PORT` (default `8080`) and expose
   `GET /healthz → 200`.

---

## Installation

```bash
cd infra/cloudflare
npm install
```

---

## Secrets + environment variables

### Router Worker / Go container (`wrangler.toml`)

All of these must be available to the Go binary **as container environment
variables**.  Inject them using the `envVars` property on the `GoBackend` class
(see `src/index.ts`) **or** — the recommended approach for secrets — by
configuring them as Worker secrets that the container start-up code reads.

As of Cloudflare Containers beta, the supported way to pass secrets into a
container at runtime is through the `envVars` property on the Container
subclass, populated from Worker-level secrets/bindings, e.g.:

```typescript
// In GoBackend.onStart() or by overriding start():
override onStart() {
  // env vars declared in envVars {} at class level or passed to start()
}
```

For the current beta it is simplest to declare static vars in `wrangler.toml`
`[vars]` and set secrets via `wrangler secret put`, then read them inside the
Worker and pass them through `ContainerStartConfigOptions.envVars` when calling
`this.start()` if you need dynamic injection.  Check the CF Containers docs for
updates: https://developers.cloudflare.com/containers/

| Variable | Example | How to set |
|---|---|---|
| `DATABASE_URL` | `postgres://...` | `wrangler secret put DATABASE_URL` |
| `STORAGE_BUCKET` | `slipscan-docs` | `wrangler secret put STORAGE_BUCKET` |
| `STORAGE_ACCESS_KEY_ID` | AWS-style key | `wrangler secret put STORAGE_ACCESS_KEY_ID` |
| `STORAGE_SECRET_ACCESS_KEY` | AWS-style secret | `wrangler secret put STORAGE_SECRET_ACCESS_KEY` |
| `STORAGE_ENDPOINT` | R2 endpoint URL | `wrangler secret put STORAGE_ENDPOINT` |
| `AWS_ACCESS_KEY_ID` | SES key | `wrangler secret put AWS_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` | SES secret | `wrangler secret put AWS_SECRET_ACCESS_KEY` |
| `AWS_REGION` | `us-east-1` | `wrangler secret put AWS_REGION` |
| `EMAIL_FROM` | `noreply@slipscan.app` | `wrangler secret put EMAIL_FROM` |
| `EMAIL_WORKER_ENABLED` | `true` | `wrangler secret put EMAIL_WORKER_ENABLED` |
| `JWT_SECRET` | random 64-char string | `wrangler secret put JWT_SECRET` |
| `JWT_ISSUER` | `slipscan` | `wrangler secret put JWT_ISSUER` |
| `GEMINI_API_KEY` | GCP API key | `wrangler secret put GEMINI_API_KEY` |
| `INBOUND_INGEST_SECRET` | random secret | shared with Email Worker — see below |

### Email Worker (`wrangler.email.toml`)

| Variable | Example | How to set |
|---|---|---|
| `INGEST_BASE_URL` | `https://api.slipscan.app` | `[vars]` in `wrangler.email.toml` (already set) or `wrangler secret put` |
| `INBOUND_INGEST_SECRET` | random 32+ char string | `wrangler secret put INBOUND_INGEST_SECRET --config wrangler.email.toml` |

**`INBOUND_INGEST_SECRET` must match** the value set on the Go container side.

Quick helper:

```bash
npm run secret:ingest
# prompts for the value of INBOUND_INGEST_SECRET for the email worker
```

---

## Deploying the Router Worker + Container

```bash
# From infra/cloudflare/ (or repo root with --config)
npm run deploy
# or directly:
npx wrangler deploy --config infra/cloudflare/wrangler.toml
```

On first deploy Wrangler builds the Docker image from `backend/Dockerfile`,
pushes it to Cloudflare's registry, and creates the Durable Object migration.
Subsequent deploys only rebuild if the Dockerfile or context changes.

### Local development

```bash
npm run dev
# Wrangler starts a local miniflare instance with the container stubbed.
# Full container support requires `wrangler dev --remote` (beta).
```

---

## Deploying the Email Worker

```bash
npm run deploy:email
# or:
npx wrangler deploy --config infra/cloudflare/wrangler.email.toml
```

### Enable Email Routing on the zone

1. **Cloudflare Dashboard → your account → `mail.slipscan.app` zone → Email Routing**.
2. Enable Email Routing if not already on.
3. Under **Routing rules** → **Catch-all address**:
   - Action: **Send to a Worker**
   - Worker: `slipscan-email-ingest` (the name in `wrangler.email.toml`)
   - This catches `*@mail.slipscan.app`.
4. Optionally add specific rules (e.g. `receipts@mail.slipscan.app`) before the
   catch-all for future routing logic.

### Local testing

```bash
npm run dev:email
# Then POST a raw .eml file:
curl -X POST http://localhost:8787/cdn-cgi/handler/email \
  --data-binary @test.eml \
  -H "Content-Type: message/rfc822"
```

---

## Type-checking

```bash
npm run type-check
# runs: tsc --noEmit
```

Note: `tsc --noEmit` requires `node_modules` to be installed (the
`@cloudflare/workers-types` package provides the global Worker types).  If
running in a sandboxed environment without network, install manually:
`npm install`.

---

## Deploy all at once

```bash
npm run deploy:all
```

---

## Version notes / caveats

- **Cloudflare Containers is in beta** (as of 2026-05).  The API surface —
  particularly `envVars` injection for secrets, health check configuration, and
  `instance_type` values — may change.  Always consult
  https://developers.cloudflare.com/containers/ before deploying.
- The `@cloudflare/containers` npm package version in `package.json` is pinned
  to `^0.1.0`; check `npm info @cloudflare/containers` for the latest release.
- `new_sqlite_classes` in the `[[migrations]]` block is required for Container-
  backed Durable Objects (CF uses SQLite storage for container DO state).
- The `pingEndpoint = "healthz"` property tells CF to probe `GET /healthz`
  (CF prepends `/` to the value) before marking the container healthy.  This
  corresponds to the `GET /healthz` endpoint the Go binary exposes.
- SSE / chunked streaming: `getContainer(...).fetch(request)` returns the
  `Response` stream directly without buffering, so streaming endpoints are
  preserved end-to-end.
- Inbound email size limit is enforced at 25 MB in the Email Worker before
  reading the stream; this matches typical MTA limits.  The `message.rawSize`
  field (from `ForwardableEmailMessage`) is checked before calling
  `.arrayBuffer()`, avoiding memory exhaustion on oversized messages.
