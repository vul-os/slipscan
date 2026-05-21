package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

type ctxKey int

const ctxClaims ctxKey = iota

// WithClaims stashes the decoded JWT claims and the user id under the
// shared identity key, so downstream packages (org, document, …) can read
// the user id without importing auth.
func WithClaims(ctx context.Context, c *Claims) context.Context {
	ctx = context.WithValue(ctx, ctxClaims, c)
	ctx = identity.WithUserID(ctx, c.UserID)
	return ctx
}

// UserIDFrom is a thin re-export so existing auth callers keep working.
// Prefer identity.UserIDFrom in new code.
func UserIDFrom(ctx context.Context) (uuid.UUID, bool) { return identity.UserIDFrom(ctx) }

func ClaimsFrom(ctx context.Context) (*Claims, bool) {
	v, ok := ctx.Value(ctxClaims).(*Claims)
	return v, ok
}

// Middleware enforces a valid access token on requests. The decoded claims
// are stashed in the request context for downstream handlers.
func (s *Signer) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearerToken(r)
		if raw == "" {
			httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "authorization header required")
			return
		}
		claims, err := s.Parse(raw, TokenAccess)
		if err != nil {
			httpx.WriteError(w, http.StatusUnauthorized, "invalid_token", "invalid or expired token")
			return
		}
		ctx := WithClaims(r.Context(), claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

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
