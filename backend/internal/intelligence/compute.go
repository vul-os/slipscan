package intelligence

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/google/uuid"
)

// ─── Forecast ─────────────────────────────────────────────────────────────────

// ForecastPoint is one projected month in the cash-flow forecast.
type ForecastPoint struct {
	Month            string  // "2026-06"
	ProjectedInflow  float64 `json:"projected_inflow"`
	ProjectedOutflow float64 `json:"projected_outflow"`
	ProjectedNet     float64 `json:"projected_net"`
	ProjectedBalance float64 `json:"projected_balance"`
}

// ForecastResult is the full forecast response payload.
type ForecastResult struct {
	Horizon     int             `json:"horizon"`
	Currency    string          `json:"currency"`
	Points      []ForecastPoint `json:"points"`
	Assumptions []string        `json:"assumptions"`
}

// frequencyMonthlyMultiplier returns approximate monthly occurrences for a frequency.
func frequencyMonthlyMultiplier(freq string) float64 {
	switch freq {
	case "weekly":
		return 52.0 / 12.0 // ~4.33
	case "biweekly":
		return 26.0 / 12.0 // ~2.17
	case "monthly":
		return 1.0
	case "quarterly":
		return 1.0 / 3.0
	case "yearly":
		return 1.0 / 12.0
	default:
		return 1.0
	}
}

// projectRecurring sums up the expected monthly recurring inflows and outflows.
// recurring rows without an expected_amount are skipped.
func projectRecurring(rows []RecurringRow) (inflow, outflow float64, merchants []string) {
	seen := make(map[string]bool)
	for _, r := range rows {
		if !r.ExpectedAmount.Valid || r.ExpectedAmount.Float64 <= 0 {
			continue
		}
		mult := frequencyMonthlyMultiplier(r.Frequency)
		monthly := r.ExpectedAmount.Float64 * mult
		// Heuristic: if merchant name hints at income (subscription, salary) treat as
		// inflow; for now use amount direction from category.  We lack a direction field
		// on recurring_transactions so we treat all recurring as outflows (expenses)
		// unless the caller overrides.  The assumption is surfaced in the response.
		outflow += monthly
		if !seen[r.MerchantNormalized] {
			merchants = append(merchants, r.MerchantNormalized)
			seen[r.MerchantNormalized] = true
		}
	}
	return 0, outflow, merchants
}

// ComputeForecast builds a horizon-month cash-flow projection.
// history must be ordered oldest → newest.
func ComputeForecast(
	history []MonthlyTotals,
	recurring []RecurringRow,
	horizon int,
	currency string,
) ForecastResult {
	if horizon < 1 {
		horizon = 3
	}
	if horizon > 24 {
		horizon = 24
	}

	// Compute historical averages.
	var totalIn, totalOut float64
	for _, h := range history {
		totalIn += h.In
		totalOut += h.Out
	}
	n := float64(len(history))
	avgIn, avgOut := 0.0, 0.0
	if n > 0 {
		avgIn = totalIn / n
		avgOut = totalOut / n
	}

	// Recurring contribution (monthly).
	_, recurOut, recurMerchants := projectRecurring(recurring)

	// Blend: use average as base, add recurring outflow on top of average if
	// average outflow is less than recurring (avoid double-counting if averages
	// already include these charges).
	blendedOut := avgOut
	if recurOut > avgOut {
		blendedOut = recurOut
	}
	blendedIn := avgIn

	// Build projection points.
	now := time.Now().UTC()
	startYear, startMonth, _ := now.Date()
	// project from next month
	projStart := time.Date(startYear, startMonth+1, 1, 0, 0, 0, 0, time.UTC)

	points := make([]ForecastPoint, 0, horizon)
	balance := 0.0 // running balance; starts at 0 (relative change)
	for i := 0; i < horizon; i++ {
		t := projStart.AddDate(0, i, 0)
		label := fmt.Sprintf("%d-%02d", t.Year(), t.Month())
		net := blendedIn - blendedOut
		balance += net
		points = append(points, ForecastPoint{
			Month:            label,
			ProjectedInflow:  roundTwo(blendedIn),
			ProjectedOutflow: roundTwo(blendedOut),
			ProjectedNet:     roundTwo(net),
			ProjectedBalance: roundTwo(balance),
		})
	}

	// Surface assumptions.
	assumptions := []string{}
	if len(history) == 0 {
		assumptions = append(assumptions, "No transaction history available; projection uses zero baseline")
	} else {
		assumptions = append(assumptions, fmt.Sprintf(
			"Historical averages computed from %d month(s) of data", len(history),
		))
	}
	if len(recurMerchants) > 0 {
		assumptions = append(assumptions, fmt.Sprintf(
			"%d recurring merchant(s) included: %s", len(recurMerchants), joinMerchants(recurMerchants, 5),
		))
	} else {
		assumptions = append(assumptions, "No active recurring transactions found")
	}
	assumptions = append(assumptions, "Recurring transactions treated as outflows (expense); override if merchant is income source")
	assumptions = append(assumptions, "Projection uses flat average; seasonality not modelled")

	return ForecastResult{
		Horizon:     horizon,
		Currency:    currency,
		Points:      points,
		Assumptions: assumptions,
	}
}

