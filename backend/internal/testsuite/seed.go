package testsuite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Stable identifiers for the suite's fixture data. Anything created by
// Seed reuses these so reruns are idempotent and a human can spot test
// rows in the DB at a glance.
const (
	seedUserEmail  = "tests+suite@slipscan.local"
	seedOrgSlug    = "slipscan-test-suite"
	seedOrgRxLocal = "test-suite"
)

// Seed creates (or reuses) a deterministic test organization with a
// fixture of transactions and returns the org id. Idempotent — running
// it twice leaves the same data behind, just refreshed.
func Seed(ctx context.Context, db *sql.DB) (uuid.UUID, error) {
	var userID uuid.UUID
	if err := db.QueryRowContext(ctx, `
		INSERT INTO users (email, password_hash, full_name)
		VALUES ($1, 'x', 'Test Suite')
		ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
		RETURNING id`, seedUserEmail).Scan(&userID); err != nil {
		return uuid.Nil, fmt.Errorf("seed user: %w", err)
	}

	var orgID uuid.UUID
	if err := db.QueryRowContext(ctx, `
		INSERT INTO organizations (kind, name, slug, rx_local_part, created_by)
		VALUES ('personal', 'Test Suite', $1, $2, $3)
		ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
		RETURNING id`, seedOrgSlug, seedOrgRxLocal, userID).Scan(&orgID); err != nil {
		return uuid.Nil, fmt.Errorf("seed org: %w", err)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO personal_profiles (organization_id, full_name)
		VALUES ($1, 'Test Suite')
		ON CONFLICT (organization_id) DO NOTHING`, orgID); err != nil {
		return uuid.Nil, fmt.Errorf("seed personal_profile: %w", err)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, 'owner')
		ON CONFLICT (organization_id, user_id) DO NOTHING`, orgID, userID); err != nil {
		return uuid.Nil, fmt.Errorf("seed membership: %w", err)
	}

	if err := seedTransactions(ctx, db, orgID); err != nil {
		return uuid.Nil, err
	}
	return orgID, nil
}

func seedTransactions(ctx context.Context, db *sql.DB, orgID uuid.UUID) error {
	if _, err := db.ExecContext(ctx, `
		DELETE FROM transactions WHERE organization_id = $1`, orgID); err != nil {
		return fmt.Errorf("clear transactions: %w", err)
	}
	fixtures := []struct {
		merchant string
		amount   float64
		date     string
		currency string
	}{
		{"McDonald's", 119.50, "2026-01-12", "ZAR"},
		{"Uber", 78.00, "2026-02-03", "ZAR"},
		{"Uber", 142.20, "2026-02-19", "ZAR"},
		{"Uber Eats", 215.00, "2026-03-04", "ZAR"},
		{"Pick n Pay", 642.30, "2026-03-15", "ZAR"},
		{"Café Mocca", 45.00, "2026-04-01", "ZAR"},
		{"Netflix", 199.00, "2026-04-10", "ZAR"},
	}
	for _, f := range fixtures {
		d, err := time.Parse("2006-01-02", f.date)
		if err != nil {
			return fmt.Errorf("parse fixture date %s: %w", f.date, err)
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO transactions
				(organization_id, merchant, merchant_normalized, amount, currency, posted_date, status)
			VALUES ($1, $2, lower($2), $3, $4, $5, 'verified')`,
			orgID, f.merchant, f.amount, f.currency, d); err != nil {
			return fmt.Errorf("seed transaction %s: %w", f.merchant, err)
		}
	}
	return nil
}
