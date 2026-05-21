package intelligence

import (
	"database/sql"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

func floatPtr(f float64) *float64 { return &f }
func strPtr(s string) *string     { return &s }

func nullFloat(f float64) sql.NullFloat64 {
	return sql.NullFloat64{Float64: f, Valid: true}
}
func nullStr(s string) sql.NullString {
	return sql.NullString{String: s, Valid: true}
}
func nullTime(t time.Time) sql.NullTime {
	return sql.NullTime{Time: t, Valid: true}
}
func nullUUID(id uuid.UUID) uuid.NullUUID {
	return uuid.NullUUID{UUID: id, Valid: true}
}

// ─── Forecast tests ───────────────────────────────────────────────────────────

func TestComputeForecast_EmptyHistory(t *testing.T) {
	result := ComputeForecast(nil, nil, 3, "ZAR")
	if result.Horizon != 3 {
		t.Fatalf("want horizon 3, got %d", result.Horizon)
	}
	if len(result.Points) != 3 {
		t.Fatalf("want 3 points, got %d", len(result.Points))
	}
	if result.Currency != "ZAR" {
		t.Fatalf("want currency ZAR, got %s", result.Currency)
	}
	// With no history, every point should be 0.
	for _, p := range result.Points {
		if p.ProjectedInflow != 0 || p.ProjectedOutflow != 0 {
			t.Fatalf("want zero projection with no history, got inflow=%.2f outflow=%.2f", p.ProjectedInflow, p.ProjectedOutflow)
		}
	}
	if len(result.Assumptions) == 0 {
		t.Fatal("want at least one assumption")
	}
}

func TestComputeForecast_WithHistory(t *testing.T) {
	history := []MonthlyTotals{
		{Year: 2026, Month: 1, In: 10000, Out: 7000},
		{Year: 2026, Month: 2, In: 12000, Out: 8000},
		{Year: 2026, Month: 3, In: 11000, Out: 7500},
	}
	result := ComputeForecast(history, nil, 3, "ZAR")

	// Average in = (10000+12000+11000)/3 = 11000
	// Average out = (7000+8000+7500)/3 = 7500
	if len(result.Points) != 3 {
		t.Fatalf("want 3 points, got %d", len(result.Points))
	}
	for i, p := range result.Points {
		if math.Abs(p.ProjectedInflow-11000) > 1 {
			t.Errorf("point %d: want inflow ~11000, got %.2f", i, p.ProjectedInflow)
		}
		if math.Abs(p.ProjectedOutflow-7500) > 1 {
			t.Errorf("point %d: want outflow ~7500, got %.2f", i, p.ProjectedOutflow)
		}
		want := 11000.0 - 7500.0
		if math.Abs(p.ProjectedNet-want) > 1 {
			t.Errorf("point %d: want net ~%.2f, got %.2f", i, want, p.ProjectedNet)
		}
	}
	// Balance should accumulate.
	if math.Abs(result.Points[2].ProjectedBalance-3*3500) > 1 {
		t.Errorf("want cumulative balance ~10500, got %.2f", result.Points[2].ProjectedBalance)
	}
}

func TestComputeForecast_WithRecurring(t *testing.T) {
	// Recurring higher than average → should use recurring
	recurring := []RecurringRow{
		{
			ID:                 uuid.New(),
			MerchantNormalized: "rent",
			ExpectedAmount:     nullFloat(15000),
			Currency:           nullStr("ZAR"),
			Frequency:          "monthly",
		},
	}
	history := []MonthlyTotals{
		{Year: 2026, Month: 1, In: 10000, Out: 5000},
	}
	result := ComputeForecast(history, recurring, 2, "ZAR")

	// Recurring outflow = 15000 > avg out 5000 → should use 15000
	for _, p := range result.Points {
		if math.Abs(p.ProjectedOutflow-15000) > 1 {
			t.Errorf("want outflow 15000 (driven by recurring), got %.2f", p.ProjectedOutflow)
		}
	}
}

func TestComputeForecast_HorizonClamped(t *testing.T) {
	r := ComputeForecast(nil, nil, 0, "USD")
	if r.Horizon != 3 {
		t.Errorf("want clamped horizon 3, got %d", r.Horizon)
	}
	r = ComputeForecast(nil, nil, 100, "USD")
	if r.Horizon != 24 {
		t.Errorf("want clamped horizon 24, got %d", r.Horizon)
	}
}

func TestComputeForecast_PointLabels(t *testing.T) {
	result := ComputeForecast(nil, nil, 3, "ZAR")
	for i, p := range result.Points {
		if len(p.Month) != 7 {
			t.Errorf("point %d: want YYYY-MM label (7 chars), got %q", i, p.Month)
		}
	}
}

// ─── Duplicate detection tests ────────────────────────────────────────────────

func TestDetectDuplicates_NoDuplicates(t *testing.T) {
	now := time.Now()
	txs := []TxRow{
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -10)),
			MerchantNormalized: nullStr("uber"),
			Amount:             nullFloat(100),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -5)),
			MerchantNormalized: nullStr("netflix"),
			Amount:             nullFloat(100),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
	}
	anomalies := DetectDuplicates(txs, now)
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies, got %d", len(anomalies))
	}
}

