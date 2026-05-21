// Package intelligence implements P4-02 cross-org intelligence:
// cash-flow forecasting, anomaly detection, and tax-readiness scoring.
//
// Store methods are all (ctx, orgID, …) scoped so they never bleed across orgs.
package intelligence

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Store is the data-access layer for the intelligence package.
type Store struct {
	db *sql.DB
}

// NewStore creates a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─── Forecast data ────────────────────────────────────────────────────────────

// RecurringRow is one active recurring transaction read from DB.
type RecurringRow struct {
	ID                 uuid.UUID
	MerchantNormalized string
	CategoryID         uuid.NullUUID
	ExpectedAmount     sql.NullFloat64
	Currency           sql.NullString
	Frequency          string // weekly | biweekly | monthly | quarterly | yearly
	NextExpectedDate   sql.NullTime
}

// ListActiveRecurring returns all active recurring transactions for the org.
func (s *Store) ListActiveRecurring(ctx context.Context, orgID uuid.UUID) ([]RecurringRow, error) {
	const q = `
		SELECT id, merchant_normalized, category_id, expected_amount, currency,
		       frequency, next_expected_date
		FROM recurring_transactions
		WHERE organization_id = $1
		  AND status          = 'active'
		ORDER BY next_expected_date ASC NULLS LAST
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("intelligence: list recurring: %w", err)
	}
	defer rows.Close()

	var out []RecurringRow
	for rows.Next() {
		var r RecurringRow
		if err := rows.Scan(
			&r.ID, &r.MerchantNormalized, &r.CategoryID,
			&r.ExpectedAmount, &r.Currency, &r.Frequency, &r.NextExpectedDate,
		); err != nil {
			return nil, fmt.Errorf("intelligence: scan recurring: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MonthlyTotals is the aggregated debit/credit for a calendar month.
type MonthlyTotals struct {
	Year  int
	Month time.Month
	In    float64 // credit sum
	Out   float64 // debit sum
}

// HistoricalMonthlyTotals returns the last N months of monthly in/out totals.
// Excludes rejected transactions.
func (s *Store) HistoricalMonthlyTotals(ctx context.Context, orgID uuid.UUID, months int) ([]MonthlyTotals, error) {
	if months < 1 {
		months = 12
	}
	const q = `
		SELECT
			EXTRACT(YEAR  FROM posted_date)::int                    AS yr,
			EXTRACT(MONTH FROM posted_date)::int                    AS mo,
			COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END), 0) AS total_in,
			COALESCE(SUM(CASE WHEN direction='debit'  THEN amount ELSE 0 END), 0) AS total_out
		FROM transactions
		WHERE organization_id = $1
		  AND status          != 'rejected'
		  AND posted_date     >= date_trunc('month', NOW() - ($2::int - 1) * INTERVAL '1 month')
		  AND posted_date      < date_trunc('month', NOW())
		GROUP BY yr, mo
		ORDER BY yr ASC, mo ASC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, months)
	if err != nil {
		return nil, fmt.Errorf("intelligence: monthly totals: %w", err)
	}
	defer rows.Close()

	var out []MonthlyTotals
	for rows.Next() {
		var r MonthlyTotals
		var yr, mo int
		if err := rows.Scan(&yr, &mo, &r.In, &r.Out); err != nil {
			return nil, fmt.Errorf("intelligence: monthly totals scan: %w", err)
		}
		r.Year = yr
		r.Month = time.Month(mo)
		out = append(out, r)
	}
	return out, rows.Err()
}