func joinMerchants(ms []string, max int) string {
	sort.Strings(ms)
	if len(ms) > max {
		ms = ms[:max]
		return fmt.Sprintf("%v and more", ms)
	}
	s := ""
	for i, m := range ms {
		if i > 0 {
			s += ", "
		}
		s += m
	}
	return s
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

// AnomalyType enumerates the kinds of anomalies we detect.
type AnomalyType string

const (
	AnomalyDuplicate      AnomalyType = "duplicate"
	AnomalyUnusualSpend   AnomalyType = "unusual_spend"
	AnomalyMissingReceipt AnomalyType = "missing_receipt"
)

// Severity ranks anomalies.
type Severity string

const (
	SeverityHigh   Severity = "high"
	SeverityMedium Severity = "medium"
	SeverityLow    Severity = "low"
)

// Anomaly is one detected anomaly.
type Anomaly struct {
	ID            string      `json:"id"`
	Type          AnomalyType `json:"type"`
	Severity      Severity    `json:"severity"`
	Title         string      `json:"title"`
	Description   string      `json:"description"`
	Amount        *float64    `json:"amount,omitempty"`
	Currency      *string     `json:"currency,omitempty"`
	TransactionID *string     `json:"transaction_id,omitempty"`
	DetectedAt    string      `json:"detected_at"`
}

// highValueThreshold is the amount above which a transaction lacking a
// reconciled document is flagged as missing_receipt.
const highValueThreshold = 500.0

// duplicateDateWindowDays: two transactions are "near date" if within this window.
const duplicateDateWindowDays = 3

// DetectDuplicates finds pairs of transactions that share merchant_normalized +
// similar amount within a short date window.  Returns one anomaly per suspect pair.
func DetectDuplicates(txs []TxRow, detectedAt time.Time) []Anomaly {
	type key struct {
		merchant string
		amount   int64 // rounded to cents
	}
	// Group by key.
	type entry struct {
		id   uuid.UUID
		date time.Time
		amt  float64
		cur  string
	}
	groups := make(map[key][]entry)
	for _, t := range txs {
		if !t.MerchantNormalized.Valid || !t.Amount.Valid || !t.PostedDate.Valid {
			continue
		}
		k := key{
			merchant: t.MerchantNormalized.String,
			amount:   int64(math.Round(t.Amount.Float64 * 100)),
		}
		cur := ""
		if t.Currency.Valid {
			cur = t.Currency.String
		}
		groups[k] = append(groups[k], entry{
			id:   t.ID,
			date: t.PostedDate.Time,
			amt:  t.Amount.Float64,
			cur:  cur,
		})
	}

	var anomalies []Anomaly
	seen := make(map[string]bool)
	for _, entries := range groups {
		if len(entries) < 2 {
			continue
		}
		// Sort by date.
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].date.Before(entries[j].date)
		})
		// Find pairs within date window.
		for i := 0; i < len(entries); i++ {
			for j := i + 1; j < len(entries); j++ {
				delta := entries[j].date.Sub(entries[i].date)
				if delta < 0 {
					delta = -delta
				}
				if delta > time.Duration(duplicateDateWindowDays)*24*time.Hour {
					break // sorted, remaining entries only get further away
				}
				pairKey := entries[i].id.String() + "+" + entries[j].id.String()
				if seen[pairKey] {
					continue
				}
				seen[pairKey] = true
				amt := entries[i].amt
				cur := entries[i].cur
				txID := entries[j].id.String() // flag the later one as suspect
				anomalies = append(anomalies, Anomaly{
					ID:            "dup-" + entries[i].id.String()[:8],
					Type:          AnomalyDuplicate,
					Severity:      SeverityHigh,
					Title:         "Possible duplicate transaction",
					Description:   fmt.Sprintf("Two transactions of %.2f from %q within %d days", amt, entries[i].id.String()[:8], duplicateDateWindowDays),
					Amount:        &amt,
					Currency:      &cur,
					TransactionID: &txID,
					DetectedAt:    detectedAt.Format(time.RFC3339),
				})
			}
		}
	}
	return anomalies
}

