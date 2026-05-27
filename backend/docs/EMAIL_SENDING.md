# slip/scan — Amazon SES Email Sending Runbook

This document covers everything needed to provision, configure, verify, and
operate the Amazon SES transactional email system for slip/scan.  It is
written for the **SES migration** of the existing `email.Sender` interface
(currently backed by Resend) and should be read alongside
`backend/DEPLOY.md`.

---

## 1. Overview & Architecture

### Why SES and not Cloudflare's `send_email` binding

The backend is progressively migrating to Cloudflare Workers.  Workers have
**no port 25 egress** and cannot originate SMTP connections.  Cloudflare's
`send_email` binding only delivers to addresses pre-verified in the same
Cloudflare account — it cannot send to arbitrary recipients.  Amazon SES
provides a fully managed HTTPS API that Workers can reach with a signed
`fetch()`, which is why SES is the chosen MTA for outbound transactional mail.

### Message flow

```
Application handler
        │
        │  enqueue (INSERT email_outbox)
        ▼
   email_outbox table (Postgres / Neon)
        │
        │  poll (FOR UPDATE SKIP LOCKED)
        ▼
   Email retry worker goroutine
        │
        │  ses:SendEmail  (AWS SES v2 HTTPS API)
        ▼
   Amazon SES  ──────────────────────────────► Recipient inbox
        │
        │  Bounce / Complaint events
        ▼
   Amazon SNS topic
        │
        │  HTTPS subscription
        ▼
   POST /webhooks/ses  (slip/scan API)
        │
        │  INSERT / UPDATE
        ▼
   email_suppressions table
```

**Outbox guarantee.**  The `email_outbox` table acts as a durable write-ahead
log.  The retry worker polls it with `FOR UPDATE SKIP LOCKED`, so running
multiple worker instances is safe (each row is claimed by one worker).
However, running exactly one worker instance is recommended to avoid
unnecessary API calls on transient failures — set `EMAIL_WORKER_ENABLED=true`
on one container instance only, matching the same pattern as `FX_SYNC_ENABLED`.

**Bounce / complaint webhook.**  The `POST /webhooks/ses` endpoint and the
`email_suppressions` table are the **intended future design**; they are
implemented in a later phase.  Document them here so DNS and SNS are wired
correctly from day one.

---

## 2. SES Account Setup (Step by Step)

All console steps assume the **us-east-1** region.  The region is
configurable via `AWS_REGION`; substitute accordingly.

### 2.1 Create and verify the sending domain identity

