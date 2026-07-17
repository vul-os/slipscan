/**
 * Non-fatal audit-log emission helper.
 *
 * `emitAudit` fires an audit write in the background via
 * `ctx.waitUntil` when available, or as an awaited-but-caught write
 * otherwise.  The primary mutation is NEVER blocked or rolled back
 * because of an audit failure.
 *
 * Design notes:
 * - We use `queryRows` (bare Neon HTTP, no pooled transaction) for audit
 *   writes so they are never entangled with the primary mutation's
 *   transaction.  The audit_log table's Postgres RULES already block any
 *   UPDATE/DELETE, so we never need the wrapping `withOrg` RLS context.
 * - `before` must always be captured BEFORE the primary mutation.
 * - `after` is captured after, or derived from the return value.
 */

import { queryRows } from "../../db/client";
import type { Env } from "../../bindings";

export interface AuditEntry {
  organization_id?: string | null;
  actor_user_id?: string | null;
  actor_token_id?: string | null;
  entity_type: string;
  entity_id?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  ip_address?: string;
  user_agent?: string;
}

/**
 * Build a Query-compatible wrapper around the bare Neon HTTP client so it
 * can be passed to writeAuditLog directly.
 */
function makeQueryFn(env: Env) {
  return (text: string, params: unknown[] = []) => queryRows(env, text, params);
}

/**
 * Write an audit entry non-fatally.
 *
 * If `ctx` (Cloudflare ExecutionContext) is available the write is deferred
 * via `waitUntil` so it cannot delay the response. If not, we await-and-catch
 * so the primary mutation is never aborted.
 */
export function emitAudit(
  env: Env,
  entry: AuditEntry,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void } | null,
): void {
  const write = (async () => {
    const q = makeQueryFn(env);
    await q(
      `INSERT INTO audit_log
         (organization_id, actor_user_id, actor_token_id,
          entity_type, entity_id,
          action, before, after,
          ip_address, user_agent,
          created_at)
       VALUES
         ($1, $2, $3,
          $4, $5,
          $6, $7, $8,
          NULLIF($9, '')::inet, NULLIF($10, ''),
          NOW())`,
      [
        entry.organization_id ?? null,
        entry.actor_user_id ?? null,
        entry.actor_token_id ?? null,
        entry.entity_type,
        entry.entity_id ?? null,
        entry.action,
        entry.before != null ? JSON.stringify(entry.before) : null,
        entry.after != null ? JSON.stringify(entry.after) : null,
        entry.ip_address ?? "",
        entry.user_agent ?? "",
      ],
    );
  })().catch((err) => {
    // Audit failures are logged but never surfaced to the caller.
    console.error("audit emit failed:", entry.action, err);
  });

  if (ctx?.waitUntil) {
    ctx.waitUntil(write);
  }
  // If no ctx, the promise still runs — `.catch` above ensures it is non-fatal.
}
