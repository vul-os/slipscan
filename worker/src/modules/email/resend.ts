/**
 * Resend HTTPS sender. Cloudflare Workers can't send SMTP (port 25 blocked),
 * so outbound transactional email goes through Resend's API over HTTPS.
 *   POST https://api.resend.com/emails  (Authorization: Bearer RESEND_API_KEY)
 * Drop-in replacement for the SES sender (same EmailMessage/SendResult shape +
 * isTransient), so the durable outbox + retry cron are unchanged.
 *
 * Noop: when RESEND_API_KEY or the from address is missing, log and treat the
 * message as "sent" so the outbox doesn't wedge in dev/unconfigured envs.
 */
import type { Env } from "../../bindings";

export interface EmailMessage {
  from?: string; // override; falls back to RESEND_FROM / EMAIL_FROM
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface SendResult {
  messageId: string; // Resend email id, or "" for noop
  noop: boolean;
}

export async function resendSend(env: Env, msg: EmailMessage): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY;
  const from = msg.from ?? env.RESEND_FROM ?? env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.warn("resend: RESEND_API_KEY or from address not set — noop send");
    return { messageId: "", noop: true };
  }
  if (!msg.to) throw new ResendError("resend: missing to address", false);

  const body: Record<string, unknown> = { from, to: [msg.to], subject: msg.subject };
  if (msg.html) body.html = msg.html;
  if (msg.text) body.text = msg.text;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new ResendError(`resend: HTTP ${resp.status}: ${errText.slice(0, 256)}`, isTransientStatus(resp.status));
  }
  const result = (await resp.json()) as { id?: string };
  return { messageId: result.id ?? "", noop: false };
}

export class ResendError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ResendError";
    this.transient = transient;
  }
}

/** 401/403/422 + 400 are permanent (bad key/payload); 429/5xx + unknown retry. */
export function isTransientStatus(status: number): boolean {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 422:
      return false;
    case 429:
    case 500:
    case 502:
    case 503:
      return true;
    default:
      return true;
  }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof ResendError) return err.transient;
  if (err instanceof TypeError) return true; // network/fetch error
  return true;
}
