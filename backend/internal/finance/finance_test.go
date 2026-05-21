package finance

import (
	"database/sql"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─── Aggregation math: SpendingBreakdown share computation ────────────────────

// simulateSpendingBreakdown mirrors the share-computation logic from
// Store.SpendingBreakdown so we can test it without a DB.
func simulateSpendingBreakdown(rows []spendingRow) []CategoryTotal {
	var grandTotal float64
	for _, r := range rows {
		grandTotal += r.TotalAmount
	}

	out := make([]CategoryTotal, 0, len(rows))
	for _, r := range rows {
		ct := CategoryTotal{
			TotalAmount: r.TotalAmount,
			TxCount:     r.TxCount,
		}
		if r.CategoryID.Valid {
			ct.CategoryID = r.CategoryID.UUID
		}
		if r.CategoryName.Valid {
			ct.CategoryName = r.CategoryName.String
		} else {
			ct.CategoryName = "Uncategorized"
		}
		if r.Kind.Valid {
			ct.Kind = r.Kind.String
		} else {
			ct.Kind = "expense"
		}
		if grandTotal > 0 {
			ct.SharePercent = (r.TotalAmount / grandTotal) * 100
		}
		out = append(out, ct)
	}
	return out
}

func TestSpendingShareSumsToHundred(t *testing.T) {
	rows := []spendingRow{
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Groceries"),
			Kind:         nullString("expense"),
			TotalAmount:  400,
			TxCount:      5,
		},
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Transport"),
			Kind:         nullString("expense"),
			TotalAmount:  300,
			TxCount:      3,
		},
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Utilities"),
			Kind:         nullString("expense"),
			TotalAmount:  300,
			TxCount:      2,
		},
	}
	totals := simulateSpendingBreakdown(rows)

	var sumShares float64
	for _, ct := range totals {
		sumShares += ct.SharePercent
	}
	if math.Abs(sumShares-100.0) > 0.001 {
		t.Errorf("shares sum = %.4f, want 100", sumShares)
	}
}

func TestSpendingShareCorrectValues(t *testing.T) {
	rows := []spendingRow{
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Groceries"),
			Kind:         nullString("expense"),
			TotalAmount:  600,
			TxCount:      4,
		},
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Transport"),
			Kind:         nullString("expense"),
			TotalAmount:  400,
			TxCount:      2,
		},
	}
	totals := simulateSpendingBreakdown(rows)

	if len(totals) != 2 {
		t.Fatalf("expected 2 categories, got %d", len(totals))
	}
	if math.Abs(totals[0].SharePercent-60.0) > 0.001 {
		t.Errorf("Groceries share = %.4f, want 60", totals[0].SharePercent)
	}
	if math.Abs(totals[1].SharePercent-40.0) > 0.001 {
		t.Errorf("Transport share = %.4f, want 40", totals[1].SharePercent)
	}
}

func TestSpendingZeroGrandTotal(t *testing.T) {
	// When there are no transactions, shares must all be 0 (no division by zero).
	rows := []spendingRow{
		{
			CategoryID:   uuid.NullUUID{UUID: uuid.New(), Valid: true},
			CategoryName: nullString("Groceries"),
			Kind:         nullString("expense"),
			TotalAmount:  0,
			TxCount:      0,
		},
	}
	totals := simulateSpendingBreakdown(rows)
	if totals[0].SharePercent != 0 {
		t.Errorf("share should be 0 when grand total is 0, got %.4f", totals[0].SharePercent)
	}
}

func TestSpendingUncategorizedBucket(t *testing.T) {
	// Rows without category should get name "Uncategorized".
	rows := []spendingRow{
		{
			CategoryID:   uuid.NullUUID{Valid: false},
			CategoryName: nullString(""),   // invalid (empty) → Uncategorized
			Kind:         nullString(""),   // invalid → "expense"
			TotalAmount:  200,
			TxCount:      1,
		},
	}
	// Override: blank CategoryName.Valid = false
	rows[0].CategoryName.Valid = false

	totals := simulateSpendingBreakdown(rows)
	if totals[0].CategoryName != "Uncategorized" {
		t.Errorf("CategoryName = %q, want Uncategorized", totals[0].CategoryName)
	}
	if totals[0].Kind != "expense" {
		t.Errorf("Kind = %q, want expense", totals[0].Kind)
	}
}

// ─── Net-worth math ───────────────────────────────────────────────────────────

