// Package finance implements the personal-finance domain: spend-by-category
// aggregation, budgets with progress, goals, and net-worth computation
// (assets − liabilities + holdings, FX-normalised to the org currency).
//
// All store methods take (ctx, orgID, …) so callers never need to pre-filter;
// the org check is the first WHERE clause in every query.
package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─── sentinel errors ──────────────────────────────────────────────────────────

var (
	ErrNotFound  = errors.New("finance: not found")
	ErrForbidden = errors.New("finance: forbidden")
)

// ─── Store ────────────────────────────────────────────────────────────────────

// Store is the finance data-access object.  It wraps *sql.DB and exposes only
// methods used by this package's handlers.
type Store struct {
	db *sql.DB
}

// NewStore constructs a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─── Spending breakdown ───────────────────────────────────────────────────────

// CategoryTotal is one row of the spend-by-category aggregation result.
type CategoryTotal struct {
	CategoryID   uuid.UUID
	CategoryName string
	Kind         string // "income" | "expense" | "transfer"
	TotalAmount  float64
	SharePercent float64 // 0–100, computed in Go after fetching rows
	TxCount      int
}

// SpendingRow is the DB row before share is computed.
type spendingRow struct {
	CategoryID   uuid.NullUUID
	CategoryName sql.NullString
	Kind         sql.NullString
	TotalAmount  float64
	TxCount      int
}

