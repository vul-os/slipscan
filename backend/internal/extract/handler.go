package extract

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// Handler exposes the extraction pipeline over HTTP.
type Handler struct {
	svc *Service
}

// NewHandler constructs an extraction Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// TriggerExtract handles POST /orgs/{orgID}/documents/{docID}/extract.
// It (re-)runs the extraction pipeline for the given document. Idempotent:
// calling it again adds a new extraction row and flips is_current.
//
// P1-01 route — authedMember pattern (see PHASE1-CONTRACT.md §3).
func (h *Handler) TriggerExtract(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	docID, err := uuid.Parse(r.PathValue("docID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_doc_id", "invalid document id")
		return
	}

	if err := h.svc.Run(r.Context(), docID, orgID); err != nil {
		if errors.Is(err, errDocNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "document not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "extraction_failed", err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusAccepted, map[string]string{"status": "extraction queued"})
}

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// errDocNotFound is returned when the document doesn't exist or doesn't
// belong to the org.
var errDocNotFound = errors.New("document not found")
