package extract

// Prompt version constants. The version tag is recorded in ai_runs so
// we can A/B prompt changes without losing the model-run trail.
const (
	PromptVersionKindDetect = "kind-detect-v1"
	PromptVersionSlip       = "slip-v1"
	PromptVersionInvoice    = "invoice-v1"
	PromptVersionStatement  = "bank-statement-v1"
)

// kindDetectPrompt is the cheap first-pass to classify an unknown document.
const kindDetectPrompt = `You are a document classifier.
Examine the attached image or PDF and classify it as one of:
  slip          - A point-of-sale receipt or till slip
  invoice       - A tax invoice, purchase order, or billing document
  bank_statement - A bank or credit-card statement listing transactions

Rules:
- Use slip when you see a single retail purchase (merchant + line items + total).
- Use invoice when you see a formal invoice number, billing address, or supplier details.
- Use bank_statement when you see a running balance column with multiple dated transactions.
- If you genuinely cannot tell, default to slip.
- Return only the JSON below, nothing else.`

var kindDetectSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"kind": map[string]any{
			"type": "string",
			"enum": []string{"slip", "invoice", "bank_statement"},
		},
		"confidence": map[string]any{
			"type":     "number",
			"nullable": true,
		},
	},
	"required": []string{"kind"},
}

// slipPrompt extracts from a till-slip or retail receipt.
const slipPrompt = `You are a receipt parser (version: slip-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: full name as printed (e.g. "WOOLWORTHS PTY LTD #4021"). Null if absent.
- date: ISO 8601 YYYY-MM-DD. Null if not visible.
- currency: 3-letter ISO code (ZAR, USD, EUR…). Null if absent.
- subtotal: amount before tax. 0 if not printed.
- tax: VAT/GST amount. 0 if none.
- total: final amount charged. 0 if not readable.
- line_items: array of purchased lines. Use [] if no lines visible.
  Each item: description (string), qty (number), unit (unit price, number), amount (line total, number).
- confidence: self-rating 0.0 – 1.0. Be honest — admins use this to decide what needs manual review.
- Numbers are decimals only. No currency symbols. No thousand-separators.`

var slipSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"merchant":   map[string]any{"type": "string", "nullable": true},
		"date":       map[string]any{"type": "string", "nullable": true},
		"currency":   map[string]any{"type": "string", "nullable": true},
		"subtotal":   map[string]any{"type": "number", "nullable": true},
		"tax":        map[string]any{"type": "number", "nullable": true},
		"total":      map[string]any{"type": "number", "nullable": true},
		"confidence": map[string]any{"type": "number", "nullable": true},
		"line_items": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"description": map[string]any{"type": "string", "nullable": true},
					"qty":         map[string]any{"type": "number", "nullable": true},
					"unit":        map[string]any{"type": "number", "nullable": true},
					"amount":      map[string]any{"type": "number", "nullable": true},
				},
			},
		},
	},
}

// invoicePrompt extracts from a tax invoice or billing document.
const invoicePrompt = `You are an invoice parser (version: invoice-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: supplier / seller name as printed. Null if absent.
- date: invoice date, ISO 8601 YYYY-MM-DD. Null if absent.
- currency: 3-letter ISO code. Null if absent.
- subtotal: amount before tax. 0 if absent.
- tax: VAT/GST. 0 if absent.
- total: invoice total (subtotal + tax). 0 if absent.
- line_items: each billed line. Use [] if none visible.
  Each item: description, qty, unit (unit price), amount (line total).
- confidence: 0.0–1.0 self-rating.
- Numbers are decimals only. No currency symbols. No thousand-separators.`

// invoiceSchema reuses slipSchema (same structure).
var invoiceSchema = slipSchema

