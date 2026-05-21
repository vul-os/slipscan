package extract

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// loadFixture reads a testdata JSON file and unmarshals it into geminiRaw.
func loadFixture(t *testing.T, name string) *geminiRaw {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var raw geminiRaw
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal fixture %s: %v", name, err)
	}
	return &raw
}

const tolerance = 0.02 // ±2% tolerance for floating-point comparisons

func approxEqual(a, b float64) bool {
	if b == 0 {
		return math.Abs(a) < 0.01
	}
	return math.Abs(a-b)/math.Abs(b) < tolerance
}

// TestSlipExtraction verifies that a slip fixture maps to the correct Extracted
// struct and that line items sum approximately to subtotal.
func TestSlipExtraction(t *testing.T) {
	raw := loadFixture(t, "slip_raw.json")
	e := mapToExtracted(KindSlip, raw, "ZAR")

	if e.Kind != KindSlip {
		t.Errorf("kind: got %q want %q", e.Kind, KindSlip)
	}
	if e.Merchant != "WOOLWORTHS PTY LTD #4021" {
		t.Errorf("merchant: got %q", e.Merchant)
	}
	if e.Date != "2026-05-18" {
		t.Errorf("date: got %q want 2026-05-18", e.Date)
	}
	if e.Currency != "ZAR" {
		t.Errorf("currency: got %q want ZAR", e.Currency)
	}
	if !approxEqual(e.Total, 241.50) {
		t.Errorf("total: got %.2f want 241.50", e.Total)
	}
	if !approxEqual(e.Tax, 31.50) {
		t.Errorf("tax: got %.2f want 31.50", e.Tax)
	}
	if e.Confidence < 0.9 {
		t.Errorf("confidence: got %.2f want >= 0.90", e.Confidence)
	}
	if len(e.LineItems) == 0 {
		t.Fatal("expected line items")
	}

	// Line item sum should reconcile with subtotal within tolerance.
	var lineSum float64
	for _, li := range e.LineItems {
		lineSum += li.Amount
	}
	if !approxEqual(lineSum, e.Subtotal) {
		t.Errorf("line item sum %.2f does not reconcile with subtotal %.2f", lineSum, e.Subtotal)
	}

	// StatementLines must be nil/empty for a slip.
	if len(e.StatementLines) != 0 {
		t.Errorf("expected no statement_lines for slip, got %d", len(e.StatementLines))
	}
}

// TestInvoiceExtraction verifies invoice fixture mapping.
func TestInvoiceExtraction(t *testing.T) {
	raw := loadFixture(t, "invoice_raw.json")
	e := mapToExtracted(KindInvoice, raw, "ZAR")

	if e.Kind != KindInvoice {
		t.Errorf("kind: got %q want %q", e.Kind, KindInvoice)
	}
	if e.Merchant != "ACME SUPPLIES (PTY) LTD" {
		t.Errorf("merchant: got %q", e.Merchant)
	}
	if !approxEqual(e.Total, 1725.00) {
		t.Errorf("total: got %.2f want 1725.00", e.Total)
	}
	if len(e.LineItems) != 2 {
		t.Errorf("line_items: got %d want 2", len(e.LineItems))
	}
	if len(e.StatementLines) != 0 {
		t.Errorf("unexpected statement_lines for invoice")
	}

	// Subtotal + tax ≈ total.
	if !approxEqual(e.Subtotal+e.Tax, e.Total) {
		t.Errorf("subtotal %.2f + tax %.2f != total %.2f", e.Subtotal, e.Tax, e.Total)
	}
}

