# TODO: Fold ShapePay into SlipScan

> [!IMPORTANT]
> **We must fold ShapePay into this project: users configure webhook details, and SlipScan fires those webhooks when it detects incoming transactions that match a code on a bank account — an EFT-style, decentralized payment-provider capability. As long as your box has network, this works. No central infrastructure, ever.**

## The idea

SlipScan already watches bank accounts (statement imports today; live adapters and email alerts on the roadmap). That means it can act as a **payment detector**: a merchant/freelancer gives a customer a unique reference code, the customer pays by EFT with that code, and the moment SlipScan sees the matching incoming transaction it **fires a webhook** to whatever the user wired up — an order system, an invoicing tool, a Telegram bot, anything with a URL.

That is the useful core of ShapePay, rebuilt on SlipScan's sovereignty terms: your bank session, your box, your webhook endpoints — a decentralized alternative to hosted payment-notification providers.

## What to build

- **Payment expectations** — first-class records: reference code (exact or pattern), expected amount (optional tolerance), account to watch, expiry, one-shot vs recurring.
- **Matcher** — runs inside the existing ingestion pipeline (statement import, and later live adapters / email alerts): when a new inbound transaction's reference/description matches an open expectation, mark it paid and enqueue events.
- **Webhook dispatcher** — per-user endpoints with:
  - secrets stored in the **credential vault** (write-only, like everything else)
  - **HMAC-signed payloads** (timestamp + nonce, replay-safe) so receivers can verify
  - at-least-once delivery with retry/backoff queue persisted in SQLite — if the box is offline, deliveries fire when network returns ("as long as your box has network this works")
  - delivery log in the audit trail (never payload secrets)
- **Surfaces** — CLI (`slipscan pay expect / list / cancel`), server routes, desktop screen for expectations + delivery status.
- **Mantra compliance** — outbound-only, user-configured URLs, no ShapePay cloud, no callback relay. A self-hosted box with `slipscan serve` is the always-on deployment shape.

## Status

- [ ] Not started — this file is the commitment. Fold into ROADMAP as its own phase when the globalization wave lands.
