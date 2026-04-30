package insights

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const (
	defaultListLimit = 25
	maxListLimit     = 200
	maxGroupRows     = 12
)

// Document is the slim shape Run returns for "list" intent. We don't
// reuse the document package's type to avoid an import cycle and to keep
// the response payload tight (no raw_extraction blob).
type Document struct {
	ID              string   `json:"id"`
	Merchant        string   `json:"merchant,omitempty"`
	Amount          *float64 `json:"amount,omitempty"`
	Currency        string   `json:"currency,omitempty"`
	TransactionDate string   `json:"transaction_date,omitempty"`
	Category        string   `json:"category,omitempty"`
	Status          string   `json:"status"`
	CreatedAt       string   `json:"created_at"`
}

// Group is one row of an aggregated breakdown.
type Group struct {
	Key   string  `json:"key"`
	Total float64 `json:"total"`
	Count int     `json:"count"`
}

// Totals is what we return for sum/count intents. Amount is a pointer so
// the count intent's response doesn't carry a misleading "amount: 0".
type Totals struct {
	Amount   *float64 `json:"amount,omitempty"`
	Count    int      `json:"count"`
	Currency string   `json:"currency,omitempty"`
}

// Result is the union answer for any intent. Frontend picks fields based
// on `Intent`.
type Result struct {
	Intent    Intent     `json:"intent"`
	Filters   Filters    `json:"filters"`
	Summary   string     `json:"summary"`
	Documents []Document `json:"documents,omitempty"`
	Groups    []Group    `json:"groups,omitempty"`
	Totals    *Totals    `json:"totals,omitempty"`
}

// Run executes the structured query against the transactions table for a
// single organization. All filters become positional SQL parameters; the
// model can never inject SQL.
func Run(ctx context.Context, db *sql.DB, orgID uuid.UUID, q *Query) (*Result, error) {
	res := &Result{Intent: q.Intent, Filters: q.Filters}

	where, args := buildWhere(orgID, q.Filters)

	switch q.Intent {
	case IntentList:
		docs, err := runList(ctx, db, where, args, q.Limit)
		if err != nil {
			return nil, err
		}
		res.Documents = docs
		res.Summary = summarizeList(q.Filters, len(docs))
	case IntentSum:
		t, err := runSum(ctx, db, where, args)
		if err != nil {
			return nil, err
		}
		res.Totals = t
		res.Summary = summarizeSum(q.Filters, t)
	case IntentCount:
		count, err := runCount(ctx, db, where, args)
		if err != nil {
			return nil, err
		}
		res.Totals = &Totals{Count: count}
		res.Summary = summarizeCount(q.Filters, count)
	case IntentTopMerchants:
		groups, err := runGroup(ctx, db, "merchant", where, args)
		if err != nil {
			return nil, err
		}
		res.Groups = groups
		res.Summary = summarizeGroups("merchant", q.Filters, groups)
	case IntentByCategory:
		groups, err := runGroup(ctx, db, "category", where, args)
		if err != nil {
			return nil, err
		}
		res.Groups = groups
		res.Summary = summarizeGroups("category", q.Filters, groups)
	case IntentByMonth:
		groups, err := runByMonth(ctx, db, where, args)
		if err != nil {
			return nil, err
		}
		res.Groups = groups
		res.Summary = summarizeGroups("month", q.Filters, groups)
	default:
		return nil, fmt.Errorf("unsupported intent %q", q.Intent)
	}
	return res, nil
}

