package classify

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
)

// Signal is the result of a cross-tenant merchant_signals lookup.
type Signal struct {
	// CategoryLabel is the category name (TEXT) from merchant_signals —
	// NOT a per-org UUID. The caller maps this label to the org's own
	// category by name.
	CategoryLabel string
	// VoteCount is the aggregated correction count across all tenants.
	VoteCount int
}

// LookupSignal returns the top (highest-vote) cross-tenant signal for the
// given merchant_normalized string. Returns nil, nil when no signal exists.
//
// P1-04 populates merchant_signals by aggregating classification_corrections
// across orgs. P1-02 reads from it here. The contract between them is this
// function signature and the table (merchant_normalized, category_label,
// vote_count).
//
// Privacy invariant: only merchant_normalized + category_label + vote_count
// are stored in merchant_signals — never org_id, user_id, or amounts.
func LookupSignal(ctx context.Context, db *sql.DB, merchantNormalized string) (*Signal, error) {
	if merchantNormalized == "" {
		return nil, nil
	}
	const q = `
		SELECT category_label, vote_count
		FROM merchant_signals
		WHERE merchant_normalized = $1
		ORDER BY vote_count DESC, last_seen_at DESC
		LIMIT 1
	`
	var s Signal
	err := db.QueryRowContext(ctx, q, merchantNormalized).Scan(&s.CategoryLabel, &s.VoteCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// mapSignalToCategory resolves a merchant_signals category_label (a plain
// TEXT name) to the org's own category ID by name match.
// Returns uuid.Nil when no matching category is found.
func mapSignalToCategory(ctx context.Context, db *sql.DB, orgID uuid.UUID, label string) (uuid.UUID, error) {
	if label == "" {
		return uuid.Nil, nil
	}
	const q = `
		SELECT id FROM categories
		WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
		LIMIT 1
	`
	var id uuid.UUID
	err := db.QueryRowContext(ctx, q, orgID, label).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}
