package apitokens

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// ctxKey is this package's private context key type.
type ctxKey int

const ctxToken ctxKey = iota

// WithToken stashes the authenticated API token in the context.
// It also populates identity.WithUserID when the token has a user_id,
// so downstream handlers that call identity.UserIDFrom still work.
func WithToken(ctx context.Context, tok *Token) context.Context {
	ctx = context.WithValue(ctx, ctxToken, tok)
	if tok.UserID.Valid {
		ctx = identity.WithUserID(ctx, tok.UserID.UUID)
	}
	return ctx
}

// TokenFrom retrieves the API token stashed by WithToken.
func TokenFrom(ctx context.Context) (*Token, bool) {
	v, ok := ctx.Value(ctxToken).(*Token)
	return v, ok
}

// Middleware authenticates requests via "Authorization: Bearer sk_<kind>_…"
// and enforces:
//  1. Token validity (not revoked, not expired, hash matches).
//  2. Rate limiting (per-token, in-memory).
//
// The org-scoped context is set for downstream handlers.
// Scope enforcement is done per-endpoint via RequireScope.
func (s *Store) Middleware(rl *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearerToken(r)
			if raw == "" {
				httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "API token required")
				return
			}

			sourceIP := clientIP(r)
			tok, err := s.Authenticate(r.Context(), raw, sourceIP)
			if err != nil {
				switch err {
				case ErrRevoked:
					httpx.WriteError(w, http.StatusUnauthorized, "token_revoked", "API token has been revoked")
				case ErrExpired:
					httpx.WriteError(w, http.StatusUnauthorized, "token_expired", "API token has expired")
				default:
					httpx.WriteError(w, http.StatusUnauthorized, "invalid_token", "invalid API token")
				}
				return
			}

			// Rate limiting.
			if !rl.Allow(tok.ID.String(), tok.RateLimitPerMin) {
				w.Header().Set("Retry-After", "60")
				httpx.WriteError(w, http.StatusTooManyRequests, "rate_limited",
					"rate limit exceeded; retry after 60 seconds")
				return
			}

			ctx := WithToken(r.Context(), tok)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireScope returns a middleware that 403s unless the token has the given
// scope AND (for live-only resources) the token kind is live or restricted.
// scopeRequired follows the pattern "resource:action", e.g. "documents:write".
func RequireScope(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok, ok := TokenFrom(r.Context())
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "API token required")
				return
			}
			if !tok.HasScope(scope) {
				httpx.WriteError(w, http.StatusForbidden, "insufficient_scope",
					"token does not have the '"+scope+"' scope")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireLive is middleware that rejects test tokens on endpoints that must
// operate on real (live) data.  Pass it after RequireScope.
func RequireLive(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, ok := TokenFrom(r.Context())
		if !ok {
			httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "API token required")
			return
		}
		if tok.Kind == KindTest {
			httpx.WriteError(w, http.StatusForbidden, "test_token_not_allowed",
				"this endpoint requires a live API token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// OrgIDFrom returns the org UUID pinned to the current API token.
// It matches the {orgID} path parameter against the token's OrganizationID
// so tokens can't be used across orgs.
func OrgIDFrom(r *http.Request) (uuid.UUID, bool) {
	tok, ok := TokenFrom(r.Context())
	if !ok {
		return uuid.Nil, false
	}
	// Also validate the path parameter matches.
	raw := r.PathValue("orgID")
	if raw == "" {
		return tok.OrganizationID, true
	}
	pathID, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	if pathID != tok.OrganizationID {
		return uuid.Nil, false
	}
	return tok.OrganizationID, true
}

// ─── helpers ──────────────────────────────────────────────────────────────

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the leftmost (client) IP.
		if idx := strings.Index(xff, ","); idx >= 0 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx >= 0 {
		return addr[:idx]
	}
	return addr
}
