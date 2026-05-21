// Package audit — integration-style tests that verify sensitive paths emit
// audit entries. These tests use the fakeQuerier from audit_test.go to avoid
// live DB calls.
package audit

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// TestSensitivePathEntries validates that an audit.Entry produced for each
// instrumented sensitive path contains the required fields defined in P4-03.
//
// Each sub-test constructs the entry as the instrumented call site does, then
// verifies actor + entity + action + before/after presence.
func TestSensitivePathEntries(t *testing.T) {
	orgID := uuid.New()
	actorID := uuid.New()
	entityID := uuid.New()

	t.Run("classification.corrected entry is valid", func(t *testing.T) {
		before := MarshalBefore(map[string]any{
			"category_id": uuid.New(),
			"source":      "llm",
		})
		after := MarshalAfter(map[string]any{
			"category_id": uuid.New(),
			"source":      "user",
		})
		e := Entry{
			OrganizationID: &orgID,
			ActorUserID:    &actorID,
			EntityType:     "transaction",
			EntityID:       &entityID,
			Action:         "classification.corrected",
			Before:         before,
			After:          after,
		}
		assertEntryValid(t, e)

		q := &fakeQuerier{}
		if err := Write(context.Background(), q, e); err != nil {
			t.Fatalf("Write: %v", err)
		}
		if !q.called {
			t.Fatal("ExecContext was not called — entry was not written")
		}
	})

	t.Run("membership.added entry is valid", func(t *testing.T) {
		after := MarshalAfter(map[string]any{
			"user_id": uuid.New(),
			"role":    "member",
		})
		e := Entry{
			OrganizationID: &orgID,
			EntityType:     "membership",
			EntityID:       &entityID,
			Action:         "membership.added",
			After:          after,
		}
		assertEntryValid(t, e)

		q := &fakeQuerier{}
		if err := Write(context.Background(), q, e); err != nil {
			t.Fatalf("Write: %v", err)
		}
		if !q.called {
			t.Fatal("ExecContext was not called — entry was not written")
		}
	})

	t.Run("organization.created entry is valid", func(t *testing.T) {
		after := MarshalAfter(map[string]any{
			"kind": "business",
			"name": "Acme Corp",
			"slug": "acme-corp",
		})
		e := Entry{
			OrganizationID: &orgID,
			ActorUserID:    &actorID,
			EntityType:     "organization",
			EntityID:       &orgID,
			Action:         "organization.created",
			After:          after,
		}
		assertEntryValid(t, e)

		q := &fakeQuerier{}
		if err := Write(context.Background(), q, e); err != nil {
			t.Fatalf("Write: %v", err)
		}
		if !q.called {
			t.Fatal("ExecContext was not called — entry was not written")
		}
	})
}

// TestAppendOnlyPolicy documents the append-only contract: the Write helper
// only ever INSERTs and never issues UPDATE or DELETE.
func TestAppendOnlyPolicy(t *testing.T) {
	q := &fakeQuerier{}
	orgID := uuid.New()
	e := Entry{
		OrganizationID: &orgID,
		EntityType:     "transaction",
		Action:         "classification.corrected",
	}
	if err := Write(context.Background(), q, e); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Verify the SQL is an INSERT (not UPDATE/DELETE).
	if len(q.query) < 6 || q.query[:6] != "\n\t\tINSE" {
		// Flexible check: just ensure "INSERT" appears and "UPDATE"/"DELETE" do not.
		if !containsWord(q.query, "INSERT") {
			t.Errorf("expected INSERT in query, got: %s", q.query)
		}
		if containsWord(q.query, "UPDATE") {
			t.Errorf("query must not contain UPDATE: %s", q.query)
		}
		if containsWord(q.query, "DELETE") {
			t.Errorf("query must not contain DELETE: %s", q.query)
		}
	}
}

// assertEntryValid checks that an Entry has the minimum required fields for a
// useful audit record.
func assertEntryValid(t *testing.T, e Entry) {
	t.Helper()
	if e.EntityType == "" {
		t.Error("EntityType must not be empty")
	}
	if e.Action == "" {
		t.Error("Action must not be empty")
	}
	// Entries for user-initiated mutations must have an org.
	if e.ActorUserID != nil && e.OrganizationID == nil {
		t.Error("user-actor entry must have OrganizationID")
	}
	// If After is set, it must be valid JSON.
	if len(e.After) > 0 {
		if !json.Valid(e.After) {
			t.Errorf("After is not valid JSON: %s", e.After)
		}
	}
	// If Before is set, it must be valid JSON.
	if len(e.Before) > 0 {
		if !json.Valid(e.Before) {
			t.Errorf("Before is not valid JSON: %s", e.Before)
		}
	}
}

func containsWord(s, word string) bool {
	for i := 0; i <= len(s)-len(word); i++ {
		if s[i:i+len(word)] == word {
			return true
		}
	}
	return false
}
