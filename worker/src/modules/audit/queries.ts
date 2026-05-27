/**
 * Raw parameterized SQL — ported 1:1 from Go internal/audit/store.go.
 * audit_log is APPEND-ONLY: only INSERT and SELECT are performed here.
 * Every org query includes WHERE organization_id = $ (belt-and-suspenders).
 */
import type { Query } from "../../db/client";
import type { LogEntry, ListFilter } from "./types";

/**
 * List audit log entries for an org with optional filters.
 * Results are ordered newest-first. Mirrors Go (*Store).List.
 *
 * NOTE: Uses queryRows (no RLS transaction needed; table-owner connection
 * has INSERT + SELECT only on audit_log). Caller passes a query fn from
 * withOrg if transactional isolation is needed, or a bare queryRows wrapper.
 */
export async function listAuditLog(
  q: Query,
  orgId: string,
  f: ListFilter,
): Promise<LogEntry[]> {
  let limit = f.limit ?? 100;
  if (limit <= 0) limit = 100;
  if (limit > 1000) limit = 1000;
  let offset = f.offset ?? 0;
  if (offset < 0) offset = 0;

  // Build parameterized WHERE clause dynamically (mirrors Go's andParam helper).
  const params: unknown[] = [orgId];
  let where = "WHERE organization_id = $1";
  let n = 2;

  if (f.actor_user_id) {
    where += ` AND actor_user_id = $${n++}`;
    params.push(f.actor_user_id);
  }
  if (f.entity_type) {
    where += ` AND entity_type = $${n++}`;
    params.push(f.entity_type);
  }
  if (f.entity_id) {
    where += ` AND entity_id = $${n++}`;
    params.push(f.entity_id);
  }
  if (f.action) {
    where += ` AND action = $${n++}`;
    params.push(f.action);
  }
  if (f.since) {
    where += ` AND created_at > $${n++}`;
    params.push(f.since);
  }
  if (f.until) {
    where += ` AND created_at <= $${n++}`;
    params.push(f.until);
  }

  params.push(limit, offset);
  const limitP = n++;
  const offsetP = n;

  const sql = `
    SELECT
      id,
      organization_id::text,
      actor_user_id::text,
      actor_token_id::text,
      entity_type,
      entity_id::text,
      action,
      before,
      after,
      ip_address::text,
      user_agent,
      created_at
    FROM audit_log
    ${where}
    ORDER BY created_at DESC
    LIMIT $${limitP} OFFSET $${offsetP}
  `;

  const rows = await q(sql, params);

  return rows.map((r): LogEntry => {
    const e: LogEntry = {
      id: r.id as string,
      entity_type: r.entity_type as string,
      action: r.action as string,
      created_at: r.created_at instanceof Date
        ? (r.created_at as Date).toISOString()
        : String(r.created_at),
    };
    if (r.organization_id != null) e.organization_id = r.organization_id as string;
    if (r.actor_user_id != null) e.actor_user_id = r.actor_user_id as string;
    if (r.actor_token_id != null) e.actor_token_id = r.actor_token_id as string;
    if (r.entity_id != null) e.entity_id = r.entity_id as string;
    if (r.before != null) e.before = r.before;
    if (r.after != null) e.after = r.after;
    if (r.ip_address != null) e.ip_address = r.ip_address as string;
    if (r.user_agent != null) e.user_agent = r.user_agent as string;
    return e;
  });
}

/**
 * Append a single entry to audit_log (INSERT only — no UPDATE/DELETE).
 * Non-fatal: callers should log but not abort the primary operation.
 * Mirrors Go audit.Write.
 */
export async function writeAuditLog(
  q: Query,
  entry: {
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
  },
): Promise<void> {
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
}
