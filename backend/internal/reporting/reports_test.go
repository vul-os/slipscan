package reporting

import (
	"strings"
	"testing"
	"time"
)

// ─── Helpers ───────────────────────────────────────────────────────────────

func mustDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func period(from, to string) Period {
	return Period{From: mustDate(from), To: mustDate(to)}
}

const eps = 0.01 // 1-cent tolerance for float comparisons

func withinEps(a, b float64) bool {
	d := a - b
	return d >= -eps && d <= eps
}

// ─── ValidateReport ─────────────────────────────────────────────────────────

func TestValidateReport_KnownReports(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		wantErr bool
	}{
		{"profit-and-loss", "business", false},
		{"balance-sheet", "business", false},
		{"vat-summary", "business", false},
		{"cash-flow", "personal", false},
		{"spending-trend", "personal", false},
		{"net-worth", "personal", false},
		// Cross-kind: business report requested by personal org.
		{"profit-and-loss", "personal", true},
		{"balance-sheet", "personal", true},
		{"vat-summary", "personal", true},
		// Cross-kind: personal report requested by business org.
		{"cash-flow", "business", true},
		{"spending-trend", "business", true},
		{"net-worth", "business", true},
		// Unknown report.
		{"unknown-report", "business", true},
		{"unknown-report", "personal", true},
	}
	for _, tc := range cases {
		t.Run(tc.name+"/"+tc.kind, func(t *testing.T) {
			err := ValidateReport(tc.name, tc.kind)
			if (err != nil) != tc.wantErr {
				t.Errorf("ValidateReport(%q, %q) error=%v, wantErr=%v", tc.name, tc.kind, err, tc.wantErr)
			}
		})
	}
}

// ─── Profit & Loss ─────────────────────────────────────────────────────────

func TestBuildPL_Basic(t *testing.T) {
	p := period("2026-01-01", "2026-03-31")
	rows := []PLLine{
		{AccountID: "a1", Name: "Sales", AccountType: "income", NetBalance: 10000},
		{AccountID: "a2", Name: "Other Income", AccountType: "income", NetBalance: 500},
		{AccountID: "a3", Name: "Salaries", AccountType: "expense", NetBalance: 6000},
		{AccountID: "a4", Name: "Rent", AccountType: "expense", NetBalance: 1500},
	}
	r := BuildPL(p, rows)

	if !withinEps(r.TotalIncome, 10500) {
		t.Errorf("TotalIncome: got %.2f, want 10500", r.TotalIncome)
	}
	if !withinEps(r.TotalExpense, 7500) {
		t.Errorf("TotalExpense: got %.2f, want 7500", r.TotalExpense)
	}
	if !withinEps(r.NetIncome, 3000) {
		t.Errorf("NetIncome: got %.2f, want 3000", r.NetIncome)
	}
	if len(r.IncomeLines) != 2 {
		t.Errorf("IncomeLines: got %d, want 2", len(r.IncomeLines))
	}
	if len(r.ExpenseLines) != 2 {
		t.Errorf("ExpenseLines: got %d, want 2", len(r.ExpenseLines))
	}
}

func TestBuildPL_Empty(t *testing.T) {
	r := BuildPL(period("2026-01-01", "2026-01-31"), nil)
	if r.NetIncome != 0 || r.TotalIncome != 0 || r.TotalExpense != 0 {
		t.Errorf("empty P&L should be all zeros, got %+v", r)
	}
}

func TestBuildPL_LossScenario(t *testing.T) {
	p := period("2026-01-01", "2026-01-31")
	rows := []PLLine{
		{AccountID: "a1", Name: "Revenue", AccountType: "income", NetBalance: 1000},
		{AccountID: "a2", Name: "Wages", AccountType: "expense", NetBalance: 5000},
	}
	r := BuildPL(p, rows)
	if !withinEps(r.NetIncome, -4000) {
		t.Errorf("NetIncome: got %.2f, want -4000", r.NetIncome)
	}
}

// ─── Balance Sheet ─────────────────────────────────────────────────────────