func TestDetectDuplicates_SameMerchantAmountNearDate(t *testing.T) {
	now := time.Now()
	txs := []TxRow{
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -2)),
			MerchantNormalized: nullStr("gym"),
			Amount:             nullFloat(299.99),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -1)),
			MerchantNormalized: nullStr("gym"),
			Amount:             nullFloat(299.99),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
	}
	anomalies := DetectDuplicates(txs, now)
	if len(anomalies) != 1 {
		t.Errorf("want 1 duplicate anomaly, got %d", len(anomalies))
	}
	if anomalies[0].Type != AnomalyDuplicate {
		t.Errorf("want type %s, got %s", AnomalyDuplicate, anomalies[0].Type)
	}
	if anomalies[0].Severity != SeverityHigh {
		t.Errorf("want severity high, got %s", anomalies[0].Severity)
	}
}

func TestDetectDuplicates_SameMerchantAmountFarDate(t *testing.T) {
	now := time.Now()
	txs := []TxRow{
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -30)),
			MerchantNormalized: nullStr("gym"),
			Amount:             nullFloat(299.99),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
		{
			ID:                 uuid.New(),
			PostedDate:         nullTime(now.AddDate(0, 0, -1)),
			MerchantNormalized: nullStr("gym"),
			Amount:             nullFloat(299.99),
			Currency:           nullStr("ZAR"),
			Direction:          "debit",
		},
	}
	// 29 days apart — should NOT be a duplicate
	anomalies := DetectDuplicates(txs, now)
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies (far dates), got %d", len(anomalies))
	}
}

// ─── Unusual spend tests ──────────────────────────────────────────────────────

func TestDetectUnusualSpend_NormalSpend(t *testing.T) {
	catID := uuid.New()
	// avg=100, wide spread → stddev ~50 so z for 115 ≈ 0.3 (well under 2.5)
	history := map[string][]float64{
		catID.String(): {50, 150, 100, 80, 120, 100},
	}
	txs := []TxRow{
		{
			ID:         uuid.New(),
			PostedDate: nullTime(time.Now()),
			CategoryID: nullUUID(catID),
			Amount:     nullFloat(115), // within 2.5 σ
			Currency:   nullStr("ZAR"),
			Direction:  "debit",
		},
	}
	anomalies := DetectUnusualSpend(txs, history, time.Now())
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies for normal spend, got %d", len(anomalies))
	}
}

