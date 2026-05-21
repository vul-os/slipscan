// Package identity holds the auth context-key plumbing shared between the
// auth package (which sets the user id on the request context) and other
// packages (org, document, etc.) that read it. Living in its own package
// avoids an import cycle between auth and org.
package identity

import (
	"context"

	"github.com/google/uuid"
)

type ctxKey int

const ctxUserID ctxKey = iota

// WithUserID returns a copy of ctx with the user id stashed under the
// shared key.
func WithUserID(ctx context.Context, uid uuid.UUID) context.Context {
	return context.WithValue(ctx, ctxUserID, uid)
}

// UserIDFrom retrieves the user id stashed by WithUserID. The bool is
// false when no id has been set, which means the caller is unauthenticated.
func UserIDFrom(ctx context.Context) (uuid.UUID, bool) {
	v, ok := ctx.Value(ctxUserID).(uuid.UUID)
	return v, ok
}
