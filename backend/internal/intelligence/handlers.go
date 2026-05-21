package intelligence

import (
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// Handler exposes the P4-02 intelligence HTTP endpoints.
type Handler struct {
	store *Store
}

// NewHandler constructs a Handler backed by store.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// pathUUID parses a path value as UUID, returning false on failure.
func pathUUID(r *http.Request, param string) (uuid.UUID, bool) {
	raw := r.PathValue(param)
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// GetForecast handles:
//
//	GET /orgs/{orgID}/forecast?horizon=<months>
//
// Projects monthly cash-flow from recurring_transactions + historical averages.
// Response: { horizon, currency, points: [...], assumptions: [...] }
func (h *Handler) GetForecast(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	horizon := 3
	if raw := r.URL.Query().Get("horizon"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 24 {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_horizon", "horizon must be an integer 1–24")
			return
		}
		horizon = n
	}

	ctx := r.Context()

	currency, err := h.store.OrgCurrency(ctx, orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "currency_error", "could not determine org currency")
		return
	}

	history, err := h.store.HistoricalMonthlyTotals(ctx, orgID, 12)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "history_error", "could not fetch transaction history")
		return
	}

	recurring, err := h.store.ListActiveRecurring(ctx, orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "recurring_error", "could not fetch recurring transactions")
		return
	}

	result := ComputeForecast(history, recurring, horizon, currency)
	httpx.WriteJSON(w, http.StatusOK, result)
}

// GetAnomalies handles:
//
//	GET /orgs/{orgID}/anomalies
//
// Returns typed anomaly list: duplicates, unusual spend, missing receipts.
// Response: { anomalies: [{ id, type, severity, title, description, amount?,
// currency?, transaction_id?, detected_at }] }
func (h *Handler) GetAnomalies(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	ctx := r.Context()
	now := time.Now().UTC()

	txs, err := h.store.RecentTransactions(ctx, orgID, 90)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "transactions_error", "could not fetch transactions")
		return
	}

	history, err := h.store.CategorySpendHistory(ctx, orgID, 12)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "history_error", "could not fetch category history")
		return
	}

	reconciledIDs, err := h.store.ReconciledTransactionIDs(ctx, orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "recon_error", "could not fetch reconciliation data")
		return
	}

	var anomalies []Anomaly
	anomalies = append(anomalies, DetectDuplicates(txs, now)...)
	anomalies = append(anomalies, DetectUnusualSpend(txs, history, now)...)
	anomalies = append(anomalies, DetectMissingReceipts(txs, reconciledIDs, now)...)

	if anomalies == nil {
		anomalies = []Anomaly{} // return empty array, not null
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{"anomalies": anomalies})
}

// GetTaxReadiness handles:
//
//	GET /orgs/{orgID}/tax-readiness
//
// Returns a 0–100 readiness score, VAT position, document coverage, and
// unreconciled count.
// Response: { score, vat_position?, documented_expense_pct, unreconciled_count,
// components: [{ label, status, detail }] }
func (h *Handler) GetTaxReadiness(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	data, err := h.store.GetTaxReadinessData(r.Context(), orgID, 365)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "tax_readiness_error", "could not compute tax readiness")
		return
	}

	result := ComputeTaxReadiness(data)
	httpx.WriteJSON(w, http.StatusOK, result)
}
