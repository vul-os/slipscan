//go:build integration

package ocr

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// TestGeminiExtract sends a real receipt image at /tmp/receipt.png to Gemini
// and asserts the parsed Receipt contains values consistent with the synthetic
// receipt the test generator created.
//
// Run with:  go test -tags=integration ./internal/ocr/...
func TestGeminiExtract(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY not set; skipping Gemini live test")
	}

	imgPath := os.Getenv("RECEIPT_IMAGE")
	if imgPath == "" {
		imgPath = "/tmp/receipt.png"
	}
	imgBytes, err := os.ReadFile(imgPath)
	if err != nil {
		t.Fatalf("read sample image %s: %v", imgPath, err)
	}

	c := New(apiKey)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	receipt, raw, err := c.Extract(ctx, imgBytes, "image/png")
	if err != nil {
		t.Fatalf("Extract: %v\nraw: %s", err, string(raw))
	}

	pretty, _ := json.MarshalIndent(receipt, "", "  ")
	t.Logf("Parsed receipt:\n%s", string(pretty))
	t.Logf("Raw JSON:\n%s", string(raw))

	if receipt.Total == nil {
		t.Errorf("expected total to be parsed; got nil")
	} else if *receipt.Total < 200 || *receipt.Total > 250 {
		t.Errorf("total out of expected range (~228.21): got %v", *receipt.Total)
	}
	if receipt.Currency == nil || *receipt.Currency != "ZAR" {
		t.Errorf("expected currency ZAR, got %v", strPtr(receipt.Currency))
	}
	if receipt.Merchant == nil || *receipt.Merchant == "" {
		t.Errorf("expected merchant to be parsed")
	}
	if len(receipt.LineItems) == 0 {
		t.Errorf("expected at least one line item")
	}
}

func strPtr(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