1. Open the [SES console](https://console.aws.amazon.com/ses/home?region=us-east-1)
   and navigate to **Verified identities → Create identity**.
2. Choose **Domain**, enter `mail.slipscan.app`.
3. Leave **Use a custom MAIL FROM domain** unchecked for now — you will
   configure it in step 2.3.
4. Click **Create identity**.  SES presents the DKIM CNAME records to add
   (three records, one per token).

> **Subdomain isolation.**  Sending from `mail.slipscan.app` keeps the
> outbound sending reputation separate from the apex domain and from the
> inbound MX sub-domain.  Do not use the apex or `rx.*` for SES sending —
> see the DNS conflict note in section 3.

### 2.2 Easy DKIM (SES-managed, 2048-bit RSA)

SES generates three CNAME records.  Add them in Cloudflare exactly as shown;
the token values appear in the SES console after identity creation.

| Type  | Name (relative to zone root)                      | Target                                   | Proxy     |
|-------|---------------------------------------------------|------------------------------------------|-----------|
| CNAME | `<token1>._domainkey.mail.slipscan.app`           | `<token1>.dkim.amazonses.com`            | DNS only  |
| CNAME | `<token2>._domainkey.mail.slipscan.app`           | `<token2>.dkim.amazonses.com`            | DNS only  |
| CNAME | `<token3>._domainkey.mail.slipscan.app`           | `<token3>.dkim.amazonses.com`            | DNS only  |

**CRITICAL: set Proxy status to "DNS only" (grey cloud).**  If these CNAMEs
are orange-clouded, Cloudflare's proxy intercepts the DKIM DNS lookups and
returns its own IP instead of the SES endpoint.  Receiving mail servers will
fail DKIM verification and your deliverability will be broken.

After adding records, return to the SES console and click **Verify** (or wait
up to 72 hours for automatic re-check).  Status should change to **Verified**.

### 2.3 Custom MAIL FROM domain (SPF alignment)

A custom MAIL FROM subdomain causes the `MAIL FROM` envelope header to use
your domain rather than `amazonses.com`, achieving SPF alignment with the
RFC5321 `MAIL FROM` and the RFC5322 `From:` header.

Recommended subdomain: `bounce.mail.slipscan.app`

In SES: open the verified identity → **General details** → **Custom MAIL FROM
domain** → edit → enter `bounce.mail.slipscan.app`.

SES requires two DNS records on the MAIL FROM subdomain:

**MX record** (routes DSN / bounce messages back to SES):

| Type | Name                          | Value                                         | Priority | TTL  | Proxy    |
|------|-------------------------------|-----------------------------------------------|----------|------|----------|
| MX   | `bounce.mail.slipscan.app`    | `feedback-smtp.us-east-1.amazonses.com`       | 10       | 300  | DNS only |

**SPF TXT record** on the MAIL FROM subdomain:

| Type | Name                          | Value                                | TTL  | Proxy    |
|------|-------------------------------|--------------------------------------|------|----------|
| TXT  | `bounce.mail.slipscan.app`    | `v=spf1 include:amazonses.com ~all`  | 300  | DNS only |

> **Inbound MX conflict note.**  Inbound mail for `mail.slipscan.app` is
> received by **Cloudflare Email Routing**, whose MX records live on that
> label.  The SES custom MAIL FROM MX lives on `bounce.mail.slipscan.app` — a
> distinct subdomain — so there is **no conflict**.  Never add the SES MAIL
> FROM MX record to the `mail.slipscan.app` label used by Email Routing.

### 2.4 SPF on the From address domain

Add an SPF TXT record on `mail.slipscan.app` itself (the domain that appears
in the `From:` header):

| Type | Name                   | Value                                | TTL  | Proxy    |
|------|------------------------|--------------------------------------|------|----------|
| TXT  | `mail.slipscan.app`    | `v=spf1 include:amazonses.com ~all`  | 300  | DNS only |

If you already have other senders (e.g. Google Workspace) on this label,
merge includes: `v=spf1 include:amazonses.com include:_spf.google.com ~all`.
A domain must have at most one SPF TXT record.

### 2.5 DMARC

Add a DMARC policy at `_dmarc.mail.slipscan.app`.

Start with monitoring mode (`p=none`) until you have confirmed DKIM and SPF
are passing cleanly, then tighten.

**Phase 1 — monitoring (add immediately):**

| Type | Name                          | Value                                                                    | TTL   | Proxy    |
|------|-------------------------------|--------------------------------------------------------------------------|-------|----------|
| TXT  | `_dmarc.mail.slipscan.app`    | `v=DMARC1; p=none; rua=mailto:dmarc-reports@slipscan.app; fo=1`         | 3600  | DNS only |

**Phase 2 — enforce (after ≥ 2 weeks of clean reports):**

Update the record value to:

```
v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc-reports@slipscan.app; fo=1
```

Then escalate to `p=reject` once you are confident all legitimate mail
streams are covered.

### 2.6 Move out of the SES sandbox

By default new SES accounts are in the **sandbox**: you can only send to
verified email addresses and verified domains.  This is unsuitable for
production.

To request production access:

1. In the SES console, go to **Account dashboard** → **Request production
   access**.
2. Fill in the request form:
   - **Mail type:** Transactional
   - **Website URL:** `https://slipscan.app`
   - **Use case description** (suggested):

     > slip/scan is an accounting and document-management SaaS.  We send
     > transactional emails only: user invitations, password resets, and
     > email verification links.  All sends are user-initiated.  We do not
     > send marketing or bulk mail.  Users may only be invited by an existing
     > org admin, limiting the total addressable set.

   - **Additional contacts:** leave blank unless you have a dedicated postmaster
     address.
3. AWS typically responds within 1–2 business days.
4. After approval, confirm by removing sandbox restrictions in the console.

### 2.7 Configuration set and SNS event publishing

The `SES_CONFIGURATION_SET` env var must match the name you create here.

**Create the configuration set:**

```bash
aws ses create-configuration-set \
  --configuration-set-name slipscan-transactional \
  --region us-east-1
```

**Create the SNS topic:**

```bash
aws sns create-topic --name slipscan-ses-events --region us-east-1
# Note the TopicArn in the output, e.g.:
#   arn:aws:sns:us-east-1:123456789012:slipscan-ses-events
```

**Subscribe the webhook endpoint to the SNS topic:**

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:slipscan-ses-events \
  --protocol https \
  --notification-endpoint "https://api.slipscan.app/webhooks/ses" \
  --region us-east-1
```

SNS sends a `SubscriptionConfirmation` POST to the endpoint.  The
`/webhooks/ses` handler must respond by fetching the `SubscribeURL` from the
payload to confirm.  (Implemented in a later phase.)

**Attach the SNS destination to the configuration set:**

```bash
aws sesv2 create-configuration-set-event-destination \
  --configuration-set-name slipscan-transactional \
  --event-destination-name sns-all-events \
  --event-destination '{
    "Enabled": true,
    "MatchingEventTypes": ["BOUNCE","COMPLAINT","DELIVERY","SEND","REJECT"],
    "SnsDestination": {
      "TopicArn": "arn:aws:sns:us-east-1:123456789012:slipscan-ses-events"
    }
  }' \
  --region us-east-1
