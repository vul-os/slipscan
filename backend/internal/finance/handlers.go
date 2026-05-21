package finance

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// Handler exposes all P2-02 HTTP endpoints.
type Handler struct {
	store *Store
}

// NewHandler constructs a Handler backed by store.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// ─── helpers ──────────────────────────────────────────────────────────────────

func pathUUID(r *http.Request, param string) (uuid.UUID, bool) {
	raw := r.PathValue(param)
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// parseDate parses YYYY-MM-DD; returns zero time on empty or error.
func parseDate(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", s)
	return t, err == nil
}

// ─── Spending ─────────────────────────────────────────────────────────────────

// GetSpending handles:
//
//	GET /orgs/{orgID}/spending?from=YYYY-MM-DD&to=YYYY-MM-DD&direction=debit|credit
//
// Returns category totals + percentage share for the period.
func (h *Handler) GetSpending(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	q := r.URL.Query()
	from, ok := parseDate(q.Get("from"))
	if !ok {
		// Default: start of current month.
		now := time.Now()
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	to, ok := parseDate(q.Get("to"))
	if !ok {
		to = time.Now().UTC()
	}
	direction := q.Get("direction")
	if direction == "" {
		direction = "debit"
	}

	totals, err := h.store.SpendingBreakdown(r.Context(), orgID, from, to, direction)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "spending_error", "could not compute spending breakdown")
		return
	}

	type catOut struct {
		CategoryID   string  `json:"category_id,omitempty"`
		CategoryName string  `json:"category_name"`
		Kind         string  `json:"kind"`
		TotalAmount  float64 `json:"total_amount"`
		SharePercent float64 `json:"share_percent"`
		TxCount      int     `json:"tx_count"`
	}
	out := make([]catOut, 0, len(totals))
	for _, ct := range totals {
		c := catOut{
			CategoryName: ct.CategoryName,
			Kind:         ct.Kind,
			TotalAmount:  ct.TotalAmount,
			SharePercent: roundTwo(ct.SharePercent),
			TxCount:      ct.TxCount,
		}
		if ct.CategoryID != uuid.Nil {
			c.CategoryID = ct.CategoryID.String()
		}
		out = append(out, c)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"from":       from.Format("2006-01-02"),
		"to":         to.Format("2006-01-02"),
		"direction":  direction,
		"categories": out,
	})
}

// GetSpendingDrilldown handles:
//
//	GET /orgs/{orgID}/spending/{categoryID}?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Drill-down: returns the individual transactions for the category.
// Use "uncategorized" as categoryID for transactions with no category.
func (h *Handler) GetSpendingDrilldown(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	rawCat := r.PathValue("categoryID")
	var categoryID uuid.UUID
	if rawCat != "uncategorized" {
		var err error
		categoryID, err = uuid.Parse(rawCat)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_category_id", "invalid category id")
			return
		}
	}

	q := r.URL.Query()
	from, ok := parseDate(q.Get("from"))
	if !ok {
		now := time.Now()
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	to, ok := parseDate(q.Get("to"))
	if !ok {
		to = time.Now().UTC()
	}

	limit := 50
	offset := 0

	txns, err := h.store.TransactionsByCategory(r.Context(), orgID, categoryID, from, to, limit, offset)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "drill_error", "could not fetch transactions")
		return
	}

	type txOut struct {
		ID           string  `json:"id"`
		PostedDate   string  `json:"posted_date,omitempty"`
		Merchant     string  `json:"merchant,omitempty"`
		Description  string  `json:"description,omitempty"`
		Amount       float64 `json:"amount,omitempty"`
		Currency     string  `json:"currency,omitempty"`
		Direction    string  `json:"direction"`
		CategoryName string  `json:"category_name,omitempty"`
	}
	out := make([]txOut, 0, len(txns))
	for _, t := range txns {
		o := txOut{
			ID:        t.ID.String(),
			Direction: t.Direction,
		}
		if t.PostedDate.Valid {
			o.PostedDate = t.PostedDate.Time.Format("2006-01-02")
		}
		if t.Merchant.Valid {
			o.Merchant = t.Merchant.String
		}
		if t.Description.Valid {
			o.Description = t.Description.String
		}
		if t.Amount.Valid {
			o.Amount = t.Amount.Float64
		}
		if t.Currency.Valid {
			o.Currency = t.Currency.String
		}
		if t.CategoryName.Valid {
			o.CategoryName = t.CategoryName.String
		}
		out = append(out, o)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"category_id":  rawCat,
		"transactions": out,
	})
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

