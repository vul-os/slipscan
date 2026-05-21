package testsuite

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/exolutionza/slipscan/backend/internal/insights"
)

func init() {
	Register(Test{
		Name:        "insights",
		Description: "Exercises insights.Run with adversarial input (LIKE wildcards, quotes, injection attempts).",
		NeedsDB:     true,
		Run:         runInsights,
	})
}

func runInsights(ctx context.Context, env *Env) error {
	ptr := func(f float64) *float64 { return &f }
	cases := []struct {
		name string
		q    insights.Query
	}{
		{"by_month no filter", insights.Query{Intent: insights.IntentByMonth}},
		{"single quote", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: "McDonald's"}}},
		{"percent wildcard literal", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: "%"}}},
		{"underscore wildcard literal", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: "_bad"}}},
		{"backslash", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: `pa\th`}}},
		{"DROP TABLE attempt", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: "'); DROP TABLE transactions; --"}}},
		{"unicode café", insights.Query{Intent: insights.IntentList, Filters: insights.Filters{MerchantContains: "café"}}},
		{"sum bounded", insights.Query{Intent: insights.IntentSum, Filters: insights.Filters{AmountMin: ptr(100), AmountMax: ptr(700)}}},
		{"sum negative bound", insights.Query{Intent: insights.IntentSum, Filters: insights.Filters{AmountMin: ptr(-9999), AmountMax: ptr(0)}}},
		{"category travel", insights.Query{Intent: insights.IntentByCategory, Filters: insights.Filters{Category: "travel"}}},
		{"limit override 99999", insights.Query{Intent: insights.IntentList, Limit: 99999}},
		{"all uber jan-apr 2026", insights.Query{Intent: insights.IntentSum, Filters: insights.Filters{
			MerchantContains: "uber", DateFrom: "2026-01-01", DateTo: "2026-04-30",
		}}},
	}

	failures := 0
	for _, tc := range cases {
		fmt.Printf("\n  --- %s ---\n", tc.name)
		res, err := insights.Run(ctx, env.DB, env.OrgID, &tc.q)
		if err != nil {
			fmt.Printf("  ERROR: %v\n", err)
			failures++
			continue
		}
		out, _ := json.MarshalIndent(res, "  ", "  ")
		if len(out) > 800 {
			out = append(out[:800], []byte("\n  ...")...)
		}
		fmt.Printf("  %s\n", string(out))
	}

	rowCount := 0
	_ = env.DB.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM transactions WHERE organization_id = $1", env.OrgID).Scan(&rowCount)
	fmt.Printf("\n  sanity: org has %d transactions (would be 0 if DROP succeeded)\n", rowCount)

	if failures > 0 {
		return fmt.Errorf("%d/%d insights cases failed", failures, len(cases))
	}
	return nil
}
