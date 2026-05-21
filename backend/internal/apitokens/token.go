// Package apitokens implements P4-04: developer API tokens for the public /v1
// surface.  Tokens are issued per-org (admin-gated), hashed at rest with
// SHA-256, shown in plaintext exactly once.  Each token carries a scopes
// list (JSON array of strings matching api_permissions.code) and a kind
// (live | test | restricted) drawn from the api_token_kind enum.
//
// The token format is:
//
//	sk_{kind}_{randomBase64}
//
// e.g. sk_live_aB3…  /  sk_test_xY7…
//
// A 10-char prefix (the first two segments: "sk_live_" + first 2 chars) is
// stored in api_tokens.token_prefix for fast prefix-based lookup.
package apitokens

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Kind mirrors the api_token_kind postgres enum.
type Kind string

const (
	KindLive       Kind = "live"
	KindTest       Kind = "test"
	KindRestricted Kind = "restricted"
)

func (k Kind) Valid() bool {
	return k == KindLive || k == KindTest || k == KindRestricted
}

var (
	ErrNotFound      = errors.New("api token not found")
	ErrRevoked       = errors.New("api token has been revoked")
	ErrExpired       = errors.New("api token has expired")
	ErrIPDenied      = errors.New("source IP is not in the allowed CIDR list")
	ErrInvalidToken  = errors.New("api token is invalid")
)

// Token is the decoded in-memory representation of a valid api_tokens row.
type Token struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	UserID          uuid.NullUUID
	Name            string
	Kind            Kind
	Scopes          []string
	RateLimitPerMin int // 0 means use the default
	ExpiresAt       sql.NullTime
	CreatedAt       time.Time
}

// HasScope reports whether this token includes the given scope string.
func (t *Token) HasScope(scope string) bool {
	for _, s := range t.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// ─── Token generation ────────────────────────────────────────────────────────

// generate creates a new plaintext token, its prefix, and its hash.
func generate(kind Kind) (plaintext, prefix, hash string, err error) {
	var b [32]byte
	if _, err = rand.Read(b[:]); err != nil {
		return
	}
	raw := base64.RawURLEncoding.EncodeToString(b[:])
	plaintext = fmt.Sprintf("sk_%s_%s", kind, raw)
	prefix = prefixOf(plaintext)
	hash = hashToken(plaintext)
	return
}

// prefixOf returns the first 12 characters of the plaintext token, used for
// display ("ends with …XY") and fast table index lookup.
// Format: "sk_live_" = 8 chars + 4 random chars = 12.
func prefixOf(plaintext string) string {
	if len(plaintext) <= 12 {
		return plaintext
	}
	return plaintext[:12]
}

// hashToken computes the SHA-256 hex digest of the plaintext token.
func hashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// VerifyToken checks whether the supplied plaintext token matches the stored
// hash.  Used in tests; the real auth path looks up by prefix then verifies.
func VerifyToken(plaintext, storedHash string) bool {
	return hashToken(plaintext) == storedHash
}
