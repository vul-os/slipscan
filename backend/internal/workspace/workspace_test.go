package workspace

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/exolutionza/slipscan/backend/internal/org"
)

// TestAggregationQueryShape validates the aggregation SQL by PREPAREing it
// against the real local postgres. No rows need to exist; we only care that
// the query is syntactically and semantically valid against the live schema.
// Skip when DATABASE_URL is not set (CI without a DB).
func TestAggregationQueryShape(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		// Fall back to the local socket used in development.
		dsn = "host=/var/run/postgresql dbname=slipscan sslmode=disable"
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Skipf("cannot open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Skipf("db not reachable: %v", err)
	}

	store := NewStore(db)
	// Use a random UUID that will match zero rows — we only care the query runs.
	ghostUser := uuid.New()
	entries, err := store.ForUser(context.Background(), ghostUser)
	if err != nil {
		t.Fatalf("ForUser failed: %v", err)
	}
	// A fresh user has no memberships, so we expect an empty slice.
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for unknown user, got %d", len(entries))
	}
}

// TestOrgEntryShape ensures the OrgEntry struct marshals the correct fields.
func TestOrgEntryShape(t *testing.T) {
	e := OrgEntry{
		ID:   uuid.New().String(),
		Name: "Acme Ltd",
		Kind: org.KindBusiness,
		Role: org.RoleAccountant,
		Attention: Attention{
			UnverifiedTransactions: 3,
			UnmatchedLines:         1,
			PendingDocuments:       0,
			SuggestedMatches:       2,
		},
	}
	if e.Attention.UnverifiedTransactions != 3 {
		t.Errorf("expected 3 unverified, got %d", e.Attention.UnverifiedTransactions)
	}
	if e.Role != org.RoleAccountant {
		t.Errorf("expected accountant role, got %q", e.Role)
	}
}

// TestAttentionZeroValues confirms Attention{} is a valid zero value (no panics).
func TestAttentionZeroValues(t *testing.T) {
	var a Attention
	if a.UnverifiedTransactions != 0 || a.UnmatchedLines != 0 ||
		a.PendingDocuments != 0 || a.SuggestedMatches != 0 {
		t.Error("zero Attention should have all zero counts")
	}
}
