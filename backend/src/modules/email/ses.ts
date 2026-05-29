/**
 * SES v2 HTTPS sender — port of backend/internal/email/ses.go.
 *
 * Uses aws4fetch (AwsClient) for SigV4 request signing instead of the AWS SDK.
 * The SES v2 SendEmail API endpoint is:
 *   POST https://email.<region>.amazonaws.com/v2/email/outbound-emails
 * with a JSON body matching the SES v2 SendEmail request shape.
 *
 * NoopSender: when AWS_REGION or EMAIL_FROM is absent we log and return,
 * treating the message as "sent" so the outbox marks it sent without delivery.
 */

import { AwsClient } from "aws4fetch";
import type { Env } from "../../bindings";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmailMessage {
  from?:    string; // override; falls back to EMAIL_FROM
  to:       string;
  subject:  string;
  html?:    string;
  text?:    string;
}

export interface SendResult {
  messageId: string; // SES MessageId, or "" for noop
  noop:      boolean;
}

// ── SES v2 JSON request shape ────────────────────────────────────────────────

interface SESContent {
  Data: string;
}
interface SESBody {
  Html?: { Data: string };
  Text?: { Data: string };
}
interface SESSimpleMessage {
  Subject: SESContent;
  Body:    SESBody;
}
interface SESEmailContent {
  Simple: SESSimpleMessage;
}
interface SESDestination {
  ToAddresses: string[];
}
interface SESSendRequest {
  FromEmailAddress: string;
  Destination:      SESDestination;
  Content:          SESEmailContent;
  ConfigurationSetName?: string;
}

// ── Public send function ──────────────────────────────────────────────────────

/**
 * Send an email via SES v2 HTTPS using aws4fetch SigV4 signing.
 * Returns { messageId, noop:false } on success.
 * Returns { messageId:"", noop:true } when SES is not configured.
 * Throws SesError on a permanent SES API error.
 */
export async function sesSend(env: Env, msg: EmailMessage): Promise<SendResult> {
  // Noop path: SES not configured.
  if (!env.AWS_REGION || !env.EMAIL_FROM) {
    console.warn("ses: AWS_REGION or EMAIL_FROM not set — noop send");
    return { messageId: "", noop: true };
  }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.warn("ses: AWS credentials not set — noop send");
    return { messageId: "", noop: true };
  }

  const from = msg.from ?? env.EMAIL_FROM;
  if (!from) throw new SesError("ses: missing from address", false);
  if (!msg.to) throw new SesError("ses: missing to address", false);

  const body: SESSendRequest = buildSendRequest(from, msg, env.SES_CONFIGURATION_SET);

  const url = `https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`;

  const aws = new AwsClient({
    accessKeyId:     env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region:          env.AWS_REGION,
    service:         "ses",
  });

  const bodyStr = JSON.stringify(body);
  const resp = await aws.fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    bodyStr,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const transient = isTransientStatus(resp.status);
    throw new SesError(
      `ses: HTTP ${resp.status}: ${errText.slice(0, 256)}`,
      transient,
    );
  }

  const result = (await resp.json()) as { MessageId?: string };
  return { messageId: result.MessageId ?? "", noop: false };
}

// ── Request builder (pure, testable) ─────────────────────────────────────────

/**
 * Build the SES v2 SendEmail JSON body.
 * Pure function — no side effects, suitable for unit tests.
 */
export function buildSendRequest(
  from:             string,
  msg:              EmailMessage,
  configurationSet?: string,
): SESSendRequest {
  const body: SESBody = {};
  if (msg.html) body.Html = { Data: msg.html };
  if (msg.text) body.Text = { Data: msg.text };

  const req: SESSendRequest = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [msg.to] },
    Content: {
      Simple: {
        Subject: { Data: msg.subject },
        Body:    body,
      },
    },
  };

  if (configurationSet) req.ConfigurationSetName = configurationSet;

  return req;
}

// ── SesError ─────────────────────────────────────────────────────────────────

/** Thrown by sesSend on API errors. transient=true → retry; false → dead-letter. */
export class SesError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name      = "SesError";
    this.transient = transient;
  }
}

// ── isTransient helper ────────────────────────────────────────────────────────

/**
 * Classify an SES HTTP response status as transient or permanent.
 * Mirrors Go email.IsTransient:
 *   - 429 (TooManyRequests), 500, 503 → transient (retry)
 *   - 400, 403, 422 → permanent (dead-letter)
 *   - Others → transient (unknown errors get a retry)
 */
export function isTransientStatus(status: number): boolean {
  switch (status) {
    case 400: // Bad request — permanent
    case 403: // Forbidden / account suspended — permanent
    case 422: // Unprocessable — permanent
      return false;
    case 429: // Throttled → retry
    case 500:
    case 503:
      return true;
    default:
      return true; // unknown → transient
  }
}

/**
 * Classify any error as transient or permanent.
 * SesError carries its own flag; fetch network errors are transient.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof SesError) return err.transient;
  // Network / fetch errors (TypeError) are transient.
  if (err instanceof TypeError) return true;
  // Everything else defaults to transient so it gets a retry.
  return true;
}
