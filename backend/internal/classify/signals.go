// Cross-tenant merchant signal lookup (P1-02 reader) and aggregation
// (P1-04 writer) for the classification cascade.
//
// Privacy model
// -------------
// merchant_signals is a cross-tenant table. The ONLY columns ever written are:
//
//	merchant_normalized  (TEXT — output of merchant.Normalize)
//	category_label       (TEXT — category name, NOT a per-org UUID)
//	vote_count           (INTEGER — number of distinct orgs that agreed)
//	last_seen_at         (TIMESTAMPTZ)
//	updated_at           (TIMESTAMPTZ — maintained by DB trigger)
//
// Amounts, org IDs, and user IDs MUST NEVER be written. See TestPrivacyInvariant.
//
// Aggregation algorithm
// ---------------------
// The aggregation job reads classification_corrections across ALL orgs, groups
// by (merchant_normalized, category_name), counts distinct org_ids per group,
// and upserts merchant_signals only for groups where distinct_org_count >= K
// (configurable via SIGNALS_MIN_ORGS, default 2).
//
// Leader guard: the scheduler only runs when SIGNALS_AGG_ENABLED=true. Set that
// env var on exactly ONE fleet member (same pattern as FX_SYNC_ENABLED).
package classify

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"time"

	"github.com/google/uuid"
)

// ─── Reader (P1-02 cascade consults this) ──────────────────────────────────

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
// This is the function the P1-02 cascade's merchant_signal stage calls.
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

// ─── Writer / aggregator (P1-04 scheduler populates merchant_signals) ───────

// DefaultMinOrgs is the default minimum number of distinct organisations that
// must agree on a (merchant, category) pair before the signal is written to
// merchant_signals. This prevents single-org noise from leaking into the
// global table.
const DefaultMinOrgs = 2

// signalRow is the in-process representation of one aggregated signal.
// Only privacy-safe fields — never amounts, org IDs, or user IDs.
type signalRow struct {
	MerchantNormalized string
	CategoryLabel      string
	VoteCount          int
	LastSeenAt         time.Time
}

// Store provides read/write access to merchant_signals and the source tables
// needed by the aggregation job.
type Store struct {
	db *sql.DB
}

// NewStore constructs a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// LookupSignal returns the top-voted category label and vote count for a
// normalised merchant string. Returns ("", 0) when no signal exists.
// (Method form retained for the aggregation tests; the cascade uses the
// package-level LookupSignal above.)
func (s *Store) LookupSignal(ctx context.Context, merchantNormalized string) (categoryLabel string, votes int, err error) {
	if merchantNormalized == "" {
		return "", 0, nil
	}
	const q = `
		SELECT category_label, vote_count
		FROM   merchant_signals
		WHERE  merchant_normalized = $1
		ORDER  BY vote_count DESC, last_seen_at DESC
		LIMIT  1
	`
	row := s.db.QueryRowContext(ctx, q, merchantNormalized)
	err = row.Scan(&categoryLabel, &votes)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, fmt.Errorf("classify: lookup signal: %w", err)
	}
	return categoryLabel, votes, nil
}

// Aggregate reads classification_corrections across all orgs, computes
// (merchant_normalized, category_label) agreement counts, and upserts
// merchant_signals for groups with at least minOrgs distinct organisations.
// Idempotent: re-running produces the same result. No amounts, org IDs, or
// user IDs are written — only aggregated vote_count and timestamps.
func (s *Store) Aggregate(ctx context.Context, minOrgs int) error {
	if minOrgs <= 0 {
		minOrgs = DefaultMinOrgs
	}

	// PRIVACY: the subquery selects only merchant_normalized, category name,
	// COUNT(DISTINCT org), and MAX(created_at). No amounts, no org UUIDs,
	// no user UUIDs leave the subquery boundary.
	const q = `
		INSERT INTO merchant_signals (merchant_normalized, category_label, vote_count, last_seen_at)
		SELECT
			cc.merchant_normalized,
			cat.name            AS category_label,
			COUNT(DISTINCT cc.organization_id) AS vote_count,
			MAX(cc.created_at)  AS last_seen_at
		FROM  classification_corrections cc
		JOIN  categories cat ON cat.id = cc.new_category_id
		WHERE cc.merchant_normalized IS NOT NULL
		  AND cc.merchant_normalized <> ''
		  AND cc.new_category_id     IS NOT NULL
		GROUP BY cc.merchant_normalized, cat.name
		HAVING COUNT(DISTINCT cc.organization_id) >= $1
		ON CONFLICT (merchant_normalized, category_label)
		DO UPDATE SET
			vote_count   = EXCLUDED.vote_count,
			last_seen_at = EXCLUDED.last_seen_at
	`

	res, err := s.db.ExecContext(ctx, q, minOrgs)
	if err != nil {
		return fmt.Errorf("classify: aggregate signals: %w", err)
	}
	n, _ := res.RowsAffected()
	log.Printf("classify: signals aggregated — %d rows upserted (min_orgs=%d)", n, minOrgs)
	return nil
}

// Scheduler runs the periodic merchant-signal aggregation job. Only one fleet
// member should run this (set SIGNALS_AGG_ENABLED=true on exactly one VM).
type Scheduler struct {
	store    *Store
	minOrgs  int
	interval time.Duration
}

// NewScheduler constructs a Scheduler. interval is how often the aggregation
// runs; pass 0 to use the default of 1 hour.
func NewScheduler(store *Store, minOrgs int, interval time.Duration) *Scheduler {
	if interval <= 0 {
		interval = time.Hour
	}
	if minOrgs <= 0 {
		minOrgs = DefaultMinOrgs
	}
	return &Scheduler{store: store, minOrgs: minOrgs, interval: interval}
}

// Run performs an immediate aggregation on startup, then ticks every interval
// (with ±60 s jitter) until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	log.Printf("classify: signal aggregation scheduler started (interval=%s min_orgs=%d)", s.interval, s.minOrgs)

	s.aggregate(ctx)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("classify: signal aggregation scheduler stopped")
			return
		case <-ticker.C:
			jitter := time.Duration(rand.Int63n(60)) * time.Second //nolint:gosec
			select {
			case <-ctx.Done():
				return
			case <-time.After(jitter):
			}
			s.aggregate(ctx)
		}
	}
}

func (s *Scheduler) aggregate(ctx context.Context) {
	if err := s.store.Aggregate(ctx, s.minOrgs); err != nil {
		log.Printf("classify: aggregate error: %v", err)
	}
}
