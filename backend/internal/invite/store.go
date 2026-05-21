package invite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/org"
)

var (
	ErrPendingExists = errors.New("pending invitation already exists for this email")
	ErrNotFound      = errors.New("invitation not found")
	ErrExpired       = errors.New("invitation expired")
	ErrConsumed      = errors.New("invitation already accepted or revoked")
	ErrEmailMismatch = errors.New("invitation email does not match caller")
)

type Invitation struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Email          string
	Role           org.Role
	InvitedBy      uuid.NullUUID
	ExpiresAt      time.Time
	AcceptedAt     sql.NullTime
	AcceptedBy     uuid.NullUUID
	RevokedAt      sql.NullTime
	CreatedAt      time.Time
}

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Create(ctx context.Context, orgID uuid.UUID, email string, role org.Role, invitedBy uuid.UUID, tokenHash string, expiresAt time.Time) (*Invitation, error) {
	const q = `
		INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, email, role, invited_by, expires_at,
		          accepted_at, accepted_by, revoked_at, created_at
	`
	row := s.db.QueryRowContext(ctx, q, orgID, email, role, tokenHash, invitedBy, expiresAt)
	inv, err := scan(row)
	if err != nil {
		if isUniqueViolation(err) {
			// Could be the pending-uniqueness partial index OR token_hash
			// collision. The former is overwhelmingly the likely case.
			return nil, ErrPendingExists
		}
		return nil, err
	}
	return inv, nil
}

func (s *Store) ListPending(ctx context.Context, orgID uuid.UUID) ([]Invitation, error) {
	const q = `
		SELECT id, organization_id, email, role, invited_by, expires_at,
		       accepted_at, accepted_by, revoked_at, created_at
		FROM invitations
		WHERE organization_id = $1
		  AND accepted_at IS NULL
		  AND revoked_at IS NULL
		ORDER BY created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Invitation
	for rows.Next() {
		inv, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *inv)
	}
	return out, rows.Err()
}

func (s *Store) Revoke(ctx context.Context, orgID, inviteID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE invitations
		SET revoked_at = NOW()
		WHERE id = $1 AND organization_id = $2
		  AND accepted_at IS NULL AND revoked_at IS NULL
	`, inviteID, orgID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// AcceptByTokenHash atomically validates an invitation and creates the
// membership. It runs inside a single transaction so a user can't redeem
// the same invite twice in parallel. callerEmail must match the
// invitation's email (case-insensitive) — pass the authenticated user's
// stored email; the store does not look it up.
func (s *Store) AcceptByTokenHash(ctx context.Context, tokenHash string, userID uuid.UUID, callerEmail string) (*Invitation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	const lookup = `
		SELECT id, organization_id, email, role, invited_by, expires_at,
		       accepted_at, accepted_by, revoked_at, created_at
		FROM invitations
		WHERE token_hash = $1
		FOR UPDATE
	`
	row := tx.QueryRowContext(ctx, lookup, tokenHash)
	inv, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if inv.AcceptedAt.Valid || inv.RevokedAt.Valid {
		return nil, ErrConsumed
	}
	if time.Now().After(inv.ExpiresAt) {
		return nil, ErrExpired
	}
	if !strings.EqualFold(strings.TrimSpace(callerEmail), inv.Email) {
		return nil, ErrEmailMismatch
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (organization_id, user_id) DO NOTHING
	`, inv.OrganizationID, userID, inv.Role); err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE invitations
		SET accepted_at = NOW(), accepted_by = $2
		WHERE id = $1
	`, inv.ID, userID); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	now := time.Now()
	inv.AcceptedAt = sql.NullTime{Time: now, Valid: true}
	inv.AcceptedBy = uuid.NullUUID{UUID: userID, Valid: true}
	return inv, nil
}

// Resend rotates the token_hash and pushes expires_at forward on a
// pending invitation. The previous link stops working immediately. We
// scope the update with the same "still pending" predicate Revoke uses,
// so accepted/revoked invites can't be resurrected.
func (s *Store) Resend(ctx context.Context, orgID, inviteID uuid.UUID, newTokenHash string, newExpiresAt time.Time) (*Invitation, error) {
	const q = `
		UPDATE invitations
		SET token_hash = $3, expires_at = $4
		WHERE id = $1 AND organization_id = $2
		  AND accepted_at IS NULL AND revoked_at IS NULL
		RETURNING id, organization_id, email, role, invited_by, expires_at,
		          accepted_at, accepted_by, revoked_at, created_at
	`
	row := s.db.QueryRowContext(ctx, q, inviteID, orgID, newTokenHash, newExpiresAt)
	inv, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return inv, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scan(row scanner) (*Invitation, error) {
	var inv Invitation
	if err := row.Scan(
		&inv.ID, &inv.OrganizationID, &inv.Email, &inv.Role,
		&inv.InvitedBy, &inv.ExpiresAt,
		&inv.AcceptedAt, &inv.AcceptedBy, &inv.RevokedAt, &inv.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &inv, nil
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "SQLSTATE 23505") || strings.Contains(s, "unique constraint")
}
