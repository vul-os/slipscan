// Package reporting delivers named financial reports differentiated by org kind.
//
// Business org reports:
//   - profit-and-loss  — income vs expense accounts over a period
//   - balance-sheet    — assets = liabilities + equity at a point in time
//   - vat-summary      — output vs input VAT via tax_rates
//
// Personal org reports:
//   - cash-flow        — cash in vs out aggregated by calendar month
//   - spending-trend   — spend by category over time
//   - net-worth        — asset/liability time series
//
// All report functions are pure: they take pre-fetched rows and return
// structured results with no I/O side effects.  Handlers fetch rows from
// the store then call these functions, making unit testing straightforward.
package reporting

import (
	"errors"
	"fmt"
	"time"
)

// ─── Errors ────────────────────────────────────────────────────────────────

// ErrWrongOrgKind is returned when a report is requested for an org kind
// that does not support it.
var ErrWrongOrgKind = errors.New("report not available for this org kind")

// ErrUnknownReport is returned when the report name is not recognised.
var ErrUnknownReport = errors.New("unknown report name")

// ─── Report registry ───────────────────────────────────────────────────────

// reportMeta describes a named report and the org kinds it supports.
type reportMeta struct {
	Name        string
	Description string
	Kinds       map[string]bool // "personal" | "business"
}

var registry = []reportMeta{
	{Name: "profit-and-loss", Description: "Income vs expense accounts over the period", Kinds: map[string]bool{"business": true}},
	{Name: "balance-sheet", Description: "Assets = liabilities + equity at the end date", Kinds: map[string]bool{"business": true}},
	{Name: "vat-summary", Description: "Output vs input VAT for the period", Kinds: map[string]bool{"business": true}},
	{Name: "cash-flow", Description: "Cash in vs out aggregated by month", Kinds: map[string]bool{"personal": true}},
	{Name: "spending-trend", Description: "Spend by category over time", Kinds: map[string]bool{"personal": true}},
	{Name: "net-worth", Description: "Net worth time series", Kinds: map[string]bool{"personal": true}},
}

// ValidateReport returns ErrUnknownReport if name is not in the registry, or
// ErrWrongOrgKind if orgKind does not support the requested report.
func ValidateReport(name, orgKind string) error {
	for _, m := range registry {
		if m.Name == name {
			if !m.Kinds[orgKind] {
				return fmt.Errorf("%w: %q is not available for %q orgs", ErrWrongOrgKind, name, orgKind)
			}
			return nil
		}
	}
	return fmt.Errorf("%w: %q", ErrUnknownReport, name)
}

// ─── Shared types ──────────────────────────────────────────────────────────

// Period is an inclusive date range.
type Period struct {
	From time.Time
	To   time.Time
}

// AccountLine is one row in a P&L or balance-sheet section.
type AccountLine struct {
	AccountID   string  `json:"account_id"`
	Code        string  `json:"code,omitempty"`
	Name        string  `json:"name"`
	AccountType string  `json:"account_type"`
	Balance     float64 `json:"balance"`
}

// ─── Profit & Loss ─────────────────────────────────────────────────────────

// PLInput is the set of ledger-derived rows needed to build a P&L.
// Each row has account type (income | expense) and a net balance for the
// period (credit-debit for income, debit-credit for expense).
type PLInput struct {
	Lines []PLLine
}

// PLLine is one account's contribution to the P&L.
type PLLine struct {
	AccountID   string
	Code        string
	Name        string
	AccountType string  // "income" | "expense"
	NetBalance  float64 // positive = normal-sign contribution
}

// PLReport is the result of BuildPL.
type PLReport struct {
	Period       Period        `json:"period"`
	IncomeLines  []AccountLine `json:"income_lines"`
	ExpenseLines []AccountLine `json:"expense_lines"`
	TotalIncome  float64       `json:"total_income"`
	TotalExpense float64       `json:"total_expense"`
	NetIncome    float64       `json:"net_income"`
}

// BuildPL produces a profit-and-loss statement from the provided ledger rows.
// Pure function — no I/O.
func BuildPL(p Period, rows []PLLine) PLReport {
	r := PLReport{Period: p}
	for _, l := range rows {
		line := AccountLine{
			AccountID:   l.AccountID,
			Code:        l.Code,
			Name:        l.Name,
			AccountType: l.AccountType,
			Balance:     l.NetBalance,
		}
		switch l.AccountType {
		case "income":
			r.IncomeLines = append(r.IncomeLines, line)
			r.TotalIncome += l.NetBalance
		case "expense":
			r.ExpenseLines = append(r.ExpenseLines, line)
			r.TotalExpense += l.NetBalance
		}
	}
	r.NetIncome = r.TotalIncome - r.TotalExpense
	return r
}

// ─── Balance Sheet ─────────────────────────────────────────────────────────

