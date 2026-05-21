package reporting

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// Handler exposes the P2-04 report endpoints:
//
//	GET /orgs/{orgID}/reports/{name}?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
type Handler struct {
	store *Store
	db    *sql.DB
}

// NewHandler returns a Handler backed by store and db.
func NewHandler(db *sql.DB) *Handler {
	return &Handler{store: NewStore(db), db: db}
}

// Get dispatches to the appropriate report builder based on {name}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	orgID, ok := parseUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	reportName := r.PathValue("name")

	// Parse the period.
	from, to, err := parsePeriod(r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_period", err.Error())
		return
	}

	// Look up org kind.
	orgKind, err := OrgKind(r.Context(), h.db, orgID)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "org_not_found", "organization not found")
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "lookup_failed", "could not look up organization")
		return
	}

	// Gate the report by org kind.
	if err := ValidateReport(reportName, orgKind); err != nil {
		if errors.Is(err, ErrWrongOrgKind) {
			httpx.WriteError(w, http.StatusForbidden, "wrong_org_kind", err.Error())
			return
		}
		if errors.Is(err, ErrUnknownReport) {
			httpx.WriteError(w, http.StatusNotFound, "unknown_report", err.Error())
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "invalid_report", err.Error())
		return
	}

	wantCSV := strings.EqualFold(r.URL.Query().Get("format"), "csv") ||
		strings.Contains(r.Header.Get("Accept"), "text/csv")

	p := Period{From: from, To: to}

	switch reportName {
	case "profit-and-loss":
		h.servePL(w, r, orgID, p, wantCSV)
	case "balance-sheet":
		h.serveBS(w, r, orgID, p, wantCSV)
	case "vat-summary":
		h.serveVAT(w, r, orgID, p, wantCSV)
	case "cash-flow":
		h.serveCashFlow(w, r, orgID, p, wantCSV)
	case "spending-trend":
		h.serveSpendingTrend(w, r, orgID, p, wantCSV)
	case "net-worth":
		h.serveNetWorth(w, r, orgID, p, wantCSV)
	default:
		// Should not reach here — ValidateReport already rejected unknowns.
		httpx.WriteError(w, http.StatusNotFound, "unknown_report", "unknown report")
	}
}

// ─── Business reports ──────────────────────────────────────────────────────

func (h *Handler) servePL(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	lines, err := h.store.FetchPLLines(r.Context(), orgID, p.From, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query P&L data")
		return
	}
	report := BuildPL(p, lines)
	serveReport(w, report, "profit-and-loss", wantCSV)
}

func (h *Handler) serveBS(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	lines, err := h.store.FetchBSLines(r.Context(), orgID, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query balance-sheet data")
		return
	}
	report := BuildBalanceSheet(p.To, lines)
	serveReport(w, report, "balance-sheet", wantCSV)
}

func (h *Handler) serveVAT(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	lines, err := h.store.FetchVATLines(r.Context(), orgID, p.From, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query VAT data")
		return
	}
	report := BuildVAT(p, lines)
	serveReport(w, report, "vat-summary", wantCSV)
}

// ─── Personal reports ──────────────────────────────────────────────────────

func (h *Handler) serveCashFlow(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	rows, err := h.store.FetchCashFlowRows(r.Context(), orgID, p.From, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query cash-flow data")
		return
	}
	report := BuildCashFlow(p, rows)
	serveReport(w, report, "cash-flow", wantCSV)
}

func (h *Handler) serveSpendingTrend(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	rows, err := h.store.FetchSpendingTrendRows(r.Context(), orgID, p.From, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query spending-trend data")
		return
	}
	report := BuildSpendingTrend(p, rows)
	serveReport(w, report, "spending-trend", wantCSV)
}

func (h *Handler) serveNetWorth(w http.ResponseWriter, r *http.Request, orgID uuid.UUID, p Period, wantCSV bool) {
	rows, err := h.store.FetchNetWorthSeries(r.Context(), orgID, p.From, p.To)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", "could not query net-worth data")
		return
	}
	report := BuildNetWorth(p, rows)
	serveReport(w, report, "net-worth", wantCSV)
}

// ─── Response helpers ──────────────────────────────────────────────────────

func serveReport(w http.ResponseWriter, report any, name string, wantCSV bool) {
	if wantCSV {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
		w.WriteHeader(http.StatusOK)
		_ = WriteCSV(w, report)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"report": name, "data": report})
}

// ─── Parsing helpers ──────────────────────────────────────────────────────

func parsePeriod(r *http.Request) (from, to time.Time, err error) {
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")

	if fromStr == "" || toStr == "" {
		return time.Time{}, time.Time{}, errors.New("from and to query parameters are required (YYYY-MM-DD)")
	}

	from, err = time.Parse("2006-01-02", fromStr)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("from must be YYYY-MM-DD")
	}
	to, err = time.Parse("2006-01-02", toStr)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("to must be YYYY-MM-DD")
	}
	if to.Before(from) {
		return time.Time{}, time.Time{}, errors.New("to must not be before from")
	}
	return from, to, nil
}

func parseUUID(r *http.Request, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(param))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
