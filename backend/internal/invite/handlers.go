package invite

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/auth"
	"github.com/exolutionza/slipscan/backend/internal/email"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/org"
)

type Handler struct {
	store           *Store
	users           *auth.Store
	orgs            *org.Store
	ttl             time.Duration
	frontendBaseURL string
	mailer          email.Sender
}

func NewHandler(store *Store, users *auth.Store, orgs *org.Store, ttl time.Duration, frontendBaseURL string, mailer email.Sender) *Handler {
	if mailer == nil {
		mailer = email.NoopSender{}
	}
	return &Handler{store: store, users: users, orgs: orgs, ttl: ttl, frontendBaseURL: frontendBaseURL, mailer: mailer}
}

// sendInvite fires the invitation email but never blocks the HTTP response
// on it: the admin gets the accept link in the JSON regardless, so a flaky
// email provider can't prevent invite creation. Failures are logged.
func (h *Handler) sendInvite(toEmail, orgName, inviterName, acceptURL string) {
	subject, htmlBody, textBody := email.InviteEmail(orgName, inviterName, acceptURL)
	go func() {
		// Decouple from the request lifetime — Sender has its own timeout.
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := h.mailer.Send(ctx, email.Message{
			To: toEmail, Subject: subject, HTML: htmlBody, Text: textBody,
		}); err != nil {
			log.Printf("invite email to %s failed: %v", toEmail, err)
		}
	}()
}

type createRequest struct {
	Email string   `json:"email"`
	Role  org.Role `json:"role"`
}

type inviteResponse struct {
	ID         string    `json:"id"`
	Email      string    `json:"email"`
	Role       org.Role  `json:"role"`
	ExpiresAt  time.Time `json:"expires_at"`
	CreatedAt  time.Time `json:"created_at"`
	AcceptURL  string    `json:"accept_url,omitempty"`
	Token      string    `json:"token,omitempty"`
}