// TestBuildBalanceSheet_Balances verifies the fundamental accounting equation:
// Assets = Liabilities + Equity
func TestBuildBalanceSheet_Balances(t *testing.T) {
	asOf := mustDate("2026-03-31")
	rows := []BSLine{
		// Assets
		{AccountID: "a1", Name: "Bank", AccountType: "asset", Balance: 5000},
		{AccountID: "a2", Name: "Receivables", AccountType: "asset", Balance: 3000},
		// Liabilities
		{AccountID: "a3", Name: "Payables", AccountType: "liability", Balance: 2000},
		{AccountID: "a4", Name: "Bank Loan", AccountType: "liability", Balance: 1000},
		// Equity (retained earnings + capital)
		{AccountID: "a5", Name: "Share Capital", AccountType: "equity", Balance: 5000},
	}
	r := BuildBalanceSheet(asOf, rows)

	if !withinEps(r.TotalAssets, 8000) {
		t.Errorf("TotalAssets: got %.2f, want 8000", r.TotalAssets)
	}
	if !withinEps(r.TotalLiabilities, 3000) {
		t.Errorf("TotalLiabilities: got %.2f, want 3000", r.TotalLiabilities)
	}
	if !withinEps(r.TotalEquity, 5000) {
		t.Errorf("TotalEquity: got %.2f, want 5000", r.TotalEquity)
	}
	if !r.Balanced {
		t.Errorf("balance sheet should be balanced: assets=%.2f, liab+equity=%.2f, diff=%.2f",
			r.TotalAssets, r.TotalLiabilities+r.TotalEquity, r.Diff)
	}
}

func TestBuildBalanceSheet_Unbalanced(t *testing.T) {
	asOf := mustDate("2026-03-31")
	// Deliberately mismatched: 1000 asset, 0 liab+equity.
	rows := []BSLine{
		{AccountID: "a1", Name: "Bank", AccountType: "asset", Balance: 1000},
	}
	r := BuildBalanceSheet(asOf, rows)
	if r.Balanced {
		t.Error("expected unbalanced balance sheet to report Balanced=false")
	}
	if !withinEps(r.Diff, 1000) {
		t.Errorf("Diff: got %.2f, want 1000", r.Diff)
	}
}

func TestBuildBalanceSheet_PnLTiesThrough(t *testing.T) {
	// Simulate a P&L net income of 2000 being posted to retained earnings:
	// Revenue 10000, Expense 8000 → net 2000 pushed to equity.
	asOf := mustDate("2026-06-30")
	rows := []BSLine{
		{AccountID: "a1", Name: "Bank", AccountType: "asset", Balance: 12000},
		{AccountID: "a2", Name: "Payables", AccountType: "liability", Balance: 5000},
		{AccountID: "a3", Name: "Retained Earnings", AccountType: "equity", Balance: 4000},
		{AccountID: "a4", Name: "Share Capital", AccountType: "equity", Balance: 3000},
	}
	r := BuildBalanceSheet(asOf, rows)
	if !r.Balanced {
		t.Errorf("PnL tie-through: expected balanced, diff=%.4f", r.Diff)
	}
}

// ─── VAT Summary ────────────────────────────────────────────────────────────

func TestBuildVAT_Basic(t *testing.T) {
	p := period("2026-01-01", "2026-03-31")
	rows := []VATLine{
		{TaxRateID: "tr1", Code: "VAT15", Name: "Standard VAT", Rate: 15, Net: 5000, TaxAmount: 750, Direction: "output"},
		{TaxRateID: "tr1", Code: "VAT15", Name: "Standard VAT", Rate: 15, Net: 2000, TaxAmount: 300, Direction: "input"},
		{TaxRateID: "tr2", Code: "VAT0", Name: "Zero Rated", Rate: 0, Net: 1000, TaxAmount: 0, Direction: "output"},
	}
	r := BuildVAT(p, rows)

	if !withinEps(r.TotalOutput, 750) {
		t.Errorf("TotalOutput: got %.2f, want 750", r.TotalOutput)
	}
	if !withinEps(r.TotalInput, 300) {
		t.Errorf("TotalInput: got %.2f, want 300", r.TotalInput)
	}
	if !withinEps(r.NetVATPayable, 450) {
		t.Errorf("NetVATPayable: got %.2f, want 450", r.NetVATPayable)
	}
	if len(r.OutputLines) != 2 {
		t.Errorf("OutputLines: got %d, want 2", len(r.OutputLines))
	}
	if len(r.InputLines) != 1 {
		t.Errorf("InputLines: got %d, want 1", len(r.InputLines))
	}
}