```

### 2.8 IAM credentials — least-privilege policy

Create a dedicated IAM user (or assume a role) for the application.  Attach
the following inline policy; substitute your verified identity ARN and
configuration set ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SESTransactionalSend",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail"
      ],
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/mail.slipscan.app",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/slipscan-transactional"
      ]
    }
  ]
}
```

Store the access key and secret as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` Cloudflare Container/Worker secrets
(`wrangler secret put AWS_SECRET_ACCESS_KEY`).

---

## 3. Cloudflare DNS Records — Consolidated Table

Add these records in the Cloudflare dashboard for the `slipscan.app` zone.
All records must be **DNS only (grey cloud)** — no orange-cloud proxying.

Replace `<tokenN>` with the actual DKIM tokens from the SES console.
Replace `us-east-1` with your `AWS_REGION` if different.

| Type  | Name                                        | Value / Target                                    | Priority | TTL  | Proxy    |
|-------|---------------------------------------------|---------------------------------------------------|----------|------|----------|
| CNAME | `<token1>._domainkey.mail.slipscan.app`     | `<token1>.dkim.amazonses.com`                     | —        | auto | DNS only |
| CNAME | `<token2>._domainkey.mail.slipscan.app`     | `<token2>.dkim.amazonses.com`                     | —        | auto | DNS only |
| CNAME | `<token3>._domainkey.mail.slipscan.app`     | `<token3>.dkim.amazonses.com`                     | —        | auto | DNS only |
| MX    | `bounce.mail.slipscan.app`                  | `feedback-smtp.us-east-1.amazonses.com`           | 10       | 300  | DNS only |
| TXT   | `bounce.mail.slipscan.app`                  | `v=spf1 include:amazonses.com ~all`               | —        | 300  | DNS only |
| TXT   | `mail.slipscan.app`                         | `v=spf1 include:amazonses.com ~all`               | —        | 300  | DNS only |
| TXT   | `_dmarc.mail.slipscan.app`                  | `v=DMARC1; p=none; rua=mailto:dmarc-reports@slipscan.app; fo=1` | — | 3600 | DNS only |

**Existing inbound MX (do not touch):**  `mail.slipscan.app` → MX →
`vm*.rx.mail.slipscan.app` (managed by `backend/deploy.sh`).  The SES MAIL
FROM MX lives on `bounce.mail.slipscan.app` and does not conflict.

---

## 4. Cloudflare DNS Automation Script

See `backend/scripts/cloudflare-ses-dns.sh` (created alongside this doc).
That script creates the SPF, DMARC, and MAIL FROM MX records using the
Cloudflare REST API.  DKIM CNAMEs contain SES-generated tokens and must be
added manually or passed as positional arguments — see the script's usage
comment for details.

Run it once per environment after SES identity creation:

```bash
export CF_API_TOKEN="<cloudflare-api-token>"     # Zone:Edit DNS permission
export CF_ZONE_ID="<zone-id-for-slipscan-app>"
export EMAIL_SENDING_DOMAIN="mail.slipscan.app"
export AWS_REGION="us-east-1"

chmod +x backend/scripts/cloudflare-ses-dns.sh
backend/scripts/cloudflare-ses-dns.sh

