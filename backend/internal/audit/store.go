package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// LogEntry is a single row from audit_log as returned by List.
type LogEntry struct {
	ID             uuid.UUID        `json:"id"`
	OrganizationID *uuid.UUID       `json:"organization_id,omitempty"`
	ActorUserID    *uuid.UUID       `json:"actor_user_id,omitempty"`
	ActorTokenID   *uuid.UUID       `json:"actor_token_id,omitempty"`
	EntityType     string           `json:"entity_type"`
	EntityID       *uuid.UUID       `json:"entity_id,omitempty"`
	Action         string           `json:"action"`
	Before         json.RawMessage  `json:"before,omitempty"`
	After          json.RawMessage  `json:"after,omitempty"`
	IPAddress      *string          `json:"ip_address,omitempty"`
	UserAgent      *string          `json:"user_agent,omitempty"`
	CreatedAt      time.Time        `json:"created_at"`
}

// ListFilter holds optional filter parameters for List.
type ListFilter struct {
	// ActorUserID filters to entries by a specific actor (optional).
	ActorUserID *uuid.UUID
	// EntityType filters to a specific entity class, e.g. "transaction" (optional).
	EntityType string
	// EntityID filters to a specific entity primary key (optional).
	EntityID *uuid.UUID
	// Action filters to entries with this exact action string (optional).
	Action string
	// Since filters to entries created after this time (optional).
	Since *time.Time
	// Until filters to entries created before or at this time (optional).
	Until *time.Time
	// Limit is the maximum number of rows to return. Defaults to 100; max 1000.
	Limit int
	// Offset is the row offset for pagination.
	Offset int
}

// Store provides read access to the audit_log table.
type Store struct{ db *sql.DB }

// NewStore creates a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// List returns audit log entries for the given organization, applying any
// filters in f. Results are ordered newest-first.
func (s *Store) List(ctx context.Context, orgID uuid.UUID, f ListFilter) ([]LogEntry, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	// Build query dynamically. We keep it simple with numbered params to stay
	// on stdlib/pgx without a query builder dependency.
	args := []any{orgID}
	where := "WHERE organization_id = $1"
	n := 2 // next param index

	if f.ActorUserID != nil {
		where += andParam("actor_user_id = $", &n)
		args = append(args, *f.ActorUserID)
	}
	if f.EntityType != "" {
		where += andParam("entity_type = $", &n)
		args = append(args, f.EntityType)
	}
	if f.EntityID != nil {
		where += andParam("entity_id = $", &n)
		args = append(args, *f.EntityID)
	}
	if f.Action != "" {
		where += andParam("action = $", &n)
		args = append(args, f.Action)
	}
	if f.Since != nil {
		where += andParam("created_at > $", &n)
		args = append(args, *f.Since)
	}
	if f.Until != nil {
		where += andParam("created_at <= $", &n)
		args = append(args, *f.Until)
	}

	// Append LIMIT / OFFSET params.
	limitP := n
	n++
	offsetP := n
	args = append(args, limit, offset)

	q := `
		SELECT id, organization_id, actor_user_id, actor_token_id,
		       entity_type, entity_id,
		       action, before, after,
		       ip_address::text, user_agent,
		       created_at
		FROM audit_log
		` + where + `
		ORDER BY created_at DESC
		LIMIT $` + itoa(limitP) + ` OFFSET $` + itoa(offsetP)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []LogEntry
	for rows.Next() {
		var e LogEntry
		var orgIDN, actorN, tokenN, entityN uuid.NullUUID
		var ipN, uaN sql.NullString
		var beforeN, afterN []byte

		if err := rows.Scan(
			&e.ID, &orgIDN, &actorN, &tokenN,
			&e.EntityType, &entityN,
			&e.Action, &beforeN, &afterN,
			&ipN, &uaN,
			&e.CreatedAt,
		); err != nil {
			return nil, err
		}
		if orgIDN.Valid {
			v := orgIDN.UUID
			e.OrganizationID = &v
		}
		if actorN.Valid {
			v := actorN.UUID
			e.ActorUserID = &v
		}
		if tokenN.Valid {
			v := tokenN.UUID
			e.ActorTokenID = &v
		}
		if entityN.Valid {
			v := entityN.UUID
			e.EntityID = &v
		}
		if ipN.Valid {
			v := ipN.String
			e.IPAddress = &v
		}
		if uaN.Valid {
			v := uaN.String
			e.UserAgent = &v
		}
		if len(beforeN) > 0 {
			e.Before = json.RawMessage(beforeN)
		}
		if len(afterN) > 0 {
			e.After = json.RawMessage(afterN)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// andParam builds " AND <clause><n>" and increments *n.
func andParam(clause string, n *int) string {
	s := " AND " + clause + itoa(*n)
	*n++
	return s
}

// itoa converts an int to a decimal string without importing strconv.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := [20]byte{}
	pos := len(digits)
	for n > 0 {
		pos--
		digits[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[pos:])
}