func TestBuildVAT_Empty(t *testing.T) {
	r := BuildVAT(period("2026-01-01", "2026-01-31"), nil)
	if r.NetVATPayable != 0 {
		t.Errorf("empty VAT: NetVATPayable should be 0, got %.2f", r.NetVATPayable)
	}
}

func TestBuildVAT_InputExceedsOutput(t *testing.T) {
	p := period("2026-01-01", "2026-01-31")
	rows := []VATLine{
		{TaxRateID: "tr1", Code: "VAT15", Name: "VAT", Rate: 15, Net: 100, TaxAmount: 15, Direction: "output"},
		{TaxRateID: "tr1", Code: "VAT15", Name: "VAT", Rate: 15, Net: 2000, TaxAmount: 300, Direction: "input"},
	}
	r := BuildVAT(p, rows)
	if !withinEps(r.NetVATPayable, -285) {
		t.Errorf("NetVATPayable: got %.2f, want -285 (refund)", r.NetVATPayable)
	}
}

// ─── Cash Flow ─────────────────────────────────────────────────────────────

func TestBuildCashFlow_Basic(t *testing.T) {
	p := period("2026-01-01", "2026-03-31")
	rows := []CashFlowInput{
		{"2026-01", "credit", 3000},
		{"2026-01", "debit", 2000},
		{"2026-02", "credit", 4000},
		{"2026-02", "debit", 1500},
		{"2026-02", "transfer", 500}, // ignored
		{"2026-03", "credit", 2000},
		{"2026-03", "debit", 2500},
	}
	r := BuildCashFlow(p, rows)

	if len(r.Months) != 3 {
		t.Errorf("Months: got %d, want 3", len(r.Months))
	}
	if !withinEps(r.TotalInflow, 9000) {
		t.Errorf("TotalInflow: got %.2f, want 9000", r.TotalInflow)
	}
	if !withinEps(r.TotalOutflow, 6000) {
		t.Errorf("TotalOutflow: got %.2f, want 6000", r.TotalOutflow)
	}
	if !withinEps(r.NetCashFlow, 3000) {
		t.Errorf("NetCashFlow: got %.2f, want 3000", r.NetCashFlow)
	}
	// Jan net = 1000
	if !withinEps(r.Months[0].Net, 1000) {
		t.Errorf("Jan net: got %.2f, want 1000", r.Months[0].Net)
	}
	// Mar net = -500 (outflow > inflow)
	if !withinEps(r.Months[2].Net, -500) {
		t.Errorf("Mar net: got %.2f, want -500", r.Months[2].Net)
	}
}

func TestBuildCashFlow_TransfersIgnored(t *testing.T) {
	p := period("2026-01-01", "2026-01-31")
	rows := []CashFlowInput{
		{"2026-01", "transfer", 999999},
	}
	r := BuildCashFlow(p, rows)
	if r.TotalInflow != 0 || r.TotalOutflow != 0 {
		t.Error("transfers must not affect cash flow")
	}
}

func TestBuildCashFlow_MonthOrder(t *testing.T) {
	// Rows arrive in reverse order — output must be sorted ascending.
	p := period("2026-01-01", "2026-03-31")
	rows := []CashFlowInput{
		{"2026-03", "credit", 10},
		{"2026-01", "credit", 10},
		{"2026-02", "credit", 10},
	}
	r := BuildCashFlow(p, rows)
	if len(r.Months) != 3 {
		t.Fatalf("expected 3 months, got %d", len(r.Months))
	}
	if r.Months[0].Month != "2026-01" || r.Months[1].Month != "2026-02" || r.Months[2].Month != "2026-03" {
		t.Errorf("months not sorted: %v", r.Months)
	}
}

