# Payments — ShapePay

> **ShapePay is a payment detector on your own inbox.** Give a customer a reference code, connect your email, and when the EFT lands you get a signed webhook — fired from your machine, straight to your systems. A payment product built on the transactions already flowing through your own mailbox: as long as your box has network, it works. No central infrastructure, ever.

You hand a customer a reference (`INV-7031`). They pay by EFT. The bank's statement or alert arrives in your mailbox, SlipScan ingests it, and the moment a matching inbound transaction is detected your endpoints receive an HMAC-signed `payment.matched` webhook. Inbox in, webhook out — that is the whole product.

Deliberately simple, by design: watch codes are a **flat list** with an on/off switch. No expiry, no recurring/one-shot machinery, no tolerance windows — the only optional filter is one exact amount in one currency.

## How a payment becomes a webhook

1. **Email in.** `slipscan mail-sync` fetches unseen mail from your own mailbox and imports attachments as documents ([EMAIL.md](EMAIL.md)) — bank statements and payment alerts arrive here.
2. **Transaction created.** The detection hook lives inside core's `transaction_create`, so **every ingestion source inherits it**: statement-preset imports (`slipscan import statement.csv --preset … --account …`), manual entries, server/desktop creates, and any future connector.
3. **Match.** Enabled watch codes are checked against the transaction's description and merchant text — case-insensitive, **whole-token** (`INV1` never fires on `INV11`), inbound money only, with the optional exact amount+currency filter applied. A match is recorded and audited (metadata only).
4. **Webhook out.** One delivery per enabled endpoint is queued in SQLite and POSTed with HMAC-SHA256 signature headers. Failures retry with backoff until your box and the receiver can talk (or the schedule is exhausted).

> **Honest status:** parsing bank-alert *emails* directly into transactions is not wired yet ([EMAIL.md](EMAIL.md) tracks it) — today email-ingested statements land as documents, and the reliable trigger is a statement import that carries the reference (or any other `transaction_create`). Every `mail-sync` run already flushes the webhook queue, so once alert parsing lands, email in → webhook out is one command.

## Setup walkthrough

### 1. Connect your mailbox

