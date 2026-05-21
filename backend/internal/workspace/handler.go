package workspace

import (
	"net/http"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler serves the GET /workspace endpoint.
type Handler struct {
	store *Store
}

// NewHandler constructs a Handler.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// GetWorkspace handles GET /workspace.
// It is user-scoped (authed/JWT only, not authedMember): no org in the path.
// Response: { "orgs": [ { "id", "name", "kind", "role", "attention": { ... } } ] }
func (h *Handler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	uid, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	entries, err := h.store.ForUser(r.Context(), uid)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "workspace_failed", "could not load workspace")
		return
	}

	// Never return a JSON null for the array — callers expect an empty slice.
	if entries == nil {
		entries = []OrgEntry{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"orgs": entries})
}
