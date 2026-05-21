// Package audit provides the append-only audit trail for P4-03.
//
// # Append-only enforcement
//
// The audit_log table has no UPDATE or DELETE paths in the application code.
// Enforce this at the database layer with a PostgreSQL policy / trigger:
//
//	CREATE RULE no_update_audit_log AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
//	CREATE RULE no_delete_audit_log AS ON DELETE TO audit_log DO INSTEAD NOTHING;
//
// Alternatively, grant INSERT + SELECT to the app role and revoke UPDATE/DELETE:
//
//	REVOKE UPDATE, DELETE ON audit_log FROM slipscan_app;
//
// The migration 20260521000001_audit_log_append_only.sql implements this for
// production. In development the constraint is advisory; the Write helper itself
// only ever INSERTs.
//
// # Usage
//
//	entry := audit.Entry{
//	    OrganizationID: orgID,
//	    ActorUserID:    &userID,
//	    EntityType:     "transaction",
//	    EntityID:       &txID,
//	    Action:         "classification.corrected",
//	    Before:         beforeJSON,  // optional
//	    After:          afterJSON,   // optional
//	    IPAddress:      r.RemoteAddr,
//	    UserAgent:      r.Header.Get("User-Agent"),
//	}
//	if err := audit.Write(ctx, db, entry); err != nil {
//	    log.Printf("audit: write failed: %v", err) // non-fatal; log and continue
//	}
package audit

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/google/uuid"
)

// Entry describes a single audit log record.
type Entry struct {
	// OrganizationID scopes the entry; nil for system-level events.
	OrganizationID *uuid.UUID
	// ActorUserID is the authenticated user who triggered the mutation; nil for
	// system / background jobs.
	ActorUserID *uuid.UUID
	// ActorTokenID is the API token that authenticated the request, when
	// relevant.
	ActorTokenID *uuid.UUID
	// EntityType is a short, stable string naming the entity class, e.g.
	// "transaction", "membership", "invitation".
	EntityType string
	// EntityID is the primary key of the affected row; nil for bulk operations
	// or entity-less events.
	EntityID *uuid.UUID
	// Action is a dot-separated verb string, e.g. "classification.corrected",
	// "membership.added", "invitation.revoked".
	Action string
	// Before is the JSON snapshot of the entity before the mutation. Use
	// MarshalBefore to convert a Go struct.
	Before json.RawMessage
	// After is the JSON snapshot of the entity after the mutation.
	After json.RawMessage
	// IPAddress is the requester's address (best-effort; may be empty for
	// background jobs).
	IPAddress string
	// UserAgent is the requester's User-Agent header value (best-effort).
	UserAgent string
}

// Querier is the minimal database interface needed by Write. Both *sql.DB and
// *sql.Tx satisfy it, so audit writes can run inside or outside a transaction.
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Write appends a single entry to the audit_log table. It is intentionally
// non-fatal: callers should log the error but not abort the primary operation.
// Pass a *sql.Tx to include the write in the same transaction as the mutation
// (preferred for atomicity). Pass a *sql.DB to write outside a transaction
// (useful when the mutation has already committed).
func Write(ctx context.Context, q Querier, e Entry) error {
	const stmt = `
		INSERT INTO audit_log
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
			 NOW())
	`
	_, err := q.ExecContext(ctx, stmt,
		nullUUID(e.OrganizationID),
		nullUUID(e.ActorUserID),
		nullUUID(e.ActorTokenID),
		e.EntityType,
		nullUUID(e.EntityID),
		e.Action,
		nullJSON(e.Before),
		nullJSON(e.After),
		e.IPAddress,
		e.UserAgent,
	)
	return err
}

// MarshalBefore marshals v as JSON for use as Entry.Before. Errors are
// silently swallowed and return nil (missing before-snapshot is tolerable).
func MarshalBefore(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// MarshalAfter is the same as MarshalBefore but semantically for the after
// snapshot. Provided as a separate function for call-site readability.
func MarshalAfter(v any) json.RawMessage { return MarshalBefore(v) }

// nullUUID converts *uuid.UUID to a value that pgx stores as NULL when nil.
func nullUUID(u *uuid.UUID) any {
	if u == nil {
		return nil
	}
	return *u
}

// nullJSON converts a json.RawMessage to nil when it is empty, so the driver
// stores NULL rather than an empty byte slice.
func nullJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return []byte(b)
}