// CreateBudget handles: POST /orgs/{orgID}/budgets
func (h *Handler) CreateBudget(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	type lineReq struct {
		CategoryID *string `json:"category_id"`
		Amount     float64 `json:"amount"`
		Rollover   bool    `json:"rollover"`
	}
	var req struct {
		Name      string    `json:"name"`
		Period    string    `json:"period"`
		StartDate string    `json:"start_date"`
		EndDate   string    `json:"end_date,omitempty"`
		Currency  string    `json:"currency"`
		Lines     []lineReq `json:"lines"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	start, ok := parseDate(req.StartDate)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_start_date", "start_date must be YYYY-MM-DD")
		return
	}
	var endPtr *time.Time
	if req.EndDate != "" {
		end, ok := parseDate(req.EndDate)
		if !ok {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_end_date", "end_date must be YYYY-MM-DD")
			return
		}
		endPtr = &end
	}

	lines := make([]BudgetLineInput, 0, len(req.Lines))
	for _, l := range req.Lines {
		bl := BudgetLineInput{Amount: l.Amount, Rollover: l.Rollover}
		if l.CategoryID != nil {
			id, err := uuid.Parse(*l.CategoryID)
			if err != nil {
				httpx.WriteError(w, http.StatusBadRequest, "invalid_category_id", "category_id must be a valid UUID")
				return
			}
			bl.CategoryID = &id
		}
		lines = append(lines, bl)
	}

	bwl, err := h.store.CreateBudget(r.Context(), orgID, CreateBudgetInput{
		Name:      req.Name,
		Period:    req.Period,
		StartDate: start,
		EndDate:   endPtr,
		Currency:  req.Currency,
	}, lines)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "create_budget_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, budgetResponse(bwl))
}

// ListBudgets handles: GET /orgs/{orgID}/budgets?active=true
func (h *Handler) ListBudgets(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	activeOnly := r.URL.Query().Get("active") == "true"
	budgets, err := h.store.ListBudgets(r.Context(), orgID, activeOnly)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_budgets_failed", "could not list budgets")
		return
	}
	out := make([]any, 0, len(budgets))
	for _, b := range budgets {
		out = append(out, singleBudgetResponse(&b))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"budgets": out})
}

// GetBudgetProgress handles: GET /orgs/{orgID}/budgets/{budgetID}/progress?from=YYYY-MM-DD&to=YYYY-MM-DD
func (h *Handler) GetBudgetProgress(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	budgetID, ok := pathUUID(r, "budgetID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_budget_id", "invalid budget id")
		return
	}

	q := r.URL.Query()
	from, ok := parseDate(q.Get("from"))
	if !ok {
		now := time.Now()
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	to, ok := parseDate(q.Get("to"))
	if !ok {
		to = time.Now().UTC()
	}

	bwl, err := h.store.BudgetProgress(r.Context(), orgID, budgetID, from, to)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "budget not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "progress_failed", "could not compute budget progress")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, budgetResponse(bwl))
}

// DeleteBudget handles: DELETE /orgs/{orgID}/budgets/{budgetID}
func (h *Handler) DeleteBudget(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	budgetID, ok := pathUUID(r, "budgetID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_budget_id", "invalid budget id")
		return
	}

	if err := h.store.DeleteBudget(r.Context(), orgID, budgetID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "budget not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "delete_failed", "could not delete budget")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Goals ────────────────────────────────────────────────────────────────────

// CreateGoal handles: POST /orgs/{orgID}/goals
func (h *Handler) CreateGoal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	var req struct {
		Name          string  `json:"name"`
		Kind          string  `json:"kind"`
		TargetAmount  float64 `json:"target_amount"`
		CurrentAmount float64 `json:"current_amount"`
		TargetDate    string  `json:"target_date,omitempty"`
		Currency      string  `json:"currency"`
		AccountID     string  `json:"account_id,omitempty"`
		CategoryID    string  `json:"category_id,omitempty"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	input := CreateGoalInput{
		Name:          req.Name,
		Kind:          req.Kind,
		TargetAmount:  req.TargetAmount,
		CurrentAmount: req.CurrentAmount,
		Currency:      req.Currency,
	}
	if req.TargetDate != "" {
		td, ok := parseDate(req.TargetDate)
		if !ok {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_target_date", "target_date must be YYYY-MM-DD")
			return
		}
		input.TargetDate = &td
	}
	if req.AccountID != "" {
		id, err := uuid.Parse(req.AccountID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "account_id must be a valid UUID")
			return
		}
		input.AccountID = &id
	}
	if req.CategoryID != "" {
		id, err := uuid.Parse(req.CategoryID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_category_id", "category_id must be a valid UUID")
			return
		}
		input.CategoryID = &id
	}

	g, err := h.store.CreateGoal(r.Context(), orgID, input)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "create_goal_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, goalResponse(g))
}