func TestDetectUnusualSpend_SpikeDetected(t *testing.T) {
	catID := uuid.New()
	// Monthly history: avg ~100, stddev ~10
	history := map[string][]float64{
		catID.String(): {100, 110, 90, 105, 95, 100},
	}
	txs := []TxRow{
		{
			ID:         uuid.New(),
			PostedDate: nullTime(time.Now()),
			CategoryID: nullUUID(catID),
			Amount:     nullFloat(150), // 5 σ above mean
			Currency:   nullStr("ZAR"),
			Direction:  "debit",
		},
	}
	anomalies := DetectUnusualSpend(txs, history, time.Now())
	if len(anomalies) == 0 {
		t.Error("want at least 1 unusual spend anomaly for spike, got 0")
	}
	if anomalies[0].Type != AnomalyUnusualSpend {
		t.Errorf("want type %s, got %s", AnomalyUnusualSpend, anomalies[0].Type)
	}
}

func TestDetectUnusualSpend_IgnoresCredits(t *testing.T) {
	catID := uuid.New()
	history := map[string][]float64{
		catID.String(): {100, 100, 100, 100},
	}
	txs := []TxRow{
		{
			ID:         uuid.New(),
			PostedDate: nullTime(time.Now()),
			CategoryID: nullUUID(catID),
			Amount:     nullFloat(50000), // enormous but it's a credit
			Currency:   nullStr("ZAR"),
			Direction:  "credit",
		},
	}
	anomalies := DetectUnusualSpend(txs, history, time.Now())
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies for credit transactions, got %d", len(anomalies))
	}
}

// ─── Missing receipt tests ────────────────────────────────────────────────────

func TestDetectMissingReceipts_LowValue(t *testing.T) {
	txID := uuid.New()
	txs := []TxRow{
		{
			ID:        txID,
			Amount:    nullFloat(100), // below threshold
			Currency:  nullStr("ZAR"),
			Direction: "debit",
		},
	}
	anomalies := DetectMissingReceipts(txs, nil, time.Now())
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies for low-value tx, got %d", len(anomalies))
	}
}

func TestDetectMissingReceipts_HighValueNoReceipt(t *testing.T) {
	txID := uuid.New()
	txs := []TxRow{
		{
			ID:        txID,
			Amount:    nullFloat(10000),
			Currency:  nullStr("ZAR"),
			Direction: "debit",
		},
	}
	anomalies := DetectMissingReceipts(txs, map[uuid.UUID]struct{}{}, time.Now())
	if len(anomalies) != 1 {
		t.Fatalf("want 1 missing receipt anomaly, got %d", len(anomalies))
	}
	if anomalies[0].Type != AnomalyMissingReceipt {
		t.Errorf("want type %s, got %s", AnomalyMissingReceipt, anomalies[0].Type)
	}
}

func TestDetectMissingReceipts_HighValueWithReconciled(t *testing.T) {
	txID := uuid.New()
	txs := []TxRow{
		{
			ID:        txID,
			Amount:    nullFloat(10000),
			Currency:  nullStr("ZAR"),
			Direction: "debit",
		},
	}
	reconciledIDs := map[uuid.UUID]struct{}{txID: {}}
	anomalies := DetectMissingReceipts(txs, reconciledIDs, time.Now())
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies for reconciled tx, got %d", len(anomalies))
	}
}

func TestDetectMissingReceipts_CreditIgnored(t *testing.T) {
	txs := []TxRow{
		{
			ID:        uuid.New(),
			Amount:    nullFloat(50000),
			Currency:  nullStr("ZAR"),
			Direction: "credit", // credit — ignore
		},
	}
	anomalies := DetectMissingReceipts(txs, nil, time.Now())
	if len(anomalies) != 0 {
		t.Errorf("want 0 anomalies for credit tx, got %d", len(anomalies))
	}
}

// ─── Tax readiness tests ──────────────────────────────────────────────────────

