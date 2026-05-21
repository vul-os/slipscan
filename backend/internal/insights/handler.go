package insights

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/ocr"
)

type Handler struct {
	db *sql.DB
	tr *Translator
}

func NewHandler(db *sql.DB, tr *Translator) *Handler {
	return &Handler{db: db, tr: tr}
}

type askRequest struct {
	Question string `json:"question"`
}

// Ask is the natural-language search endpoint.
//
//	POST /orgs/{orgID}/ask  { "question": "how much did I spend on Uber last month?" }
//
// Returns the parsed Query, a deterministic summary, and the result rows
// the chosen intent produced.
func (h *Handler) Ask(w http.ResponseWriter, r *http.Request) {
	orgID, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	var req askRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	q := strings.TrimSpace(req.Question)
	if q == "" {
		httpx.WriteError(w, http.StatusBadRequest, "empty_question", "question is required")
		return
	}
	if len(q) > 500 {
		httpx.WriteError(w, http.StatusBadRequest, "question_too_long", "question must be under 500 characters")
		return
	}

	parsed, err := h.tr.Translate(r.Context(), q)
	if err != nil {
		if errors.Is(err, ocr.ErrRateLimited) {
			httpx.WriteError(w, http.StatusTooManyRequests, "rate_limited",
				"AI search is busy right now. Try again in a moment.")
			return
		}
		httpx.WriteError(w, http.StatusBadGateway, "translate_failed",
			"Couldn't understand the question — try rephrasing.")
		return
	}

	result, err := Run(r.Context(), h.db, orgID, parsed)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "run_failed", err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, result)
}