// simulateNetWorth mirrors NetWorthNow arithmetic without any DB.
func simulateNetWorth(assets, holdings, liabs []valueRow, fxRates map[string]float64, baseCurrency string) NetWorthSnapshot {
	convert := func(amount float64, currency string) float64 {
		if currency == baseCurrency || currency == "" {
			return amount
		}
		if rate, ok := fxRates[currency]; ok && rate > 0 {
			return amount / rate
		}
		return amount
	}

	var totalAssets, totalHoldings, totalLiabs float64
	for _, a := range assets {
		totalAssets += convert(a.value, a.currency)
	}
	for _, h := range holdings {
		totalHoldings += convert(h.value, h.currency)
	}
	for _, l := range liabs {
		totalLiabs += convert(l.value, l.currency)
	}

	return NetWorthSnapshot{
		AsOf:          time.Now(),
		BaseCurrency:  baseCurrency,
		TotalAssets:   totalAssets,
		TotalHoldings: totalHoldings,
		TotalLiabs:    totalLiabs,
		NetWorth:      totalAssets + totalHoldings - totalLiabs,
	}
}

func TestNetWorthSimple(t *testing.T) {
	assets := []valueRow{{value: 500_000, currency: "ZAR"}}
	liabs := []valueRow{{value: 200_000, currency: "ZAR"}}
	snap := simulateNetWorth(assets, nil, liabs, nil, "ZAR")

	if snap.NetWorth != 300_000 {
		t.Errorf("net worth = %.2f, want 300000", snap.NetWorth)
	}
	if snap.TotalAssets != 500_000 {
		t.Errorf("total assets = %.2f, want 500000", snap.TotalAssets)
	}
	if snap.TotalLiabs != 200_000 {
		t.Errorf("total liabs = %.2f, want 200000", snap.TotalLiabs)
	}
}

func TestNetWorthWithHoldings(t *testing.T) {
	assets := []valueRow{{value: 100_000, currency: "ZAR"}}
	holdings := []valueRow{{value: 50_000, currency: "ZAR"}}
	liabs := []valueRow{{value: 30_000, currency: "ZAR"}}
	snap := simulateNetWorth(assets, holdings, liabs, nil, "ZAR")

	want := 100_000.0 + 50_000.0 - 30_000.0
	if snap.NetWorth != want {
		t.Errorf("net worth = %.2f, want %.2f", snap.NetWorth, want)
	}
}

func TestNetWorthFXNormalization(t *testing.T) {
	// 1 ZAR = 0.053 USD  → 1 USD = 18.87 ZAR
	// fxRates[quote] = rate where base = ZAR; so fxRates["USD"] = 0.053
	// To convert USD → ZAR: amount / rate = amount / 0.053
	fxRates := map[string]float64{"USD": 0.053}

	// Asset of 10 000 USD should convert to 10000 / 0.053 ≈ 188 679 ZAR.
	assets := []valueRow{{value: 10_000, currency: "USD"}}
	snap := simulateNetWorth(assets, nil, nil, fxRates, "ZAR")

	want := 10_000.0 / 0.053
	if math.Abs(snap.TotalAssets-want) > 1 {
		t.Errorf("FX-converted assets = %.2f, want %.2f", snap.TotalAssets, want)
	}
}

func TestNetWorthFXNoRate(t *testing.T) {
	// When no FX rate is available the amount is kept as-is (best-effort).
	fxRates := map[string]float64{} // empty
	assets := []valueRow{{value: 5_000, currency: "GBP"}}
	snap := simulateNetWorth(assets, nil, nil, fxRates, "ZAR")

	// Best-effort: keep original value.
	if snap.TotalAssets != 5_000 {
		t.Errorf("no-rate fallback: assets = %.2f, want 5000", snap.TotalAssets)
	}
}

func TestNetWorthNegative(t *testing.T) {
	// Liabilities larger than assets → negative net worth.
	assets := []valueRow{{value: 100, currency: "ZAR"}}
	liabs := []valueRow{{value: 200, currency: "ZAR"}}
	snap := simulateNetWorth(assets, nil, liabs, nil, "ZAR")

	if snap.NetWorth != -100 {
		t.Errorf("net worth = %.2f, want -100", snap.NetWorth)
	}
}

// ─── Budget progress edges ────────────────────────────────────────────────────

type budgetProgressCase struct {
	name      string
	budgeted  float64
	actual    float64
	wantOver  bool
	wantUnder bool
	wantZero  bool
}

func computeBudgetRemaining(budgeted, actual float64) float64 {
	return budgeted - actual
}