// BSLine is one account's contribution to the balance sheet.
type BSLine struct {
	AccountID   string
	Code        string
	Name        string
	AccountType string  // "asset" | "liability" | "equity"
	Balance     float64 // debit-positive for assets, credit-positive for L+E
}

// BSReport is the result of BuildBalanceSheet.
type BSReport struct {
	AsOf             time.Time     `json:"as_of"`
	AssetLines       []AccountLine `json:"asset_lines"`
	LiabilityLines   []AccountLine `json:"liability_lines"`
	EquityLines      []AccountLine `json:"equity_lines"`
	TotalAssets      float64       `json:"total_assets"`
	TotalLiabilities float64       `json:"total_liabilities"`
	TotalEquity      float64       `json:"total_equity"`
	// Check: TotalAssets should equal TotalLiabilities + TotalEquity.
	Balanced bool    `json:"balanced"`
	Diff     float64 `json:"diff"` // 0 when balanced within rounding
}

// BuildBalanceSheet assembles a balance-sheet report.
// For assets the normal sign is debit (positive Balance means debit).
// For liabilities and equity the normal sign is credit (positive Balance
// means credit).  Callers must pre-compute the signed balance per account.
// Pure function — no I/O.
func BuildBalanceSheet(asOf time.Time, rows []BSLine) BSReport {
	r := BSReport{AsOf: asOf}
	for _, l := range rows {
		line := AccountLine{
			AccountID:   l.AccountID,
			Code:        l.Code,
			Name:        l.Name,
			AccountType: l.AccountType,
			Balance:     l.Balance,
		}
		switch l.AccountType {
		case "asset":
			r.AssetLines = append(r.AssetLines, line)
			r.TotalAssets += l.Balance
		case "liability":
			r.LiabilityLines = append(r.LiabilityLines, line)
			r.TotalLiabilities += l.Balance
		case "equity":
			r.EquityLines = append(r.EquityLines, line)
			r.TotalEquity += l.Balance
		}
	}
	r.Diff = r.TotalAssets - (r.TotalLiabilities + r.TotalEquity)
	// Treat as balanced if diff is within 1 cent rounding.
	r.Balanced = r.Diff >= -0.01 && r.Diff <= 0.01
	return r
}

// ─── VAT Summary ────────────────────────────────────────────────────────────

// VATLine is one tax-rate's contribution to the VAT summary.
type VATLine struct {
	TaxRateID   string
	Code        string
	Name        string
	Rate        float64
	Net         float64 // taxable amount (excl tax)
	TaxAmount   float64 // collected / paid
	Direction   string  // "output" (sales) | "input" (purchases)
}

// VATReport is the result of BuildVAT.
type VATReport struct {
	Period        Period    `json:"period"`
	OutputLines   []VATLine `json:"output_lines"`
	InputLines    []VATLine `json:"input_lines"`
	TotalOutput   float64   `json:"total_output_tax"`
	TotalInput    float64   `json:"total_input_tax"`
	NetVATPayable float64   `json:"net_vat_payable"`
}

// BuildVAT assembles a VAT summary from pre-fetched tax-rate lines.
// Pure function — no I/O.
func BuildVAT(p Period, rows []VATLine) VATReport {
	r := VATReport{Period: p}
	for _, l := range rows {
		switch l.Direction {
		case "output":
			r.OutputLines = append(r.OutputLines, l)
			r.TotalOutput += l.TaxAmount
		case "input":
			r.InputLines = append(r.InputLines, l)
			r.TotalInput += l.TaxAmount
		}
	}
	r.NetVATPayable = r.TotalOutput - r.TotalInput
	return r
}

// ─── Cash Flow ─────────────────────────────────────────────────────────────

// CashFlowMonth is one calendar month's in/out totals.
type CashFlowMonth struct {
	Month   string  `json:"month"` // "YYYY-MM"
	Inflow  float64 `json:"inflow"`
	Outflow float64 `json:"outflow"`
	Net     float64 `json:"net"`
}

// CashFlowInput is one transaction row used to build the cash flow report.
type CashFlowInput struct {
	Month     string  // "YYYY-MM"
	Direction string  // "credit" | "debit" | "transfer"
	Amount    float64
}

// CashFlowReport is the result of BuildCashFlow.
type CashFlowReport struct {
	Period      Period          `json:"period"`
	Months      []CashFlowMonth `json:"months"`
	TotalInflow float64         `json:"total_inflow"`
	TotalOutflow float64        `json:"total_outflow"`
	NetCashFlow float64         `json:"net_cash_flow"`
}

