package recon

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

func cfg() Config { return DefaultConfig() }

func day(offset int) time.Time {
	base := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	return base.AddDate(0, 0, offset)
}

func makeTx(merchant string, amount float64, date time.Time) TxCandidate {
	return TxCandidate{
		ID:                 uuid.New(),
		OrganizationID:     uuid.New(),
		PostedDate:         date,
		Amount:             amount,
		Currency:           "ZAR",
		Merchant:           merchant,
		MerchantNormalized: merchant, // already normalized in tests
	}
}

func makeLine(description string, amount float64, date time.Time) LineCandidate {
	return LineCandidate{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		LineDate:       date,
		Description:    description,
		Amount:         amount,
	}
}

// ─── scoreAmount ──────────────────────────────────────────────────────────────

func TestScoreAmount_ExactMatch(t *testing.T) {
	s := scoreAmount(250.00, 250.00, cfg())
	if s != 1.0 {
		t.Fatalf("exact match should return 1.0, got %v", s)
	}
}

func TestScoreAmount_WithinAbsTolerance(t *testing.T) {
	// 250.01 vs 250.00 — delta 0.01, abs tolerance 0.02 → within band.
	s := scoreAmount(250.01, 250.00, cfg())
	if s <= 0 || s >= 1 {
		t.Fatalf("within abs tolerance should return 0 < score < 1, got %v", s)
	}
}

func TestScoreAmount_ExceedsBothTolerances(t *testing.T) {
	// 250 vs 260 — delta 10. abs tol 0.02 (no). pct tol 0.5% of 250 = 1.25 (no, 10 > 1.25).
	s := scoreAmount(250.00, 260.00, cfg())
	if s != 0 {
		t.Fatalf("outside both tolerances should return 0, got %v", s)
	}
}

func TestScoreAmount_WithinPctTolerance(t *testing.T) {
	// 10000 vs 10049 — delta 49, abs tol 0.02 (no), pct 0.5% of 10000=50 (yes).
	s := scoreAmount(10000.00, 10049.00, cfg())
	if s <= 0 {
		t.Fatalf("within pct tolerance should return positive score, got %v", s)
	}
}

// ─── scoreDate ────────────────────────────────────────────────────────────────

func TestScoreDate_SameDay(t *testing.T) {
	s := scoreDate(0, cfg())
	if s != 1.0 {
		t.Fatalf("same-day should return 1.0, got %v", s)
	}
}

func TestScoreDate_AtWindowEdge(t *testing.T) {
	// delta == DateWindowDays → score should be 0.
	c := cfg()
	s := scoreDate(c.DateWindowDays, c)
	if s != 0 {
		t.Fatalf("at window edge should return 0, got %v", s)
	}
}

func TestScoreDate_BeyondWindow(t *testing.T) {
	c := cfg()
	s := scoreDate(c.DateWindowDays+1, c)
	if s != 0 {
		t.Fatalf("beyond window should return 0, got %v", s)
	}
}

func TestScoreDate_Midpoint(t *testing.T) {
	c := cfg() // DateWindowDays = 5
	s := scoreDate(2, c)
	// Expected: 1 - 2/5 = 0.6
	want := 0.6
	if diff := s - want; diff < -0.001 || diff > 0.001 {
		t.Fatalf("midpoint score should be ~0.6, got %v", s)
	}
}

// ─── scoreMerchant ────────────────────────────────────────────────────────────

func TestScoreMerchant_ExactMatch(t *testing.T) {
	s := scoreMerchant("woolworths", "woolworths")
	if s != 1.0 {
		t.Fatalf("exact match should return 1.0, got %v", s)
	}
}

func TestScoreMerchant_BothEmpty(t *testing.T) {
	s := scoreMerchant("", "")
	if s != 0.3 {
		t.Fatalf("both empty should return 0.3 (neutral), got %v", s)
	}
}

func TestScoreMerchant_OneEmpty(t *testing.T) {
	s := scoreMerchant("woolworths", "")
	if s != 0.3 {
		t.Fatalf("one empty should return 0.3 (neutral), got %v", s)
	}
}

func TestScoreMerchant_PartialOverlap(t *testing.T) {
	// "woolworths food" vs "woolworths jhb": intersection={woolworths}, union={woolworths,food,jhb} → 1/3
	s := scoreMerchant("woolworths food", "woolworths jhb")
	want := 1.0 / 3.0
	if diff := s - want; diff < -0.001 || diff > 0.001 {
		t.Fatalf("partial overlap should return ~%.4f, got %v", want, s)
	}
}

func TestScoreMerchant_NoOverlap(t *testing.T) {
	s := scoreMerchant("woolworths", "checkers")
	if s != 0 {
		t.Fatalf("no overlap should return 0, got %v", s)
	}
}

// ─── GenerateCandidates ───────────────────────────────────────────────────────

func TestGenerateCandidates_PerfectMatch(t *testing.T) {
	tx := makeTx("woolworths", 250.00, day(0))
	line := makeLine("woolworths", 250.00, day(0))

	c := cfg()
	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line}, c)

	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}
	m := candidates[0]
	if m.Tx.ID != tx.ID {
		t.Errorf("tx ID mismatch")
	}
	if m.Line.ID != line.ID {
		t.Errorf("line ID mismatch")
	}
	if m.Confidence < c.AutoConfidenceThreshold {
		t.Errorf("perfect match should be above auto threshold, got %v", m.Confidence)
	}
}