// DetectUnusualSpend uses a per-category z-score approach: a transaction whose
// amount is more than zThreshold standard deviations above the category mean is
// flagged.  history is map[catID] → []monthly_amounts.
func DetectUnusualSpend(txs []TxRow, history map[string][]float64, detectedAt time.Time) []Anomaly {
	const zThreshold = 2.5

	// Compute per-category mean and stddev.
	type stats struct {
		mean   float64
		stddev float64
	}
	catStats := make(map[string]stats)
	for catID, vals := range history {
		if len(vals) < 2 {
			continue // need at least 2 data points for stddev
		}
		mean := mean(vals)
		sd := stddev(vals, mean)
		if sd < 1.0 {
			sd = 1.0 // floor to avoid division by near-zero
		}
		catStats[catID] = stats{mean, sd}
	}

	var anomalies []Anomaly
	for _, t := range txs {
		if !t.CategoryID.Valid || !t.Amount.Valid || t.Direction != "debit" {
			continue
		}
		catID := t.CategoryID.UUID.String()
		cs, ok := catStats[catID]
		if !ok {
			continue
		}
		z := (t.Amount.Float64 - cs.mean) / cs.stddev
		if z < zThreshold {
			continue
		}
		sev := SeverityMedium
		if z > 4.0 {
			sev = SeverityHigh
		}
		amt := t.Amount.Float64
		cur := ""
		if t.Currency.Valid {
			cur = t.Currency.String
		}
		txID := t.ID.String()
		anomalies = append(anomalies, Anomaly{
			ID:            "usp-" + t.ID.String()[:8],
			Type:          AnomalyUnusualSpend,
			Severity:      sev,
			Title:         "Unusual spend in category",
			Description:   fmt.Sprintf("Transaction of %.2f is %.1f standard deviations above category average (%.2f)", amt, z, cs.mean),
			Amount:        &amt,
			Currency:      &cur,
			TransactionID: &txID,
			DetectedAt:    detectedAt.Format(time.RFC3339),
		})
	}
	return anomalies
}

// DetectMissingReceipts flags high-value debit transactions that lack a
// reconciled document match.
func DetectMissingReceipts(txs []TxRow, reconciledIDs map[uuid.UUID]struct{}, detectedAt time.Time) []Anomaly {
	var anomalies []Anomaly
	for _, t := range txs {
		if t.Direction != "debit" {
			continue
		}
		if !t.Amount.Valid || t.Amount.Float64 < highValueThreshold {
			continue
		}
		if _, ok := reconciledIDs[t.ID]; ok {
			continue
		}
		amt := t.Amount.Float64
		cur := ""
		if t.Currency.Valid {
			cur = t.Currency.String
		}
		txID := t.ID.String()
		anomalies = append(anomalies, Anomaly{
			ID:            "rcpt-" + t.ID.String()[:8],
			Type:          AnomalyMissingReceipt,
			Severity:      SeverityMedium,
			Title:         "High-value transaction without reconciled document",
			Description:   fmt.Sprintf("Transaction of %.2f has no confirmed or auto-matched document", amt),
			Amount:        &amt,
			Currency:      &cur,
			TransactionID: &txID,
			DetectedAt:    detectedAt.Format(time.RFC3339),
		})
	}
	return anomalies
}

// ─── Tax-readiness ────────────────────────────────────────────────────────────

// TaxComponent is one line in the tax-readiness component list.
type TaxComponent struct {
	Label  string `json:"label"`
	Status string `json:"status"` // "ok" | "warn" | "error"
	Detail string `json:"detail"`
}