# Add DKIM CNAMEs (token values from SES console):
backend/scripts/cloudflare-ses-dns.sh --dkim <token1> <token2> <token3>
```

---

## 5. Verification & Testing

### 5.1 DNS propagation checks

Run these after adding records (substitute `<tokenN>` with your actual DKIM
tokens):

```bash
# DKIM CNAMEs
dig CNAME <token1>._domainkey.mail.slipscan.app +short
# Expected:  <token1>.dkim.amazonses.com.

dig CNAME <token2>._domainkey.mail.slipscan.app +short
dig CNAME <token3>._domainkey.mail.slipscan.app +short

# MAIL FROM MX
dig MX bounce.mail.slipscan.app +short
# Expected:  10 feedback-smtp.us-east-1.amazonses.com.

# SPF on MAIL FROM subdomain
dig TXT bounce.mail.slipscan.app +short
# Expected:  "v=spf1 include:amazonses.com ~all"

# SPF on From domain
dig TXT mail.slipscan.app +short
# Expected:  "v=spf1 include:amazonses.com ~all"  (among any other TXT records)

# DMARC
dig TXT _dmarc.mail.slipscan.app +short
# Expected:  "v=DMARC1; p=none; rua=mailto:dmarc-reports@slipscan.app; fo=1"
```

### 5.2 SES identity verification status

```bash
aws sesv2 get-email-identity \
  --email-identity mail.slipscan.app \
  --region us-east-1 \
  --query '{DKIM: DkimAttributes.Status, MailFrom: MailFromAttributes.MailFromDomainStatus}'
```

Expected: `{"DKIM": "SUCCESS", "MailFrom": "SUCCESS"}`

### 5.3 End-to-end authentication test

1. Visit [mail-tester.com](https://www.mail-tester.com/) and copy the
   generated test address (e.g. `test-xyz@srv1.mail-tester.com`).
2. Trigger a transactional email from the app with that address as the
   recipient (invite the address or use a direct API call with
   `EMAIL_WORKER_ENABLED=true`).
3. Return to mail-tester.com and click **Then check your score**.
4. Expand **Authentication** in the report; confirm:
   - **DKIM:** pass
   - **SPF:** pass (aligned)
   - **DMARC:** pass
5. Alternatively, check the raw headers in any received message for:
   ```
   Authentication-Results: ...
     dkim=pass ...
     spf=pass ...
     dmarc=pass ...
   ```

### 5.4 SES send-to-simulator (sandbox)

While still in the sandbox, use the SES simulator addresses to test bounce
and complaint handling without affecting reputation:

```bash
# Success
aws sesv2 send-email \
  --from-email-address "slip/scan <noreply@mail.slipscan.app>" \
  --destination "ToAddresses=success@simulator.amazonses.com" \
  --content '{"Simple":{"Subject":{"Data":"Test"},"Body":{"Text":{"Data":"Hello"}}}}' \
  --configuration-set-name slipscan-transactional \
  --region us-east-1

# Bounce simulator
aws sesv2 send-email \
  --from-email-address "slip/scan <noreply@mail.slipscan.app>" \
  --destination "ToAddresses=bounce@simulator.amazonses.com" \
  --content '{"Simple":{"Subject":{"Data":"Test"},"Body":{"Text":{"Data":"Hello"}}}}' \
  --configuration-set-name slipscan-transactional \
  --region us-east-1
