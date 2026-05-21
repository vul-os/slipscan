// Package insights translates natural-language questions about receipts
// into a closed-form query the database can answer safely.
//
// The model never produces SQL. It produces a typed Query (intent + a
// fixed set of filters), and the SQL builder here turns that into a
// parameterised statement. This means a malicious or confused model
// can't cause SQL injection — the worst it can do is filter by an
// unhelpful value.
package insights

// Intent is what the user is asking for, drawn from a closed enum.
type Intent string

const (
	IntentList          Intent = "list"           // Return matching receipts
	IntentSum           Intent = "sum"            // Total spend across matches
	IntentCount         Intent = "count"          // How many receipts match
	IntentTopMerchants  Intent = "top_merchants"  // Group by merchant, sum
	IntentByCategory    Intent = "by_category"    // Group by category, sum
	IntentByMonth       Intent = "by_month"       // Group by YYYY-MM, sum
)

func (i Intent) Valid() bool {
	switch i {
	case IntentList, IntentSum, IntentCount, IntentTopMerchants, IntentByCategory, IntentByMonth:
		return true
	}
	return false
}

// Filters is the closed set of conditions the model can produce. Anything
// not in this struct can't be filtered on — by design.
type Filters struct {
	MerchantContains string   `json:"merchant_contains,omitempty"`
	Category         string   `json:"category,omitempty"`         // must be in ocr.Categories
	DateFrom         string   `json:"date_from,omitempty"`        // YYYY-MM-DD
	DateTo           string   `json:"date_to,omitempty"`          // YYYY-MM-DD
	AmountMin        *float64 `json:"amount_min,omitempty"`
	AmountMax        *float64 `json:"amount_max,omitempty"`
	Currency         string   `json:"currency,omitempty"`         // 3-letter
	Status           string   `json:"status,omitempty"`           // pending|verified|rejected
}

// Query is what the model emits. Limit is bounded by the runner so the
// model can't request 1M rows.
type Query struct {
	Intent  Intent  `json:"intent"`
	Filters Filters `json:"filters,omitempty"`
	Limit   int     `json:"limit,omitempty"`
}