func TestComputeTaxReadiness_Perfect(t *testing.T) {
	data := &TaxReadinessData{
		VATOutput:          1000,
		VATInput:           500,
		TotalExpenses:      100,
		DocumentedExpenses: 100,
		UnreconciledCount:  0,
	}
	result := ComputeTaxReadiness(data)
	// VAT ok: 40, doc 100%: 40, recon 0: 20 → total 100
	if result.Score != 100.0 {
		t.Errorf("want score 100, got %.2f", result.Score)
	}
	if result.VATPosition == nil || *result.VATPosition != 500 {
		t.Errorf("want vat_position 500, got %v", result.VATPosition)
	}
	if result.DocumentedExpensePct != 100 {
		t.Errorf("want documented_expense_pct 100, got %.2f", result.DocumentedExpensePct)
	}
	if len(result.Components) != 3 {
		t.Errorf("want 3 components, got %d", len(result.Components))
	}
}

func TestComputeTaxReadiness_NegativeVAT(t *testing.T) {
	data := &TaxReadinessData{
		VATOutput:          200,
		VATInput:           500, // refund position
		TotalExpenses:      100,
		DocumentedExpenses: 80,
		UnreconciledCount:  5,
	}
	result := ComputeTaxReadiness(data)
	// VAT warn: 20, doc 80%: 32, recon 5: 19.5 → 71.5
	if result.Score <= 0 {
		t.Errorf("want positive score, got %.2f", result.Score)
	}
	pos := *result.VATPosition
	if pos != -300 {
		t.Errorf("want vat_position -300, got %.2f", pos)
	}
	// Check VAT component has warn status
	if result.Components[0].Status != "warn" {
		t.Errorf("want VAT component warn status, got %s", result.Components[0].Status)
	}
}

func TestComputeTaxReadiness_NoData(t *testing.T) {
	data := &TaxReadinessData{}
	result := ComputeTaxReadiness(data)
	if result.Score > 20 {
		t.Errorf("want score ≤ 20 with no data (only recon points), got %.2f", result.Score)
	}
	if result.VATPosition != nil {
		t.Errorf("want nil vat_position with no VAT data, got %v", result.VATPosition)
	}
}

func TestComputeTaxReadiness_ManyUnreconciled(t *testing.T) {
	data := &TaxReadinessData{
		VATOutput:          1000,
		VATInput:           500,
		TotalExpenses:      100,
		DocumentedExpenses: 100,
		UnreconciledCount:  200, // many → score penalty
	}
	result := ComputeTaxReadiness(data)
	// recon score = max(0, 20 - 200/10) = 0
	// total = 40 + 40 + 0 = 80
	if result.Score != 80 {
		t.Errorf("want score 80 (recon zeroed out), got %.2f", result.Score)
	}
}

// ─── math helper tests ────────────────────────────────────────────────────────

func TestMean(t *testing.T) {
	cases := []struct {
		vals []float64
		want float64
	}{
		{[]float64{}, 0},
		{[]float64{10}, 10},
		{[]float64{1, 2, 3}, 2},
		{[]float64{100, 200}, 150},
	}
	for _, c := range cases {
		got := mean(c.vals)
		if math.Abs(got-c.want) > 0.001 {
			t.Errorf("mean(%v): want %.3f, got %.3f", c.vals, c.want, got)
		}
	}
}

func TestStddev(t *testing.T) {
	vals := []float64{2, 4, 4, 4, 5, 5, 7, 9}
	m := mean(vals)
	got := stddev(vals, m)
	// Population stddev ≈ 2.0
	if math.Abs(got-2.0) > 0.01 {
		t.Errorf("stddev: want ~2.0, got %.3f", got)
	}
}

func TestFrequencyMultiplier(t *testing.T) {
	cases := map[string]float64{
		"monthly":   1.0,
		"weekly":    52.0 / 12.0,
		"biweekly":  26.0 / 12.0,
		"quarterly": 1.0 / 3.0,
		"yearly":    1.0 / 12.0,
	}
	for freq, want := range cases {
		got := frequencyMonthlyMultiplier(freq)
		if math.Abs(got-want) > 0.001 {
			t.Errorf("freq %q: want %.4f, got %.4f", freq, want, got)
		}
	}
}