```

Confirm bounce events arrive at the SNS topic (check SNS → Subscriptions →
delivery log, or CloudWatch Logs if enabled).

---

## 6. Running on Cloudflare (Container model)

The Go monolith runs inside a **Cloudflare Container** (`backend/Dockerfile`,
fronted by the router Worker in `infra/cloudflare/`). Because the binary runs
as-is, the entire email subsystem works without change:

- The `aws-sdk-go-v2 sesv2.SendEmail` client runs in the container — no need
  for a SigV4-signed `fetch()` or a TS rewrite.
- The `email_outbox` retry worker stays a normal Go goroutine, gated by
  `EMAIL_WORKER_ENABLED=true` on exactly one container instance.
- The outbox is queried with the same `pgx` pool over the Neon connection
  string — no serverless driver / Hyperdrive needed.
- `email_outbox` and `email_suppressions` tables and the SES identity, DNS,
  configuration set, SNS topic, and IAM policy are all unchanged.

The only operational difference from a self-managed host is **secrets**:
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `EMAIL_FROM`,
`SES_CONFIGURATION_SET`, `EMAIL_WORKER_ENABLED` are injected as Cloudflare
Container/Worker secrets (`wrangler secret put …`) rather than read from a
file.

#### `/webhooks/ses` SNS handler (future)

The bounce/complaint webhook is a Go HTTP handler on the monolith
(`api.slipscan.app/webhooks/ses`), implemented in a later phase. It must:

1. Verify the `x-amz-sns-message-type` header.
2. On `SubscriptionConfirmation`: fetch the `SubscribeURL` to confirm.
3. On `Notification`: parse the SES event JSON, check `notificationType`
   (`Bounce` or `Complaint`), and upsert the affected address into
   `email_suppressions`.
4. Validate the SNS message signature against the cert at `SigningCertURL`.

---

## 7. Operational Notes

### 7.1 IP / domain reputation warmup

SES allocates shared IPs by default.  For a new sending domain:

- Expect deliverability to improve over the first 2–4 weeks as ISPs learn
  your sending patterns.
- Start with a low send volume; avoid large spikes in the first month.
- If you need a dedicated IP (available at ~$24.95 USD/month per IP), request
  one via the SES console and run a warmup schedule over 4–6 weeks.

### 7.2 Metrics and alerting thresholds

Monitor these in the SES console (**Account dashboard → Sending statistics**)
or via CloudWatch metrics (`AWS/SES`):

| Metric             | Warning threshold | Critical / SES action threshold           |
|--------------------|-------------------|-------------------------------------------|
| Bounce rate        | > 2%              | > 5% — SES pauses sending automatically  |
| Complaint rate     | > 0.08%           | > 0.1% — SES pauses sending automatically|
| Delivery rate      | < 95%             | < 90%                                     |

Set up CloudWatch alarms on `Reputation.BounceRate` and
`Reputation.ComplaintRate` with SNS notifications to your ops channel.

### 7.3 Outbox status lifecycle

| `status` value | Meaning                                                      |
|----------------|--------------------------------------------------------------|
| `pending`      | Enqueued, not yet attempted                                  |
| `sending`      | Claimed by worker, SES call in progress                      |
| `sent`         | SES accepted the message (200 response)                      |
| `failed`       | Last attempt failed; will be retried                         |
| `dead`         | Exceeded `max_attempts`; no further retries                  |

**Dead-letter handling.**  Rows with `status='dead'` will not be retried
automatically.  Alert when `SELECT COUNT(*) FROM email_outbox WHERE status='dead'`
grows.  Common causes: invalid `To` address, suppressed address, SES account
paused.  Investigate and either re-queue manually (reset to `pending`) or
close the ticket if the address is legitimately suppressed.

### 7.4 Suppression list hygiene

The `email_suppressions` table (populated via `/webhooks/ses`) prevents
re-sending to bounced or complained-about addresses.  Before enqueuing any
email, the application should check:

```sql
SELECT EXISTS (
  SELECT 1 FROM email_suppressions
  WHERE address = $1
    AND (expires_at IS NULL OR expires_at > now())
)
```

Hard bounces (type `Permanent`) should be suppressed indefinitely.  Soft
bounces (type `Transient`) may be retried after a cooling-off period.

### 7.5 Runtime environment variables

Set these as Cloudflare Container/Worker secrets (`wrangler secret put …`):

| Variable                  | Example value                                     | Notes                                                    |
|---------------------------|---------------------------------------------------|----------------------------------------------------------|
| `AWS_REGION`              | `us-east-1`                                       | Region where the SES identity lives                      |
| `AWS_ACCESS_KEY_ID`       | `AKIAIOSFODNN7EXAMPLE`                            | IAM key with `ses:SendEmail` only                        |
| `AWS_SECRET_ACCESS_KEY`   | `wJalrXUtn...`                                    | Never log; rotate every 90 days                          |
| `EMAIL_FROM`              | `slip/scan <noreply@mail.slipscan.app>`           | Must match the verified SES identity domain              |
| `SES_CONFIGURATION_SET`   | `slipscan-transactional`                          | Must match the set created in step 2.7                   |
| `EMAIL_WORKER_ENABLED`    | `true`                                            | Set on **exactly one** node; `false` or unset on others  |

`EMAIL_WORKER_ENABLED=true` on multiple nodes is safe due to `FOR UPDATE SKIP
LOCKED` but will produce extra idle-poll load.  Recommend one.
