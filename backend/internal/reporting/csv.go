package reporting

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
)

// WriteCSV serialises any recognised report struct to CSV and writes it to w.
// The Accept header "text/csv" or the ?format=csv query parameter triggers
// this path in the handler.
func WriteCSV(w io.Writer, report any) error {
	cw := csv.NewWriter(w)
	defer cw.Flush()

	switch r := report.(type) {
	case PLReport:
		return writePLCSV(cw, r)
	case BSReport:
		return writeBSCSV(cw, r)
	case VATReport:
		return writeVATCSV(cw, r)
	case CashFlowReport:
		return writeCashFlowCSV(cw, r)
	case SpendingTrendReport:
		return writeSpendingTrendCSV(cw, r)
	case NetWorthReport:
		return writeNetWorthCSV(cw, r)
	default:
		return fmt.Errorf("csv: unsupported report type %T", report)
	}
}

func moneyStr(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }

func writePLCSV(w *csv.Writer, r PLReport) error {
	_ = w.Write([]string{"section", "account_id", "code", "name", "balance"})
	for _, l := range r.IncomeLines {
		_ = w.Write([]string{"income", l.AccountID, l.Code, l.Name, moneyStr(l.Balance)})
	}
	_ = w.Write([]string{"income_total", "", "", "Total Income", moneyStr(r.TotalIncome)})
	for _, l := range r.ExpenseLines {
		_ = w.Write([]string{"expense", l.AccountID, l.Code, l.Name, moneyStr(l.Balance)})
	}
	_ = w.Write([]string{"expense_total", "", "", "Total Expense", moneyStr(r.TotalExpense)})
	_ = w.Write([]string{"net_income", "", "", "Net Income", moneyStr(r.NetIncome)})
	return w.Error()
}

func writeBSCSV(w *csv.Writer, r BSReport) error {
	_ = w.Write([]string{"section", "account_id", "code", "name", "balance"})
	for _, l := range r.AssetLines {
		_ = w.Write([]string{"asset", l.AccountID, l.Code, l.Name, moneyStr(l.Balance)})
	}
	_ = w.Write([]string{"asset_total", "", "", "Total Assets", moneyStr(r.TotalAssets)})
	for _, l := range r.LiabilityLines {
		_ = w.Write([]string{"liability", l.AccountID, l.Code, l.Name, moneyStr(l.Balance)})
	}
	_ = w.Write([]string{"liability_total", "", "", "Total Liabilities", moneyStr(r.TotalLiabilities)})
	for _, l := range r.EquityLines {
		_ = w.Write([]string{"equity", l.AccountID, l.Code, l.Name, moneyStr(l.Balance)})
	}
	_ = w.Write([]string{"equity_total", "", "", "Total Equity", moneyStr(r.TotalEquity)})
	return w.Error()
}

func writeVATCSV(w *csv.Writer, r VATReport) error {
	_ = w.Write([]string{"direction", "tax_rate_id", "code", "name", "rate", "net", "tax_amount"})
	for _, l := range r.OutputLines {
		_ = w.Write([]string{
			"output", l.TaxRateID, l.Code, l.Name,
			strconv.FormatFloat(l.Rate, 'f', 4, 64),
			moneyStr(l.Net), moneyStr(l.TaxAmount),
		})
	}
	_ = w.Write([]string{"output_total", "", "", "Total Output VAT", "", "", moneyStr(r.TotalOutput)})
	for _, l := range r.InputLines {
		_ = w.Write([]string{
			"input", l.TaxRateID, l.Code, l.Name,
			strconv.FormatFloat(l.Rate, 'f', 4, 64),
			moneyStr(l.Net), moneyStr(l.TaxAmount),
		})
	}
	_ = w.Write([]string{"input_total", "", "", "Total Input VAT", "", "", moneyStr(r.TotalInput)})
	_ = w.Write([]string{"net_vat_payable", "", "", "Net VAT Payable", "", "", moneyStr(r.NetVATPayable)})
	return w.Error()
}

func writeCashFlowCSV(w *csv.Writer, r CashFlowReport) error {
	_ = w.Write([]string{"month", "inflow", "outflow", "net"})
	for _, m := range r.Months {
		_ = w.Write([]string{m.Month, moneyStr(m.Inflow), moneyStr(m.Outflow), moneyStr(m.Net)})
	}
	_ = w.Write([]string{"total", moneyStr(r.TotalInflow), moneyStr(r.TotalOutflow), moneyStr(r.NetCashFlow)})
	return w.Error()
}

func writeSpendingTrendCSV(w *csv.Writer, r SpendingTrendReport) error {
	_ = w.Write([]string{"category_id", "category_name", "month", "amount"})
	for _, row := range r.Rows {
		_ = w.Write([]string{row.CategoryID, row.CategoryName, row.Month, moneyStr(row.Amount)})
	}
	return w.Error()
}

func writeNetWorthCSV(w *csv.Writer, r NetWorthReport) error {
	_ = w.Write([]string{"date", "total_assets", "total_debt", "net_worth"})
	for _, p := range r.Series {
		_ = w.Write([]string{p.Date, moneyStr(p.TotalAssets), moneyStr(p.TotalDebt), moneyStr(p.NetWorth)})
	}
	return w.Error()
}
