package org

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

func (r Role) Valid() bool { return r == RoleAdmin || r == RoleMember }

var (
	ErrNotFound  = errors.New("organization not found")
	ErrSlugTaken = errors.New("slug already in use")
	ErrForbidden = errors.New("forbidden")
)

type Organization struct {
	ID        uuid.UUID
	Name      string
	Slug      string
	CreatedBy uuid.NullUUID
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Member struct {
	UserID   uuid.UUID
	Email    string
	FullName sql.NullString
	Role     Role
	JoinedAt time.Time
}

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create inserts an organization and the creator's admin membership in a
// single transaction. Both rows commit together, so a partially-created
// org with no admin can never exist.
func (s *Store) Create(ctx context.Context, name, slug string, createdBy uuid.UUID) (*Organization, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	const insertOrg = `
		INSERT INTO organizations (name, slug, created_by)
		VALUES ($1, $2, $3)
		RETURNING id, name, slug, created_by, created_at, updated_at
	`
	var o Organization
	if err := tx.QueryRowContext(ctx, insertOrg, name, slug, createdBy).Scan(
		&o.ID, &o.Name, &o.Slug, &o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
	); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSlugTaken
		}
		return nil, err
	}

	const insertMember = `
		INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, 'admin')
	`
	if _, err := tx.ExecContext(ctx, insertMember, o.ID, createdBy); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &o, nil
}

// ListForUser returns every organization the user belongs to, plus their
// role in each one.
func (s *Store) ListForUser(ctx context.Context, userID uuid.UUID) ([]OrgWithRole, error) {
	const q = `
		SELECT o.id, o.name, o.slug, o.created_by, o.created_at, o.updated_at,
		       m.role, m.joined_at
		FROM organizations o
		JOIN memberships m ON m.organization_id = o.id
		WHERE m.user_id = $1
		ORDER BY m.joined_at ASC
	`
	rows, err := s.db.QueryContext(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []OrgWithRole
	for rows.Next() {
		var o OrgWithRole
		if err := rows.Scan(
			&o.ID, &o.Name, &o.Slug, &o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
			&o.Role, &o.JoinedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

type OrgWithRole struct {
	Organization
	Role     Role
	JoinedAt time.Time
}

// ByID fetches a single organization by id. Returns ErrNotFound when the
// row is absent.
func (s *Store) ByID(ctx context.Context, orgID uuid.UUID) (*Organization, error) {
	const q = `
		SELECT id, name, slug, created_by, created_at, updated_at
		FROM organizations
		WHERE id = $1
	`
	var o Organization
	err := s.db.QueryRowContext(ctx, q, orgID).Scan(
		&o.ID, &o.Name, &o.Slug, &o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// MemberRole returns the role the user has in the given organization, or
// ErrForbidden if no membership exists.
func (s *Store) MemberRole(ctx context.Context, orgID, userID uuid.UUID) (Role, error) {
	var role Role
	err := s.db.QueryRowContext(ctx,
		`SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2`,
		orgID, userID,
	).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrForbidden
	}
	return role, err
}

func (s *Store) ListMembers(ctx context.Context, orgID uuid.UUID) ([]Member, error) {
	const q = `
		SELECT u.id, u.email, u.full_name, m.role, m.joined_at
		FROM memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.organization_id = $1
		ORDER BY m.joined_at ASC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Email, &m.FullName, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddMember creates a membership row, ignoring the request if one already
// exists.
func (s *Store) AddMember(ctx context.Context, orgID, userID uuid.UUID, role Role) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (organization_id, user_id) DO NOTHING
	`, orgID, userID, role)
	return err
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "SQLSTATE 23505") || strings.Contains(s, "unique constraint")
}
