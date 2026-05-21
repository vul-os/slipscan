package apitokens

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Store persists and retrieves API tokens from the api_tokens table.
type Store struct{ db *sql.DB }

// NewStore constructs a Store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// IssueRequest is the data needed to mint a new token.
type IssueRequest struct {
	OrganizationID  uuid.UUID
	CreatedBy       uuid.UUID
	Name            string
	Kind            Kind
	Scopes          []string
	AllowedIPCIDRs  []string
	RateLimitPerMin int       // 0 = use default
	ExpiresAt       time.Time // zero = no expiry
}

// Issued is returned from Issue: the Token and the one-time plaintext.
type Issued struct {
	Token     Token
	Plaintext string // shown to the user exactly once
}

// Issue mints a new API token, stores only the hash, and returns the plaintext.
func (s *Store) Issue(ctx context.Context, req IssueRequest) (*Issued, error) {
	if !req.Kind.Valid() {
		return nil, errors.New("apitokens: invalid kind")
	}

	plaintext, prefix, hash, err := generate(req.Kind)
	if err != nil {
		return nil, err
	}

	scopesJSON, err := json.Marshal(req.Scopes)
	if err != nil {
		return nil, err
	}

	var expiresAt *time.Time
	if !req.ExpiresAt.IsZero() {
		t := req.ExpiresAt
		expiresAt = &t
	}

	var rlpm *int
	if req.RateLimitPerMin > 0 {
		v := req.RateLimitPerMin
		rlpm = &v
	}

	var allowedIPs []string
	if len(req.AllowedIPCIDRs) > 0 {
		allowedIPs = req.AllowedIPCIDRs
	}

	const q = `
		INSERT INTO api_tokens
			(organization_id, created_by, name, kind, token_hash, token_prefix,
			 scopes, allowed_ip_cidrs, rate_limit_per_minute, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, created_at
	`
	var id uuid.UUID
	var createdAt time.Time
	err = s.db.QueryRowContext(ctx, q,
		req.OrganizationID,
		req.CreatedBy,
		req.Name,
		string(req.Kind),
		hash,
		prefix,
		scopesJSON,
		stringSliceToArray(allowedIPs),
		rlpm,
		expiresAt,
	).Scan(&id, &createdAt)
	if err != nil {
		return nil, err
	}

	tok := Token{
		ID:              id,
		OrganizationID:  req.OrganizationID,
		UserID:          uuid.NullUUID{UUID: req.CreatedBy, Valid: true},
		Name:            req.Name,
		Kind:            req.Kind,
		Scopes:          req.Scopes,
		RateLimitPerMin: req.RateLimitPerMin,
		CreatedAt:       createdAt,
	}
	if expiresAt != nil {
		tok.ExpiresAt = sql.NullTime{Time: *expiresAt, Valid: true}
	}
	return &Issued{Token: tok, Plaintext: plaintext}, nil
}

