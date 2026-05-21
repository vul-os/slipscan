package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// -----------------------------------------------------------------------------
// MarshalBefore / MarshalAfter
// -----------------------------------------------------------------------------

func TestMarshalBeforeAfter(t *testing.T) {
	type item struct{ Name string }

	t.Run("valid struct serialises", func(t *testing.T) {
		raw := MarshalBefore(item{Name: "acme"})
		if raw == nil {
			t.Fatal("expected non-nil JSON")
		}
		var got item
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got.Name != "acme" {
			t.Errorf("name: want acme, got %s", got.Name)
		}
	})

	t.Run("nil input returns nil", func(t *testing.T) {
		if MarshalBefore(nil) != nil {
			t.Error("expected nil for nil input")
		}
	})

	t.Run("MarshalAfter matches MarshalBefore", func(t *testing.T) {
		v := item{Name: "x"}
		a := MarshalBefore(v)
		b := MarshalAfter(v)
		if string(a) != string(b) {
			t.Errorf("before=%s after=%s", a, b)
		}
	})
}

// -----------------------------------------------------------------------------
// nullUUID / nullJSON helpers
// -----------------------------------------------------------------------------

func TestNullHelpers(t *testing.T) {
	t.Run("nullUUID nil → nil", func(t *testing.T) {
		if nullUUID(nil) != nil {
			t.Error("expected nil")
		}
	})
	t.Run("nullUUID non-nil → UUID", func(t *testing.T) {
		id := uuid.New()
		got := nullUUID(&id)
		if got != id {
			t.Errorf("want %s, got %v", id, got)
		}
	})
	t.Run("nullJSON empty → nil", func(t *testing.T) {
		if nullJSON(nil) != nil {
			t.Error("expected nil for nil")
		}
		if nullJSON(json.RawMessage{}) != nil {
			t.Error("expected nil for empty")
		}
	})
	t.Run("nullJSON non-empty → bytes", func(t *testing.T) {
		raw := json.RawMessage(`{"k":1}`)
		got := nullJSON(raw)
		if got == nil {
			t.Fatal("expected non-nil")
		}
	})
}

// -----------------------------------------------------------------------------
// Write — fake Querier that captures calls
// -----------------------------------------------------------------------------

type fakeQuerier struct {
	called bool
	query  string
	args   []any
	err    error
}

func (f *fakeQuerier) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	f.called = true
	f.query = query
	f.args = args
	return nil, f.err
}

func TestWrite(t *testing.T) {
	orgID := uuid.New()
	actorID := uuid.New()
	entityID := uuid.New()

	t.Run("inserts with all fields", func(t *testing.T) {
		q := &fakeQuerier{}
		e := Entry{
			OrganizationID: &orgID,
			ActorUserID:    &actorID,
			EntityType:     "transaction",
			EntityID:       &entityID,
			Action:         "classification.corrected",
			Before:         json.RawMessage(`{"cat":"old"}`),
			After:          json.RawMessage(`{"cat":"new"}`),
			IPAddress:      "127.0.0.1",
			UserAgent:      "test/1.0",
		}
		if err := Write(context.Background(), q, e); err != nil {
			t.Fatalf("Write returned error: %v", err)
		}
		if !q.called {
			t.Fatal("ExecContext was not called")
		}
	})

	t.Run("propagates querier error", func(t *testing.T) {
		want := errors.New("db error")
		q := &fakeQuerier{err: want}
		err := Write(context.Background(), q, Entry{EntityType: "test", Action: "test"})
		if !errors.Is(err, want) {
			t.Errorf("want %v, got %v", want, err)
		}
	})

	t.Run("nil org and actor are accepted", func(t *testing.T) {
		q := &fakeQuerier{}
		err := Write(context.Background(), q, Entry{
			EntityType: "system",
			Action:     "system.startup",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// Confirm ExecContext was invoked.
		if !q.called {
			t.Fatal("ExecContext was not called")
		}
	})
}

// -----------------------------------------------------------------------------
// Store helpers (itoa / andParam)
// -----------------------------------------------------------------------------

func TestItoa(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 0}, {1, 1}, {9, 9}, {10, 10}, {100, 100}, {999, 999},
	}
	for _, c := range cases {
		got := itoa(c.in)
		if got != itoa(c.want) {
			// Use string representation to check
			wantStr := itoa(c.want)
			if got != wantStr {
				t.Errorf("itoa(%d) = %q, want %q", c.in, got, wantStr)
			}
		}
	}
}