// statementPrompt extracts from a bank or credit-card statement.
const statementPrompt = `You are a bank statement parser (version: bank-statement-v1).
Extract the data from the attached image or PDF.

Rules:
- merchant: bank / institution name. Null if absent.
- date: statement date or end-date, ISO 8601 YYYY-MM-DD. Null if absent.
- currency: 3-letter ISO code. Null if absent.
- subtotal: 0 (not applicable for statements).
- tax: 0 (not applicable for statements).
- total: 0 (not applicable for statements).
- confidence: 0.0–1.0 self-rating.
- statement_lines: array of transaction rows on the statement.
  Each line: date (YYYY-MM-DD), description, amount (negative = debit), balance (running balance after transaction).
- Numbers are decimals only. Debits as negative numbers.`

var statementSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"merchant":   map[string]any{"type": "string", "nullable": true},
		"date":       map[string]any{"type": "string", "nullable": true},
		"currency":   map[string]any{"type": "string", "nullable": true},
		"subtotal":   map[string]any{"type": "number", "nullable": true},
		"tax":        map[string]any{"type": "number", "nullable": true},
		"total":      map[string]any{"type": "number", "nullable": true},
		"confidence": map[string]any{"type": "number", "nullable": true},
		"statement_lines": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"date":        map[string]any{"type": "string", "nullable": true},
					"description": map[string]any{"type": "string", "nullable": true},
					"amount":      map[string]any{"type": "number", "nullable": true},
					"balance":     map[string]any{"type": "number", "nullable": true},
				},
			},
		},
	},
}

// geminiRaw is the shape Gemini returns before we map it to Extracted.
type geminiRaw struct {
	Merchant       *string         `json:"merchant"`
	Date           *string         `json:"date"`
	Currency       *string         `json:"currency"`
	Subtotal       *float64        `json:"subtotal"`
	Tax            *float64        `json:"tax"`
	Total          *float64        `json:"total"`
	Confidence     *float64        `json:"confidence"`
	LineItems      []geminiLine    `json:"line_items"`
	StatementLines []geminiStmtLine `json:"statement_lines"`
}

type geminiLine struct {
	Description *string  `json:"description"`
	Qty         *float64 `json:"qty"`
	Unit        *float64 `json:"unit"`
	Amount      *float64 `json:"amount"`
}

type geminiStmtLine struct {
	Date        *string  `json:"date"`
	Description *string  `json:"description"`
	Amount      *float64 `json:"amount"`
	Balance     *float64 `json:"balance"`
}

type geminiKind struct {
	Kind       string   `json:"kind"`
	Confidence *float64 `json:"confidence"`
}

// deref safely dereferences a float64 pointer (returns 0 for nil).
func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// derefStr safely dereferences a string pointer.
func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// mapToExtracted converts a geminiRaw response to the canonical Extracted struct.
func mapToExtracted(kind DocumentKind, raw *geminiRaw, orgCurrency string) *Extracted {
	if raw == nil {
		return &Extracted{Kind: kind}
	}
	e := &Extracted{
		Kind:       kind,
		Merchant:   derefStr(raw.Merchant),
		Date:       derefStr(raw.Date),
		Currency:   NormalizeCurrency(derefStr(raw.Currency), orgCurrency),
		Subtotal:   deref(raw.Subtotal),
		Tax:        deref(raw.Tax),
		Total:      deref(raw.Total),
		Confidence: deref(raw.Confidence),
	}
	if kind == KindBankStatement {
		lines := make([]StatementLine, 0, len(raw.StatementLines))
		for _, l := range raw.StatementLines {
			lines = append(lines, StatementLine{
				Date:        derefStr(l.Date),
				Description: derefStr(l.Description),
				Amount:      deref(l.Amount),
				Balance:     deref(l.Balance),
			})
		}
		e.StatementLines = lines
	} else {
		items := make([]LineItem, 0, len(raw.LineItems))
		for _, l := range raw.LineItems {
			items = append(items, LineItem{
				Description: derefStr(l.Description),
				Qty:         deref(l.Qty),
				Unit:        deref(l.Unit),
				Amount:      deref(l.Amount),
			})
		}
		e.LineItems = items
	}
	return e
}