// ListByOrg returns all active (non-revoked) tokens for an org.
func (s *Store) ListByOrg(ctx context.Context, orgID uuid.UUID) ([]TokenMeta, error) {
	const q = `
		SELECT id, organization_id, created_by, name, kind, token_prefix,
		       scopes, rate_limit_per_minute, last_used_at, expires_at, created_at
		FROM api_tokens
		WHERE organization_id = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TokenMeta
	for rows.Next() {
		var m TokenMeta
		if err := scanMeta(rows, &m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Revoke marks a token as revoked.  revokedBy is the admin user's ID.
func (s *Store) Revoke(ctx context.Context, tokenID, orgID, revokedBy uuid.UUID) error {
	const q = `
		UPDATE api_tokens
		SET revoked_at = NOW(), revoked_by = $3
		WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
	`
	res, err := s.db.ExecContext(ctx, q, tokenID, orgID, revokedBy)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Authenticate looks up a token by prefix, verifies the hash, and returns
// the decoded Token.  It also updates last_used_at + last_used_ip.
func (s *Store) Authenticate(ctx context.Context, plaintext, sourceIP string) (*Token, error) {
	if plaintext == "" {
		return nil, ErrInvalidToken
	}

	prefix := prefixOf(plaintext)
	h := hashToken(plaintext)

	const q = `
		SELECT id, organization_id, user_id, name, kind, scopes,
		       rate_limit_per_minute, allowed_ip_cidrs, expires_at,
		       revoked_at, created_at
		FROM api_tokens
		WHERE token_prefix = $1 AND token_hash = $2
		LIMIT 1
	`
	row := s.db.QueryRowContext(ctx, q, prefix, h)

	var (
		id             uuid.UUID
		orgID          uuid.UUID
		userID         uuid.NullUUID
		name           string
		kind           string
		scopesJSON     []byte
		rlpm           sql.NullInt32
		allowedIPsRaw  interface{} // text[] — we'll ignore for now
		expiresAt      sql.NullTime
		revokedAt      sql.NullTime
		createdAt      time.Time
	)

	err := row.Scan(
		&id, &orgID, &userID, &name, &kind, &scopesJSON,
		&rlpm, &allowedIPsRaw, &expiresAt, &revokedAt, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInvalidToken
	}
	if err != nil {
		return nil, err
	}
	if revokedAt.Valid {
		return nil, ErrRevoked
	}
	if expiresAt.Valid && time.Now().After(expiresAt.Time) {
		return nil, ErrExpired
	}

	var scopes []string
	if len(scopesJSON) > 0 {
		_ = json.Unmarshal(scopesJSON, &scopes)
	}

	// Best-effort last_used_at update — don't fail auth on write error.
	_, _ = s.db.ExecContext(ctx,
		`UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1`,
		id, sourceIP,
	)

	rl := 0
	if rlpm.Valid {
		rl = int(rlpm.Int32)
	}

	return &Token{
		ID:              id,
		OrganizationID:  orgID,
		UserID:          userID,
		Name:            name,
		Kind:            Kind(kind),
		Scopes:          scopes,
		RateLimitPerMin: rl,
		ExpiresAt:       expiresAt,
		CreatedAt:       createdAt,
	}, nil
}

// ─── Meta type for list responses ─────────────────────────────────────────

// TokenMeta is the safe-to-display token summary (no hash, no full plaintext).
type TokenMeta struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	CreatedBy       uuid.NullUUID
	Name            string
	Kind            Kind
	Prefix          string // first 12 chars e.g. "sk_live_aBcD"
	Scopes          []string
	RateLimitPerMin int
	LastUsedAt      sql.NullTime
	ExpiresAt       sql.NullTime
	CreatedAt       time.Time
}

type metaScanner interface {
	Scan(dest ...any) error
}

func scanMeta(row metaScanner, m *TokenMeta) error {
	var scopesJSON []byte
	var rlpm sql.NullInt32
	err := row.Scan(
		&m.ID, &m.OrganizationID, &m.CreatedBy, &m.Name, &m.Kind,
		&m.Prefix, &scopesJSON, &rlpm, &m.LastUsedAt, &m.ExpiresAt, &m.CreatedAt,
	)
	if err != nil {
		return err
	}
	if rlpm.Valid {
		m.RateLimitPerMin = int(rlpm.Int32)
	}
	if len(scopesJSON) > 0 {
		_ = json.Unmarshal(scopesJSON, &m.Scopes)
	}
	return nil
}

// stringSliceToArray converts a Go string slice to a postgres text[] literal.
// Returns nil when the slice is empty (stores NULL in the DB).
func stringSliceToArray(s []string) interface{} {
	if len(s) == 0 {
		return nil
	}
	// Use the jackc/pgx array type serialization indirectly: pass as JSON
	// and let postgres cast, or just return the slice and trust the driver.
	// The pgx driver handles []string → text[].
	return s
}