// TaxReadinessResult is the full tax-readiness response payload.
type TaxReadinessResult struct {
	Score                float64        `json:"score"`
	VATPosition          *float64       `json:"vat_position,omitempty"`
	DocumentedExpensePct float64        `json:"documented_expense_pct"`
	UnreconciledCount    int            `json:"unreconciled_count"`
	Components           []TaxComponent `json:"components"`
}

// ComputeTaxReadiness derives a 0–100 score from three components:
//  1. VAT position (output − input): 40 pts — 40 if ≥ 0 (net payable tracked),
//     20 if data present but negative (refund position), 0 if no VAT data.
//  2. Document coverage for expenses: 40 pts × documented_pct.
//  3. Unreconciled penalty: max 20 pts, reduced by 1 per 10 unreconciled items.
func ComputeTaxReadiness(data *TaxReadinessData) TaxReadinessResult {
	var components []TaxComponent

	// Component 1: VAT tracking.
	vatScore := 0.0
	var vatPosition *float64
	hasVAT := data.VATOutput > 0 || data.VATInput > 0
	if hasVAT {
		pos := data.VATOutput - data.VATInput
		vatPosition = &pos
		if pos >= 0 {
			vatScore = 40.0
			components = append(components, TaxComponent{
				Label:  "VAT position",
				Status: "ok",
				Detail: fmt.Sprintf("Net VAT payable: %.2f (output %.2f, input %.2f)", pos, data.VATOutput, data.VATInput),
			})
		} else {
			vatScore = 20.0
			components = append(components, TaxComponent{
				Label:  "VAT position",
				Status: "warn",
				Detail: fmt.Sprintf("Net VAT refund position: %.2f — verify input tax claims", pos),
			})
		}
	} else {
		vatScore = 0.0
		components = append(components, TaxComponent{
			Label:  "VAT position",
			Status: "warn",
			Detail: "No VAT-tagged transactions found; assign tax rates to enable VAT tracking",
		})
	}

	// Component 2: document coverage.
	docPct := 0.0
	if data.TotalExpenses > 0 {
		docPct = float64(data.DocumentedExpenses) / float64(data.TotalExpenses) * 100
	}
	docScore := docPct / 100 * 40
	docStatus := "ok"
	if docPct < 50 {
		docStatus = "error"
	} else if docPct < 80 {
		docStatus = "warn"
	}
	components = append(components, TaxComponent{
		Label:  "Expense documentation",
		Status: docStatus,
		Detail: fmt.Sprintf("%.0f%% of expense transactions have a supporting document (%d of %d)", docPct, data.DocumentedExpenses, data.TotalExpenses),
	})

	// Component 3: reconciliation.
	reconScore := 20.0 - float64(data.UnreconciledCount)/10.0
	if reconScore < 0 {
		reconScore = 0
	}
	reconStatus := "ok"
	if data.UnreconciledCount > 50 {
		reconStatus = "error"
	} else if data.UnreconciledCount > 10 {
		reconStatus = "warn"
	}
	components = append(components, TaxComponent{
		Label:  "Reconciliation",
		Status: reconStatus,
		Detail: fmt.Sprintf("%d expense transaction(s) lack a reconciled bank statement line", data.UnreconciledCount),
	})

	score := vatScore + docScore + reconScore
	if score > 100 {
		score = 100
	}
	if score < 0 {
		score = 0
	}

	return TaxReadinessResult{
		Score:                roundTwo(score),
		VATPosition:          vatPosition,
		DocumentedExpensePct: roundTwo(docPct),
		UnreconciledCount:    data.UnreconciledCount,
		Components:           components,
	}
}

// ─── math helpers ─────────────────────────────────────────────────────────────

func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	var s float64
	for _, v := range vals {
		s += v
	}
	return s / float64(len(vals))
}

func stddev(vals []float64, m float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	var s float64
	for _, v := range vals {
		d := v - m
		s += d * d
	}
	return math.Sqrt(s / float64(len(vals)))
}

func roundTwo(f float64) float64 {
	shifted := f * 100
	if shifted < 0 {
		shifted -= 0.5
	} else {
		shifted += 0.5
	}
	return float64(int64(shifted)) / 100
}
