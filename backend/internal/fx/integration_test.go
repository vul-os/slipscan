//go:build integration

// Integration test — only runs when built with -tags integration AND
// EXCHANGE_RATE_API_KEY (or empty string for Frankfurter) is set.
// Requires network access.
//
// Run with:
//   go test -tags integration ./internal/fx/... -v
//
// For Frankfurter (free, no key):
//   go test -tags integration ./internal/fx/... -v
//
// For exchangerate-api.com:
//   EXCHANGE_RATE_API_KEY=your-key go test -tags integration ./internal/fx/... -v
package fx

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestLiveFetch(t *testing.T) {
	apiKey := os.Getenv("EXCHANGE_RATE_API_KEY")
	// Either key present (exchangerate-api.com) or absent (frankfurter) is fine.

	client := NewClient(apiKey)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.Fetch(ctx, "USD")
	if err != nil {
		t.Fatalf("live Fetch: %v", err)
	}

	if result.Base != "USD" {
		t.Errorf("Base = %q, want USD", result.Base)
	}
	if result.AsOf.IsZero() {
		t.Error("AsOf is zero")
	}
	if len(result.Rates) == 0 {
		t.Error("Rates is empty")
	}

	// ZAR must be present — core requirement for this product.
	zar, ok := result.Rates["ZAR"]
	if !ok {
		t.Error("ZAR missing from live rates")
	} else if zar <= 0 {
		t.Errorf("ZAR rate = %v, want > 0", zar)
	} else {
		t.Logf("live ZAR/USD = %.4f as of %s", zar, result.AsOf.Format("2006-01-02"))
	}
}
