package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/exolutionza/slipscan/backend/internal/ocr"
)

// Translator turns a question into a structured Query using Gemini's
// responseSchema. The model has no access to data — it only emits a
// filter; we run the actual query.
type Translator struct {
	client *ocr.Client
}

func NewTranslator(c *ocr.Client) *Translator { return &Translator{client: c} }

// querySchema mirrors the Query struct above. Intent and category are
// closed enums so we get an immediate validation error instead of a
// silent "merchant equals 'travelish' " surprise.
var querySchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"intent": map[string]any{
			"type": "string",
			"enum": []string{
				string(IntentList), string(IntentSum), string(IntentCount),
				string(IntentTopMerchants), string(IntentByCategory), string(IntentByMonth),
			},
		},
		"filters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"merchant_contains": map[string]any{"type": "string", "nullable": true},
				"category":          map[string]any{"type": "string", "nullable": true, "enum": ocr.Categories},
				"date_from":         map[string]any{"type": "string", "nullable": true},
				"date_to":           map[string]any{"type": "string", "nullable": true},
				"amount_min":        map[string]any{"type": "number", "nullable": true},
				"amount_max":        map[string]any{"type": "number", "nullable": true},
				"currency":          map[string]any{"type": "string", "nullable": true},
				"status":            map[string]any{"type": "string", "nullable": true, "enum": []string{"pending", "verified", "rejected"}},
			},
		},
		"limit": map[string]any{"type": "integer", "nullable": true},
	},
	"required": []string{"intent"},
}

// Translate calls Gemini and returns the parsed Query. The current date
// goes into the prompt so relative phrases ("last month", "this week")
// resolve correctly.
func (t *Translator) Translate(ctx context.Context, question string) (*Query, error) {
	now := time.Now().UTC().Format("2006-01-02")
	prompt := fmt.Sprintf(`You translate a user's question about their receipts into a structured query.

Today is %s. The user's question:
"%s"

Pick the single best intent:
- list: show me individual receipts
- sum: total spend ("how much did I spend on X")
- count: how many receipts match
- top_merchants: rank merchants by spend ("who do I spend the most with")
- by_category: break spend down by category
- by_month: break spend down by month

Set only the filters that are explicitly implied. Convert relative dates
(today, this week, last month, year-to-date) into concrete date_from/date_to
ranges. Categories must be one of: %s.
If the user says "show me" or "list" without an aggregation hint, use list with limit 25.`,
		now, strings.TrimSpace(question), strings.Join(ocr.Categories, ", "))

	raw, err := t.client.GenerateJSON(ctx, prompt, querySchema, 0.0)
	if err != nil {
		return nil, fmt.Errorf("translate: %w", err)
	}
	var q Query
	if err := json.Unmarshal(raw, &q); err != nil {
		return nil, fmt.Errorf("translate: parse: %w", err)
	}
	if !q.Intent.Valid() {
		return nil, fmt.Errorf("translate: invalid intent %q", q.Intent)
	}
	return &q, nil
}
