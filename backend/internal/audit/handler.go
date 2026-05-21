package audit

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// Handler exposes the audit-log HTTP endpoints.
type Handler struct{ store *Store }

// NewHandler returns a Handler backed by store.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// List handles GET /orgs/{orgID}/audit
//
// Query parameters (all optional):
//
//	actor_user_id  – filter by actor UUID
//	entity_type    – filter by entity class (e.g. "transaction")
//	entity_id      – filter by entity UUID
//	action         – filter by exact action string
//	since          – RFC3339 lower bound (exclusive)
//	until          – RFC3339 upper bound (inclusive)
//	limit          – max rows (default 100, max 1000)
//	offset         – pagination offset
//
// Auth: authedAdmin middleware (set in main.go wiring).
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	orgID, ok := uuidParam(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	f := ListFilter{}

	if v := r.URL.Query().Get("actor_user_id"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_actor_user_id", "actor_user_id must be a valid UUID")
			return
		}
		f.ActorUserID = &id
	}
	f.EntityType = r.URL.Query().Get("entity_type")
	if v := r.URL.Query().Get("entity_id"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_entity_id", "entity_id must be a valid UUID")
			return
		}
		f.EntityID = &id
	}
	f.Action = r.URL.Query().Get("action")

	if v := r.URL.Query().Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_since", "since must be RFC3339")
			return
		}
		f.Since = &t
	}
	if v := r.URL.Query().Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_until", "until must be RFC3339")
			return
		}
		f.Until = &t
	}

	f.Limit = queryInt(r, "limit", 100)
	f.Offset = queryInt(r, "offset", 0)

	entries, err := h.store.List(r.Context(), orgID, f)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list audit entries")
		return
	}
	if entries == nil {
		entries = []LogEntry{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"audit_log": entries})
}

// uuidParam parses a path value as a UUID.
func uuidParam(r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// queryInt parses a URL query parameter as an integer, returning def on
// missing / invalid input.
func queryInt(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}