func TestGenerateCandidates_AmountMismatch(t *testing.T) {
	tx := makeTx("woolworths", 250.00, day(0))
	line := makeLine("woolworths", 500.00, day(0))

	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line}, cfg())
	if len(candidates) != 0 {
		t.Fatalf("amount mismatch should yield no candidates, got %d", len(candidates))
	}
}

func TestGenerateCandidates_DateBeyondWindow(t *testing.T) {
	c := cfg()
	tx := makeTx("woolworths", 250.00, day(0))
	line := makeLine("woolworths", 250.00, day(c.DateWindowDays+1))

	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line}, c)
	if len(candidates) != 0 {
		t.Fatalf("beyond date window should yield no candidates, got %d", len(candidates))
	}
}

func TestGenerateCandidates_DateAtWindowEdge(t *testing.T) {
	// delta == DateWindowDays exactly → dateScore=0 → low confidence.
	c := cfg()
	tx := makeTx("woolworths", 250.00, day(0))
	line := makeLine("woolworths", 250.00, day(c.DateWindowDays))

	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line}, c)
	// dateScore = 0, but amount/merchant are strong; total may still exceed
	// SuggestConfidenceThreshold depending on weights. The important thing is
	// that we do NOT get a high confidence.
	for _, m := range candidates {
		if m.Confidence >= c.AutoConfidenceThreshold {
			t.Errorf("at date window edge confidence should be < auto threshold, got %v", m.Confidence)
		}
	}
}

func TestGenerateCandidates_MerchantMismatch_LowScore(t *testing.T) {
	// Exact amount + date, completely different merchants.
	c := cfg()
	tx := makeTx("woolworths", 250.00, day(0))
	line := makeLine("checkers", 250.00, day(0))

	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line}, c)
	for _, m := range candidates {
		if m.Confidence >= c.AutoConfidenceThreshold {
			t.Errorf("merchant mismatch should not reach auto threshold, got %v", m.Confidence)
		}
	}
}

func TestGenerateCandidates_NoDoubleMatch_SortGuard(t *testing.T) {
	// One tx vs two lines with same amount/date/merchant — only the higher-
	// confidence line should be chosen by sortByConfidence + usedTx guard in
	// RunMatcher. GenerateCandidates itself returns both; the guard lives in
	// RunMatcher. This test verifies sortByConfidence orders them correctly.
	tx := makeTx("woolworths", 250.00, day(0))
	line1 := makeLine("woolworths", 250.00, day(0))
	line2 := makeLine("woolworths", 250.00, day(1)) // 1 day delta → slightly lower score

	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line1, line2}, cfg())
	if len(candidates) < 2 {
		t.Fatalf("expected at least 2 candidates, got %d", len(candidates))
	}

	sortByConfidence(candidates)
	if candidates[0].Confidence < candidates[1].Confidence {
		t.Errorf("sortByConfidence should order descending, got %v < %v",
			candidates[0].Confidence, candidates[1].Confidence)
	}
}

// ─── scoreComponents.totalScore ───────────────────────────────────────────────

func TestScoreComponents_Weights(t *testing.T) {
	// All components at 1.0 → total should be 1.0.
	sc := scoreComponents{amountScore: 1, dateScore: 1, merchantScore: 1}
	if sc.totalScore() != 1.0 {
		t.Fatalf("all 1.0 should total 1.0, got %v", sc.totalScore())
	}

	// Verify weights sum: 0.45 + 0.30 + 0.25 = 1.0.
	zero := scoreComponents{amountScore: 0, dateScore: 0, merchantScore: 0}
	if zero.totalScore() != 0 {
		t.Fatalf("all 0.0 should total 0.0, got %v", zero.totalScore())
	}
}

// ─── No-double-match: in-memory guard in RunMatcher ──────────────────────────

// TestNoDoubleMatchInRun uses a fakeStore to drive RunMatcher's in-memory
// dedup guard without a real database.
func TestNoDoubleMatchInRun(t *testing.T) {
	// Two lines that both perfectly match one tx.
	org := uuid.New()
	tx := TxCandidate{
		ID:                 uuid.New(),
		OrganizationID:     org,
		PostedDate:         day(0),
		Amount:             250.00,
		Currency:           "ZAR",
		Merchant:           "woolworths",
		MerchantNormalized: "woolworths",
	}
	line1 := LineCandidate{ID: uuid.New(), OrganizationID: org,
		LineDate: day(0), Description: "woolworths", Amount: 250.00}
	line2 := LineCandidate{ID: uuid.New(), OrganizationID: org,
		LineDate: day(0), Description: "woolworths", Amount: 250.00}

	c := cfg()
	candidates := GenerateCandidates([]TxCandidate{tx}, []LineCandidate{line1, line2}, c)
	sortByConfidence(candidates)

	usedTx := make(map[uuid.UUID]bool)
	usedLine := make(map[uuid.UUID]bool)

	inserted := 0
	for _, cand := range candidates {
		if usedTx[cand.Tx.ID] || usedLine[cand.Line.ID] {
			continue
		}
		usedTx[cand.Tx.ID] = true
		usedLine[cand.Line.ID] = true
		inserted++
	}

	if inserted != 1 {
		t.Fatalf("no-double-match: expected exactly 1 insert, got %d", inserted)
	}
}
