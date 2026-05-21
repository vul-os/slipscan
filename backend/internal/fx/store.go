package fx

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Store writes FX rates into the fx_rates table.
// The unique key is (base, quote, as_of) — upserts update the rate and source
// on conflict so re-running is idempotent.
type Store struct {
	db *sql.DB
}

// NewStore constructs a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Upsert writes all rates in result into fx_rates, treating (base, quote,
// as_of) as the natural key. Existing rows for the same date are overwritten
// so the function is safe to call multiple times without creating duplicates.
// The base currency itself is skipped (base == quote is rejected by the
// fx_rates_distinct constraint).
func (s *Store) Upsert(ctx context.Context, result *FetchResult, source string) error {
	if result == nil || len(result.Rates) == 0 {
		return nil
	}

	const q = `
		INSERT INTO fx_rates (base, quote, rate, as_of, source)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (base, quote, as_of)
		DO UPDATE SET
			rate      = EXCLUDED.rate,
			source    = EXCLUDED.source
	`

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("fx store: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return fmt.Errorf("fx store: prepare: %w", err)
	}
	defer stmt.Close()

	asOf := result.AsOf.Truncate(24 * time.Hour)

	for quote, rate := range result.Rates {
		if quote == result.Base {
			continue // skip identity pair; DB constraint would reject it too
		}
		if rate <= 0 {
			continue // guard against malformed responses
		}
		if _, err := stmt.ExecContext(ctx, result.Base, quote, rate, asOf, source); err != nil {
			return fmt.Errorf("fx store: upsert %s/%s: %w", result.Base, quote, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("fx store: commit: %w", err)
	}
	return nil
}

// LastSync returns the most recent as_of date in fx_rates for the given base,
// or a zero time.Time if no rows exist yet.
func (s *Store) LastSync(ctx context.Context, base string) (time.Time, error) {
	var t time.Time
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(as_of), '0001-01-01') FROM fx_rates WHERE base = $1`,
		base,
	).Scan(&t)
	if err != nil {
		return time.Time{}, fmt.Errorf("fx store: last sync: %w", err)
	}
	return t, nil
}
