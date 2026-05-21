package org

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Kind matches the SQL enum organization_kind.
type Kind string

const (
	KindPersonal Kind = "personal"
	KindBusiness Kind = "business"
)

func (k Kind) Valid() bool { return k == KindPersonal || k == KindBusiness }

// Role matches the SQL enum membership_role.
type Role string

const (
	RoleOwner      Role = "owner"
	RoleAdmin      Role = "admin"
	RoleAccountant Role = "accountant"
	RoleMember     Role = "member"
	RoleViewer     Role = "viewer"
)

func (r Role) Valid() bool {
	switch r {
	case RoleOwner, RoleAdmin, RoleAccountant, RoleMember, RoleViewer:
		return true
	}
	return false
}

var (
	ErrNotFound  = errors.New("organization not found")
	ErrSlugTaken = errors.New("slug already in use")
	ErrForbidden = errors.New("forbidden")
)

type Organization struct {
	ID          uuid.UUID
	Kind        Kind
	Name        string
	Slug        string
	RxLocalPart string
	Currency    string
	CreatedBy   uuid.NullUUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Member struct {
	UserID   uuid.UUID
	Email    string
	FullName sql.NullString
	Role     Role
	JoinedAt time.Time
}

// PersonalProfile is the personal_profiles row paired 1:1 with a personal org.
type PersonalProfile struct {
	FullName string
}

// BusinessProfile is the business_profiles row paired 1:1 with a business org.
// Only legal_name is required at signup; the rest can be filled in via Settings.
type BusinessProfile struct {
	LegalName          string
	RegistrationNumber string
	TaxNumber          string
	Industry           string
	Website            string
	Country            string // ISO-3166 alpha-2; written to organizations.country
}

// CategorySeeder is called inside the org-creation transaction after the org
// row and profile row have been inserted.  It should idempotently seed the
// default category (and, for business orgs, account) tree.
// Injected by classify.SeedDefaultCategories to avoid an import cycle.
type CategorySeeder func(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, orgKind string, currency string) error

type Store struct {
	db              *sql.DB
	categorySeeder  CategorySeeder
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// WithCategorySeeder returns a new Store that calls seeder during org creation.
func (s *Store) WithCategorySeeder(seeder CategorySeeder) *Store {
	return &Store{db: s.db, categorySeeder: seeder}
}

// CreateOptions bundles everything needed to spin up an organization at
// registration time: the org's kind, a display name, the per-kind profile
// payload, and the user that becomes the owner.
type CreateOptions struct {
	Kind        Kind
	Name        string
	Personal    *PersonalProfile // required iff Kind == KindPersonal
	Business    *BusinessProfile // required iff Kind == KindBusiness
	OwnerUserID uuid.UUID
}

// Create inserts an organization, the matching profile row, and the owner
// membership in one transaction. Slug + rx_local_part are auto-generated
// from Name with a numeric suffix on collision.
func (s *Store) Create(ctx context.Context, opts CreateOptions) (*Organization, error) {
	if !opts.Kind.Valid() {
		return nil, fmt.Errorf("invalid kind %q", opts.Kind)
	}
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		return nil, errors.New("organization name is required")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	slug, err := allocSlug(ctx, tx, name)
	if err != nil {
		return nil, err
	}
	rx, err := allocRxLocalPart(ctx, tx, name)
	if err != nil {
		return nil, err
	}

	country := sql.NullString{}
	if opts.Kind == KindBusiness && opts.Business != nil {
		c := strings.ToUpper(strings.TrimSpace(opts.Business.Country))
		if c != "" {
			country = sql.NullString{String: c, Valid: true}
		}
	}

	const insertOrg = `
		INSERT INTO organizations (kind, name, slug, rx_local_part, country, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, kind, name, slug, rx_local_part, currency, created_by, created_at, updated_at
	`
	var o Organization
	if err := tx.QueryRowContext(ctx, insertOrg,
		string(opts.Kind), name, slug, rx, country, opts.OwnerUserID,
	).Scan(
		&o.ID, &o.Kind, &o.Name, &o.Slug, &o.RxLocalPart, &o.Currency,
		&o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
	); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSlugTaken
		}
		return nil, err
	}

	switch opts.Kind {
	case KindPersonal:
		p := opts.Personal
		if p == nil || strings.TrimSpace(p.FullName) == "" {
			return nil, errors.New("personal profile full_name is required")
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO personal_profiles (organization_id, full_name) VALUES ($1, $2)`,
			o.ID, strings.TrimSpace(p.FullName),
		); err != nil {
			return nil, err
		}
	case KindBusiness:
		p := opts.Business
		if p == nil || strings.TrimSpace(p.LegalName) == "" {
			return nil, errors.New("business profile legal_name is required")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO business_profiles (
				organization_id, legal_name, registration_number, tax_number, industry, website
			) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''))
		`,
			o.ID,
			strings.TrimSpace(p.LegalName),
			strings.TrimSpace(p.RegistrationNumber),
			strings.TrimSpace(p.TaxNumber),
			strings.TrimSpace(p.Industry),
			strings.TrimSpace(p.Website),
		); err != nil {
			return nil, err
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
		o.ID, opts.OwnerUserID,
	); err != nil {
		return nil, err
	}

	// P1-02: seed default categories (and accounts for business orgs) inside
	// this transaction so any failure rolls the whole org creation back.
	if s.categorySeeder != nil {
		if err := s.categorySeeder(ctx, tx, o.ID, string(o.Kind), o.Currency); err != nil {
			return nil, fmt.Errorf("org: seed categories: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &o, nil
}

// allocSlug generates a candidate slug from name and finds the first
// non-colliding variant, retrying with -2, -3, … then a random suffix.
// Runs inside the caller's transaction so colliding inserts during signup
// rollback together.
func allocSlug(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	base := slugify(name)
	if base == "" {
		// Fall back to a random slug rather than rejecting the request.
		base = "org"
	}
	return findFreeIdentifier(ctx, tx,
		"SELECT 1 FROM organizations WHERE slug = $1",
		base,
	)
}

// allocRxLocalPart generates a candidate inbound-mail local-part. Schema
// allows dots/dashes/underscores so we can be more forgiving than the slug.
func allocRxLocalPart(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	base := slugify(name)
	if base == "" {
		base = "rx"
	}
	return findFreeIdentifier(ctx, tx,
		"SELECT 1 FROM organizations WHERE rx_local_part = $1",
		base,
	)
}

func findFreeIdentifier(ctx context.Context, tx *sql.Tx, lookupSQL, base string) (string, error) {
	check := func(candidate string) (bool, error) {
		var x int
		err := tx.QueryRowContext(ctx, lookupSQL, candidate).Scan(&x)
		if errors.Is(err, sql.ErrNoRows) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		return false, nil
	}

	if free, err := check(base); err != nil {
		return "", err
	} else if free {
		return base, nil
	}
	for i := 2; i < 100; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if free, err := check(candidate); err != nil {
			return "", err
		} else if free {
			return candidate, nil
		}
	}
	// 100 collisions in a row is statistically impossible for a real name.
	// Fall through to a random hex suffix so signup never fails.
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s", base, hex.EncodeToString(b[:])), nil
}

var slugTrim = regexp.MustCompile(`(^-+|-+$)`)
var slugSquash = regexp.MustCompile(`-+`)

// slugify converts a free-form name into a slug compatible with the
// organizations.slug + rx_local_part check constraints
// (^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$).
func slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_' || r == '.' || r == '/' || r == '+' || r == '&':
			b.WriteByte('-')
		}
	}
	out := slugSquash.ReplaceAllString(b.String(), "-")
	out = slugTrim.ReplaceAllString(out, "")
	if len(out) < 3 {
		// Pad short slugs so they pass the length check.
		out = out + "-org"
		out = slugTrim.ReplaceAllString(out, "")
	}
	if len(out) > 60 {
		out = out[:60]
		out = slugTrim.ReplaceAllString(out, "")
	}
	return out
}

