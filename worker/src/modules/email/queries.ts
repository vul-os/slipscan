/**
 * DB queries for the email outbox — port of backend/internal/mailout/store.go.
 *
 * Uses queryRows/queryOne for simple reads and a Pool transaction for
 * claim-with-FOR-UPDATE-SKIP-LOCKED (mirrors the Go ClaimDue tx pattern).
 */
import { Pool } from "@neondatabase/serverless";
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";

// ── Row types ─────────────────────────────────────────────────────────────────

export interface EnqueueParams {
  to:             string;
  from:           string;
  subject:        string;
  htmlBody:       string;
  textBody:       string;
  kind:           string;
  organizationId?: string | null;
  userId?:         string | null;
  idempotencyKey?: string;
}

export interface OutboxJob {
  id:           string;
  toAddress:    string;
  fromAddress:  string;
  subject:      string;
  htmlBody:     string;
  textBody:     string;
  emailKind:    string;
  attempts:     number;
  maxAttempts:  number;
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Insert a pending row into email_outbox.
 * When idempotencyKey is non-empty, duplicate inserts are silently ignored
 * (ON CONFLICT DO NOTHING).
 */
export async function enqueueEmail(env: Env, p: EnqueueParams): Promise<void> {
  const q = `
    INSERT INTO email_outbox
      (to_address, from_address, subject, html_body, text_body, email_kind,
       organization_id, user_id, idempotency_key)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''))
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
  await queryRows(env, q, [
    p.to,
    p.from,
    p.subject,
    p.htmlBody,
    p.textBody,
    p.kind,
    p.organizationId ?? null,
    p.userId         ?? null,
    p.idempotencyKey ?? "",
  ]);
}

// ── ClaimDue ──────────────────────────────────────────────────────────────────

/**
 * Select up to `limit` due rows (status pending|failed, next_attempt_at <= now),
 * mark them 'sending', and return them atomically via FOR UPDATE SKIP LOCKED.
 *
 * Uses a Pool transaction — mirrors Go mailout.Store.ClaimDue.
 */
export async function claimDueJobs(env: Env, limit: number): Promise<OutboxJob[]> {
  const pool   = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id:           string;
      to_address:   string;
      from_address: string;
      subject:      string;
      html_body:    string;
      text_body:    string;
      email_kind:   string;
      attempts:     number;
      max_attempts: number;
    }>(
      `SELECT id, to_address, from_address, subject,
              COALESCE(html_body, '') AS html_body,
              COALESCE(text_body, '') AS text_body,
              email_kind, attempts, max_attempts
         FROM email_outbox
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );

    if (rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const ids = rows.map((r) => r.id);
    // Build WHERE id = ANY($1) — simpler than building positional placeholders.
    await client.query(
      `UPDATE email_outbox
          SET status = 'sending', updated_at = now()
        WHERE id = ANY($1)`,
      [ids],
    );

    await client.query("COMMIT");

    return rows.map((r) => ({
      id:          r.id,
      toAddress:   r.to_address,
      fromAddress: r.from_address,
      subject:     r.subject,
      htmlBody:    r.html_body,
      textBody:    r.text_body,
      emailKind:   r.email_kind,
      attempts:    r.attempts,
      maxAttempts: r.max_attempts,
    }));
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
    void pool.end().catch(() => {});
  }
}

// ── Mark helpers ──────────────────────────────────────────────────────────────

export async function markSent(env: Env, id: string, providerMessageId: string): Promise<void> {
  await queryRows(
    env,
    `UPDATE email_outbox
        SET status = 'sent',
            provider_message_id = $2,
            sent_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [id, providerMessageId],
  );
}

export async function markRetry(
  env:           Env,
  id:            string,
  attempts:      number,
  nextAttemptAt: Date,
  lastErr:       string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE email_outbox
        SET status = 'failed',
            attempts = $2,
            next_attempt_at = $3,
            last_error = $4,
            updated_at = now()
      WHERE id = $1`,
    [id, attempts, nextAttemptAt.toISOString(), lastErr],
  );
}

export async function markDead(env: Env, id: string, lastErr: string): Promise<void> {
  await queryRows(
    env,
    `UPDATE email_outbox
        SET status = 'dead',
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, lastErr],
  );
}

// ── Suppression ───────────────────────────────────────────────────────────────

export async function isSuppressed(env: Env, address: string): Promise<boolean> {
  const row = await queryOne(
    env,
    `SELECT EXISTS(SELECT 1 FROM email_suppressions WHERE address = $1) AS exists`,
    [address],
  );
  return row ? (row.exists as boolean) : false;
}

export async function suppressAddress(
  env:     Env,
  address: string,
  reason:  string,
  detail:  string,
): Promise<void> {
  const trimmed = address.trim();
  await queryRows(
    env,
    `INSERT INTO email_suppressions (address, reason, detail)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE
       SET reason = EXCLUDED.reason,
           detail = EXCLUDED.detail`,
    [trimmed, reason, detail],
  );
}
