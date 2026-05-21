package classification_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/exolutionza/slipscan/backend/internal/testsuite/classification"
)

func TestScoreAllCorrect(t *testing.T) {
	preds := []classification.Prediction{
		{FixtureID: "f1", Merchant: "Woolworths", Expected: "Groceries", Predicted: "Groceries", Source: "rule", Confidence: 1.0},
		{FixtureID: "f2", Merchant: "Engen", Expected: "Fuel/Transport", Predicted: "Fuel/Transport", Source: "merchant_signal", Confidence: 0.9},
	}
	res := classification.Score(preds, nil)
	if res.Total != 2 {
		t.Errorf("Total: want 2, got %d", res.Total)
	}
	if res.Correct != 2 {
		t.Errorf("Correct: want 2, got %d", res.Correct)
	}
	if res.Accuracy != 1.0 {
		t.Errorf("Accuracy: want 1.0, got %f", res.Accuracy)
	}
}

func TestScorePartialCorrect(t *testing.T) {
	preds := []classification.Prediction{
		{FixtureID: "f1", Merchant: "Woolworths", Expected: "Groceries", Predicted: "Groceries", Source: "rule"},
		{FixtureID: "f2", Merchant: "Engen", Expected: "Fuel/Transport", Predicted: "Groceries", Source: "llm"}, // wrong
		{FixtureID: "f3", Merchant: "Vodacom", Expected: "Telecoms", Predicted: "Telecoms", Source: "merchant_signal"},
	}
	res := classification.Score(preds, nil)
	if res.Total != 3 {
		t.Errorf("Total: want 3, got %d", res.Total)
	}
	if res.Correct != 2 {
		t.Errorf("Correct: want 2, got %d", res.Correct)
	}
	want := 2.0 / 3.0
	if res.Accuracy < want-0.001 || res.Accuracy > want+0.001 {
		t.Errorf("Accuracy: want %.4f, got %.4f", want, res.Accuracy)
	}
}

func TestScoreEmpty(t *testing.T) {
	res := classification.Score(nil, nil)
	if res.Total != 0 || res.Correct != 0 || res.Accuracy != 0 {
		t.Errorf("expected zero result for empty input, got %+v", res)
	}
}

func TestScoreCaseInsensitive(t *testing.T) {
	preds := []classification.Prediction{
		{Expected: "Groceries", Predicted: "groceries"},
		{Expected: "FUEL/TRANSPORT", Predicted: "Fuel/Transport"},
	}
	res := classification.Score(preds, nil)
	if res.Correct != 2 {
		t.Errorf("case-insensitive match: want 2 correct, got %d", res.Correct)
	}
}

func TestScoreByMerchant(t *testing.T) {
	normFn := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	preds := []classification.Prediction{
		{Merchant: "Woolworths JHB", Expected: "Groceries", Predicted: "Groceries", Source: "rule"},
		{Merchant: "Woolworths PTY LTD", Expected: "Groceries", Predicted: "Clothing", Source: "llm"}, // wrong
		{Merchant: "Engen", Expected: "Fuel/Transport", Predicted: "Fuel/Transport", Source: "merchant_signal"},
	}
	res := classification.Score(preds, normFn)

	wools := res.ByMerchant["woolworths jhb"]
	if wools.Total != 1 || wools.Correct != 1 {
		t.Errorf("woolworths jhb: want 1/1, got %d/%d", wools.Correct, wools.Total)
	}
	woolsPTY := res.ByMerchant["woolworths pty ltd"]
	if woolsPTY.Total != 1 || woolsPTY.Correct != 0 {
		t.Errorf("woolworths pty ltd: want 0/1, got %d/%d", woolsPTY.Correct, woolsPTY.Total)
	}
	if len(woolsPTY.Errors) != 1 {
		t.Errorf("woolworths pty ltd: expected 1 error detail, got %d", len(woolsPTY.Errors))
	}
}

func TestScoreBySource(t *testing.T) {
	preds := []classification.Prediction{
		{Expected: "Groceries", Predicted: "Groceries", Source: "rule"},
		{Expected: "Fuel/Transport", Predicted: "Fuel/Transport", Source: "rule"},
		{Expected: "Telecoms", Predicted: "Entertainment", Source: "llm"}, // wrong
		{Expected: "Groceries", Predicted: "Groceries", Source: "merchant_signal"},
	}
	res := classification.Score(preds, nil)

	ruleRes := res.BySource["rule"]
	if ruleRes.Total != 2 || ruleRes.Correct != 2 {
		t.Errorf("source=rule: want 2/2, got %d/%d", ruleRes.Correct, ruleRes.Total)
	}
	llmRes := res.BySource["llm"]
	if llmRes.Total != 1 || llmRes.Correct != 0 {
		t.Errorf("source=llm: want 0/1, got %d/%d", llmRes.Correct, llmRes.Total)
	}
}

func TestPrintReportDoesNotPanic(t *testing.T) {
	preds := []classification.Prediction{
		{FixtureID: "x1", Merchant: "Woolworths", Expected: "Groceries", Predicted: "Groceries", Source: "rule", Confidence: 1.0},
		{FixtureID: "x2", Merchant: "Engen Fuel", Expected: "Fuel/Transport", Predicted: "Groceries", Source: "llm", Confidence: 0.5},
	}
	res := classification.Score(preds, nil)
	var buf bytes.Buffer
	// Must not panic.
	classification.PrintReport(&buf, res)
	out := buf.String()
	if !strings.Contains(out, "Classification Accuracy Report") {
		t.Errorf("report missing header; got:\n%s", out)
	}
	if !strings.Contains(out, "FAIL") {
		t.Errorf("report should flag the wrong prediction; got:\n%s", out)
	}
}

func TestPrintReportPerfect(t *testing.T) {
	res := classification.Score([]classification.Prediction{
		{Expected: "X", Predicted: "X"},
	}, nil)
	var buf bytes.Buffer
	classification.PrintReport(&buf, res)
	if !strings.Contains(buf.String(), "100.0%") {
		t.Errorf("expected 100%% in perfect report, got:\n%s", buf.String())
	}
}