// BuildCashFlow produces a monthly cash-flow report.
// Credits = inflows (money coming in), debits = outflows.
// Transfers are ignored to avoid double-counting.
// Pure function — no I/O.
func BuildCashFlow(p Period, rows []CashFlowInput) CashFlowReport {
	type monthly struct {
		in  float64
		out float64
	}
	// Ordered month keys.
	order := make([]string, 0)
	byMonth := make(map[string]*monthly)

	for _, row := range rows {
		if row.Direction == "transfer" {
			continue
		}
		m, exists := byMonth[row.Month]
		if !exists {
			m = &monthly{}
			byMonth[row.Month] = m
			order = append(order, row.Month)
		}
		switch row.Direction {
		case "credit":
			m.in += row.Amount
		case "debit":
			m.out += row.Amount
		}
	}

	// Deduplicate order (in case rows arrive unsorted).
	seen := make(map[string]bool)
	uniqueOrder := make([]string, 0, len(order))
	for _, k := range order {
		if !seen[k] {
			seen[k] = true
			uniqueOrder = append(uniqueOrder, k)
		}
	}
	// Sort months lexicographically ("YYYY-MM" sorts correctly).
	sortStrings(uniqueOrder)

	r := CashFlowReport{Period: p}
	for _, mon := range uniqueOrder {
		m := byMonth[mon]
		net := m.in - m.out
		r.Months = append(r.Months, CashFlowMonth{
			Month:   mon,
			Inflow:  m.in,
			Outflow: m.out,
			Net:     net,
		})
		r.TotalInflow += m.in
		r.TotalOutflow += m.out
	}
	r.NetCashFlow = r.TotalInflow - r.TotalOutflow
	return r
}

// ─── Spending Trend ─────────────────────────────────────────────────────────

// SpendingTrendRow is one (category, month) cell.
type SpendingTrendRow struct {
	CategoryID   string  `json:"category_id"`
	CategoryName string  `json:"category_name"`
	Month        string  `json:"month"` // "YYYY-MM"
	Amount       float64 `json:"amount"`
}

// SpendingTrendInput feeds BuildSpendingTrend.
type SpendingTrendInput struct {
	CategoryID   string
	CategoryName string
	Month        string
	Amount       float64
}

// SpendingTrendReport is the result of BuildSpendingTrend.
type SpendingTrendReport struct {
	Period Period             `json:"period"`
	Rows   []SpendingTrendRow `json:"rows"`
	// Months lists the unique months across all rows (ordered).
	Months []string `json:"months"`
}

// BuildSpendingTrend assembles the spending-trend matrix.
// Pure function — no I/O.
func BuildSpendingTrend(p Period, rows []SpendingTrendInput) SpendingTrendReport {
	monthSet := map[string]bool{}
	out := make([]SpendingTrendRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, SpendingTrendRow{
			CategoryID:   row.CategoryID,
			CategoryName: row.CategoryName,
			Month:        row.Month,
			Amount:       row.Amount,
		})
		monthSet[row.Month] = true
	}
	months := make([]string, 0, len(monthSet))
	for m := range monthSet {
		months = append(months, m)
	}
	sortStrings(months)
	return SpendingTrendReport{Period: p, Rows: out, Months: months}
}

// ─── Net Worth ──────────────────────────────────────────────────────────────

// NetWorthPoint is the net worth at a single point in time.
type NetWorthPoint struct {
	Date        string  `json:"date"` // "YYYY-MM-DD"
	TotalAssets float64 `json:"total_assets"`
	TotalDebt   float64 `json:"total_debt"`
	NetWorth    float64 `json:"net_worth"`
}

// NetWorthInput feeds BuildNetWorth.
type NetWorthInput struct {
	Date        string
	TotalAssets float64
	TotalDebt   float64
}

// NetWorthReport is the result of BuildNetWorth.
type NetWorthReport struct {
	Period Period          `json:"period"`
	Series []NetWorthPoint `json:"series"`
}

// BuildNetWorth assembles the net-worth time series.
// Pure function — no I/O.
func BuildNetWorth(p Period, rows []NetWorthInput) NetWorthReport {
	series := make([]NetWorthPoint, 0, len(rows))
	for _, r := range rows {
		series = append(series, NetWorthPoint{
			Date:        r.Date,
			TotalAssets: r.TotalAssets,
			TotalDebt:   r.TotalDebt,
			NetWorth:    r.TotalAssets - r.TotalDebt,
		})
	}
	return NetWorthReport{Period: p, Series: series}
}

// ─── Utility ───────────────────────────────────────────────────────────────

// sortStrings sorts a slice of strings in ascending order (stdlib sort-free
// insertion sort — avoids importing "sort" for a tiny slice).
func sortStrings(ss []string) {
	for i := 1; i < len(ss); i++ {
		key := ss[i]
		j := i - 1
		for j >= 0 && ss[j] > key {
			ss[j+1] = ss[j]
			j--
		}
		ss[j+1] = key
	}
}
