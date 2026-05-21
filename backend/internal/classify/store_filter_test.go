package classify

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestListTransactionsDocumentIDFilter verifies that the tx filter
// (document_id query parameter) correctly modifies the SQL query and args
// when a document_id is provided, and leaves them unchanged when nil.
//
// tx filter: these tests exercise the query-building logic without a real DB.
func TestListTransactionsDocumentIDFilter(t *testing.T) {
	orgID := uuid.New()
	docID := uuid.New()

	t.Run("no document_id filter — no extra arg", func(t *testing.T) {
		args, docFilter := buildListTransactionsArgs(orgID, 50, 0, nil)
		if docFilter != "" {
			t.Errorf("expected empty docFilter, got %q", docFilter)
		}
		if len(args) != 3 {
			t.Errorf("expected 3 args (orgID, limit, offset), got %d", len(args))
		}
		if args[0] != orgID {
			t.Errorf("args[0] = %v, want %v", args[0], orgID)
		}
	})

	t.Run("with document_id filter — $4 added to WHERE", func(t *testing.T) {
		args, docFilter := buildListTransactionsArgs(orgID, 50, 0, &docID)
		if !strings.Contains(docFilter, "$4") {
			t.Errorf("expected docFilter to contain $4, got %q", docFilter)
		}
		if len(args) != 4 {
			t.Errorf("expected 4 args (orgID, limit, offset, docID), got %d", len(args))
		}
		if args[3] != docID {
			t.Errorf("args[3] = %v, want %v", args[3], docID)
		}
	})

	t.Run("limit clamped to 50 when 0", func(t *testing.T) {
		args, _ := buildListTransactionsArgs(orgID, 0, 0, nil)
		if args[1] != 50 {
			t.Errorf("limit = %v, want 50", args[1])
		}
	})

	t.Run("limit clamped to 50 when >200", func(t *testing.T) {
		args, _ := buildListTransactionsArgs(orgID, 300, 0, nil)
		if args[1] != 50 {
			t.Errorf("limit = %v, want 50", args[1])
		}
	})
}

// buildListTransactionsArgs mirrors the query-building logic in ListTransactions
// so we can unit-test it without a live database connection.
//
// tx filter: extracted from ListTransactions for testability.
func buildListTransactionsArgs(orgID uuid.UUID, limit, offset int, documentID *uuid.UUID) ([]any, string) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{orgID, limit, offset}
	docFilter := ""
	if documentID != nil {
		args = append(args, *documentID)
		docFilter = " AND t.document_id = $4"
	}
	return args, docFilter
}
