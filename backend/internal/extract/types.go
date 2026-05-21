// Package extract implements the P1-01 extraction pipeline: typed structured
// extraction for slips, invoices, and bank statements via Gemini, with
// persistence into document_extractions + ai_runs and document status
// transitions (pending → processing → extracted/failed).
//
// The output shape of Extracted.extracted is the binding contract for P1-02
// (cascade matching). See PHASE1-CONTRACT.md §2 "P1-01 → P1-02".
package extract

// DocumentKind mirrors the document_kind enum in migration 2.
type DocumentKind string

const (
	KindSlip          DocumentKind = "slip"
	KindInvoice       DocumentKind = "invoice"
	KindBankStatement DocumentKind = "bank_statement"
	KindUnknown       DocumentKind = "unknown"
)

// DocumentStatus mirrors the document_status enum.
type DocumentStatus string

const (
	StatusPending    DocumentStatus = "pending"
	StatusProcessing DocumentStatus = "processing"
	StatusExtracted  DocumentStatus = "extracted"
	StatusFailed     DocumentStatus = "failed"
)

// LineItem is one purchased line on a slip or invoice.
// All numeric fields are pointers so missing values round-trip as null.
type LineItem struct {
	Description string  `json:"description"`
	Qty         float64 `json:"qty"`
	Unit        float64 `json:"unit"`
	Amount      float64 `json:"amount"`
}

// StatementLine is one row on a bank statement.
type StatementLine struct {
	Date        string  `json:"date"`
	Description string  `json:"description"`
	Amount      float64 `json:"amount"`
	Balance     float64 `json:"balance"`
}

// Extracted is the canonical P1-01 → P1-02 handoff struct. It is serialized
// as JSONB into document_extractions.extracted. P1-02 reads this row; it does
// NOT call P1-01 Go code.
//
// JSON shape (BINDING — see PHASE1-CONTRACT.md §2):
//
//	{
//	  "kind":       "slip|invoice|bank_statement",
//	  "merchant":   "WOOLWORTHS PTY LTD #4021",
//	  "date":       "2026-05-18",
//	  "currency":   "ZAR",
//	  "subtotal":   210.00,
//	  "tax":        31.50,
//	  "total":      241.50,
//	  "confidence": 0.94,
//	  "line_items": [{"description":"Milk 2L","qty":1,"unit":24.99,"amount":24.99}],
//	  "statement_lines": [{"date":"…","description":"…","amount":-120.00,"balance":880.00}]
//	}
//
// statement_lines is only present for kind=bank_statement.
// line_items is only present for kind=slip|invoice.
type Extracted struct {
	Kind           DocumentKind    `json:"kind"`
	Merchant       string          `json:"merchant"`
	Date           string          `json:"date"`
	Currency       string          `json:"currency"`
	Subtotal       float64         `json:"subtotal"`
	Tax            float64         `json:"tax"`
	Total          float64         `json:"total"`
	Confidence     float64         `json:"confidence"`
	LineItems      []LineItem      `json:"line_items,omitempty"`
	StatementLines []StatementLine `json:"statement_lines,omitempty"`
}