func TestBudgetProgressEdges(t *testing.T) {
	cases := []budgetProgressCase{
		{name: "under budget", budgeted: 1000, actual: 750, wantUnder: true},
		{name: "over budget", budgeted: 500, actual: 600, wantOver: true},
		{name: "exactly on budget", budgeted: 300, actual: 300},
		{name: "zero budget zero actual", budgeted: 0, actual: 0, wantZero: true},
		{name: "zero actual", budgeted: 400, actual: 0, wantUnder: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			remaining := computeBudgetRemaining(tc.budgeted, tc.actual)

			if tc.wantOver && remaining >= 0 {
				t.Errorf("expected over-budget (remaining < 0), got %.2f", remaining)
			}
			if tc.wantUnder && remaining <= 0 {
				t.Errorf("expected under-budget (remaining > 0), got %.2f", remaining)
			}
			if tc.wantZero && remaining != 0 {
				t.Errorf("expected zero remaining, got %.2f", remaining)
			}
			// "exactly on budget": remaining == 0
			if !tc.wantOver && !tc.wantUnder && !tc.wantZero {
				if remaining != 0 {
					t.Errorf("expected 0 remaining, got %.2f", remaining)
				}
			}
		})
	}
}

// ─── Goal progress ────────────────────────────────────────────────────────────

func TestGoalProgressComputation(t *testing.T) {
	cases := []struct {
		name          string
		target        float64
		current       float64
		wantPct       float64
		wantPctCapped float64 // after clamping to [0,100]
	}{
		{name: "half done", target: 1000, current: 500, wantPct: 50},
		{name: "fully achieved", target: 1000, current: 1000, wantPct: 100},
		{name: "over-contributed", target: 1000, current: 1100, wantPct: 100}, // clamped
		{name: "nothing saved", target: 1000, current: 0, wantPct: 0},
		{name: "zero target", target: 0, current: 500, wantPct: 0}, // avoid div/0
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := &Goal{TargetAmount: tc.target, CurrentAmount: tc.current}
			g.computeProgress()

			got := g.ProgressPct
			if got != tc.wantPct {
				t.Errorf("progress = %.2f, want %.2f", got, tc.wantPct)
			}
			// ProgressPct must always be in [0, 100].
			if got < 0 || got > 100 {
				t.Errorf("progress %.2f is outside [0, 100]", got)
			}
		})
	}
}

// ─── roundTwo ─────────────────────────────────────────────────────────────────

func TestRoundTwo(t *testing.T) {
	cases := []struct {
		input float64
		want  float64
	}{
		{33.33333, 33.33},
		{66.66666, 66.67},
		{100.0, 100.0},
		{0.0, 0.0},
		{-5.555, -5.56},
	}
	for _, tc := range cases {
		got := roundTwo(tc.input)
		if math.Abs(got-tc.want) > 0.005 {
			t.Errorf("roundTwo(%.5f) = %.5f, want %.5f", tc.input, got, tc.want)
		}
	}
}

// ─── validateBudgetInput ─────────────────────────────────────────────────────

func TestValidateBudgetInput(t *testing.T) {
	good := CreateBudgetInput{
		Name:      "Monthly",
		Period:    "monthly",
		StartDate: time.Now(),
		Currency:  "ZAR",
	}
	if err := validateBudgetInput(good); err != nil {
		t.Errorf("valid input rejected: %v", err)
	}

	// Empty name.
	bad := good
	bad.Name = ""
	if err := validateBudgetInput(bad); err == nil {
		t.Error("empty name should be rejected")
	}

	// Invalid period.
	bad = good
	bad.Period = "daily"
	if err := validateBudgetInput(bad); err == nil {
		t.Error("invalid period should be rejected")
	}

	// Missing currency.
	bad = good
	bad.Currency = ""
	if err := validateBudgetInput(bad); err == nil {
		t.Error("empty currency should be rejected")
	}
}

// ─── validateGoalInput ───────────────────────────────────────────────────────

func TestValidateGoalInput(t *testing.T) {
	good := CreateGoalInput{
		Name:         "Emergency Fund",
		Kind:         "savings",
		TargetAmount: 50_000,
		Currency:     "ZAR",
	}
	if err := validateGoalInput(good); err != nil {
		t.Errorf("valid goal rejected: %v", err)
	}

	bad := good
	bad.Name = ""
	if err := validateGoalInput(bad); err == nil {
		t.Error("empty name should be rejected")
	}

	bad = good
	bad.Kind = "lottery"
	if err := validateGoalInput(bad); err == nil {
		t.Error("invalid kind should be rejected")
	}

	bad = good
	bad.TargetAmount = 0
	if err := validateGoalInput(bad); err == nil {
		t.Error("zero target_amount should be rejected")
	}

	bad = good
	bad.TargetAmount = -1
	if err := validateGoalInput(bad); err == nil {
		t.Error("negative target_amount should be rejected")
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