// ─── Spending Trend ─────────────────────────────────────────────────────────

func TestBuildSpendingTrend_Basic(t *testing.T) {
	p := period("2026-01-01", "2026-03-31")
	rows := []SpendingTrendInput{
		{"c1", "Groceries", "2026-01", 500},
		{"c1", "Groceries", "2026-02", 450},
		{"c2", "Dining", "2026-01", 200},
		{"c2", "Dining", "2026-03", 300},
	}
	r := BuildSpendingTrend(p, rows)

	if len(r.Rows) != 4 {
		t.Errorf("Rows: got %d, want 4", len(r.Rows))
	}
	if len(r.Months) != 3 {
		t.Errorf("Months: got %d, want 3 unique months, got %v", len(r.Months), r.Months)
	}
	// Months should be sorted.
	if r.Months[0] != "2026-01" {
		t.Errorf("first month should be 2026-01, got %s", r.Months[0])
	}
}

// ─── Net Worth ──────────────────────────────────────────────────────────────

func TestBuildNetWorth_Basic(t *testing.T) {
	p := period("2026-01-01", "2026-03-31")
	rows := []NetWorthInput{
		{"2026-01-31", 10000, 3000},
		{"2026-02-28", 10500, 2900},
		{"2026-03-31", 11000, 2800},
	}
	r := BuildNetWorth(p, rows)

	if len(r.Series) != 3 {
		t.Errorf("Series: got %d, want 3", len(r.Series))
	}
	// Jan net worth = 7000
	if !withinEps(r.Series[0].NetWorth, 7000) {
		t.Errorf("Jan net worth: got %.2f, want 7000", r.Series[0].NetWorth)
	}
	// Mar net worth = 8200
	if !withinEps(r.Series[2].NetWorth, 8200) {
		t.Errorf("Mar net worth: got %.2f, want 8200", r.Series[2].NetWorth)
	}
}

func TestBuildNetWorth_Empty(t *testing.T) {
	r := BuildNetWorth(period("2026-01-01", "2026-01-31"), nil)
	if len(r.Series) != 0 {
		t.Error("empty net worth should have no series points")
	}
}

// ─── Period boundary tests ──────────────────────────────────────────────────

func TestParsePeriod_SameDay(t *testing.T) {
	// A single-day period (from == to) should be valid.
	from := mustDate("2026-06-01")
	to := mustDate("2026-06-01")
	if to.Before(from) {
		t.Error("same-day period should not be rejected")
	}
}

// ─── CSV ────────────────────────────────────────────────────────────────────

func TestWriteCSV_PL(t *testing.T) {
	var buf strings.Builder
	report := BuildPL(period("2026-01-01", "2026-01-31"), []PLLine{
		{AccountID: "a1", Name: "Rev", AccountType: "income", NetBalance: 1000},
	})
	err := WriteCSV(&buf, report)
	if err != nil {
		t.Fatalf("WriteCSV: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "income") {
		t.Errorf("CSV missing 'income' section: %s", out)
	}
	if !strings.Contains(out, "1000.00") {
		t.Errorf("CSV missing '1000.00': %s", out)
	}
}

func TestWriteCSV_BS(t *testing.T) {
	var buf strings.Builder
	report := BuildBalanceSheet(mustDate("2026-01-31"), []BSLine{
		{AccountID: "a1", Name: "Bank", AccountType: "asset", Balance: 500},
		{AccountID: "a2", Name: "Equity", AccountType: "equity", Balance: 500},
	})
	err := WriteCSV(&buf, report)
	if err != nil {
		t.Fatalf("WriteCSV BS: %v", err)
	}
	if !strings.Contains(buf.String(), "asset") {
		t.Errorf("BS CSV should contain 'asset'")
	}
}

func TestWriteCSV_UnknownType(t *testing.T) {
	var buf strings.Builder
	err := WriteCSV(&buf, struct{ x int }{x: 1})
	if err == nil {
		t.Error("WriteCSV with unknown type should return error")
	}
}
