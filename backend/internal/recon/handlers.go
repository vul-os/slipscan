package recon

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes the P3-02 reconciliation HTTP endpoints.
//
// Wire in cmd/server/main.go:
//
//	// P3-02
//	reconH := recon.NewHandler(recon.NewStore(pool, recon.DefaultConfig()))
//	mux.Handle("POST /orgs/{orgID}/reconcile",             authedMember(reconH.Run))
//	mux.Handle("GET  /orgs/{orgID}/reconcile",             authedMember(reconH.Buckets))
//	mux.Handle("POST /orgs/{orgID}/reconcile/{matchID}/confirm", authedMember(reconH.Confirm))
//	mux.Handle("POST /orgs/{orgID}/reconcile/{matchID}/reject",  authedMember(reconH.Reject))
type Handler struct {
	store *Store
}

// NewHandler creates a Handler backed by the given Store.
func NewHandler(store *Store) *Handler {
	return &Handler{store: store}
}

// Run triggers the matcher for an org and returns a summary.
//
//	POST /orgs/{orgID}/reconcile
func (h *Handler) Run(w http.ResponseWriter, r *http.Request) {
	orgID, ok := uuidFromPath(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	result, err := h.store.RunMatcher(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "matcher_error", "reconciliation run failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, result)
}

// Buckets returns the three-bucket reconciliation view for an org.
//
//	GET /orgs/{orgID}/reconcile
func (h *Handler) GetBuckets(w http.ResponseWriter, r *http.Request) {
	orgID, ok := uuidFromPath(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	matched, err := h.matchedList(r, orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_error", "failed to fetch matched")
		return
	}
	suggested, err := h.store.ListByState(r.Context(), orgID, StateSuggested)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_error", "failed to fetch suggested")
		return
	}

	txIDs, err := h.store.ListUnmatchedTxIDs(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_error", "failed to fetch unmatched transactions")
		return
	}
	lineIDs, err := h.store.ListUnmatchedLineIDs(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_error", "failed to fetch unmatched lines")
		return
	}

	// Ensure nil slices are returned as empty JSON arrays.
	if matched == nil {
		matched = []MatchRecord{}
	}
	if suggested == nil {
		suggested = []MatchRecord{}
	}
	if txIDs == nil {
		txIDs = []uuid.UUID{}
	}
	if lineIDs == nil {
		lineIDs = []uuid.UUID{}
	}

	httpx.WriteJSON(w, http.StatusOK, Buckets{
		Matched:   matched,
		Suggested: suggested,
		Unmatched: &Unmatched{
			TransactionIDs:   txIDs,
			StatementLineIDs: lineIDs,
		},
	})
}

// matchedList returns auto + confirmed matches combined.
func (h *Handler) matchedList(r *http.Request, orgID uuid.UUID) ([]MatchRecord, error) {
	auto, err := h.store.ListByState(r.Context(), orgID, StateAuto)
	if err != nil {
		return nil, err
	}
	confirmed, err := h.store.ListByState(r.Context(), orgID, StateConfirmed)
	if err != nil {
		return nil, err
	}
	return append(auto, confirmed...), nil
}

// Confirm transitions a suggested/auto match to confirmed.
//
//	POST /orgs/{orgID}/reconcile/{matchID}/confirm
func (h *Handler) Confirm(w http.ResponseWriter, r *http.Request) {
	orgID, matchID, userID, ok := h.parseMatchRoute(w, r)
	if !ok {
		return
	}

	m, err := h.store.Confirm(r.Context(), orgID, matchID, userID)
	if err != nil {
		h.writeActionError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, m)
}

// Reject transitions a match to rejected.
//
//	POST /orgs/{orgID}/reconcile/{matchID}/reject
func (h *Handler) Reject(w http.ResponseWriter, r *http.Request) {
	orgID, matchID, userID, ok := h.parseMatchRoute(w, r)
	if !ok {
		return
	}

	m, err := h.store.Reject(r.Context(), orgID, matchID, userID)
	if err != nil {
		h.writeActionError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, m)
}

// parseMatchRoute parses orgID, matchID, and userID from the request.
func (h *Handler) parseMatchRoute(w http.ResponseWriter, r *http.Request) (
	orgID, matchID, userID uuid.UUID, ok bool,
) {
	orgID, ok = uuidFromPath(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	matchID, ok = uuidFromPath(r, "matchID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_match_id", "invalid match id")
		return
	}
	userID, ok = identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}
	return
}

func (h *Handler) writeActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "match not found")
	case errors.Is(err, ErrAlreadyActioned):
		httpx.WriteError(w, http.StatusConflict, "already_actioned", "match is already confirmed or rejected")
	case errors.Is(err, ErrDoubleMatch):
		httpx.WriteError(w, http.StatusConflict, "double_match", "transaction or line already has an active match")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal_error", "action failed")
	}
}

// uuidFromPath parses a named path parameter as a UUID.
func uuidFromPath(r *http.Request, param string) (uuid.UUID, bool) {
	raw := r.PathValue(param)
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