// ListForUser returns every organization the user belongs to, plus their
// role in each one.
func (s *Store) ListForUser(ctx context.Context, userID uuid.UUID) ([]OrgWithRole, error) {
	const q = `
		SELECT o.id, o.kind, o.name, o.slug, o.rx_local_part, o.currency,
		       o.created_by, o.created_at, o.updated_at,
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
			&o.ID, &o.Kind, &o.Name, &o.Slug, &o.RxLocalPart, &o.Currency,
			&o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
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

// ByRxLocalPart fetches the organization whose rx_local_part matches the
// given value (case-insensitive). Returns ErrNotFound when no row matches.
func (s *Store) ByRxLocalPart(ctx context.Context, localPart string) (*Organization, error) {
	const q = `
		SELECT id, kind, name, slug, rx_local_part, currency,
		       created_by, created_at, updated_at
		FROM organizations
		WHERE rx_local_part = LOWER($1)
	`
	var o Organization
	err := s.db.QueryRowContext(ctx, q, localPart).Scan(
		&o.ID, &o.Kind, &o.Name, &o.Slug, &o.RxLocalPart, &o.Currency,
		&o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// ByID fetches a single organization by id. Returns ErrNotFound when the
// row is absent.
func (s *Store) ByID(ctx context.Context, orgID uuid.UUID) (*Organization, error) {
	const q = `
		SELECT id, kind, name, slug, rx_local_part, currency,
		       created_by, created_at, updated_at
		FROM organizations
		WHERE id = $1
	`
	var o Organization
	err := s.db.QueryRowContext(ctx, q, orgID).Scan(
		&o.ID, &o.Kind, &o.Name, &o.Slug, &o.RxLocalPart, &o.Currency,
		&o.CreatedBy, &o.CreatedAt, &o.UpdatedAt,
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
