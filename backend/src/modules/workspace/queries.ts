/**
 * Workspace queries — port of Go backend/internal/workspace/store.go.
 *
 * Single CTE round-trip: returns one OrgEntry per org the user belongs to,
 * each enriched with per-org attention counts.
 *
 * Metric definitions (ported verbatim from Go comments):
 *   unverified_transactions — transactions with status <> 'verified'
 *   unmatched_lines         — statement_lines with no active recon match (state != 'rejected')
 *   pending_documents       — documents with status IN ('pending', 'processing')
 *   suggested_matches       — reconciliation_matches with state = 'suggested'
 */
import type { Env } from "../../bindings";
import { queryRows } from "../../db/client";
import type { OrgEntry } from "./types";
import type { OrganizationKind, Role } from "../../types/schema";

/**
 * Returns one OrgEntry per org the user belongs to.
 * User-scoped: no org context, uses userId directly.
 * Port of Go Store.ForUser — single CTE.
 */
export async function forUser(env: Env, userId: string): Promise<OrgEntry[]> {
  const rows = await queryRows(env, `
    WITH member_orgs AS (
      SELECT o.id, o.name, o.kind, m.role
      FROM organizations o
      JOIN memberships m ON m.organization_id = o.id
      WHERE m.user_id = $1
    ),
    unverified AS (
      SELECT organization_id, COUNT(*) AS n
      FROM transactions
      WHERE organization_id IN (SELECT id FROM member_orgs)
        AND status <> 'verified'
      GROUP BY organization_id
    ),
    unmatched AS (
      SELECT sl.organization_id, COUNT(*) AS n
      FROM statement_lines sl
      WHERE sl.organization_id IN (SELECT id FROM member_orgs)
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_matches rm
          WHERE rm.statement_line_id = sl.id
            AND rm.state <> 'rejected'
        )
      GROUP BY sl.organization_id
    ),
    pending_docs AS (
      SELECT organization_id, COUNT(*) AS n
      FROM documents
      WHERE organization_id IN (SELECT id FROM member_orgs)
        AND status IN ('pending', 'processing')
      GROUP BY organization_id
    ),
    suggested AS (
      SELECT organization_id, COUNT(*) AS n
      FROM reconciliation_matches
      WHERE organization_id IN (SELECT id FROM member_orgs)
        AND state = 'suggested'
      GROUP BY organization_id
    )
    SELECT
      mo.id,
      mo.name,
      mo.kind,
      mo.role,
      COALESCE(uv.n, 0)::int AS unverified_transactions,
      COALESCE(um.n, 0)::int AS unmatched_lines,
      COALESCE(pd.n, 0)::int AS pending_documents,
      COALESCE(sg.n, 0)::int AS suggested_matches
    FROM member_orgs mo
    LEFT JOIN unverified   uv ON uv.organization_id = mo.id
    LEFT JOIN unmatched    um ON um.organization_id = mo.id
    LEFT JOIN pending_docs pd ON pd.organization_id = mo.id
    LEFT JOIN suggested    sg ON sg.organization_id = mo.id
    ORDER BY mo.name
  `, [userId]);

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind) as OrganizationKind,
    role: String(r.role) as Role,
    attention: {
      unverified_transactions: Number(r.unverified_transactions),
      unmatched_lines: Number(r.unmatched_lines),
      pending_documents: Number(r.pending_documents),
      suggested_matches: Number(r.suggested_matches),
    },
  }));
}