// TestBankStatementExtraction verifies bank statement fixture mapping.
func TestBankStatementExtraction(t *testing.T) {
	raw := loadFixture(t, "bank_statement_raw.json")
	e := mapToExtracted(KindBankStatement, raw, "ZAR")

	if e.Kind != KindBankStatement {
		t.Errorf("kind: got %q want %q", e.Kind, KindBankStatement)
	}
	if e.Merchant != "FIRST NATIONAL BANK" {
		t.Errorf("merchant: got %q", e.Merchant)
	}
	if e.Currency != "ZAR" {
		t.Errorf("currency: got %q want ZAR", e.Currency)
	}
	if len(e.StatementLines) != 4 {
		t.Errorf("statement_lines: got %d want 4", len(e.StatementLines))
	}
	if len(e.LineItems) != 0 {
		t.Errorf("unexpected line_items for bank_statement")
	}

	// First line should be the salary credit.
	first := e.StatementLines[0]
	if first.Description != "SALARY CREDIT" {
		t.Errorf("first line description: got %q want SALARY CREDIT", first.Description)
	}
	if !approxEqual(first.Amount, 35000.00) {
		t.Errorf("first line amount: got %.2f want 35000.00", first.Amount)
	}
}

// TestCurrencyNormalize verifies the symbol → ISO mapping.
func TestCurrencyNormalize(t *testing.T) {
	cases := []struct {
		raw     string
		orgDef  string
		want    string
	}{
		{"ZAR", "ZAR", "ZAR"},
		{"R", "ZAR", "ZAR"},
		{"r", "ZAR", "ZAR"},
		{"$", "ZAR", "USD"},
		{"USD", "ZAR", "USD"},
		{"€", "EUR", "EUR"},
		{"EUR", "USD", "EUR"},
		{"", "ZAR", "ZAR"},
		{"", "", "ZAR"},
		{"UNKNOWN_THING", "ZAR", "ZAR"},
		{"GBP", "ZAR", "GBP"},
	}
	for _, tc := range cases {
		got := NormalizeCurrency(tc.raw, tc.orgDef)
		if got != tc.want {
			t.Errorf("NormalizeCurrency(%q, %q) = %q; want %q", tc.raw, tc.orgDef, got, tc.want)
		}
	}
}

// TestMapToExtracted_NilRaw verifies graceful handling of a nil geminiRaw.
func TestMapToExtracted_NilRaw(t *testing.T) {
	e := mapToExtracted(KindSlip, nil, "ZAR")
	if e == nil {
		t.Fatal("expected non-nil Extracted for nil raw")
	}
	if e.Kind != KindSlip {
		t.Errorf("kind: got %q want slip", e.Kind)
	}
}

// TestExtractedJSONShape verifies the binding JSON shape required by P1-02.
// The keys and types must not change without updating PHASE1-CONTRACT.md §2.
func TestExtractedJSONShape(t *testing.T) {
	e := &Extracted{
		Kind:       KindSlip,
		Merchant:   "WOOLWORTHS PTY LTD #4021",
		Date:       "2026-05-18",
		Currency:   "ZAR",
		Subtotal:   210.00,
		Tax:        31.50,
		Total:      241.50,
		Confidence: 0.94,
		LineItems: []LineItem{
			{Description: "Milk 2L", Qty: 1, Unit: 24.99, Amount: 24.99},
		},
	}

	b, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal shape check: %v", err)
	}

	requiredKeys := []string{"kind", "merchant", "date", "currency", "subtotal", "tax", "total", "confidence", "line_items"}
	for _, k := range requiredKeys {
		if _, ok := m[k]; !ok {
			t.Errorf("missing required key %q in JSON output", k)
		}
	}

	// statement_lines must not appear for a slip (omitempty).
	if _, ok := m["statement_lines"]; ok {
		t.Error("statement_lines should be omitted for kind=slip")
	}
}

// TestStatementLinesOmittedForSlip verifies omitempty behaviour.
func TestStatementLinesOmittedForSlip(t *testing.T) {
	e := &Extracted{Kind: KindSlip, LineItems: []LineItem{}}
	b, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["statement_lines"]; ok {
		t.Error("statement_lines should be omitted for kind=slip")
	}
}

// TestLineItemsOmittedForStatement verifies omitempty behaviour.
func TestLineItemsOmittedForStatement(t *testing.T) {
	e := &Extracted{Kind: KindBankStatement, StatementLines: []StatementLine{}}
	b, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["line_items"]; ok {
		t.Error("line_items should be omitted for kind=bank_statement")
	}
}