Generic IMAP works end-to-end today: store the app password in the vault, configure `mail.imap.config`, and run `slipscan mail-sync` (from cron/launchd if you like). Full steps per provider: [EMAIL.md](EMAIL.md#generic-imap-any-host).

### 2. Watch the reference

```sh
# Watch a code (the EFT reference you gave the customer).
slipscan pay watch INV-7031 --label "Rent July"

# Optionally require one exact amount (minor units) in one currency.
slipscan pay watch DEP-9 --amount 50000 --currency ZAR

slipscan pay watches          # list
slipscan pay unwatch <id>     # stop watching
```

Codes are matched as whole tokens, case-insensitively, and may contain separators (`INV-001`). Only **inbound** transactions (positive amounts) ever match — a debit carrying the same reference never fires.

### 3. Register your webhook endpoint

```sh
slipscan pay endpoint add https://hooks.example.org/pay --label "Shop backend"
```

This prints the endpoint's **signing secret exactly once** — 64 hex characters, generated locally from the OS CSPRNG. Copy it into your receiver now: it is stored write-only in the [credential vault](THREAT-MODEL.md) and can never be read back. Lost it? Rotate:

```sh
slipscan pay endpoint rotate <id>    # new secret, printed exactly once; the old one stops signing immediately
slipscan pay endpoint remove <id>    # drops queued deliveries, revokes the vault-held secret
slipscan pay endpoints               # metadata only — never secrets
```

URLs must be `http(s)`, without embedded `user:pass@` credentials — deliveries are authenticated by the HMAC signature, not by the URL.

### 4. Deliver

Deliveries queue in SQLite and are flushed by whichever surface you run:

- `slipscan mail-sync` — flushes due deliveries at the end of every sync (email in → webhook out in one command)
- `slipscan pay deliver` — flush on demand; `slipscan pay deliveries [--failed]` shows the queue
- `slipscan serve` — self-host server mode runs a delivery loop (checks the queue every 30 s, honoring each delivery's own retry schedule; an empty queue means zero network activity)
- the desktop **Payments** panel — watches, endpoints, matches, and deliveries with a deliver-now action

## The delivery request

Each delivery is a `POST` to your endpoint URL with `Content-Type: application/json` and three headers:

| Header | Value |
|---|---|
| `X-SlipScan-Signature` | Lowercase hex `HMAC-SHA256(secret, "{timestamp}.{nonce}." + body)` — the key is the secret string exactly as displayed at creation (its ASCII bytes; no decoding) |
| `X-SlipScan-Timestamp` | Unix seconds at send time, as a decimal string. Fresh per attempt — reject stale values to bound replays |
| `X-SlipScan-Nonce` | The delivery id. **Stable across retries** of the same delivery — deduplicate on it |

The body is built once at match time and signed byte-for-byte on every attempt. It carries **metadata only** — the watch's own label and reference, the transaction's amount/currency/date — never account numbers, never the raw bank description:

```json
{
  "amount_minor": 50000,
  "currency": "ZAR",
  "event": "payment.matched",
  "matched_at": "2026-07-19T09:14:03Z",
  "posted_date": "2026-07-18",
  "reference": "INV-7031",
  "watch_label": "Rent July"
}
```

Always verify and parse the **raw request bytes** — re-serializing JSON can reorder keys and break the signature.

## Verifying deliveries on your receiver

Four rules: recompute the HMAC over the raw body, compare in **constant time**, bound the **timestamp window**, and deduplicate on the **nonce** (deliveries are at-least-once). A complete Node.js receiver:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const SECRET = process.env.SLIPSCAN_WEBHOOK_SECRET; // printed once by `slipscan pay endpoint add`
const WINDOW_SECS = 300;                            // reject timestamps older than 5 minutes
const seen = new Set();                             // nonce store — use your database in production

const app = express();
app.post("/pay", express.raw({ type: "application/json" }), (req, res) => {
  const signature = (req.header("X-SlipScan-Signature") ?? "").trim().toLowerCase();
  const timestamp = req.header("X-SlipScan-Timestamp") ?? "";
  const nonce = req.header("X-SlipScan-Nonce") ?? "";

  // 1. Recompute over the RAW body bytes; compare in constant time.
  const expected = createHmac("sha256", SECRET)
    .update(`${timestamp}.${nonce}.`)
    .update(req.body)
    .digest("hex");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return res.status(401).end(); // 4xx = permanent: SlipScan will not retry
  }

  // 2. Bound replays: the timestamp is fresh on every attempt.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WINDOW_SECS) {
    return res.status(401).end();
  }

  // 3. Idempotency: the nonce is stable across retries of one delivery.
  if (seen.has(nonce)) return res.status(200).end(); // already processed — acknowledge
  seen.add(nonce);

  const event = JSON.parse(req.body); // event.reference, event.amount_minor, event.currency, …
  return res.status(200).end();       // 2xx marks the delivery delivered
});
app.listen(8787);
```

Respond fast and do slow work after acknowledging — the sender times each request out at 30 seconds.

## Delivery states and retries

| Receiver response | Result |
|---|---|
| `2xx` | `delivered` — done |
| `4xx` | `failed` immediately — the receiver understood the request and rejected it; retrying cannot help |
| `5xx`, `3xx`, connection error, timeout | retried with backoff (redirects are **never followed** — that would re-send the signed body somewhere you didn't configure) |

Retry backoff after the *n*-th consecutive failure:

| Failure # | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| Next attempt in | 1 m | 5 m | 30 m | 2 h | 12 h | daily |

After **20 attempts** a delivery is abandoned as `failed` (`slipscan pay deliveries --failed` lists them). Delivery is **at-least-once**: a crash between the POST and the state write redelivers on the next run, which is exactly why your receiver deduplicates on the nonce. Each attempt re-signs with a fresh timestamp; the nonce and body never change.

## Security model

- **The signing secret is vault-held and shown once.** Generated locally (32 random bytes from the OS CSPRNG), stored only in the [write-only credential vault](THREAT-MODEL.md), displayed a single time at add/rotate. At delivery time the signature is computed *inside* the vault's use-closure — secret material never reaches the dispatcher, the queue, logs, or the audit trail.
- **Secrets never transit HTTP.** Over the [server API](API.md#payments-shapepay), `pay_endpoint_add` and `pay_endpoint_rotate_secret` are refused — endpoints are added locally (CLI or desktop). Listings return metadata only.
- **Payloads carry no bank data.** No account numbers, no raw statement description — only your own reference, label, and the amount/currency/date. The receiver already knows what the reference means.
- **No central infrastructure.** Your machine POSTs directly to endpoints you registered. No relay, no hosted queue, nothing to trust but your own box and your receiver.
- **Nothing fires twice for the same bank line.** Content-hash dedupe rejects a re-imported duplicate transaction before the detection hook runs.
- **Everything is audited, metadata only.** Watch/endpoint changes, matches, and delivery outcomes land in the append-only audit log as ids, states, and counts — never payloads, never secrets.

---

**Next:** [API.md](API.md#payments-shapepay) — the `pay_*` operations on the server and desktop surfaces.
