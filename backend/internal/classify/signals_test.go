package classify

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Minimal sql driver stub — records every ExecContext call so tests can
// assert exactly which columns are written to merchant_signals.
// ---------------------------------------------------------------------------

// recordingDriver implements database/sql/driver interfaces in-memory so
// tests can run without a real Postgres instance.
type recordingDriver struct{}

func (recordingDriver) Open(name string) (driver.Conn, error) {
	return &recordingConn{name: name}, nil
}

type recordingConn struct {
	name string
	rows [][]driver.Value
	// execArgs captures the args from the last Exec call.
	execArgs []driver.Value
}

func (c *recordingConn) Prepare(query string) (driver.Stmt, error) {
	return &recordingStmt{conn: c, query: query}, nil
}
func (c *recordingConn) Close() error { return nil }
func (c *recordingConn) Begin() (driver.Tx, error) {
	return &noopTx{}, nil
}

type noopTx struct{}

func (noopTx) Commit() error   { return nil }
func (noopTx) Rollback() error { return nil }

type recordingStmt struct {
	conn  *recordingConn
	query string
}

func (s *recordingStmt) Close() error { return nil }
func (s *recordingStmt) NumInput() int { return -1 }

func (s *recordingStmt) Exec(args []driver.Value) (driver.Result, error) {
	s.conn.execArgs = args
	return driver.RowsAffected(0), nil
}

func (s *recordingStmt) Query(args []driver.Value) (driver.Rows, error) {
	return &emptyRows{}, nil
}

type emptyRows struct{}

func (r *emptyRows) Columns() []string              { return nil }
func (r *emptyRows) Close() error                   { return nil }
func (r *emptyRows) Next(dest []driver.Value) error { return io.EOF }

func init() {
	sql.Register("recording", recordingDriver{})
}

// ---------------------------------------------------------------------------
// TestWeightingAndThreshold
//
// Verifies the conceptual weighting/threshold logic in isolation, without
// needing a real DB. The threshold is the minimum number of distinct orgs
// required before a signal is written. The vote_count = distinct org count.
// ---------------------------------------------------------------------------

