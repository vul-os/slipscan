# slip/scan — Account & Key Setup Checklist

A one-time checklist to stand up the dev environment. Legend:
**[you]** = only you can do it · **[me]** = I can do it once the relevant CLI/
integration is connected · **[gate]** = human approval step (you start it, a
third party approves).

Do **dev first**. Production repeats the same steps against the `main` Neon
branch and `slipscan-main` Pages project. Full runbook: `DEPLOY_CLOUDFLARE.md`.

---

## 1. Cloudflare account + domain
- [ ] **[you]** Create/confirm a Cloudflare account.
- [ ] **[you]** Add the `slipscan.app` zone and point your registrar's
      nameservers at Cloudflare (propagation can take minutes–hours).
- [ ] **[you]** Enable **R2** (dash → R2 → may require adding a payment method).
- [ ] **[you]** Enable **Containers** (beta) and **Email Routing** on the account.
- [ ] **[you]** `wrangler login`  *(or create an API token with Workers, Pages,
      R2, DNS, Email scopes and export `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`)*
- [ ] **[me]** Create R2 buckets (`slipscan-docs-dev` / `-main`) + an R2 API token →
      `STORAGE_*`.
- [ ] **[me]** Deploy container Worker, Email Worker, and Pages; set all
      `wrangler secret put …`; apply DNS via `backend/scripts/cloudflare-app-dns.sh`.

## 2. Neon (database) — already connected, I can do all of this
- [ ] **[me]** Create the `slipscan` Neon project + `dev` and `main` branches.
- [ ] **[me]** Run all migrations (`backend/migrations/`) against each branch.
- [ ] **[me]** Produce the pooled `DATABASE_URL` for each → Container secret.

## 3. Google Gemini (AI / OCR)
- [ ] **[you]** Create an API key at aistudio.google.com/apikey → `GEMINI_API_KEY`.

## 4. Amazon SES (outbound email)
- [ ] **[you]** AWS account + an IAM user with `ses:SendEmail` only →
      `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`.
- [ ] **[you]** `aws configure` (so I can drive the SES setup), **or** do the
      console steps in `backend/docs/EMAIL_SENDING.md`.
- [ ] **[me]** Create the verified domain identity (`mail.slipscan.app`),
      configuration set, SNS topic; output the DKIM/SPF/DMARC DNS records.
- [ ] **[me]** Add those DNS records in Cloudflare (via the DNS script).
- [ ] **[gate]** Request **SES production access** (exits the sandbox; AWS
      approves in ~1–2 business days). Until then SES only sends to verified
      addresses. I can draft/submit the request; AWS approves it.
- [ ] `EMAIL_FROM = slip/scan <noreply@mail.slipscan.app>`, `EMAIL_WORKER_ENABLED=true`.

## 5. Secrets I generated for you (store these, do not commit)
- [ ] `JWT_SECRET` — see chat (64-hex).
- [ ] `INBOUND_INGEST_SECRET` — see chat (64-hex). **Same value** goes on the
      Container *and* the Email Worker, so the inbound POST authenticates.

## 6. Optional integrations (Phase 7 — skip for first launch)
- [ ] Xero: `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` (developer.xero.com).
- [ ] Stitch: `STITCH_CLIENT_ID` / `STITCH_CLIENT_SECRET` / `STITCH_WEBHOOK_SECRET`.
- [ ] FX: `EXCHANGE_RATE_API_KEY` (optional — free Frankfurter is the default).

---

## Division of labour once CLIs are connected

| Area | Who | Notes |
|---|---|---|
| Neon project/branches/migrations/`DATABASE_URL` | **me** | Integration already connected |
| R2 buckets + B2→R2 data copy | **me** | After `wrangler login` |
| `wrangler` deploy (Workers/Pages) + `secret put` | **me** | After `wrangler login` |
| Cloudflare DNS records (api/app/Email-Routing/SES) | **me** | Via CF API token |
| SES identity / config set / SNS / DNS | **me** | After `aws configure` |
| Account signups + payment methods | **you** | — |
| Registrar nameserver move to Cloudflare | **you** | — |
| Enable Containers beta + Email Routing | **you** | Dashboard toggles |
| SES production-access approval | **gate** | AWS approves, ~1–2 days |
