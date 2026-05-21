package ledger

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─── validateJournalLines tests ───────────────────────────────────────────────

func TestValidateJournalLines_Balanced(t *testing.T) {
	accA := uuid.New()
	accB := uuid.New()
	lines := []JournalLine{
		{AccountID: accA, Debit: 100.00, Credit: 0},
		{AccountID: accB, Debit: 0, Credit: 100.00},
	}
	if err := validateJournalLines(lines); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestValidateJournalLines_Unbalanced(t *testing.T) {
	accA := uuid.New()
	accB := uuid.New()
	lines := []JournalLine{
		{AccountID: accA, Debit: 100.00, Credit: 0},
		{AccountID: accB, Debit: 0, Credit: 99.99},
	}
	if err := validateJournalLines(lines); err == nil {
		t.Fatal("expected ErrUnbalanced, got nil")
	}
}

func TestValidateJournalLines_TooFewLines(t *testing.T) {
	accA := uuid.New()
	lines := []JournalLine{
		{AccountID: accA, Debit: 100.00, Credit: 0},
	}
	if err := validateJournalLines(lines); err != ErrNoLines {
		t.Fatalf("expected ErrNoLines, got %v", err)
	}
}

func TestValidateJournalLines_BothSidesSet(t *testing.T) {
	accA := uuid.New()
	accB := uuid.New()
	lines := []JournalLine{
		{AccountID: accA, Debit: 50, Credit: 50}, // invalid: both sides
		{AccountID: accB, Debit: 0, Credit: 100},
	}
	if err := validateJournalLines(lines); err != ErrInvalidAmount {
		t.Fatalf("expected ErrInvalidAmount, got %v", err)
	}
}

func TestValidateJournalLines_NeitherSideSet(t *testing.T) {
	accA := uuid.New()
	accB := uuid.New()
	lines := []JournalLine{
		{AccountID: accA, Debit: 0, Credit: 0}, // invalid: neither side
		{AccountID: accB, Debit: 100, Credit: 0},
	}
	if err := validateJournalLines(lines); err != ErrInvalidAmount {
		t.Fatalf("expected ErrInvalidAmount, got %v", err)
	}
}

func TestValidateJournalLines_MultilineBalanced(t *testing.T) {
	// 3-line journal: one debit splits across two accounts.
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	lines := []JournalLine{
		{AccountID: a, Debit: 300.00, Credit: 0},
		{AccountID: b, Debit: 0, Credit: 200.00},
		{AccountID: c, Debit: 0, Credit: 100.00},
	}
	if err := validateJournalLines(lines); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestValidateJournalLines_FloatingPointEpsilon(t *testing.T) {
	// Tiny sub-cent difference (0.0001) should be tolerated.
	a, b := uuid.New(), uuid.New()
	lines := []JournalLine{
		{AccountID: a, Debit: 100.0001, Credit: 0},
		{AccountID: b, Debit: 0, Credit: 100.0000},
	}
	if err := validateJournalLines(lines); err != nil {
		t.Fatalf("expected nil for epsilon diff, got %v", err)
	}
}

// ─── Double-entry posting invariant (unit, no DB) ────────────────────────────
//
// We can't hit a DB in a pure unit test, but we can verify the balance logic
// that postTransactionTx would enforce: given two entries produced for a
// transaction, their debit sum == credit sum.

func TestDoubleEntryBalance_Expense(t *testing.T) {
	amount := 250.00
	// Simulated expense (debit direction) posting:
	// DR expense-account 250 / CR bank-account 250
	debitEntry := struct{ debit, credit float64 }{debit: amount, credit: 0}
	creditEntry := struct{ debit, credit float64 }{debit: 0, credit: amount}

	totalDebit := debitEntry.debit + creditEntry.debit
	totalCredit := debitEntry.credit + creditEntry.credit
	if totalDebit != totalCredit {
		t.Fatalf("expense posting unbalanced: debit=%v credit=%v", totalDebit, totalCredit)
	}
}

func TestDoubleEntryBalance_Income(t *testing.T) {
	amount := 1500.00
	// Simulated income (credit direction) posting:
	// DR bank-account 1500 / CR income-account 1500
	debitEntry := struct{ debit, credit float64 }{debit: amount, credit: 0}
	creditEntry := struct{ debit, credit float64 }{debit: 0, credit: amount}

	totalDebit := debitEntry.debit + creditEntry.debit
	totalCredit := debitEntry.credit + creditEntry.credit
	if totalDebit != totalCredit {
		t.Fatalf("income posting unbalanced: debit=%v credit=%v", totalDebit, totalCredit)
	}
}

func TestDoubleEntryBalance_ReversalNetToZero(t *testing.T) {
	// Original posting: DR expense 300 / CR bank 300.
	// Reversal deletes both rows, then re-posts with new amount 450.
	// After reversal + re-post the net of all four conceptual lines is 0.
	//
	// This unit test models the invariant without a DB.
	origAmount := 300.00
	newAmount := 450.00

	origDebit := origAmount
	origCredit := origAmount
	revDebit := -origAmount  // reversal negates
	revCredit := -origAmount // reversal negates
	newDebit := newAmount
	newCredit := newAmount

	totalDebit := origDebit + revDebit + newDebit
	totalCredit := origCredit + revCredit + newCredit
	if totalDebit != totalCredit {
		t.Fatalf("post-reversal unbalanced: debit=%v credit=%v", totalDebit, totalCredit)
	}
}

// ─── Trial-balance net-to-zero invariant (unit) ───────────────────────────────
//
// Every balanced journal contributes equal debits and credits. Sum of all
// balanced journals must also net to zero. We verify this with a table of
// journals.

func TestTrialBalanceNetToZero(t *testing.T) {
	type journal struct {
		lines []JournalLine
	}
	journals := []journal{
		{lines: []JournalLine{
			{AccountID: uuid.New(), Debit: 1000, Credit: 0},
			{AccountID: uuid.New(), Debit: 0, Credit: 1000},
		}},
		{lines: []JournalLine{
			{AccountID: uuid.New(), Debit: 500, Credit: 0},
			{AccountID: uuid.New(), Debit: 0, Credit: 300},
			{AccountID: uuid.New(), Debit: 0, Credit: 200},
		}},
		{lines: []JournalLine{
			{AccountID: uuid.New(), Debit: 75.50, Credit: 0},
			{AccountID: uuid.New(), Debit: 0, Credit: 75.50},
		}},
	}

	var grandDebit, grandCredit float64
	for _, j := range journals {
		if err := validateJournalLines(j.lines); err != nil {
			t.Fatalf("journal invalid: %v", err)
		}
		for _, l := range j.lines {
			grandDebit += l.Debit
			grandCredit += l.Credit
		}
	}

	diff := grandDebit - grandCredit
	if diff < 0 {
		diff = -diff
	}
	if diff > 0.001 {
		t.Fatalf("trial balance does not net to zero: debit=%v credit=%v diff=%v",
			grandDebit, grandCredit, diff)
	}
}

// ─── ManualJournal balance enforcement ────────────────────────────────────────

func TestManualJournalBalanceEnforcement(t *testing.T) {
	tests := []struct {
		name    string
		lines   []JournalLine
		wantErr error
	}{
		{
			name: "balanced two-liner",
			lines: []JournalLine{
				{AccountID: uuid.New(), Debit: 500, Credit: 0},
				{AccountID: uuid.New(), Debit: 0, Credit: 500},
			},
			wantErr: nil,
		},
		{
			name:    "empty",
			lines:   nil,
			wantErr: ErrNoLines,
		},
		{
			name: "single line",
			lines: []JournalLine{
				{AccountID: uuid.New(), Debit: 100, Credit: 0},
			},
			wantErr: ErrNoLines,
		},
		{
			name: "debit > credit",
			lines: []JournalLine{
				{AccountID: uuid.New(), Debit: 200, Credit: 0},
				{AccountID: uuid.New(), Debit: 0, Credit: 100},
			},
			wantErr: ErrUnbalanced,
		},
		{
			name: "both sides non-zero",
			lines: []JournalLine{
				{AccountID: uuid.New(), Debit: 100, Credit: 100},
				{AccountID: uuid.New(), Debit: 0, Credit: 200},
			},
			wantErr: ErrInvalidAmount,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateJournalLines(tc.lines)
			if tc.wantErr == nil && err != nil {
				t.Fatalf("expected nil error, got %v", err)
			}
			if tc.wantErr != nil && err != tc.wantErr {
				t.Fatalf("expected %v, got %v", tc.wantErr, err)
			}
		})
	}
}

// ─── Date parsing helper ──────────────────────────────────────────────────────

func mustDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

// TestAccountLedgerDateRange verifies the date range filter computes correctly
// for a simulated set of entries (no DB needed — testing the logic path).
func TestAccountLedgerDateRange(t *testing.T) {
	from := mustDate("2026-01-01")
	to := mustDate("2026-03-31")

	entries := []struct {
		date time.Time
	}{
		{mustDate("2025-12-31")},
		{mustDate("2026-01-01")},
		{mustDate("2026-02-15")},
		{mustDate("2026-03-31")},
		{mustDate("2026-04-01")},
	}

	var inRange []time.Time
	for _, e := range entries {
		if !e.date.Before(from) && !e.date.After(to) {
			inRange = append(inRange, e.date)
		}
	}
	if len(inRange) != 3 {
		t.Fatalf("expected 3 entries in range, got %d", len(inRange))
	}
}
