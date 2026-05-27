/**
 * Mailer — port of backend/internal/mailout/queue.go.
 *
 * enqueue(env, params) inserts a pending row into email_outbox.
 * The delivery worker (outbox.ts cron) handles actual sending asynchronously.
 *
 * Other modules (auth, invitations) should call enqueue() directly;
 * do NOT import this module from outbox.ts.
 */
import type { Env } from "../../bindings";
import { enqueueEmail } from "./queries";

export interface EnqueueInput {
  to:              string;
  subject:         string;
  html:            string;
  text:            string;
  kind:            string;       // e.g. "transactional", "invite", "verify"
  from?:           string;       // defaults to EMAIL_FROM
  organizationId?: string | null;
  userId?:         string | null;
  idempotencyKey?: string;
}

/**
 * Enqueue an email for async delivery via the outbox cron.
 * Inserts a pending row into email_outbox; returns immediately.
 * When idempotencyKey is set, duplicate enqueues are silently ignored.
 *
 * Throws if from address is unresolvable (no fallback available).
 */
export async function enqueue(env: Env, params: EnqueueInput): Promise<void> {
  const from = params.from ?? env.EMAIL_FROM;
  if (!from) {
    throw new Error("mailer: enqueue: missing from address (set EMAIL_FROM)");
  }

  await enqueueEmail(env, {
    to:             params.to,
    from,
    subject:        params.subject,
    htmlBody:       params.html,
    textBody:       params.text,
    kind:           params.kind,
    organizationId: params.organizationId ?? null,
    userId:         params.userId         ?? null,
    idempotencyKey: params.idempotencyKey,
  });
}
