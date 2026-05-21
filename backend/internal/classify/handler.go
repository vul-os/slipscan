package classify

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes the P1-03 HTTP endpoints.
// Wire it up in cmd/server/main.go under the authedMember middleware:
//
//	// P1-03: correction-learning loop
//	classifyH := classify.NewHandler(classify.NewCorrectionsStore(pool, classify.CorrectionsConfig{}))
//	mux.Handle("PATCH /orgs/{orgID}/transactions/{txID}/classification",
//	    authedMember(classifyH.PatchClassification))
type Handler struct {
	store *CorrectionsStore
}

// NewHandler creates a Handler backed by the given store.
func NewHandler(store *CorrectionsStore) *Handler {
	return &Handler{store: store}
}

// patchRequest is the JSON body for PATCH .../classification.
type patchRequest struct {
	CategoryID string `json:"category_id"`
	AccountID  string `json:"account_id,omitempty"`
}

// patchResponse is the JSON body returned on success.
type patchResponse struct {
	CorrectionID     string `json:"correction_id"`
	ClassificationID string `json:"classification_id"`
	RulePromoted     bool   `json:"rule_promoted"`
	RuleID           string `json:"rule_id,omitempty"`
	// Backfill is only present when apply_to_existing=true was requested.
	Backfill *BackfillResult `json:"backfill,omitempty"`
}

// PatchClassification handles:
//
//	PATCH /orgs/{orgID}/transactions/{txID}/classification
//	?apply_to_existing=true
//
// Body:  {"category_id": "<uuid>", "account_id": "<uuid>"}
// Auth:  authedMember (JWT + org membership verified by middleware)
func (h *Handler) PatchClassification(w http.ResponseWriter, r *http.Request) {
	orgID, ok := uuidFromPath(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	txID, ok := uuidFromPath(r, "txID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_tx_id", "invalid transaction id")
		return
	}
	userID, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	var req patchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	catID, err := uuid.Parse(req.CategoryID)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_category_id", "category_id must be a valid UUID")
		return
	}

	input := CorrectionInput{NewCategoryID: catID}
	if req.AccountID != "" {
		aid, err := uuid.Parse(req.AccountID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "account_id must be a valid UUID")
			return
		}
		input.NewAccountID = uuid.NullUUID{UUID: aid, Valid: true}
	}

	result, err := h.store.ApplyCorrection(r.Context(), orgID, txID, userID, input)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httpx.WriteError(w, http.StatusNotFound, "not_found", "transaction not found")
		case errors.Is(err, ErrForbidden):
			httpx.WriteError(w, http.StatusForbidden, "forbidden", err.Error())
		default:
			httpx.WriteError(w, http.StatusInternalServerError, "internal_error", "failed to apply correction")
		}
		return
	}

	resp := patchResponse{
		CorrectionID:     result.CorrectionID.String(),
		ClassificationID: result.ClassificationID.String(),
		RulePromoted:     result.RulePromoted,
	}
	if result.RulePromoted {
		resp.RuleID = result.RuleID.String()
	}

	// Optional backfill: reclassify past non-user transactions for the same merchant.
	if r.URL.Query().Get("apply_to_existing") == "true" {
		merchantNorm, err := h.store.GetTransactionMerchantNorm(r.Context(), orgID, txID)
		if err == nil && merchantNorm != "" {
			bf, err := h.store.ApplyToExisting(r.Context(), orgID, txID, merchantNorm, input, userID)
			if err != nil {
				// Log but don't fail the whole request — correction already succeeded.
				httpx.WriteError(w, http.StatusInternalServerError, "backfill_error",
					"correction recorded but backfill failed")
				return
			}
			resp.Backfill = bf
		}
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
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