// SpendingBreakdown aggregates spend per category for the given period.
// Transactions without a category are grouped under a synthetic "Uncategorized" bucket.
// Only 'debit' or 'credit' directions (per dirFilter) are included.
func (s *Store) SpendingBreakdown(ctx context.Context, orgID uuid.UUID, from, to time.Time, direction string) ([]CategoryTotal, error) {
	// Validate direction.
	if direction != "debit" && direction != "credit" {
		direction = "debit"
	}

	const q = `
		SELECT
			t.category_id,
			c.name                                                AS category_name,
			c.kind                                                AS category_kind,
			COALESCE(SUM(t.amount), 0)                           AS total_amount,
			COUNT(*)                                             AS tx_count
		FROM transactions t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.organization_id = $1
		  AND t.direction        = $2
		  AND t.posted_date     >= $3
		  AND t.posted_date     <= $4
		  AND t.status          != 'rejected'
		GROUP BY t.category_id, c.name, c.kind
		ORDER BY total_amount DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, direction, from, to)
	if err != nil {
		return nil, fmt.Errorf("finance: spending breakdown query: %w", err)
	}
	defer rows.Close()

	var raw []spendingRow
	var grandTotal float64
	for rows.Next() {
		var r spendingRow
		if err := rows.Scan(&r.CategoryID, &r.CategoryName, &r.Kind, &r.TotalAmount, &r.TxCount); err != nil {
			return nil, fmt.Errorf("finance: spending breakdown scan: %w", err)
		}
		raw = append(raw, r)
		grandTotal += r.TotalAmount
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("finance: spending breakdown rows: %w", err)
	}

	out := make([]CategoryTotal, 0, len(raw))
	for _, r := range raw {
		ct := CategoryTotal{
			TotalAmount: r.TotalAmount,
			TxCount:     r.TxCount,
		}
		if r.CategoryID.Valid {
			ct.CategoryID = r.CategoryID.UUID
		}
		if r.CategoryName.Valid {
			ct.CategoryName = r.CategoryName.String
		} else {
			ct.CategoryName = "Uncategorized"
		}
		if r.Kind.Valid {
			ct.Kind = r.Kind.String
		} else {
			ct.Kind = "expense"
		}
		if grandTotal > 0 {
			ct.SharePercent = (r.TotalAmount / grandTotal) * 100
		}
		out = append(out, ct)
	}
	return out, nil
}

// TransactionSummary is a compact tx view for drill-down responses.
type TransactionSummary struct {
	ID           uuid.UUID
	PostedDate   sql.NullTime
	Merchant     sql.NullString
	Description  sql.NullString
	Amount       sql.NullFloat64
	Currency     sql.NullString
	Direction    string
	CategoryName sql.NullString
}

// TransactionsByCategory returns paginated transactions for the given category
// within the date range. Pass uuid.Nil to get uncategorised transactions.
func (s *Store) TransactionsByCategory(ctx context.Context, orgID, categoryID uuid.UUID, from, to time.Time, limit, offset int) ([]TransactionSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	var (
		q    string
		args []any
	)
	if categoryID == uuid.Nil {
		// Uncategorized
		q = `
			SELECT t.id, t.posted_date, t.merchant, t.description,
			       t.amount, t.currency, t.direction, c.name
			FROM transactions t
			LEFT JOIN categories c ON c.id = t.category_id
			WHERE t.organization_id = $1
			  AND t.category_id     IS NULL
			  AND t.posted_date    >= $2
			  AND t.posted_date    <= $3
			  AND t.status         != 'rejected'
			ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
			LIMIT $4 OFFSET $5
		`
		args = []any{orgID, from, to, limit, offset}
	} else {
		q = `
			SELECT t.id, t.posted_date, t.merchant, t.description,
			       t.amount, t.currency, t.direction, c.name
			FROM transactions t
			LEFT JOIN categories c ON c.id = t.category_id
			WHERE t.organization_id = $1
			  AND t.category_id     = $2
			  AND t.posted_date    >= $3
			  AND t.posted_date    <= $4
			  AND t.status         != 'rejected'
			ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
			LIMIT $5 OFFSET $6
		`
		args = []any{orgID, categoryID, from, to, limit, offset}
	}

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("finance: transactions by category: %w", err)
	}
	defer rows.Close()

	var out []TransactionSummary
	for rows.Next() {
		var t TransactionSummary
		if err := rows.Scan(
			&t.ID, &t.PostedDate, &t.Merchant, &t.Description,
			&t.Amount, &t.Currency, &t.Direction, &t.CategoryName,
		); err != nil {
			return nil, fmt.Errorf("finance: transactions scan: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

// Budget mirrors the budgets table.
type Budget struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Name           string
	Period         string // budget_period enum
	StartDate      time.Time
	EndDate        sql.NullTime
	Currency       string
	IsActive       bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// BudgetLine mirrors budget_lines + its category name.
type BudgetLine struct {
	ID         uuid.UUID
	BudgetID   uuid.UUID
	CategoryID uuid.NullUUID
	Amount     float64
	Rollover   bool
	// Computed on budget-progress calls:
	Actual     float64
	Remaining  float64 // Amount − Actual (can be negative = over budget)
}

// BudgetWithLines is a budget plus its lines.
type BudgetWithLines struct {
	Budget
	Lines []BudgetLine
}

// CreateBudgetInput is the validated input for creating a budget.
type CreateBudgetInput struct {
	Name      string
	Period    string
	StartDate time.Time
	EndDate   *time.Time
	Currency  string
}

// BudgetLineInput is a single budget-line payload.
type BudgetLineInput struct {
	CategoryID *uuid.UUID
	Amount     float64
	Rollover   bool
}

// CreateBudget inserts a budget + lines in one transaction.
func (s *Store) CreateBudget(ctx context.Context, orgID uuid.UUID, input CreateBudgetInput, lines []BudgetLineInput) (*BudgetWithLines, error) {
	if err := validateBudgetInput(input); err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("finance: create budget begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var b Budget
	endDate := sql.NullTime{}
	if input.EndDate != nil {
		endDate = sql.NullTime{Time: *input.EndDate, Valid: true}
	}
	err = tx.QueryRowContext(ctx, `
		INSERT INTO budgets (organization_id, name, period, start_date, end_date, currency)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, name, period, start_date, end_date, currency, is_active, created_at, updated_at
	`, orgID, input.Name, input.Period, input.StartDate, endDate, input.Currency,
	).Scan(
		&b.ID, &b.OrganizationID, &b.Name, &b.Period,
		&b.StartDate, &b.EndDate, &b.Currency, &b.IsActive,
		&b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("finance: insert budget: %w", err)
	}

	bl, err := insertBudgetLines(ctx, tx, b.ID, orgID, lines)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("finance: create budget commit: %w", err)
	}
	return &BudgetWithLines{Budget: b, Lines: bl}, nil
}

func insertBudgetLines(ctx context.Context, tx *sql.Tx, budgetID, orgID uuid.UUID, lines []BudgetLineInput) ([]BudgetLine, error) {
	out := make([]BudgetLine, 0, len(lines))
	for _, l := range lines {
		var bl BudgetLine
		var catID uuid.NullUUID
		if l.CategoryID != nil {
			catID = uuid.NullUUID{UUID: *l.CategoryID, Valid: true}
		}
		err := tx.QueryRowContext(ctx, `
			INSERT INTO budget_lines (budget_id, organization_id, category_id, amount, rollover)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, budget_id, category_id, amount, rollover
		`, budgetID, orgID, catID, l.Amount, l.Rollover,
		).Scan(&bl.ID, &bl.BudgetID, &bl.CategoryID, &bl.Amount, &bl.Rollover)
		if err != nil {
			return nil, fmt.Errorf("finance: insert budget line: %w", err)
		}
		out = append(out, bl)
	}
	return out, nil
}

// GetBudget fetches a single budget (with lines) belonging to orgID.
func (s *Store) GetBudget(ctx context.Context, orgID, budgetID uuid.UUID) (*BudgetWithLines, error) {
	var b Budget
	err := s.db.QueryRowContext(ctx, `
		SELECT id, organization_id, name, period, start_date, end_date, currency, is_active, created_at, updated_at
		FROM budgets
		WHERE id = $1 AND organization_id = $2
	`, budgetID, orgID).Scan(
		&b.ID, &b.OrganizationID, &b.Name, &b.Period,
		&b.StartDate, &b.EndDate, &b.Currency, &b.IsActive,
		&b.CreatedAt, &b.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("finance: get budget: %w", err)
	}

	lines, err := s.listBudgetLines(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	return &BudgetWithLines{Budget: b, Lines: lines}, nil
}

func (s *Store) listBudgetLines(ctx context.Context, budgetID uuid.UUID) ([]BudgetLine, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, budget_id, category_id, amount, rollover
		FROM budget_lines
		WHERE budget_id = $1
		ORDER BY id
	`, budgetID)
	if err != nil {
		return nil, fmt.Errorf("finance: list budget lines: %w", err)
	}
	defer rows.Close()

	var out []BudgetLine
	for rows.Next() {
		var bl BudgetLine
		if err := rows.Scan(&bl.ID, &bl.BudgetID, &bl.CategoryID, &bl.Amount, &bl.Rollover); err != nil {
			return nil, fmt.Errorf("finance: scan budget line: %w", err)
		}
		out = append(out, bl)
	}
	return out, rows.Err()
}

