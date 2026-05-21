package org

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

type Handler struct {
	store *Store
}

func NewHandler(store *Store) *Handler { return &Handler{store: store} }

type createRequest struct {
	Kind     Kind   `json:"kind"`
	Name     string `json:"name"`
	FullName string `json:"full_name,omitempty"`

	// Business-only
	LegalName          string `json:"legal_name,omitempty"`
	RegistrationNumber string `json:"registration_number,omitempty"`
	TaxNumber          string `json:"tax_number,omitempty"`
	Industry           string `json:"industry,omitempty"`
	Website            string `json:"website,omitempty"`
	Country            string `json:"country,omitempty"`
}

type orgResponse struct {
	ID          string    `json:"id"`
	Kind        Kind      `json:"kind"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	RxLocalPart string    `json:"rx_local_part"`
	Currency    string    `json:"currency"`
	Role        Role      `json:"role,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type memberResponse struct {
	UserID   string    `json:"user_id"`
	Email    string    `json:"email"`
	FullName string    `json:"full_name,omitempty"`
	Role     Role      `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

func toResponse(o Organization, role Role) orgResponse {
	return orgResponse{
		ID: o.ID.String(), Kind: o.Kind, Name: o.Name, Slug: o.Slug,
		RxLocalPart: o.RxLocalPart, Currency: o.Currency,
		Role: role, CreatedAt: o.CreatedAt,
	}
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	uid, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	var req createRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 120 {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_name", "name is required (max 120 chars)")
		return
	}
	if !req.Kind.Valid() {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_kind", "kind must be 'personal' or 'business'")
		return
	}

	opts := CreateOptions{Kind: req.Kind, Name: name, OwnerUserID: uid}
	switch req.Kind {
	case KindPersonal:
		fn := strings.TrimSpace(req.FullName)
		if fn == "" {
			fn = name
		}
		opts.Personal = &PersonalProfile{FullName: fn}
	case KindBusiness:
		legal := strings.TrimSpace(req.LegalName)
		if legal == "" {
			legal = name
		}
		opts.Business = &BusinessProfile{
			LegalName:          legal,
			RegistrationNumber: req.RegistrationNumber,
			TaxNumber:          req.TaxNumber,
			Industry:           req.Industry,
			Website:            req.Website,
			Country:            req.Country,
		}
	}

	o, err := h.store.Create(r.Context(), opts)
	if err != nil {
		if errors.Is(err, ErrSlugTaken) {
			httpx.WriteError(w, http.StatusConflict, "slug_taken", "slug already in use")
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, toResponse(*o, RoleOwner))
}

func (h *Handler) ListMine(w http.ResponseWriter, r *http.Request) {
	uid, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}
	orgs, err := h.store.ListForUser(r.Context(), uid)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list organizations")
		return
	}
	out := make([]orgResponse, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, toResponse(o.Organization, o.Role))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"organizations": out})
}

// ListMembers requires the caller to be a member (any role).
func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	uid, ok := identity.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}
	if _, err := h.store.MemberRole(r.Context(), orgID, uid); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this organization")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "lookup_failed", "could not verify membership")
		return
	}

	members, err := h.store.ListMembers(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list members")
		return
	}
	out := make([]memberResponse, 0, len(members))
	for _, m := range members {
		fn := ""
		if m.FullName.Valid {
			fn = m.FullName.String
		}
		out = append(out, memberResponse{
			UserID: m.UserID.String(), Email: m.Email, FullName: fn,
			Role: m.Role, JoinedAt: m.JoinedAt,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"members": out})
}

// roleAtLeastAdmin is true for roles that should pass an admin gate.
// Owner and Admin both qualify; accountants/members/viewers do not.
func roleAtLeastAdmin(r Role) bool { return r == RoleOwner || r == RoleAdmin }

// RequireMember is middleware that 403s unless the caller is a member of the
// org named by the {orgID} path parameter (any role).
func RequireMember(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			orgID, ok := orgIDFromPath(r)
			if !ok {
				httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
				return
			}
			uid, ok := identity.UserIDFrom(r.Context())
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
				return
			}
			if _, err := store.MemberRole(r.Context(), orgID, uid); err != nil {
				if errors.Is(err, ErrForbidden) {
					httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this organization")
					return
				}
				httpx.WriteError(w, http.StatusInternalServerError, "lookup_failed", "could not verify membership")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAdmin is middleware that 403s unless the caller is an owner or
// admin of the org named by the {orgID} path parameter.
func RequireAdmin(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			orgID, ok := orgIDFromPath(r)
			if !ok {
				httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
				return
			}
			uid, ok := identity.UserIDFrom(r.Context())
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
				return
			}
			role, err := store.MemberRole(r.Context(), orgID, uid)
			if err != nil {
				if errors.Is(err, ErrForbidden) {
					httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this organization")
					return
				}
				httpx.WriteError(w, http.StatusInternalServerError, "lookup_failed", "could not verify membership")
				return
			}
			if !roleAtLeastAdmin(role) {
				httpx.WriteError(w, http.StatusForbidden, "forbidden", "admin role required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("orgID")
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