// ListGoals handles: GET /orgs/{orgID}/goals?status=active
func (h *Handler) ListGoals(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	statusFilter := r.URL.Query().Get("status")
	goals, err := h.store.ListGoals(r.Context(), orgID, statusFilter)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_goals_failed", "could not list goals")
		return
	}
	out := make([]any, 0, len(goals))
	for i := range goals {
		out = append(out, goalResponse(&goals[i]))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"goals": out})
}

// GetGoal handles: GET /orgs/{orgID}/goals/{goalID}
func (h *Handler) GetGoal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	goalID, ok := pathUUID(r, "goalID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_goal_id", "invalid goal id")
		return
	}
	g, err := h.store.GetGoal(r.Context(), orgID, goalID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "goal not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "get_goal_failed", "could not fetch goal")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, goalResponse(g))
}

// PatchGoal handles: PATCH /orgs/{orgID}/goals/{goalID}
func (h *Handler) PatchGoal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	goalID, ok := pathUUID(r, "goalID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_goal_id", "invalid goal id")
		return
	}

	var req struct {
		CurrentAmount float64 `json:"current_amount"`
		Status        string  `json:"status,omitempty"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	g, err := h.store.UpdateGoalAmount(r.Context(), orgID, goalID, req.CurrentAmount, req.Status)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "goal not found")
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "patch_goal_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, goalResponse(g))
}

// DeleteGoal handles: DELETE /orgs/{orgID}/goals/{goalID}
func (h *Handler) DeleteGoal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	goalID, ok := pathUUID(r, "goalID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_goal_id", "invalid goal id")
		return
	}
	if err := h.store.DeleteGoal(r.Context(), orgID, goalID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "goal not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "delete_failed", "could not delete goal")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Net worth ────────────────────────────────────────────────────────────────

// GetNetWorth handles: GET /orgs/{orgID}/net-worth
// Returns the current headline net-worth in the org's currency.
// The org's currency is passed as a query param ?currency=ZAR or falls back to ZAR.
func (h *Handler) GetNetWorth(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	currency := r.URL.Query().Get("currency")
	if currency == "" {
		currency = "ZAR"
	}

	snap, err := h.store.NetWorthNow(r.Context(), orgID, currency)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "net_worth_error", "could not compute net worth")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"as_of":          snap.AsOf.Format("2006-01-02"),
		"base_currency":  snap.BaseCurrency,
		"total_assets":   snap.TotalAssets,
		"total_holdings": snap.TotalHoldings,
		"total_liabs":    snap.TotalLiabs,
		"net_worth":      snap.NetWorth,
	})
}

// GetNetWorthTimeSeries handles:
//
//	GET /orgs/{orgID}/net-worth/history?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=ZAR
func (h *Handler) GetNetWorthTimeSeries(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	q := r.URL.Query()
	currency := q.Get("currency")
	if currency == "" {
		currency = "ZAR"
	}
	from, ok := parseDate(q.Get("from"))
	if !ok {
		from = time.Now().AddDate(-1, 0, 0).UTC() // default 1 year back
	}
	to, ok := parseDate(q.Get("to"))
	if !ok {
		to = time.Now().UTC()
	}

	points, err := h.store.NetWorthTimeSeries(r.Context(), orgID, currency, from, to)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "time_series_error", "could not compute net worth history")
		return
	}

	type pointOut struct {
		AsOf     string  `json:"as_of"`
		NetWorth float64 `json:"net_worth"`
	}
	out := make([]pointOut, 0, len(points))
	for _, p := range points {
		out = append(out, pointOut{
			AsOf:     p.AsOf.Format("2006-01-02"),
			NetWorth: roundTwo(p.NetWorth),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"currency": currency,
		"points":   out,
	})
}

// ─── response helpers ─────────────────────────────────────────────────────────

type budgetLineOut struct {
	ID         string  `json:"id"`
	CategoryID string  `json:"category_id,omitempty"`
	Amount     float64 `json:"amount"`
	Rollover   bool    `json:"rollover"`
	Actual     float64 `json:"actual"`
	Remaining  float64 `json:"remaining"`
}

type budgetOut struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Period    string          `json:"period"`
	StartDate string          `json:"start_date"`
	EndDate   string          `json:"end_date,omitempty"`
	Currency  string          `json:"currency"`
	IsActive  bool            `json:"is_active"`
	Lines     []budgetLineOut `json:"lines"`
}

func budgetResponse(bwl *BudgetWithLines) budgetOut {
	out := singleBudgetResponse(&bwl.Budget)
	out.Lines = make([]budgetLineOut, 0, len(bwl.Lines))
	for _, l := range bwl.Lines {
		lo := budgetLineOut{
			ID:        l.ID.String(),
			Amount:    l.Amount,
			Rollover:  l.Rollover,
			Actual:    l.Actual,
			Remaining: l.Remaining,
		}
		if l.CategoryID.Valid {
			lo.CategoryID = l.CategoryID.UUID.String()
		}
		out.Lines = append(out.Lines, lo)
	}
	return out
}

func singleBudgetResponse(b *Budget) budgetOut {
	out := budgetOut{
		ID:        b.ID.String(),
		Name:      b.Name,
		Period:    b.Period,
		StartDate: b.StartDate.Format("2006-01-02"),
		Currency:  b.Currency,
		IsActive:  b.IsActive,
	}
	if b.EndDate.Valid {
		out.EndDate = b.EndDate.Time.Format("2006-01-02")
	}
	return out
}

type goalOut struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Kind          string  `json:"kind"`
	TargetAmount  float64 `json:"target_amount"`
	CurrentAmount float64 `json:"current_amount"`
	ProgressPct   float64 `json:"progress_pct"`
	TargetDate    string  `json:"target_date,omitempty"`
	Currency      string  `json:"currency"`
	Status        string  `json:"status"`
	AccountID     string  `json:"account_id,omitempty"`
	CategoryID    string  `json:"category_id,omitempty"`
}

func goalResponse(g *Goal) goalOut {
	out := goalOut{
		ID:            g.ID.String(),
		Name:          g.Name,
		Kind:          g.Kind,
		TargetAmount:  g.TargetAmount,
		CurrentAmount: g.CurrentAmount,
		ProgressPct:   roundTwo(g.ProgressPct),
		Currency:      g.Currency,
		Status:        g.Status,
	}
	if g.TargetDate.Valid {
		out.TargetDate = g.TargetDate.Time.Format("2006-01-02")
	}
	if g.AccountID.Valid {
		out.AccountID = g.AccountID.UUID.String()
	}
	if g.CategoryID.Valid {
		out.CategoryID = g.CategoryID.UUID.String()
	}
	return out
}

// roundTwo rounds a float64 to 2 decimal places.
func roundTwo(f float64) float64 {
	// Simple integer-truncation rounding to 2dp without importing math.
	shifted := f * 100
	if shifted < 0 {
		shifted -= 0.5
	} else {
		shifted += 0.5
	}
	return float64(int64(shifted)) / 100
}