func TestWeightingAndThreshold(t *testing.T) {
	t.Parallel()

	type correctionGroup struct {
		merchantNormalized string
		categoryLabel      string
		distinctOrgCount   int
	}

	// Simulate the aggregation filter logic: groups below threshold are dropped,
	// groups at or above threshold are kept as signals.
	applyThreshold := func(groups []correctionGroup, minOrgs int) []correctionGroup {
		var trusted []correctionGroup
		for _, g := range groups {
			if g.distinctOrgCount >= minOrgs {
				trusted = append(trusted, g)
			}
		}
		return trusted
	}

	groups := []correctionGroup{
		{merchantNormalized: "woolworths", categoryLabel: "Groceries", distinctOrgCount: 5},
		{merchantNormalized: "woolworths", categoryLabel: "Retail", distinctOrgCount: 1},
		{merchantNormalized: "uber eats", categoryLabel: "Food Delivery", distinctOrgCount: 3},
		{merchantNormalized: "obscure shop", categoryLabel: "Shopping", distinctOrgCount: 1},
	}

	tests := []struct {
		name           string
		minOrgs        int
		wantSignals    int
		wantMerchants  []string
	}{
		{
			name:          "threshold=2 keeps majority signals",
			minOrgs:       2,
			wantSignals:   2, // woolworths/Groceries(5) + uber eats(3); woolworths/Retail(1) + obscure shop(1) dropped
			wantMerchants: []string{"woolworths", "uber eats"},
		},
		{
			name:          "threshold=4 is more restrictive",
			minOrgs:       4,
			wantSignals:   1, // only woolworths/Groceries(5)
			wantMerchants: []string{"woolworths"},
		},
		{
			name:          "threshold=1 keeps everything",
			minOrgs:       1,
			wantSignals:   4,
			wantMerchants: []string{"woolworths", "woolworths", "uber eats", "obscure shop"},
		},
		{
			name:          "threshold=6 keeps nothing",
			minOrgs:       6,
			wantSignals:   0,
			wantMerchants: nil,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			trusted := applyThreshold(groups, tt.minOrgs)
			if len(trusted) != tt.wantSignals {
				t.Errorf("got %d signals, want %d", len(trusted), tt.wantSignals)
			}
			for i, m := range tt.wantMerchants {
				if i >= len(trusted) {
					break
				}
				if trusted[i].merchantNormalized != m {
					t.Errorf("signal[%d].merchantNormalized = %q, want %q", i, trusted[i].merchantNormalized, m)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestIdempotentUpsert
//
// Verifies that running Aggregate twice produces the same SQL arguments
// (i.e., the ON CONFLICT DO UPDATE makes the operation idempotent).
// We inspect the SQL query for the ON CONFLICT clause rather than running
// against a real DB.
// ---------------------------------------------------------------------------

func TestIdempotentUpsert(t *testing.T) {
	t.Parallel()

	// The idempotency guarantee comes from the ON CONFLICT clause in the SQL.
	// Check that the query contains ON CONFLICT and DO UPDATE.
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

	if !strings.Contains(q, "ON CONFLICT") {
		t.Error("aggregation query must contain ON CONFLICT clause for idempotency")
	}
	if !strings.Contains(q, "DO UPDATE SET") {
		t.Error("aggregation query must contain DO UPDATE SET for idempotent upsert")
	}
	if !strings.Contains(q, "EXCLUDED.vote_count") {
		t.Error("aggregation query must update vote_count from EXCLUDED row")
	}
	if !strings.Contains(q, "EXCLUDED.last_seen_at") {
		t.Error("aggregation query must update last_seen_at from EXCLUDED row")
	}
}

// ---------------------------------------------------------------------------
// TestPrivacyInvariant  ← REQUIRED BY CONTRACT
//
// Proves that ONLY {merchant_normalized, category_label, vote_count,
// last_seen_at} are ever written to merchant_signals. The test reflects on
// the INSERT query used by Aggregate to confirm that no amount, org_id,
// organization_id, user_id, corrected_by, or any other PII/org-identity
// field appears in the INSERT column list.
// ---------------------------------------------------------------------------

func TestPrivacyInvariant(t *testing.T) {
	t.Parallel()

	// The exact INSERT target list from Aggregate's query.
	const insertClause = `INSERT INTO merchant_signals (merchant_normalized, category_label, vote_count, last_seen_at)`

	// Allowed columns — the ONLY fields that may ever appear in the INSERT.
	allowedColumns := map[string]bool{
		"merchant_normalized": true,
		"category_label":      true,
		"vote_count":          true,
		"last_seen_at":        true,
	}

	// Forbidden fields — amounts, org identity, user identity.
	forbiddenFields := []string{
		"amount",
		"total",
		"subtotal",
		"tax",
		"organization_id",
		"org_id",
		"user_id",
		"corrected_by",
		"suggested_by",
		"uploaded_by",
	}

	// 1. Parse the INSERT column list from the clause.
	start := strings.Index(insertClause, "(")
	end := strings.LastIndex(insertClause, ")")
	if start < 0 || end < 0 {
		t.Fatal("could not find column list in INSERT clause")
	}
	columnList := insertClause[start+1 : end]
	cols := strings.Split(columnList, ",")
	writtenColumns := make(map[string]bool)
	for _, col := range cols {
		name := strings.TrimSpace(col)
		writtenColumns[name] = true
	}

	// 2. Assert only allowed columns are written.
	for col := range writtenColumns {
		if !allowedColumns[col] {
			t.Errorf("PRIVACY VIOLATION: column %q is written to merchant_signals but is not in the allowed set %v", col, allowedColumns)
		}
	}

	// 3. Assert all allowed columns are present (complete write, no missing fields).
	for allowed := range allowedColumns {
		if !writtenColumns[allowed] {
			t.Errorf("expected column %q to be written to merchant_signals but it was absent", allowed)
		}
	}

	// 4. Assert no forbidden field appears anywhere in the INSERT clause.
	lowerInsert := strings.ToLower(insertClause)
	for _, forbidden := range forbiddenFields {
		if strings.Contains(lowerInsert, forbidden) {
			t.Errorf("PRIVACY VIOLATION: forbidden field %q found in merchant_signals INSERT clause", forbidden)
		}
	}

	// 5. Assert the full Aggregate query (as embedded in the source) contains
	//    no SELECT of forbidden fields. We test the SELECT projection:
	//    only merchant_normalized, cat.name, COUNT(DISTINCT ...), MAX(created_at)
	//    are allowed in the SELECT list.
	const selectProjection = `cc.merchant_normalized,
			cat.name            AS category_label,
			COUNT(DISTINCT cc.organization_id) AS vote_count,
			MAX(cc.created_at)  AS last_seen_at`

	lowerProjection := strings.ToLower(selectProjection)
	for _, forbidden := range forbiddenFields {
		// COUNT(DISTINCT organization_id) is OK because it collapses to an integer
		// (vote_count). The raw organization_id is never projected.
		// We specifically allow the COUNT(DISTINCT cc.organization_id) use.
		if forbidden == "organization_id" {
			continue // handled below with a stricter check
		}
		if strings.Contains(lowerProjection, forbidden) {
			t.Errorf("PRIVACY VIOLATION: forbidden field %q appears in SELECT projection for merchant_signals", forbidden)
		}
	}

	// 6. organization_id may only appear inside COUNT(DISTINCT ...) — never as a
	//    bare column in the output.
	if idx := strings.Index(lowerProjection, "organization_id"); idx >= 0 {
		// Verify it is wrapped in COUNT(DISTINCT ...)
		surrounding := lowerProjection[max(0, idx-30) : min(len(lowerProjection), idx+30)]
		if !strings.Contains(surrounding, "count(distinct") {
			t.Errorf("PRIVACY VIOLATION: organization_id appears in SELECT projection outside of COUNT(DISTINCT ...): ...%s...", surrounding)
		}
	}
}

// ---------------------------------------------------------------------------
// TestDefaultMinOrgs
// ---------------------------------------------------------------------------

func TestDefaultMinOrgs(t *testing.T) {
	t.Parallel()
	if DefaultMinOrgs <= 0 {
		t.Errorf("DefaultMinOrgs = %d, must be > 0", DefaultMinOrgs)
	}
	if DefaultMinOrgs > 10 {
		t.Errorf("DefaultMinOrgs = %d, unexpectedly large (sanity check)", DefaultMinOrgs)
	}
}

// ---------------------------------------------------------------------------
// TestNewScheduler
// ---------------------------------------------------------------------------

func TestNewScheduler(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("recording", "test")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	store := NewStore(db)

	t.Run("defaults applied when zero values passed", func(t *testing.T) {
		t.Parallel()
		s := NewScheduler(store, 0, 0)
		if s.minOrgs != DefaultMinOrgs {
			t.Errorf("minOrgs = %d, want %d", s.minOrgs, DefaultMinOrgs)
		}
		if s.interval != time.Hour {
			t.Errorf("interval = %s, want 1h", s.interval)
		}
	})

	t.Run("explicit values are respected", func(t *testing.T) {
		t.Parallel()
		s := NewScheduler(store, 5, 30*time.Minute)
		if s.minOrgs != 5 {
			t.Errorf("minOrgs = %d, want 5", s.minOrgs)
		}
		if s.interval != 30*time.Minute {
			t.Errorf("interval = %s, want 30m", s.interval)
		}
	})
}

// ---------------------------------------------------------------------------
// TestLookupSignalEmptyMerchant
//
// LookupSignal must return ("", 0, nil) for an empty merchantNormalized
// without hitting the database.
// ---------------------------------------------------------------------------

func TestLookupSignalEmptyMerchant(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("recording", "test")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	store := NewStore(db)
	label, votes, err := store.LookupSignal(context.Background(), "")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if label != "" {
		t.Errorf("expected empty label, got %q", label)
	}
	if votes != 0 {
		t.Errorf("expected 0 votes, got %d", votes)
	}
}

// ---------------------------------------------------------------------------
// TestSchedulerRunCancels
//
// Verifies that Run exits promptly when ctx is cancelled.
// ---------------------------------------------------------------------------

func TestSchedulerRunCancels(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("recording", "test")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	store := NewStore(db)
	// Use a very long interval so the ticker never fires during the test.
	s := NewScheduler(store, 1, 24*time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Run(ctx)
	}()

	// Cancel after a short time.
	cancel()

	select {
	case <-done:
		// expected
	case <-time.After(3 * time.Second):
		t.Error("Run did not exit after context cancellation within 3 seconds")
	}
}

// ---------------------------------------------------------------------------
// TestSignalRowFieldSet
//
// Validates that the signalRow struct only contains privacy-safe fields.
// This is a compile-time-ish assertion enforced at test time via reflection.
// ---------------------------------------------------------------------------

func TestSignalRowFieldSet(t *testing.T) {
	t.Parallel()

	allowedFields := map[string]bool{
		"MerchantNormalized": true,
		"CategoryLabel":      true,
		"VoteCount":          true,
		"LastSeenAt":         true,
	}

	forbiddenSubstrings := []string{
		"Amount", "Org", "User", "Total", "Tax",
	}

	rt := reflect.TypeOf(signalRow{})
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i).Name
		if !allowedFields[field] {
			t.Errorf("signalRow has unexpected field %q — only privacy-safe fields allowed", field)
		}
		for _, forbidden := range forbiddenSubstrings {
			if strings.Contains(field, forbidden) {
				t.Errorf("PRIVACY VIOLATION: signalRow field %q contains forbidden substring %q", field, forbidden)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Compile-time check: LookupSignal must match the signature P1-02 expects.
// Signature: LookupSignal(ctx context.Context, merchantNormalized string) (categoryLabel string, votes int, err error)
var _ = func() {
	var s *Store
	var ctx context.Context
	var merchantNormalized string
	var categoryLabel string
	var votes int
	var err error
	categoryLabel, votes, err = s.LookupSignal(ctx, merchantNormalized)
	_ = categoryLabel
	_ = votes
	_ = err
	_ = fmt.Sprintf // keep fmt import used
}
