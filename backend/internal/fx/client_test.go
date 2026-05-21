package fx

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ── Recorded provider fixtures ─────────────────────────────────────────────

// frankfurterFixture is a captured response from https://api.frankfurter.app/latest?from=USD
// (recorded 2026-05-21 — values are illustrative, not live).
var frankfurterFixture = frankfurterResponse{
	Base: "USD",
	Date: "2026-05-21",
	Rates: map[string]float64{
		"AED": 3.6726,
		"AUD": 1.5621,
		"CAD": 1.3590,
		"CHF": 0.8941,
		"CNY": 7.2381,
		"EUR": 0.9218,
		"GBP": 0.7889,
		"HKD": 7.7843,
		"INR": 83.1200,
		"JPY": 155.6200,
		"MXN": 17.2100,
		"NOK": 10.5630,
		"NZD": 1.6340,
		"SEK": 10.3270,
		"SGD": 1.3412,
		"ZAR": 18.4200, // South-African rand — key currency for this product
	},
}

func TestFrankfurterParse(t *testing.T) {
	// Spin up a local test server that returns the recorded fixture.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(frankfurterFixture); err != nil {
			t.Errorf("encode fixture: %v", err)
		}
	}))
	defer srv.Close()

	client := newClientWithBase("", srv.URL)
	result, err := client.Fetch(context.Background(), "USD")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if result.Base != "USD" {
		t.Errorf("Base = %q, want USD", result.Base)
	}
	wantDate := time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC)
	if !result.AsOf.Equal(wantDate) {
		t.Errorf("AsOf = %v, want %v", result.AsOf, wantDate)
	}
	if len(result.Rates) == 0 {
		t.Fatal("Rates is empty")
	}
	zar, ok := result.Rates["ZAR"]
	if !ok {
		t.Fatal("ZAR missing from rates")
	}
	if zar != 18.42 {
		t.Errorf("ZAR rate = %v, want 18.42", zar)
	}
}

func TestFrankfurterHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "server error", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := newClientWithBase("", srv.URL)
	_, err := client.Fetch(context.Background(), "USD")
	if err == nil {
		t.Fatal("expected error on HTTP 500, got nil")
	}
}

// erAPIFixture is a recorded response from exchangerate-api.com v6 (truncated).
var erAPIFixture = erAPIResponse{
	Result:            "success",
	BaseCode:          "USD",
	TimeLastUpdateUTC: "Thu, 21 May 2026 00:00:01 +0000",
	ConversionRates: map[string]float64{
		"USD": 1.0,
		"EUR": 0.9218,
		"ZAR": 18.4200,
		"GBP": 0.7889,
	},
}

func TestERAPIParse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(erAPIFixture); err != nil {
			t.Errorf("encode fixture: %v", err)
		}
	}))
	defer srv.Close()

	// Use a non-empty apiKey so the client hits erAPI code path.
	client := newClientWithBase("test-key", srv.URL)
	result, err := client.Fetch(context.Background(), "USD")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if result.Base != "USD" {
		t.Errorf("Base = %q, want USD", result.Base)
	}
	if _, ok := result.Rates["ZAR"]; !ok {
		t.Fatal("ZAR missing from rates")
	}
	// The USD self-pair should be present but the store will skip it.
	if _, ok := result.Rates["USD"]; !ok {
		t.Fatal("USD should be in conversion_rates even though it will be skipped at upsert")
	}
}

func TestERAPIErrorResponse(t *testing.T) {
	errResp := erAPIResponse{
		Result:    "error",
		ErrorType: "invalid-key",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewEncoder(w).Encode(errResp); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer srv.Close()

	client := newClientWithBase("bad-key", srv.URL)
	_, err := client.Fetch(context.Background(), "USD")
	if err == nil {
		t.Fatal("expected error for result=error, got nil")
	}
}