// Create issues a fresh invitation. The plaintext token is returned ONLY
// in this response — once the response is delivered the server keeps just
// the SHA-256 hash. In production the URL is what gets emailed; we return
// it here too so admins can copy a link if no SMTP is wired up yet.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	orgID, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	var req createRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	addr, err := mail.ParseAddress(strings.TrimSpace(req.Email))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_email", "invalid email address")
		return
	}
	email := strings.ToLower(addr.Address)

	role := req.Role
	if role == "" {
		role = org.RoleMember
	}
	if !role.Valid() {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_role", "role must be 'admin' or 'member'")
		return
	}

	plain, hash, err := GenerateToken()
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not generate invitation token")
		return
	}

	expiresAt := time.Now().Add(h.ttl)
	inv, err := h.store.Create(r.Context(), orgID, email, role, uid, hash, expiresAt)
	if err != nil {
		if errors.Is(err, ErrPendingExists) {
			httpx.WriteError(w, http.StatusConflict, "pending_exists", "a pending invitation for this email already exists")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "create_failed", "could not create invitation")
		return
	}

	acceptURL := h.frontendBaseURL + "/invitations/accept?token=" + plain

	// Best-effort enrichment for the email — failures here just mean the
	// email goes out with empty placeholders, which is still useful.
	var orgName, inviterName string
	if o, err := h.orgs.ByID(r.Context(), orgID); err == nil {
		orgName = o.Name
	}
	if u, err := h.users.ByID(r.Context(), uid); err == nil && u.FullName.Valid {
		inviterName = u.FullName.String
	}
	h.sendInvite(email, orgName, inviterName, acceptURL)

	resp := inviteResponse{
		ID:        inv.ID.String(),
		Email:     inv.Email,
		Role:      inv.Role,
		ExpiresAt: inv.ExpiresAt,
		CreatedAt: inv.CreatedAt,
		Token:     plain,
		AcceptURL: acceptURL,
	}
	httpx.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) ListPending(w http.ResponseWriter, r *http.Request) {
	orgID, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	invs, err := h.store.ListPending(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list invitations")
		return
	}
	out := make([]inviteResponse, 0, len(invs))
	for _, inv := range invs {
		out = append(out, inviteResponse{
			ID: inv.ID.String(), Email: inv.Email, Role: inv.Role,
			ExpiresAt: inv.ExpiresAt, CreatedAt: inv.CreatedAt,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"invitations": out})
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	orgID, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	invID, err := uuid.Parse(r.PathValue("inviteID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_invite_id", "invalid invitation id")
		return
	}
	if err := h.store.Revoke(r.Context(), orgID, invID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "invitation not found or already consumed")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "revoke_failed", "could not revoke invitation")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type acceptRequest struct {
	Token string `json:"token"`
}

type acceptOrg struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	Role      org.Role  `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

// acceptResponse carries the full org payload so the client can hydrate
// its cache without an extra /orgs round-trip after accepting.
type acceptResponse struct {
	Organization acceptOrg `json:"organization"`
}

// Accept consumes an invitation token. The caller must be authenticated
// and their account email must match the invitation's email — otherwise
// any user with the link could claim the invite as themselves, which
// defeats the point of inviting a specific address.
func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}
	var req acceptRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_token", "token is required")
		return
	}

	user, err := h.users.ByID(r.Context(), uid)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "user_lookup_failed", "could not load caller")
		return
	}

	inv, err := h.store.AcceptByTokenHash(r.Context(), HashToken(token), uid, user.Email)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httpx.WriteError(w, http.StatusNotFound, "not_found", "invitation not found")
		case errors.Is(err, ErrExpired):
			httpx.WriteError(w, http.StatusGone, "expired", "invitation has expired")
		case errors.Is(err, ErrConsumed):
			httpx.WriteError(w, http.StatusConflict, "consumed", "invitation already accepted or revoked")
		case errors.Is(err, ErrEmailMismatch):
			httpx.WriteError(w, http.StatusForbidden, "email_mismatch", "this invitation was sent to a different email address")
		default:
			httpx.WriteError(w, http.StatusInternalServerError, "accept_failed", "could not accept invitation")
		}
		return
	}

	o, err := h.orgs.ByID(r.Context(), inv.OrganizationID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "org_lookup_failed", "could not load organization")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, acceptResponse{
		Organization: acceptOrg{
			ID:        o.ID.String(),
			Name:      o.Name,
			Slug:      o.Slug,
			Role:      inv.Role,
			CreatedAt: o.CreatedAt,
		},
	})
}

// Resend rotates the token on a pending invitation and returns a fresh
// accept link. The old link is invalidated immediately. Useful when the
// admin loses the original link (we never store the plaintext) or when
// the invitee says it never arrived.
func (h *Handler) Resend(w http.ResponseWriter, r *http.Request) {
	orgID, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	invID, err := uuid.Parse(r.PathValue("inviteID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_invite_id", "invalid invitation id")
		return
	}

	plain, hash, err := GenerateToken()
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not generate invitation token")
		return
	}

	expiresAt := time.Now().Add(h.ttl)
	inv, err := h.store.Resend(r.Context(), orgID, invID, hash, expiresAt)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "invitation not found or already consumed")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "resend_failed", "could not resend invitation")
		return
	}

	acceptURL := h.frontendBaseURL + "/invitations/accept?token=" + plain

	var orgName string
	if o, err := h.orgs.ByID(r.Context(), orgID); err == nil {
		orgName = o.Name
	}
	var inviterName string
	if uid, ok := auth.UserIDFrom(r.Context()); ok {
		if u, err := h.users.ByID(r.Context(), uid); err == nil && u.FullName.Valid {
			inviterName = u.FullName.String
		}
	}
	h.sendInvite(inv.Email, orgName, inviterName, acceptURL)

	httpx.WriteJSON(w, http.StatusOK, inviteResponse{
		ID:        inv.ID.String(),
		Email:     inv.Email,
		Role:      inv.Role,
		ExpiresAt: inv.ExpiresAt,
		CreatedAt: inv.CreatedAt,
		Token:     plain,
		AcceptURL: acceptURL,
	})
}
