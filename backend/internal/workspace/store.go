// Package workspace implements P4-01: accountant multi-client workspace.
// GET /workspace returns every org a user belongs to with per-org attention
// metrics (unverified transactions, unmatched statement lines, pending
// documents, suggested reconciliation matches).
package workspace

import (
	"context"
	"database/sql"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/org"
)

// Attention holds cheap COUNT metrics scoped to a single org.
type Attention struct {
	UnverifiedTransactions int `json:"unverified_transactions"`
	UnmatchedLines         int `json:"unmatched_lines"`
	PendingDocuments       int `json:"pending_documents"`
	SuggestedMatches       int `json:"suggested_matches"`
}

// OrgEntry is a single row in the workspace response.
type OrgEntry struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Kind      org.Kind   `json:"kind"`
	Role      org.Role   `json:"role"`
	Attention Attention  `json:"attention"`
}

// Store owns the workspace aggregation query.
type Store struct{ db *sql.DB }

// NewStore constructs a Store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ForUser returns one OrgEntry per org the user belongs to, each enriched
// with per-org attention counts. The query is a single round-trip: it
// aggregates all four metrics inside one CTE and emits one row per org.
//
// Metric definitions:
//
//	unverified_transactions — transactions with status NOT IN ('verified')
//	                          (i.e. pending or rejected, meaning not yet signed off)
//	unmatched_lines         — statement_lines with no active reconciliation match
//	                          (no row in reconciliation_matches where state != 'rejected')
//	pending_documents       — documents with status IN ('pending', 'processing')
//	suggested_matches       — reconciliation_matches with state = 'suggested'
func (s *Store) ForUser(ctx context.Context, userID uuid.UUID) ([]OrgEntry, error) {
	const q = `
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
			COALESCE(uv.n,  0) AS unverified_transactions,
			COALESCE(um.n,  0) AS unmatched_lines,
			COALESCE(pd.n,  0) AS pending_documents,
			COALESCE(sg.n,  0) AS suggested_matches
		FROM member_orgs mo
		LEFT JOIN unverified    uv ON uv.organization_id = mo.id
		LEFT JOIN unmatched     um ON um.organization_id = mo.id
		LEFT JOIN pending_docs  pd ON pd.organization_id = mo.id
		LEFT JOIN suggested     sg ON sg.organization_id = mo.id
		ORDER BY mo.name
	`
	rows, err := s.db.QueryContext(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []OrgEntry
	for rows.Next() {
		var e OrgEntry
		if err := rows.Scan(
			&e.ID, &e.Name, &e.Kind, &e.Role,
			&e.Attention.UnverifiedTransactions,
			&e.Attention.UnmatchedLines,
			&e.Attention.PendingDocuments,
			&e.Attention.SuggestedMatches,
		); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