// OrgCurrency returns the most common non-null currency on transactions, or "ZAR" fallback.
func (s *Store) OrgCurrency(ctx context.Context, orgID uuid.UUID) (string, error) {
	var cur sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT currency
		FROM transactions
		WHERE organization_id = $1
		  AND currency IS NOT NULL
		GROUP BY currency
		ORDER BY COUNT(*) DESC
		LIMIT 1
	`, orgID).Scan(&cur)
	if err != nil || !cur.Valid {
		return "ZAR", nil //nolint:nilerr
	}
	return cur.String, nil
}

// ─── Anomaly data ─────────────────────────────────────────────────────────────

// TxRow is a minimal transaction row for anomaly detection.
type TxRow struct {
	ID                 uuid.UUID
	PostedDate         sql.NullTime
	MerchantNormalized sql.NullString
	CategoryID         uuid.NullUUID
	Amount             sql.NullFloat64
	Currency           sql.NullString
	Direction          string
}

// RecentTransactions returns non-rejected transactions in the last lookback days.
func (s *Store) RecentTransactions(ctx context.Context, orgID uuid.UUID, lookbackDays int) ([]TxRow, error) {
	if lookbackDays < 1 {
		lookbackDays = 90
	}
	const q = `
		SELECT id, posted_date, merchant_normalized, category_id, amount, currency, direction
		FROM transactions
		WHERE organization_id = $1
		  AND status          != 'rejected'
		  AND posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
		ORDER BY posted_date DESC NULLS LAST, created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, lookbackDays)
	if err != nil {
		return nil, fmt.Errorf("intelligence: recent transactions: %w", err)
	}
	defer rows.Close()

	var out []TxRow
	for rows.Next() {
		var r TxRow
		if err := rows.Scan(
			&r.ID, &r.PostedDate, &r.MerchantNormalized,
			&r.CategoryID, &r.Amount, &r.Currency, &r.Direction,
		); err != nil {
			return nil, fmt.Errorf("intelligence: recent tx scan: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CategorySpendHistory returns monthly debit spend per category over the lookback period.
// Returned as map[categoryID.String()] → []float64 of monthly amounts.
func (s *Store) CategorySpendHistory(ctx context.Context, orgID uuid.UUID, months int) (map[string][]float64, error) {
	if months < 3 {
		months = 12
	}
	const q = `
		SELECT
			category_id::text,
			EXTRACT(YEAR  FROM posted_date)::int AS yr,
			EXTRACT(MONTH FROM posted_date)::int AS mo,
			COALESCE(SUM(amount), 0)              AS total
		FROM transactions
		WHERE organization_id = $1
		  AND status          != 'rejected'
		  AND direction       = 'debit'
		  AND category_id     IS NOT NULL
		  AND posted_date     >= date_trunc('month', NOW() - ($2::int - 1) * INTERVAL '1 month')
		  AND posted_date      < date_trunc('month', NOW())
		GROUP BY category_id, yr, mo
		ORDER BY category_id, yr, mo
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, months)
	if err != nil {
		return nil, fmt.Errorf("intelligence: category history: %w", err)
	}
	defer rows.Close()

	// Group: catID → slice of monthly totals (one element per month seen).
	type monthKey struct{ yr, mo int }
	type catMonth struct {
		key   monthKey
		total float64
	}
	grouped := make(map[string][]catMonth)
	for rows.Next() {
		var catID string
		var yr, mo int
		var total float64
		if err := rows.Scan(&catID, &yr, &mo, &total); err != nil {
			return nil, fmt.Errorf("intelligence: category history scan: %w", err)
		}
		grouped[catID] = append(grouped[catID], catMonth{monthKey{yr, mo}, total})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make(map[string][]float64, len(grouped))
	for catID, entries := range grouped {
		vals := make([]float64, len(entries))
		for i, e := range entries {
			vals[i] = e.total
		}
		out[catID] = vals
	}
	return out, nil
}

// ReconciledTransactionIDs returns a set of transaction IDs that have a
// confirmed or auto reconciliation match.
func (s *Store) ReconciledTransactionIDs(ctx context.Context, orgID uuid.UUID) (map[uuid.UUID]struct{}, error) {
	const q = `
		SELECT transaction_id
		FROM reconciliation_matches
		WHERE organization_id = $1
		  AND state IN ('confirmed', 'auto')
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("intelligence: reconciled ids: %w", err)
	}
	defer rows.Close()

	out := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("intelligence: reconciled ids scan: %w", err)
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// ─── Tax-readiness data ───────────────────────────────────────────────────────

// TaxReadinessData aggregates everything needed to score tax-readiness in one query.
type TaxReadinessData struct {
	// VAT position: output tax (credit invoices) minus input tax (debit expenses).
	VATOutput float64
	VATInput  float64

	// Document coverage for expense transactions.
	TotalExpenses    int
	DocumentedExpenses int

	// Unreconciled count: debit transactions with no confirmed/auto match.
	UnreconciledCount int
}

// GetTaxReadinessData returns all aggregated data needed for the readiness score.
// lookbackDays controls the window (default 365 for tax purposes).
func (s *Store) GetTaxReadinessData(ctx context.Context, orgID uuid.UUID, lookbackDays int) (*TaxReadinessData, error) {
	if lookbackDays < 1 {
		lookbackDays = 365
	}

	var data TaxReadinessData

	// 1. VAT position via tax field on transactions joined to tax_rates.
	// Output VAT = tax on credit transactions; Input VAT = tax on debit transactions.
	const vatQ = `
		SELECT
			COALESCE(SUM(CASE WHEN t.direction = 'credit' THEN COALESCE(t.tax, 0) ELSE 0 END), 0) AS vat_output,
			COALESCE(SUM(CASE WHEN t.direction = 'debit'  THEN COALESCE(t.tax, 0) ELSE 0 END), 0) AS vat_input
		FROM transactions t
		WHERE t.organization_id = $1
		  AND t.status          != 'rejected'
		  AND t.tax_rate_id     IS NOT NULL
		  AND t.posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
	`
	if err := s.db.QueryRowContext(ctx, vatQ, orgID, lookbackDays).Scan(
		&data.VATOutput, &data.VATInput,
	); err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("intelligence: vat position: %w", err)
	}

	// 2. Document coverage for expense (debit) transactions.
	const docQ = `
		SELECT
			COUNT(*)                                             AS total,
			COUNT(CASE WHEN document_id IS NOT NULL THEN 1 END) AS documented
		FROM transactions
		WHERE organization_id = $1
		  AND direction       = 'debit'
		  AND status          != 'rejected'
		  AND posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
	`
	if err := s.db.QueryRowContext(ctx, docQ, orgID, lookbackDays).Scan(
		&data.TotalExpenses, &data.DocumentedExpenses,
	); err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("intelligence: document coverage: %w", err)
	}

	// 3. Unreconciled count: debit transactions with no confirmed/auto match.
	const reconQ = `
		SELECT COUNT(*)
		FROM transactions t
		WHERE t.organization_id = $1
		  AND t.direction       = 'debit'
		  AND t.status          != 'rejected'
		  AND t.posted_date     >= NOW() - ($2::int * INTERVAL '1 day')
		  AND NOT EXISTS (
			SELECT 1 FROM reconciliation_matches rm
			WHERE rm.transaction_id  = t.id
			  AND rm.organization_id = t.organization_id
			  AND rm.state           IN ('confirmed', 'auto')
		  )
	`
	if err := s.db.QueryRowContext(ctx, reconQ, orgID, lookbackDays).Scan(
		&data.UnreconciledCount,
	); err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("intelligence: unreconciled count: %w", err)
	}

	return &data, nil
}
