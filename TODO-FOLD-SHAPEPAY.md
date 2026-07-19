# TODO: ShapePay — email-driven payment webhooks

> [!IMPORTANT]
> **ShapePay is simple: connect your email, and when a payment transaction is detected in it — an EFT carrying a reference code you care about — SlipScan fires your webhooks. A payment system built on the transactions already flowing through your own inbox. As long as your box has network, it works. No central infrastructure, ever.**

The original ShapePay repos live in this repo's early git history (`shapepay-frontend/`, `shapepay-supabase/`) — that heritage is preserved; this phase is the simple rebuild on SlipScan's sovereignty terms.

## What it is

1. **You connect your email** — the mailbox ingestion SlipScan already has. Bank alert / payment notification emails arrive there.
2. **You tell SlipScan what to watch** — reference codes (e.g. the EFT reference you gave a customer), optionally with an amount.
3. **You add webhook endpoints** — a URL + a signing secret (vault-held, write-only, shown once at creation).
4. **When a matching inbound transaction is detected** — from email-ingested statements/alerts or any other ingestion source — SlipScan POSTs a signed webhook to your endpoints. HMAC-SHA256, timestamp + nonce, replay-safe. Delivery retries with backoff until your box and the receiver can talk.

That's the whole product: inbox in, webhook out.

## Status

- [x] Original ShapePay history folded into this repo (scrubbed, re-authored)
- [ ] Watch codes (reference + optional amount) — simple list, CRUD on CLI/server/desktop
- [ ] Webhook endpoints with vault-held secrets, HMAC-signed deliveries, retry queue
- [ ] Detection hook on inbound transactions (email-ingested first, all sources inherit)
- [ ] `docs/PAYMENTS.md` with a receiver verification example