// ListBudgets returns all budgets for the org.
func (s *Store) ListBudgets(ctx context.Context, orgID uuid.UUID, activeOnly bool) ([]Budget, error) {
	q := `
		SELECT id, organization_id, name, period, start_date, end_date, currency, is_active, created_at, updated_at
		FROM budgets
		WHERE organization_id = $1
	`
	if activeOnly {
		q += " AND is_active = TRUE"
	}
	q += " ORDER BY start_date DESC"

	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("finance: list budgets: %w", err)
	}
	defer rows.Close()

	var out []Budget
	for rows.Next() {
		var b Budget
		if err := rows.Scan(
			&b.ID, &b.OrganizationID, &b.Name, &b.Period,
			&b.StartDate, &b.EndDate, &b.Currency, &b.IsActive,
			&b.CreatedAt, &b.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("finance: scan budget: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// DeleteBudget soft-deletes (sets is_active=false) a budget.
func (s *Store) DeleteBudget(ctx context.Context, orgID, budgetID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE budgets SET is_active = FALSE, updated_at = NOW()
		WHERE id = $1 AND organization_id = $2
	`, budgetID, orgID)
	if err != nil {
		return fmt.Errorf("finance: delete budget: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// BudgetProgress returns each budget line with actual spend for the period.
// from/to define the period; if zero they default to the budget start + one period length.
func (s *Store) BudgetProgress(ctx context.Context, orgID, budgetID uuid.UUID, from, to time.Time) (*BudgetWithLines, error) {
	bwl, err := s.GetBudget(ctx, orgID, budgetID)
	if err != nil {
		return nil, err
	}

	// Build a lookup: categoryID → actual spend.
	if len(bwl.Lines) == 0 {
		return bwl, nil
	}

	// Collect category IDs (nil for "all uncategorised" lines).
	catIDs := make([]string, 0, len(bwl.Lines))
	for _, l := range bwl.Lines {
		if l.CategoryID.Valid {
			catIDs = append(catIDs, "'"+l.CategoryID.UUID.String()+"'")
		}
	}

	actualMap, err := s.actualSpendByCategory(ctx, orgID, from, to, catIDs)
	if err != nil {
		return nil, err
	}

	for i := range bwl.Lines {
		l := &bwl.Lines[i]
		key := ""
		if l.CategoryID.Valid {
			key = l.CategoryID.UUID.String()
		}
		l.Actual = actualMap[key]
		l.Remaining = l.Amount - l.Actual
	}
	return bwl, nil
}

// actualSpendByCategory returns a map of categoryID.String() → total spend.
// catIDs is a list of UUID strings already quoted for SQL IN; pass empty slice for all.
func (s *Store) actualSpendByCategory(ctx context.Context, orgID uuid.UUID, from, to time.Time, catIDs []string) (map[string]float64, error) {
	q := `
		SELECT category_id, COALESCE(SUM(amount), 0)
		FROM transactions
		WHERE organization_id = $1
		  AND direction       = 'debit'
		  AND posted_date    >= $2
		  AND posted_date    <= $3
		  AND status         != 'rejected'
	`
	if len(catIDs) > 0 {
		q += " AND category_id IN (" + strings.Join(catIDs, ",") + ")"
	}
	q += " GROUP BY category_id"

	rows, err := s.db.QueryContext(ctx, q, orgID, from, to)
	if err != nil {
		return nil, fmt.Errorf("finance: actual spend query: %w", err)
	}
	defer rows.Close()

	out := make(map[string]float64)
	for rows.Next() {
		var catID uuid.NullUUID
		var total float64
		if err := rows.Scan(&catID, &total); err != nil {
			return nil, fmt.Errorf("finance: actual spend scan: %w", err)
		}
		key := ""
		if catID.Valid {
			key = catID.UUID.String()
		}
		out[key] = total
	}
	return out, rows.Err()
}

func validateBudgetInput(input CreateBudgetInput) error {
	if strings.TrimSpace(input.Name) == "" {
		return errors.New("budget name is required")
	}
	validPeriods := map[string]bool{"weekly": true, "monthly": true, "quarterly": true, "yearly": true}
	if !validPeriods[input.Period] {
		return fmt.Errorf("invalid period %q: must be weekly, monthly, quarterly, or yearly", input.Period)
	}
	if input.Currency == "" {
		return errors.New("currency is required")
	}
	if input.StartDate.IsZero() {
		return errors.New("start_date is required")
	}
	return nil
}

// ─── Goals ────────────────────────────────────────────────────────────────────

// Goal mirrors the goals table plus computed progress.
type Goal struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	AccountID      uuid.NullUUID
	CategoryID     uuid.NullUUID
	Name           string
	Kind           string // goal_kind enum
	TargetAmount   float64
	CurrentAmount  float64
	TargetDate     sql.NullTime
	Currency       string
	Status         string // goal_status enum
	ProgressPct    float64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// computeProgress fills in ProgressPct.
func (g *Goal) computeProgress() {
	if g.TargetAmount <= 0 {
		g.ProgressPct = 0
		return
	}
	pct := (g.CurrentAmount / g.TargetAmount) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	g.ProgressPct = pct
}

// CreateGoalInput is the validated payload for a new goal.
type CreateGoalInput struct {
	Name          string
	Kind          string
	TargetAmount  float64
	CurrentAmount float64
	TargetDate    *time.Time
	Currency      string
	AccountID     *uuid.UUID
	CategoryID    *uuid.UUID
}

// CreateGoal inserts a new goal row.
func (s *Store) CreateGoal(ctx context.Context, orgID uuid.UUID, input CreateGoalInput) (*Goal, error) {
	if err := validateGoalInput(input); err != nil {
		return nil, err
	}

	var targetDate sql.NullTime
	if input.TargetDate != nil {
		targetDate = sql.NullTime{Time: *input.TargetDate, Valid: true}
	}
	var accountID uuid.NullUUID
	if input.AccountID != nil {
		accountID = uuid.NullUUID{UUID: *input.AccountID, Valid: true}
	}
	var categoryID uuid.NullUUID
	if input.CategoryID != nil {
		categoryID = uuid.NullUUID{UUID: *input.CategoryID, Valid: true}
	}

	var g Goal
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO goals
			(organization_id, account_id, category_id, name, kind,
			 target_amount, current_amount, target_date, currency)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, organization_id, account_id, category_id, name, kind,
		          target_amount, current_amount, target_date, currency, status,
		          created_at, updated_at
	`, orgID, accountID, categoryID, input.Name, input.Kind,
		input.TargetAmount, input.CurrentAmount, targetDate, input.Currency,
	).Scan(
		&g.ID, &g.OrganizationID, &g.AccountID, &g.CategoryID,
		&g.Name, &g.Kind, &g.TargetAmount, &g.CurrentAmount,
		&g.TargetDate, &g.Currency, &g.Status,
		&g.CreatedAt, &g.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("finance: create goal: %w", err)
	}
	g.computeProgress()
	return &g, nil
}

// ListGoals returns all goals for the org, optionally filtered by status.
func (s *Store) ListGoals(ctx context.Context, orgID uuid.UUID, statusFilter string) ([]Goal, error) {
	q := `
		SELECT id, organization_id, account_id, category_id, name, kind,
		       target_amount, current_amount, target_date, currency, status,
		       created_at, updated_at
		FROM goals
		WHERE organization_id = $1
	`
	args := []any{orgID}
	if statusFilter != "" {
		q += " AND status = $2"
		args = append(args, statusFilter)
	}
	q += " ORDER BY created_at DESC"

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("finance: list goals: %w", err)
	}
	defer rows.Close()

	var out []Goal
	for rows.Next() {
		var g Goal
		if err := rows.Scan(
			&g.ID, &g.OrganizationID, &g.AccountID, &g.CategoryID,
			&g.Name, &g.Kind, &g.TargetAmount, &g.CurrentAmount,
			&g.TargetDate, &g.Currency, &g.Status,
			&g.CreatedAt, &g.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("finance: scan goal: %w", err)
		}
		g.computeProgress()
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetGoal fetches a single goal.
func (s *Store) GetGoal(ctx context.Context, orgID, goalID uuid.UUID) (*Goal, error) {
	var g Goal
	err := s.db.QueryRowContext(ctx, `
		SELECT id, organization_id, account_id, category_id, name, kind,
		       target_amount, current_amount, target_date, currency, status,
		       created_at, updated_at
		FROM goals
		WHERE id = $1 AND organization_id = $2
	`, goalID, orgID).Scan(
		&g.ID, &g.OrganizationID, &g.AccountID, &g.CategoryID,
		&g.Name, &g.Kind, &g.TargetAmount, &g.CurrentAmount,
		&g.TargetDate, &g.Currency, &g.Status,
		&g.CreatedAt, &g.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("finance: get goal: %w", err)
	}
	g.computeProgress()
	return &g, nil
}

// UpdateGoalAmount updates current_amount on a goal (e.g., after a deposit).
func (s *Store) UpdateGoalAmount(ctx context.Context, orgID, goalID uuid.UUID, currentAmount float64, status string) (*Goal, error) {
	validStatuses := map[string]bool{"active": true, "achieved": true, "abandoned": true}
	if status != "" && !validStatuses[status] {
		return nil, fmt.Errorf("invalid status %q", status)
	}

	q := `
		UPDATE goals
		SET current_amount = $3, updated_at = NOW()
	`
	args := []any{goalID, orgID, currentAmount}
	if status != "" {
		q += ", status = $4"
		args = append(args, status)
	}
	q += " WHERE id = $1 AND organization_id = $2"
	q += " RETURNING id, organization_id, account_id, category_id, name, kind, target_amount, current_amount, target_date, currency, status, created_at, updated_at"

	var g Goal
	err := s.db.QueryRowContext(ctx, q, args...).Scan(
		&g.ID, &g.OrganizationID, &g.AccountID, &g.CategoryID,
		&g.Name, &g.Kind, &g.TargetAmount, &g.CurrentAmount,
		&g.TargetDate, &g.Currency, &g.Status,
		&g.CreatedAt, &g.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("finance: update goal: %w", err)
	}
	g.computeProgress()
	return &g, nil
}

// DeleteGoal marks a goal as abandoned.
func (s *Store) DeleteGoal(ctx context.Context, orgID, goalID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE goals SET status = 'abandoned', updated_at = NOW()
		WHERE id = $1 AND organization_id = $2
	`, goalID, orgID)
	if err != nil {
		return fmt.Errorf("finance: delete goal: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func validateGoalInput(input CreateGoalInput) error {
	if strings.TrimSpace(input.Name) == "" {
		return errors.New("goal name is required")
	}
	validKinds := map[string]bool{"savings": true, "debt_payoff": true, "spending": true}
	if !validKinds[input.Kind] {
		return fmt.Errorf("invalid kind %q: must be savings, debt_payoff, or spending", input.Kind)
	}
	if input.TargetAmount <= 0 {
		return errors.New("target_amount must be positive")
	}
	if input.Currency == "" {
		return errors.New("currency is required")
	}
	return nil
}

// ─── Net worth ────────────────────────────────────────────────────────────────

// NetWorthSnapshot is the headline net-worth figure for an org, FX-normalised
// to the org's base currency.
type NetWorthSnapshot struct {
	AsOf           time.Time
	BaseCurrency   string
	TotalAssets    float64
	TotalHoldings  float64
	TotalLiabs     float64
	NetWorth       float64 // TotalAssets + TotalHoldings − TotalLiabs
}

// NetWorthPoint is one data point in the time-series response.
type NetWorthPoint struct {
	AsOf     time.Time
	NetWorth float64
}

// NetWorthNow computes the current net worth by summing:
//   - latest asset_valuations for each asset (FX to baseCurrency)
//   - holdings market value = quantity * current_price (FX to baseCurrency)
//   - latest liability_balances for each liability (FX to baseCurrency)
//
// FX rates are taken from the fx_rates table (most recent rate for each pair).
// If no rate is found the amount is treated as already in baseCurrency (best-effort).
func (s *Store) NetWorthNow(ctx context.Context, orgID uuid.UUID, baseCurrency string) (*NetWorthSnapshot, error) {
	fxRates, err := s.latestFXRates(ctx, baseCurrency)
	if err != nil {
		return nil, err
	}
	convert := func(amount float64, currency string) float64 {
		if currency == baseCurrency || currency == "" {
			return amount
		}
		if rate, ok := fxRates[currency]; ok && rate > 0 {
			return amount / rate // rate is quote/base, so divide to get base
		}
		// No rate available: return as-is (best-effort).
		return amount
	}

	assets, err := s.latestAssetValuations(ctx, orgID)
	if err != nil {
		return nil, err
	}
	var totalAssets float64
	for _, a := range assets {
		totalAssets += convert(a.value, a.currency)
	}

	holdings, err := s.holdingsValue(ctx, orgID)
	if err != nil {
		return nil, err
	}
	var totalHoldings float64
	for _, h := range holdings {
		totalHoldings += convert(h.value, h.currency)
	}

	liabs, err := s.latestLiabilityBalances(ctx, orgID)
	if err != nil {
		return nil, err
	}
	var totalLiabs float64
	for _, l := range liabs {
		totalLiabs += convert(l.value, l.currency)
	}

	return &NetWorthSnapshot{
		AsOf:          time.Now().UTC(),
		BaseCurrency:  baseCurrency,
		TotalAssets:   totalAssets,
		TotalHoldings: totalHoldings,
		TotalLiabs:    totalLiabs,
		NetWorth:      totalAssets + totalHoldings - totalLiabs,
	}, nil
}

type valueRow struct {
	value    float64
	currency string
}

// latestAssetValuations fetches the most recent valuation per asset.
func (s *Store) latestAssetValuations(ctx context.Context, orgID uuid.UUID) ([]valueRow, error) {
	const q = `
		SELECT DISTINCT ON (av.asset_id)
			av.value, av.currency
		FROM asset_valuations av
		JOIN assets a ON a.id = av.asset_id
		WHERE av.organization_id = $1
		  AND a.is_archived = FALSE
		ORDER BY av.asset_id, av.as_of DESC
	`
	return s.queryValueRows(ctx, q, orgID)
}

// holdingsValue computes quantity * current_price for each non-archived holding.
func (s *Store) holdingsValue(ctx context.Context, orgID uuid.UUID) ([]valueRow, error) {
	const q = `
		SELECT
			quantity * COALESCE(current_price, 0) AS value,
			COALESCE(price_currency, cost_currency, 'ZAR') AS currency
		FROM holdings
		WHERE organization_id = $1
		  AND is_archived = FALSE
		  AND current_price IS NOT NULL
	`
	return s.queryValueRows(ctx, q, orgID)
}

// latestLiabilityBalances fetches the most recent balance per liability.
func (s *Store) latestLiabilityBalances(ctx context.Context, orgID uuid.UUID) ([]valueRow, error) {
	const q = `
		SELECT DISTINCT ON (lb.liability_id)
			lb.balance, lb.currency
		FROM liability_balances lb
		JOIN liabilities l ON l.id = lb.liability_id
		WHERE lb.organization_id = $1
		  AND l.is_archived = FALSE
		ORDER BY lb.liability_id, lb.as_of DESC
	`
	return s.queryValueRows(ctx, q, orgID)
}

func (s *Store) queryValueRows(ctx context.Context, q string, orgID uuid.UUID) ([]valueRow, error) {
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("finance: value rows query: %w", err)
	}
	defer rows.Close()

	var out []valueRow
	for rows.Next() {
		var r valueRow
		if err := rows.Scan(&r.value, &r.currency); err != nil {
			return nil, fmt.Errorf("finance: value rows scan: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// latestFXRates returns a map of quote_currency → rate (i.e., 1 baseCurrency = rate quoteCurrency).
// This is the most-recent rate per pair where base = baseCurrency.
func (s *Store) latestFXRates(ctx context.Context, baseCurrency string) (map[string]float64, error) {
	const q = `
		SELECT DISTINCT ON (quote)
			quote, rate
		FROM fx_rates
		WHERE base = $1
		ORDER BY quote, as_of DESC
	`
	rows, err := s.db.QueryContext(ctx, q, baseCurrency)
	if err != nil {
		return nil, fmt.Errorf("finance: fx rates query: %w", err)
	}
	defer rows.Close()

	out := make(map[string]float64)
	for rows.Next() {
		var quote string
		var rate float64
		if err := rows.Scan(&quote, &rate); err != nil {
			return nil, fmt.Errorf("finance: fx rates scan: %w", err)
		}
		out[quote] = rate
	}
	return out, rows.Err()
}

// NetWorthTimeSeries returns the net-worth trend by computing the net worth
// at each distinct asset-valuation date within the range [from, to].
func (s *Store) NetWorthTimeSeries(ctx context.Context, orgID uuid.UUID, baseCurrency string, from, to time.Time) ([]NetWorthPoint, error) {
	// Collect distinct as_of dates from asset_valuations and liability_balances.
	const datesQ = `
		SELECT DISTINCT as_of
		FROM (
			SELECT av.as_of FROM asset_valuations av WHERE av.organization_id = $1
			UNION
			SELECT lb.as_of FROM liability_balances lb WHERE lb.organization_id = $1
		) d
		WHERE as_of >= $2 AND as_of <= $3
		ORDER BY as_of ASC
	`
	rows, err := s.db.QueryContext(ctx, datesQ, orgID, from, to)
	if err != nil {
		return nil, fmt.Errorf("finance: net worth dates: %w", err)
	}
	var dates []time.Time
	for rows.Next() {
		var d time.Time
		if err := rows.Scan(&d); err != nil {
			rows.Close()
			return nil, fmt.Errorf("finance: net worth date scan: %w", err)
		}
		dates = append(dates, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	fxRates, err := s.latestFXRates(ctx, baseCurrency)
	if err != nil {
		return nil, err
	}
	convert := func(amount float64, currency string) float64 {
		if currency == baseCurrency || currency == "" {
			return amount
		}
		if rate, ok := fxRates[currency]; ok && rate > 0 {
			return amount / rate
		}
		return amount
	}

	out := make([]NetWorthPoint, 0, len(dates))
	for _, asOf := range dates {
		assetTotal, liabTotal, err := s.netWorthAtDate(ctx, orgID, asOf, convert)
		if err != nil {
			return nil, err
		}
		// Holdings at a given historical date: use current price (best-effort, no price history).
		holdings, err := s.holdingsValue(ctx, orgID)
		if err != nil {
			return nil, err
		}
		var holdTotal float64
		for _, h := range holdings {
			holdTotal += convert(h.value, h.currency)
		}
		out = append(out, NetWorthPoint{
			AsOf:     asOf,
			NetWorth: assetTotal + holdTotal - liabTotal,
		})
	}
	return out, nil
}

// netWorthAtDate fetches the most-recent-before-or-on asOf asset valuations and
// liability balances, summing them up.
func (s *Store) netWorthAtDate(ctx context.Context, orgID uuid.UUID, asOf time.Time, convert func(float64, string) float64) (assetTotal, liabTotal float64, err error) {
	const assetsQ = `
		SELECT DISTINCT ON (av.asset_id)
			av.value, av.currency
		FROM asset_valuations av
		JOIN assets a ON a.id = av.asset_id
		WHERE av.organization_id = $1
		  AND av.as_of           <= $2
		  AND a.is_archived       = FALSE
		ORDER BY av.asset_id, av.as_of DESC
	`
	rows, err := s.db.QueryContext(ctx, assetsQ, orgID, asOf)
	if err != nil {
		return 0, 0, fmt.Errorf("finance: assets at date: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var v float64
		var cur string
		if scanErr := rows.Scan(&v, &cur); scanErr != nil {
			return 0, 0, fmt.Errorf("finance: assets at date scan: %w", scanErr)
		}
		assetTotal += convert(v, cur)
	}
	if rowErr := rows.Err(); rowErr != nil {
		return 0, 0, rowErr
	}

	const liabsQ = `
		SELECT DISTINCT ON (lb.liability_id)
			lb.balance, lb.currency
		FROM liability_balances lb
		JOIN liabilities l ON l.id = lb.liability_id
		WHERE lb.organization_id = $1
		  AND lb.as_of           <= $2
		  AND l.is_archived       = FALSE
		ORDER BY lb.liability_id, lb.as_of DESC
	`
	lr, err := s.db.QueryContext(ctx, liabsQ, orgID, asOf)
	if err != nil {
		return 0, 0, fmt.Errorf("finance: liabs at date: %w", err)
	}
	defer lr.Close()
	for lr.Next() {
		var v float64
		var cur string
		if scanErr := lr.Scan(&v, &cur); scanErr != nil {
			return 0, 0, fmt.Errorf("finance: liabs at date scan: %w", scanErr)
		}
		liabTotal += convert(v, cur)
	}
	return assetTotal, liabTotal, lr.Err()
}
