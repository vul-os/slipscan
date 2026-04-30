package auth

import (
	"database/sql"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

type Handler struct {
	store  *Store
	signer *Signer
}

func NewHandler(store *Store, signer *Signer) *Handler {
	return &Handler{store: store, signer: signer}
}

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	FullName string `json:"full_name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type userResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	FullName  string    `json:"full_name,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type authResponse struct {
	User   userResponse `json:"user"`
	Tokens TokenPair    `json:"tokens"`
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_email", err.Error())
		return
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_password", err.Error())
		return
	}

	ctx := r.Context()
	user, err := h.store.Create(ctx, email, hash, strings.TrimSpace(req.FullName))
	if err != nil {
		if errors.Is(err, ErrEmailTaken) {
			httpx.WriteError(w, http.StatusConflict, "email_taken", "email already in use")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "create_failed", "could not create user")
		return
	}

	pair, err := h.signer.Issue(user.ID, user.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not issue tokens")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, authResponse{
		User:   userToResponse(user),
		Tokens: pair,
	})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	user, err := h.store.ByEmail(r.Context(), email)
	if err != nil {
		// Constant-time-ish: still hash a dummy password so timing leaks
		// less about whether the email exists.
		_ = VerifyPassword("$2a$12$0000000000000000000000000000000000000000000000000000", req.Password)
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}
	if !VerifyPassword(user.PasswordHash, req.Password) {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	pair, err := h.signer.Issue(user.ID, user.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not issue tokens")
		return
	}
	if err := h.store.TouchLogin(r.Context(), user.ID); err != nil {
		// Non-fatal — login already succeeded.
		_ = err
	}
	httpx.WriteJSON(w, http.StatusOK, authResponse{
		User:   userToResponse(user),
		Tokens: pair,
	})
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	claims, err := h.signer.Parse(req.RefreshToken, TokenRefresh)
	if err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_token", "invalid or expired refresh token")
		return
	}

	user, err := h.store.ByID(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_token", "user no longer exists")
		return
	}

	pair, err := h.signer.Issue(user.ID, user.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not issue tokens")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, pair)
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}
	user, err := h.store.ByID(r.Context(), uid)
	if err != nil {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, userToResponse(user))
}

func userToResponse(u *User) userResponse {
	return userResponse{
		ID:        u.ID.String(),
		Email:     u.Email,
		FullName:  nullStr(u.FullName),
		CreatedAt: u.CreatedAt,
	}
}

func nullStr(n sql.NullString) string {
	if n.Valid {
		return n.String
	}
	return ""
}

func normalizeEmail(in string) (string, error) {
	addr := strings.TrimSpace(in)
	if addr == "" {
		return "", errors.New("email is required")
	}
	parsed, err := mail.ParseAddress(addr)
	if err != nil {
		return "", errors.New("invalid email address")
	}
	return strings.ToLower(parsed.Address), nil
}

