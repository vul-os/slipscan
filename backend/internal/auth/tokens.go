package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Token kinds map 1:1 to dedicated SQL tables. A separate table per kind
// keeps the schema explicit and makes "consume on use" trivial.
type tokenKind string

const (
	tokenKindEmailVerify   tokenKind = "email_verify"
	tokenKindPasswordReset tokenKind = "password_reset"
)

func (k tokenKind) table() string {
	switch k {
	case tokenKindEmailVerify:
		return "email_verification_tokens"
	case tokenKindPasswordReset:
		return "password_reset_tokens"
	}
	return ""
}

var (
	ErrTokenInvalid = errors.New("token invalid or expired")
	ErrTokenSpent   = errors.New("token already used")
)

// TokenStore manages email-verification and password-reset tokens.
// Tokens are hashed (SHA-256) before storing — only the user, via the
// emailed link, ever sees the plaintext value.
type TokenStore struct {
	db *sql.DB
}

func NewTokenStore(db *sql.DB) *TokenStore { return &TokenStore{db: db} }

// IssueEmailVerify creates a new email-verification token. The plaintext
// token is returned (caller embeds it in the verification URL); only the
// hash is persisted.
func (s *TokenStore) IssueEmailVerify(ctx context.Context, userID uuid.UUID, ttl time.Duration) (string, error) {
	return s.issue(ctx, tokenKindEmailVerify, userID, ttl)
}

// IssuePasswordReset creates a new password-reset token.
func (s *TokenStore) IssuePasswordReset(ctx context.Context, userID uuid.UUID, ttl time.Duration) (string, error) {
	return s.issue(ctx, tokenKindPasswordReset, userID, ttl)
}

func (s *TokenStore) issue(ctx context.Context, kind tokenKind, userID uuid.UUID, ttl time.Duration) (string, error) {
	plaintext, err := newRandomToken()
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().Add(ttl)

	q := `INSERT INTO ` + kind.table() + ` (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`
	if _, err := s.db.ExecContext(ctx, q, userID, hashToken(plaintext), expiresAt); err != nil {
		return "", err
	}
	return plaintext, nil
}

// ConsumeEmailVerify atomically marks the token as used and returns the
// associated user_id. If the token doesn't match an unconsumed, unexpired
// row, ErrTokenInvalid is returned and no row is mutated.
func (s *TokenStore) ConsumeEmailVerify(ctx context.Context, plaintext string) (uuid.UUID, error) {
	return s.consume(ctx, tokenKindEmailVerify, plaintext)
}

// ConsumePasswordReset atomically marks the token as used and returns the
// associated user_id.
func (s *TokenStore) ConsumePasswordReset(ctx context.Context, plaintext string) (uuid.UUID, error) {
	return s.consume(ctx, tokenKindPasswordReset, plaintext)
}

func (s *TokenStore) consume(ctx context.Context, kind tokenKind, plaintext string) (uuid.UUID, error) {
	if plaintext == "" {
		return uuid.Nil, ErrTokenInvalid
	}
	hash := hashToken(plaintext)
	q := `
		UPDATE ` + kind.table() + `
		SET consumed_at = NOW()
		WHERE token_hash = $1
		  AND consumed_at IS NULL
		  AND expires_at > NOW()
		RETURNING user_id`
	var uid uuid.UUID
	if err := s.db.QueryRowContext(ctx, q, hash).Scan(&uid); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, ErrTokenInvalid
		}
		return uuid.Nil, err
	}
	return uid, nil
}

// InvalidateUserTokens marks every unconsumed token of this kind for this
// user as consumed. Used after a successful password reset (so older reset
// links stop working) and after issuing a new verify token.
func (s *TokenStore) InvalidateUserTokens(ctx context.Context, kind tokenKind, userID uuid.UUID) error {
	q := `UPDATE ` + kind.table() + ` SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`
	_, err := s.db.ExecContext(ctx, q, userID)
	return err
}

// newRandomToken generates 32 bytes of randomness encoded URL-safe.
// Result is ~43 chars: short enough for query strings, long enough that
// guessing is implausible.
func newRandomToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func hashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
