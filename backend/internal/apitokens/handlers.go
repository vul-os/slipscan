package apitokens

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes the admin token-management endpoints:
//
//	POST   /orgs/{orgID}/api-tokens        – issue a new token (admin-gated)
//	GET    /orgs/{orgID}/api-tokens        – list active tokens (admin-gated)
//	DELETE /orgs/{orgID}/api-tokens/{tokenID} – revoke a token (admin-gated)
type Handler struct {
	store *Store
}

// NewHandler constructs an API-token management Handler.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// ─── issue ─────────────────────────────────────────────────────────────────

type issueRequest struct {
	Name            string   `json:"name"`
	Kind            string   `json:"kind"` // "live" | "test" | "restricted"
	Scopes          []string `json:"scopes"`
	AllowedIPCIDRs  []string `json:"allowed_ip_cidrs,omitempty"`
	RateLimitPerMin int      `json:"rate_limit_per_minute,omitempty"`
	ExpiresInDays   int      `json:"expires_in_days,omitempty"` // 0 = no expiry
}

type issueResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	Scopes    []string  `json:"scopes"`
	Prefix    string    `json:"prefix"`
	Token     string    `json:"token"` // plaintext — shown exactly once
	CreatedAt time.Time `json:"created_at"`
}

// Issue handles POST /orgs/{orgID}/api-tokens.
// Must be called after authedAdmin middleware — the caller's user id is read
// from the identity context.
func (h *Handler) Issue(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	callerUID, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	var req issueRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing_name", "name is required")
		return
	}
	k := Kind(req.Kind)
	if !k.Valid() {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_kind",
			"kind must be 'live', 'test', or 'restricted'")
		return
	}
	if len(req.Scopes) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "missing_scopes", "at least one scope is required")
		return
	}

	ir := IssueRequest{
		OrganizationID:  orgID,
		CreatedBy:       callerUID,
		Name:            req.Name,
		Kind:            k,
		Scopes:          req.Scopes,
		AllowedIPCIDRs:  req.AllowedIPCIDRs,
		RateLimitPerMin: req.RateLimitPerMin,
	}
	if req.ExpiresInDays > 0 {
		ir.ExpiresAt = time.Now().UTC().Add(time.Duration(req.ExpiresInDays) * 24 * time.Hour)
	}

	issued, err := h.store.Issue(r.Context(), ir)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "issue_failed", "could not issue token")
		return
	}

	httpx.WriteJSON(w, http.StatusCreated, issueResponse{
		ID:        issued.Token.ID.String(),
		Name:      issued.Token.Name,
		Kind:      string(issued.Token.Kind),
		Scopes:    issued.Token.Scopes,
		Prefix:    prefixOf(issued.Plaintext),
		Token:     issued.Plaintext,
		CreatedAt: issued.Token.CreatedAt,
	})
}

// ─── list ──────────────────────────────────────────────────────────────────

type tokenMetaResponse struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Kind            string    `json:"kind"`
	Scopes          []string  `json:"scopes"`
	Prefix          string    `json:"prefix"`
	RateLimitPerMin int       `json:"rate_limit_per_minute,omitempty"`
	LastUsedAt      string    `json:"last_used_at,omitempty"`
	ExpiresAt       string    `json:"expires_at,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

// List handles GET /orgs/{orgID}/api-tokens.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	metas, err := h.store.ListByOrg(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list tokens")
		return
	}

	out := make([]tokenMetaResponse, 0, len(metas))
	for _, m := range metas {
		resp := tokenMetaResponse{
			ID:              m.ID.String(),
			Name:            m.Name,
			Kind:            string(m.Kind),
			Scopes:          m.Scopes,
			Prefix:          m.Prefix,
			RateLimitPerMin: m.RateLimitPerMin,
			CreatedAt:       m.CreatedAt,
		}
		if m.LastUsedAt.Valid {
			resp.LastUsedAt = m.LastUsedAt.Time.Format(time.RFC3339)
		}
		if m.ExpiresAt.Valid {
			resp.ExpiresAt = m.ExpiresAt.Time.Format(time.RFC3339)
		}
		out = append(out, resp)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"api_tokens": out})
}

// ─── revoke ────────────────────────────────────────────────────────────────

// Revoke handles DELETE /orgs/{orgID}/api-tokens/{tokenID}.
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	tokenID, err := uuid.Parse(r.PathValue("tokenID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_token_id", "invalid token id")
		return
	}
	callerUID, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	if err := h.store.Revoke(r.Context(), tokenID, orgID, callerUID); err != nil {
		if err == ErrNotFound {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "token not found or already revoked")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "revoke_failed", "could not revoke token")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// ─── helpers ──────────────────────────────────────────────────────────────

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
