// insights-test exercises the Run path directly (skipping Gemini) so we
// can verify the SQL builder against adversarial input without burning
// daily quota. Delete after the audit.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/config"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/insights"
)

func main() {
	if err := config.LoadDotenv(".env"); err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	pool, err := db.Open(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	if len(os.Args) < 2 {
		log.Fatal("usage: insights-test <orgID>")
	}
	orgID := uuid.MustParse(os.Args[1])

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
			MerchantContains: "uber", DateFrom: "2026-01-01", DateTo: "2026-04-30"},
		}},
	}

	for _, tc := range cases {
		fmt.Printf("\n=== %s ===\n", tc.name)
		res, err := insights.Run(context.Background(), pool, orgID, &tc.q)
		if err != nil {
			fmt.Printf("ERROR: %v\n", err)
			continue
		}
		out, _ := json.MarshalIndent(res, "", "  ")
		// Cap output for readability.
		if len(out) > 800 {
			out = append(out[:800], []byte("\n  ...")...)
		}
		fmt.Println(string(out))
	}

	rowCount := 0
	_ = pool.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM transactions WHERE organization_id = $1", orgID).Scan(&rowCount)
	fmt.Printf("\n# Sanity: org still has %d transactions (would be 0 if DROP succeeded)\n", rowCount)
}
