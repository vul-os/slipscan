package fx

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"testing"
	"time"
)

// ── Minimal sql/driver mock ────────────────────────────────────────────────
// We implement just enough of database/sql/driver to exercise Store.Upsert
// without a real database. The mock records every SQL execution so we can
// verify idempotency (same (base,quote,as_of) called twice should appear in
// the execution log twice — the ON CONFLICT DO UPDATE logic lives in Postgres,
// not Go, so we only verify that the correct SQL and args are sent).

type mockRows struct{}

func (r *mockRows) Columns() []string               { return nil }
func (r *mockRows) Close() error                     { return nil }
func (r *mockRows) Next(dest []driver.Value) error   { return fmt.Errorf("no rows") }

type mockStmt struct {
	execLog *[]execEntry
	query   string
}

type execEntry struct {
	query string
	args  []driver.Value
}

func (s *mockStmt) Close() error { return nil }
func (s *mockStmt) NumInput() int { return -1 } // variadic

func (s *mockStmt) Exec(args []driver.Value) (driver.Result, error) {
	*s.execLog = append(*s.execLog, execEntry{query: s.query, args: args})
	return driver.RowsAffected(1), nil
}

func (s *mockStmt) Query(args []driver.Value) (driver.Rows, error) {
	return &mockRows{}, nil
}

type mockTx struct {
	execLog *[]execEntry
}

func (t *mockTx) Commit() error   { return nil }
func (t *mockTx) Rollback() error { return nil }

type mockConn struct {
	execLog *[]execEntry
}

func (c *mockConn) Prepare(query string) (driver.Stmt, error) {
	return &mockStmt{execLog: c.execLog, query: query}, nil
}
func (c *mockConn) Close() error                                       { return nil }
func (c *mockConn) Begin() (driver.Tx, error)                          { return &mockTx{}, nil }
func (c *mockConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &mockTx{}, nil
}
func (c *mockConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	return &mockStmt{execLog: c.execLog, query: query}, nil
}

type mockDriver struct {
	execLog *[]execEntry
}

func (d *mockDriver) Open(_ string) (driver.Conn, error) {
	return &mockConn{execLog: d.execLog}, nil
}

// registerMockDriver registers a fresh driver and returns a *sql.DB and the
// exec log. Each call uses a unique driver name to avoid "already registered"
// panics when tests run in the same binary.
var mockDriverCount int

func newMockDB(t *testing.T) (*sql.DB, *[]execEntry) {
	t.Helper()
	log := &[]execEntry{}
	name := fmt.Sprintf("mock_fx_%d", mockDriverCount)
	mockDriverCount++
	sql.Register(name, &mockDriver{execLog: log})
	db, err := sql.Open(name, "mock")
	if err != nil {
		t.Fatalf("open mock db: %v", err)
	}
	return db, log
}

// ── Store tests ────────────────────────────────────────────────────────────

func TestStoreUpsertCallsInsertForEachRate(t *testing.T) {
	db, log := newMockDB(t)
	defer db.Close()

	store := NewStore(db)
	result := &FetchResult{
		Base: "USD",
		AsOf: time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC),
		Rates: map[string]float64{
			"ZAR": 18.42,
			"EUR": 0.92,
			"GBP": 0.79,
		},
	}

	if err := store.Upsert(context.Background(), result, "frankfurter.app"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	// Three rates → three exec calls (one per quote currency).
	if len(*log) != 3 {
		t.Errorf("expected 3 exec calls, got %d", len(*log))
	}
}

func TestStoreUpsertSkipsBasePair(t *testing.T) {
	db, log := newMockDB(t)
	defer db.Close()

	store := NewStore(db)
	result := &FetchResult{
		Base: "USD",
		AsOf: time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC),
		Rates: map[string]float64{
			"USD": 1.0,  // should be skipped
			"ZAR": 18.42,
		},
	}

	if err := store.Upsert(context.Background(), result, "test"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	// Only ZAR should be written; USD self-pair is skipped.
	if len(*log) != 1 {
		t.Errorf("expected 1 exec call (ZAR only), got %d", len(*log))
	}
}

func TestStoreUpsertSkipsNonPositiveRates(t *testing.T) {
	db, log := newMockDB(t)
	defer db.Close()

	store := NewStore(db)
	result := &FetchResult{
		Base: "USD",
		AsOf: time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC),
		Rates: map[string]float64{
			"ZAR": 18.42,
			"BAD": 0,    // zero — should be skipped
			"NEG": -1.0, // negative — should be skipped
		},
	}

	if err := store.Upsert(context.Background(), result, "test"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if len(*log) != 1 {
		t.Errorf("expected 1 exec call (ZAR only), got %d", len(*log))
	}
}

func TestStoreUpsertNilResultIsNoop(t *testing.T) {
	db, log := newMockDB(t)
	defer db.Close()

	store := NewStore(db)
	if err := store.Upsert(context.Background(), nil, "test"); err != nil {
		t.Fatalf("Upsert(nil): %v", err)
	}
	if len(*log) != 0 {
		t.Errorf("expected 0 exec calls for nil result, got %d", len(*log))
	}
}

func TestStoreUpsertIdempotent(t *testing.T) {
	// Call Upsert twice with the same data; both should succeed (the SQL
	// ON CONFLICT ... DO UPDATE handles deduplication). We verify that the
	// second call produces the same number of exec calls — the idempotency
	// logic lives in Postgres but we confirm the Go layer doesn't gate on it.
	db, log := newMockDB(t)
	defer db.Close()

	store := NewStore(db)
	result := &FetchResult{
		Base: "USD",
		AsOf: time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC),
		Rates: map[string]float64{
			"ZAR": 18.42,
			"EUR": 0.92,
		},
	}

	if err := store.Upsert(context.Background(), result, "test"); err != nil {
		t.Fatalf("first Upsert: %v", err)
	}
	firstCount := len(*log)

	if err := store.Upsert(context.Background(), result, "test"); err != nil {
		t.Fatalf("second Upsert: %v", err)
	}
	secondCount := len(*log) - firstCount

	if firstCount != secondCount {
		t.Errorf("idempotency: first call had %d execs, second had %d — should match",
			firstCount, secondCount)
	}
}