// buildWhere assembles the WHERE clause and the positional args. The org
// scope is always the first arg, so a missing-filter bug can't leak data
// across orgs.
func buildWhere(orgID uuid.UUID, f Filters) (string, []any) {
	args := []any{orgID}
	conds := []string{"organization_id = $1"}
	add := func(cond string, val any) {
		args = append(args, val)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if s := strings.TrimSpace(f.MerchantContains); s != "" {
		// ILIKE for case-insensitive substring match. Escape the user's
		// LIKE wildcards so they're matched literally — the model could
		// otherwise turn "%" into a free-text glob.
		add("merchant ILIKE '%%' || $%d || '%%'", escapeLike(s))
	}
	if s := strings.TrimSpace(f.Category); s != "" {
		add("category = $%d", strings.ToLower(s))
	}
	if s := strings.TrimSpace(f.DateFrom); s != "" {
		add("transaction_date >= $%d", s)
	}
	if s := strings.TrimSpace(f.DateTo); s != "" {
		add("transaction_date <= $%d", s)
	}
	if f.AmountMin != nil {
		add("amount >= $%d", *f.AmountMin)
	}
	if f.AmountMax != nil {
		add("amount <= $%d", *f.AmountMax)
	}
	if s := strings.TrimSpace(f.Currency); s != "" {
		add("currency = $%d", strings.ToUpper(s))
	}
	if s := strings.TrimSpace(f.Status); s != "" {
		add("status = $%d", s)
	}
	return strings.Join(conds, " AND "), args
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

func runList(ctx context.Context, db *sql.DB, where string, args []any, limit int) ([]Document, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	q := fmt.Sprintf(`
		SELECT id, COALESCE(merchant, ''), amount, COALESCE(currency, ''),
		       transaction_date, COALESCE(category, ''), status::text, created_at
		FROM transactions
		WHERE %s
		ORDER BY transaction_date DESC NULLS LAST, created_at DESC
		LIMIT %d`, where, limit)
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Document, 0, limit)
	for rows.Next() {
		var (
			d      Document
			amt    sql.NullFloat64
			txDate sql.NullTime
			id     uuid.UUID
		)
		var createdAt sql.NullTime
		if err := rows.Scan(&id, &d.Merchant, &amt, &d.Currency, &txDate, &d.Category, &d.Status, &createdAt); err != nil {
			return nil, err
		}
		d.ID = id.String()
		if amt.Valid {
			v := amt.Float64
			d.Amount = &v
		}
		if txDate.Valid {
			d.TransactionDate = txDate.Time.Format("2006-01-02")
		}
		if createdAt.Valid {
			d.CreatedAt = createdAt.Time.Format("2006-01-02T15:04:05Z07:00")
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func runSum(ctx context.Context, db *sql.DB, where string, args []any) (*Totals, error) {
	// Two trips — keeping each query's placeholders ($1..$N) self-contained
	// is simpler than offsetting positions across a duplicated WHERE clause.
	sumQ := fmt.Sprintf(`SELECT COALESCE(SUM(amount), 0)::float8, COUNT(*)::int FROM transactions WHERE %s`, where)
	var (
		t   Totals
		amt float64
	)
	if err := db.QueryRowContext(ctx, sumQ, args...).Scan(&amt, &t.Count); err != nil {
		return nil, err
	}
	t.Amount = &amt
	if t.Count == 0 {
		return &t, nil
	}
	ccyQ := fmt.Sprintf(`
		SELECT currency
		FROM transactions
		WHERE %s AND currency IS NOT NULL
		GROUP BY currency
		ORDER BY COUNT(*) DESC
		LIMIT 1`, where)
	var ccy sql.NullString
	if err := db.QueryRowContext(ctx, ccyQ, args...).Scan(&ccy); err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if ccy.Valid {
		t.Currency = ccy.String
	}
	return &t, nil
}

func runCount(ctx context.Context, db *sql.DB, where string, args []any) (int, error) {
	q := fmt.Sprintf(`SELECT COUNT(*)::int FROM transactions WHERE %s`, where)
	var c int
	if err := db.QueryRowContext(ctx, q, args...).Scan(&c); err != nil {
		return 0, err
	}
	return c, nil
}

func runGroup(ctx context.Context, db *sql.DB, col, where string, args []any) ([]Group, error) {
	// col is a fixed identifier from a switch in Run — never user input.
	q := fmt.Sprintf(`
		SELECT COALESCE(NULLIF(TRIM(%s), ''), '(unknown)') AS key,
		       COALESCE(SUM(amount), 0)::float8 AS total,
		       COUNT(*)::int AS cnt
		FROM transactions
		WHERE %s
		GROUP BY key
		ORDER BY total DESC NULLS LAST
		LIMIT %d`, col, where, maxGroupRows)
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Group, 0, maxGroupRows)
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.Key, &g.Total, &g.Count); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func runByMonth(ctx context.Context, db *sql.DB, where string, args []any) ([]Group, error) {
	q := fmt.Sprintf(`
		SELECT to_char(date_trunc('month', COALESCE(transaction_date, created_at::date)), 'YYYY-MM') AS key,
		       COALESCE(SUM(amount), 0)::float8 AS total,
		       COUNT(*)::int AS cnt
		FROM transactions
		WHERE %s
		GROUP BY key
		ORDER BY key DESC
		LIMIT %d`, where, maxGroupRows)
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Group, 0, maxGroupRows)
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.Key, &g.Total, &g.Count); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
