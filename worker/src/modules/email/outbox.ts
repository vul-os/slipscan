/**
 * Outbox delivery cron — port of backend/internal/mailout/worker.go.
 *
 * deliverOutbox(env):
 *   Claims up to CLAIM_BATCH_SIZE due email_outbox rows (FOR UPDATE SKIP LOCKED),
 *   checks suppression, sends via SES v2 HTTPS (or noop when unconfigured),
 *   and marks each row sent / retried (exponential backoff) / dead.
 *
 * Wire into cron/scheduled.ts — e.g. every minute or every 5 minutes.
 * The cron trigger replaces the Go ticker polling loop.
 *
 * Backoff formula (matches Go nextAttempt):
 *   delay = min(2^attempts minutes, 6 hours) + up to 10 % jitter
 */
import type { Env } from "../../bindings";
import {
  claimDueJobs,
  markSent,
  markRetry,
  markDead,
  isSuppressed,
} from "./queries";
import { resendSend, isTransient } from "./resend";
import type { OutboxJob } from "./queries";

// ── Constants (mirrors Go mailout/worker.go) ──────────────────────────────────

const CLAIM_BATCH_SIZE = 20;
const MAX_BACKOFF_MS   = 6 * 60 * 60 * 1000; // 6 hours in ms

// ── Main cron entry-point ─────────────────────────────────────────────────────

/**
 * Claim due outbox rows and deliver them.
 * Exported for wiring in the Worker's scheduled() handler.
 */
export async function deliverOutbox(env: Env): Promise<void> {
  let jobs: OutboxJob[];
  try {
    jobs = await claimDueJobs(env, CLAIM_BATCH_SIZE);
  } catch (e) {
    console.error("mailout: claim due:", e);
    return;
  }

  if (jobs.length === 0) return;
  console.log(`mailout: delivering ${jobs.length} job(s)`);

  // Deliver concurrently; each job is independent.
  await Promise.allSettled(jobs.map((j) => deliver(env, j)));
}

// ── Per-job delivery ──────────────────────────────────────────────────────────

async function deliver(env: Env, j: OutboxJob): Promise<void> {
  // 1. Suppression check.
  let suppressed: boolean;
  try {
    suppressed = await isSuppressed(env, j.toAddress);
  } catch (e) {
    // Treat as transient — leave in 'sending'; next claim will pick it up.
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn(`mailout: suppression check id=${j.id}: ${errMsg}`);
    await markRetry(env, j.id, j.attempts + 1, nextAttemptAt(j.attempts + 1), `suppression check error: ${errMsg}`).catch(
      (er) => console.error(`mailout: mark retry id=${j.id}:`, er),
    );
    return;
  }

  if (suppressed) {
    console.log(`mailout: address suppressed id=${j.id} to=${j.toAddress}`);
    await markDead(env, j.id, "address is suppressed").catch(
      (e) => console.error(`mailout: mark dead id=${j.id}:`, e),
    );
    return;
  }

  // 2. Send.
  const attempts = j.attempts + 1;
  try {
    const result = await resendSend(env, {
      from:    j.fromAddress,
      to:      j.toAddress,
      subject: j.subject,
      html:    j.htmlBody || undefined,
      text:    j.textBody || undefined,
    });

    await markSent(env, j.id, result.messageId).catch(
      (e) => console.error(`mailout: mark sent id=${j.id}:`, e),
    );
    if (result.noop) {
      console.log(`mailout: noop-sent id=${j.id}`);
    }
  } catch (sendErr) {
    await handleFailure(env, j, attempts, sendErr);
  }
}

// ── Failure handler ───────────────────────────────────────────────────────────

async function handleFailure(env: Env, j: OutboxJob, attempts: number, sendErr: unknown): Promise<void> {
  const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
  console.warn(`mailout: send error id=${j.id} attempt=${attempts}: ${errMsg}`);

  if (!isTransient(sendErr)) {
    // Permanent failure — dead-letter immediately.
    await markDead(env, j.id, errMsg).catch(
      (e) => console.error(`mailout: mark dead id=${j.id}:`, e),
    );
    return;
  }

  // Transient failure — exponential backoff or dead-letter if exhausted.
  if (attempts >= j.maxAttempts) {
    await markDead(env, j.id, errMsg).catch(
      (e) => console.error(`mailout: mark dead id=${j.id}:`, e),
    );
    return;
  }

  const next = nextAttemptAt(attempts);
  await markRetry(env, j.id, attempts, next, errMsg).catch(
    (e) => console.error(`mailout: mark retry id=${j.id}:`, e),
  );
}

// ── Backoff ───────────────────────────────────────────────────────────────────

/**
 * Compute next attempt time with exponential backoff.
 * Formula: min(2^attempts minutes, 6h) + up to 10% jitter.
 * Matches Go nextAttempt() in mailout/worker.go.
 */
export function nextAttemptAt(attempts: number): Date {
  const baseMs = Math.min(Math.pow(2, attempts) * 60_000, MAX_BACKOFF_MS);
  // ±10 % jitter (Go uses rand.Int63n(base/10 + 1), i.e. 0..base/10)
  const jitterMs = Math.random() * (baseMs / 10);
  return new Date(Date.now() + baseMs + jitterMs);
}
