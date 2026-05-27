/**
 * Audit module types — mirrors Go internal/audit store.go shapes.
 * The audit_log table is APPEND-ONLY (Postgres RULE blocks UPDATE/DELETE).
 * These are the DB-layer and HTTP response types.
 */

/** Single audit_log row as returned by List. Mirrors Go audit.LogEntry. */
export interface LogEntry {
  id: string;
  organization_id?: string;
  actor_user_id?: string;
  actor_token_id?: string;
  entity_type: string;
  entity_id?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

/** Optional filter parameters for the List query. Mirrors Go audit.ListFilter. */
export interface ListFilter {
  actor_user_id?: string;
  entity_type?: string;
  entity_id?: string;
  action?: string;
  since?: string; // RFC3339
  until?: string; // RFC3339
  limit?: number; // default 100, max 1000
  offset?: number;
}
