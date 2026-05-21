package reporting

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"
)

// Store performs all DB reads for the reporting package.
// It reads directly from the schema tables and never writes.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─── Profit & Loss ─────────────────────────────────────────────────────────

// FetchPLLines returns per-account income/expense net balances for the period.
//
// For income accounts: credit – debit (normal credit-side balance).
// For expense accounts: debit – credit (normal debit-side balance).
// Both are returned as positive numbers for "normal" activity.
func (s *Store) FetchPLLines(ctx context.Context, orgID uuid.UUID, from, to time.Time) ([]PLLine, error) {
	const q = `
		SELECT
			a.id,
			COALESCE(a.code, ''),
			a.name,
			a.type::text,
			CASE a.type
				WHEN 'income'  THEN COALESCE(SUM(le.credit - le.debit),  0)
				WHEN 'expense' THEN COALESCE(SUM(le.debit  - le.credit), 0)
				ELSE 0
			END AS net_balance
		FROM accounts a
		LEFT JOIN ledger_entries le
			ON  le.account_id      = a.id
			AND le.organization_id = a.organization_id
			AND le.posted_date     >= $2
			AND le.posted_date     <= $3
		WHERE a.organization_id = $1
		  AND a.type IN ('income', 'expense')
		  AND NOT a.is_archived
		GROUP BY a.id, a.code, a.name, a.type
		ORDER BY a.type, a.code NULLS LAST, a.name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PLLine
	for rows.Next() {
		var l PLLine
		if err := rows.Scan(&l.AccountID, &l.Code, &l.Name, &l.AccountType, &l.NetBalance); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ─── Balance Sheet ─────────────────────────────────────────────────────────

// FetchBSLines returns per-account asset/liability/equity balances as of asOf.
//
// Asset accounts: debit – credit (normal debit balance, positive = asset value).
// Liability/equity accounts: credit – debit (normal credit balance, positive = owed).
func (s *Store) FetchBSLines(ctx context.Context, orgID uuid.UUID, asOf time.Time) ([]BSLine, error) {
	const q = `
		SELECT
			a.id,
			COALESCE(a.code, ''),
			a.name,
			a.type::text,
			CASE a.type
				WHEN 'asset'     THEN COALESCE(SUM(le.debit  - le.credit), 0)
				WHEN 'liability' THEN COALESCE(SUM(le.credit - le.debit),  0)
				WHEN 'equity'    THEN COALESCE(SUM(le.credit - le.debit),  0)
				ELSE 0
			END AS balance
		FROM accounts a
		LEFT JOIN ledger_entries le
			ON  le.account_id      = a.id
			AND le.organization_id = a.organization_id
			AND le.posted_date     <= $2
		WHERE a.organization_id = $1
		  AND a.type IN ('asset', 'liability', 'equity')
		  AND NOT a.is_archived
		GROUP BY a.id, a.code, a.name, a.type
		ORDER BY a.type, a.code NULLS LAST, a.name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []BSLine
	for rows.Next() {
		var l BSLine
		if err := rows.Scan(&l.AccountID, &l.Code, &l.Name, &l.AccountType, &l.Balance); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ─── VAT Summary ────────────────────────────────────────────────────────────

// FetchVATLines returns per-tax-rate output/input totals for the period.
//
// "output" = tax collected on sales (income account direction).
// "input"  = tax paid on purchases (expense account direction).
//
// The query sums the tax column from transactions and splits by account type.
// Transactions without a tax_rate_id or with zero tax are excluded.
func (s *Store) FetchVATLines(ctx context.Context, orgID uuid.UUID, from, to time.Time) ([]VATLine, error) {
	const q = `
		SELECT
			tr.id,
			tr.code,
			tr.name,
			tr.rate,
			COALESCE(SUM(t.amount - COALESCE(t.tax, 0)), 0)                  AS net,
			COALESCE(SUM(COALESCE(t.tax, 0)), 0)                              AS tax_amount,
			CASE WHEN a.type IN ('income') THEN 'output' ELSE 'input' END     AS direction
		FROM transactions t
		JOIN tax_rates tr
			ON tr.id = t.tax_rate_id
		LEFT JOIN transaction_classifications tc
			ON tc.id = t.current_classification_id
		LEFT JOIN accounts a
			ON a.id = tc.account_id
		WHERE t.organization_id = $1
		  AND t.posted_date >= $2
		  AND t.posted_date <= $3
		  AND t.tax_rate_id IS NOT NULL
		  AND COALESCE(t.tax, 0) > 0
		GROUP BY tr.id, tr.code, tr.name, tr.rate, direction
		ORDER BY direction DESC, tr.code, tr.name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []VATLine
	for rows.Next() {
		var l VATLine
		if err := rows.Scan(&l.TaxRateID, &l.Code, &l.Name, &l.Rate, &l.Net, &l.TaxAmount, &l.Direction); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ─── Cash Flow ─────────────────────────────────────────────────────────────

// FetchCashFlowRows returns per-month transaction aggregates for the period.
func (s *Store) FetchCashFlowRows(ctx context.Context, orgID uuid.UUID, from, to time.Time) ([]CashFlowInput, error) {
	const q = `
		SELECT
			TO_CHAR(posted_date, 'YYYY-MM') AS month,
			direction::text,
			COALESCE(SUM(amount), 0)        AS amount
		FROM transactions
		WHERE organization_id = $1
		  AND posted_date >= $2
		  AND posted_date <= $3
		  AND amount IS NOT NULL
		GROUP BY month, direction
		ORDER BY month, direction
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CashFlowInput
	for rows.Next() {
		var r CashFlowInput
		if err := rows.Scan(&r.Month, &r.Direction, &r.Amount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ─── Spending Trend ─────────────────────────────────────────────────────────

// FetchSpendingTrendRows returns spend per (category, month) for the period.
// Only expense-direction transactions with a category are included.
func (s *Store) FetchSpendingTrendRows(ctx context.Context, orgID uuid.UUID, from, to time.Time) ([]SpendingTrendInput, error) {
	const q = `
		SELECT
			c.id::text,
			c.name,
			TO_CHAR(t.posted_date, 'YYYY-MM') AS month,
			COALESCE(SUM(t.amount), 0)        AS amount
		FROM transactions t
		JOIN categories c ON c.id = t.category_id
		WHERE t.organization_id = $1
		  AND t.posted_date >= $2
		  AND t.posted_date <= $3
		  AND t.direction = 'debit'
		  AND t.amount IS NOT NULL
		GROUP BY c.id, c.name, month
		ORDER BY month, c.name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SpendingTrendInput
	for rows.Next() {
		var r SpendingTrendInput
		if err := rows.Scan(&r.CategoryID, &r.CategoryName, &r.Month, &r.Amount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ─── Net Worth ──────────────────────────────────────────────────────────────

// FetchNetWorthSeries returns a net-worth time series for the period.
//
// The query unions:
//   - asset_valuations: latest valuation per asset per month (as-of date)
//   - liability_balances: latest balance per liability per month
//
// and aggregates them to produce one row per month end.
func (s *Store) FetchNetWorthSeries(ctx context.Context, orgID uuid.UUID, from, to time.Time) ([]NetWorthInput, error) {
	const q = `
		WITH months AS (
			SELECT
				TO_CHAR(gs, 'YYYY-MM-DD')::date AS month_end
			FROM generate_series(
				DATE_TRUNC('month', $2::date),
				DATE_TRUNC('month', $3::date),
				INTERVAL '1 month'
			) gs
		),
		-- Latest asset valuation on or before each month end
		asset_vals AS (
			SELECT
				m.month_end,
				a.organization_id,
				av.asset_id,
				av.value,
				ROW_NUMBER() OVER (
					PARTITION BY a.organization_id, av.asset_id, m.month_end
					ORDER BY av.as_of DESC
				) AS rn
			FROM months m
			JOIN asset_valuations av ON av.as_of <= m.month_end
			JOIN assets a ON a.id = av.asset_id
			WHERE a.organization_id = $1
			  AND NOT a.is_archived
		),
		-- Latest liability balance on or before each month end
		liab_vals AS (
			SELECT
				m.month_end,
				l.organization_id,
				lb.liability_id,
				lb.balance,
				ROW_NUMBER() OVER (
					PARTITION BY l.organization_id, lb.liability_id, m.month_end
					ORDER BY lb.as_of DESC
				) AS rn
			FROM months m
			JOIN liability_balances lb ON lb.as_of <= m.month_end
			JOIN liabilities l ON l.id = lb.liability_id
			WHERE l.organization_id = $1
			  AND NOT l.is_archived
		)
		SELECT
			TO_CHAR(m.month_end, 'YYYY-MM-DD')           AS date,
			COALESCE(SUM(av.value),    0)                 AS total_assets,
			COALESCE(SUM(lv.balance),  0)                 AS total_debt
		FROM months m
		LEFT JOIN asset_vals av
			ON av.month_end = m.month_end
			AND av.organization_id = $1
			AND av.rn = 1
		LEFT JOIN liab_vals lv
			ON lv.month_end = m.month_end
			AND lv.organization_id = $1
			AND lv.rn = 1
		GROUP BY m.month_end
		ORDER BY m.month_end
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []NetWorthInput
	for rows.Next() {
		var r NetWorthInput
		if err := rows.Scan(&r.Date, &r.TotalAssets, &r.TotalDebt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ─── Org kind lookup ────────────────────────────────────────────────────────

// OrgKind returns the kind ('personal' | 'business') of the given org.
// Returns sql.ErrNoRows if the org does not exist.
func OrgKind(ctx context.Context, db *sql.DB, orgID uuid.UUID) (string, error) {
	var kind string
	err := db.QueryRowContext(ctx,
		`SELECT kind::text FROM organizations WHERE id = $1`, orgID,
	).Scan(&kind)
	return kind, err
}
