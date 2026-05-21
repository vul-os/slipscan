package auth

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/email"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/org"
)

const (
	verifyTokenTTL = 24 * time.Hour
	resetTokenTTL  = 1 * time.Hour
)

type Handler struct {
	store           *Store
	tokens          *TokenStore
	signer          *Signer
	orgs            *org.Store
	mailer          email.Sender
	frontendBaseURL string
	rxDomain        string
}

// HandlerConfig wires the dependencies needed by every endpoint on Handler.
// It's a struct rather than a long argument list so adding a new dep
// doesn't ripple through every test.
type HandlerConfig struct {
	Users           *Store
	Tokens          *TokenStore
	Signer          *Signer
	Orgs            *org.Store
	Mailer          email.Sender
	FrontendBaseURL string // e.g. https://slipscan-staging.web.app — used to build verify/reset links
	RxDomain        string // e.g. rx.slipscan.app — used in welcome email
}

func NewHandler(cfg HandlerConfig) *Handler {
	return &Handler{
		store:           cfg.Users,
		tokens:          cfg.Tokens,
		signer:          cfg.Signer,
		orgs:            cfg.Orgs,
		mailer:          cfg.Mailer,
		frontendBaseURL: cfg.FrontendBaseURL,
		rxDomain:        cfg.RxDomain,
	}
}

// registerRequest is the v2 shape that creates a user, an organization
// (personal or business), the matching profile row, and an owner
// membership in one transaction.
type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	FullName string `json:"full_name"`

	Kind    org.Kind `json:"kind"`     // "personal" | "business"
	OrgName string   `json:"org_name"` // optional; defaults to FullName / LegalName

	// business-only
	LegalName          string `json:"legal_name,omitempty"`
	RegistrationNumber string `json:"registration_number,omitempty"`
	TaxNumber          string `json:"tax_number,omitempty"`
	Industry           string `json:"industry,omitempty"`
	Website            string `json:"website,omitempty"`
	Country            string `json:"country,omitempty"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type verifyRequest struct {
	Token string `json:"token"`
}

type resendVerifyRequest struct {
	Email string `json:"email"`
}

type resetRequestRequest struct {
	Email string `json:"email"`
}

type resetConfirmRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

type userResponse struct {
	ID              string    `json:"id"`
	Email           string    `json:"email"`
	FullName        string    `json:"full_name,omitempty"`
	EmailVerifiedAt time.Time `json:"email_verified_at,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

type orgResponse struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	RxLocalPart string `json:"rx_local_part"`
	Currency    string `json:"currency"`
	Role        string `json:"role"`
}

type registerResponse struct {
	User         userResponse `json:"user"`
	Organization orgResponse  `json:"organization"`
	Tokens       TokenPair    `json:"tokens"`
	VerifySent   bool         `json:"verify_email_sent"`
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
	emailAddr, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_email", err.Error())
		return
	}
	if !req.Kind.Valid() {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_kind", "kind must be 'personal' or 'business'")
		return
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_password", err.Error())
		return
	}

	ctx := r.Context()
	user, err := h.store.Create(ctx, emailAddr, hash, strings.TrimSpace(req.FullName))
	if err != nil {
		if errors.Is(err, ErrEmailTaken) {
			httpx.WriteError(w, http.StatusConflict, "email_taken", "email already in use")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "create_failed", "could not create user")
		return
	}

	orgName, opts := buildOrgOptions(req, user)
	o, err := h.orgs.Create(ctx, opts)
	if err != nil {
		// User row is created but org creation failed. Surface the error so
		// the client can retry; signup hasn't fully completed.
		httpx.WriteError(w, http.StatusBadRequest, "org_create_failed", err.Error())
		return
	}

	pair, err := h.signer.Issue(user.ID, user.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "token_failed", "could not issue tokens")
		return
	}

	verifySent := h.sendVerifyEmail(ctx, user)
	_ = orgName // reserved for future logging

	httpx.WriteJSON(w, http.StatusCreated, registerResponse{
		User:         userToResponse(user),
		Organization: orgToResponse(*o, org.RoleOwner),
		Tokens:       pair,
		VerifySent:   verifySent,
	})
}

func buildOrgOptions(req registerRequest, user *User) (string, org.CreateOptions) {
	fullName := strings.TrimSpace(req.FullName)
	if fullName == "" && user.FullName.Valid {
		fullName = user.FullName.String
	}

	orgName := strings.TrimSpace(req.OrgName)
	switch req.Kind {
	case org.KindPersonal:
		if orgName == "" {
			if fullName != "" {
				orgName = fullName
			} else {
				orgName = strings.SplitN(user.Email, "@", 2)[0]
			}
		}
		return orgName, org.CreateOptions{
			Kind:        org.KindPersonal,
			Name:        orgName,
			Personal:    &org.PersonalProfile{FullName: fullName},
			OwnerUserID: user.ID,
		}
	case org.KindBusiness:
		legal := strings.TrimSpace(req.LegalName)
		if legal == "" {
			legal = orgName
		}
		if orgName == "" {
			orgName = legal
		}
		return orgName, org.CreateOptions{
			Kind: org.KindBusiness,
			Name: orgName,
			Business: &org.BusinessProfile{
				LegalName:          legal,
				RegistrationNumber: req.RegistrationNumber,
				TaxNumber:          req.TaxNumber,
				Industry:           req.Industry,
				Website:            req.Website,
				Country:            req.Country,
			},
			OwnerUserID: user.ID,
		}
	}
	return orgName, org.CreateOptions{}
}

// VerifyEmail consumes a verification token, marks the user as verified,
// and sends the welcome email. Idempotent: re-clicking the link after
// success returns a friendly error and does nothing else.
func (h *Handler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	switch r.Method {
	case http.MethodPost:
		if err := httpx.DecodeJSON(r, &req); err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
			return
		}
	case http.MethodGet:
		req.Token = r.URL.Query().Get("token")
	}
	uid, err := h.tokens.ConsumeEmailVerify(r.Context(), req.Token)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_token", "verification link is invalid or expired")
		return
	}
	if err := h.store.MarkVerified(r.Context(), uid); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "verify_failed", "could not verify email")
		return
	}
	user, err := h.store.ByID(r.Context(), uid)
	if err != nil {
		// Verification recorded; just can't send the welcome. Don't fail.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"verified": true})
		return
	}
	h.sendWelcomeEmail(r.Context(), user)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"verified": true, "user": userToResponse(user)})
}

// ResendVerify issues a fresh verification token for an unverified user.
// Always returns 200 to avoid leaking which addresses are registered.
func (h *Handler) ResendVerify(w http.ResponseWriter, r *http.Request) {
	var req resendVerifyRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	emailAddr, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}
	user, err := h.store.ByEmail(r.Context(), emailAddr)
	if err != nil || user.EmailVerifiedAt.Valid {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}
	_ = h.tokens.InvalidateUserTokens(r.Context(), tokenKindEmailVerify, user.ID)
	h.sendVerifyEmail(r.Context(), user)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
}

// RequestPasswordReset starts the reset flow. Always 200 so the response
// can't be used as an account-existence oracle.
func (h *Handler) RequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var req resetRequestRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	emailAddr, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}
	user, err := h.store.ByEmail(r.Context(), emailAddr)
	if err != nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}
	_ = h.tokens.InvalidateUserTokens(r.Context(), tokenKindPasswordReset, user.ID)
	plaintext, err := h.tokens.IssuePasswordReset(r.Context(), user.ID, resetTokenTTL)
	if err != nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}
	resetURL := h.buildFrontendURL("/reset-password", "token", plaintext)
	logTokenURLForLocalDev("reset", user.Email, resetURL)
	subject, htmlBody, textBody := email.PasswordResetEmail(strFromNull(user.FullName), resetURL)
	h.sendOrLog(r.Context(), email.Message{
		To: user.Email, Subject: subject, HTML: htmlBody, Text: textBody,
	}, "password_reset")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": true})
}

// ConfirmPasswordReset consumes a reset token and rotates the password.
func (h *Handler) ConfirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	var req resetConfirmRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	uid, err := h.tokens.ConsumePasswordReset(r.Context(), req.Token)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_token", "reset link is invalid or expired")
		return
	}
	hash, err := HashPassword(req.NewPassword)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_password", err.Error())
		return
	}
	if err := h.store.UpdatePasswordHash(r.Context(), uid, hash); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "update_failed", "could not update password")
		return
	}
	// Invalidate any other outstanding reset tokens so an attacker who
	// snagged an older link can't use it after the user fixes things.
	_ = h.tokens.InvalidateUserTokens(r.Context(), tokenKindPasswordReset, uid)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"reset": true})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	emailAddr, err := normalizeEmail(req.Email)
	if err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	user, err := h.store.ByEmail(r.Context(), emailAddr)
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

// sendVerifyEmail issues a verification token and dispatches the email.
// Returns true on success. Failures are logged and reported via the bool
// so registration still succeeds (the user can hit /resend later).
func (h *Handler) sendVerifyEmail(ctx context.Context, user *User) bool {
	if h.tokens == nil {
		return false
	}
	plaintext, err := h.tokens.IssueEmailVerify(ctx, user.ID, verifyTokenTTL)
	if err != nil {
		log.Printf("verify: issue token: %v", err)
		return false
	}
	verifyURL := h.buildFrontendURL("/verify", "token", plaintext)
	logTokenURLForLocalDev("verify", user.Email, verifyURL)
	subject, htmlBody, textBody := email.VerifyEmail(strFromNull(user.FullName), verifyURL)
	return h.sendOrLog(ctx, email.Message{
		To: user.Email, Subject: subject, HTML: htmlBody, Text: textBody,
	}, "verify")
}

// logTokenURLForLocalDev prints clickable verify/reset links to the
// server log when running locally, so devs don't have to round-trip
// through email to test the flow. APP_ENV=dev or APP_ENV=main suppress
// the log so URLs never end up in prod stdout.
func logTokenURLForLocalDev(kind, recipient, url string) {
	switch os.Getenv("APP_ENV") {
	case "dev", "main":
		return
	}
	log.Printf("[local-dev] %s url for %s: %s", kind, recipient, url)
}

// sendWelcomeEmail looks up the user's primary org so we can show the
// workspace name + email-in address, then dispatches the welcome.
func (h *Handler) sendWelcomeEmail(ctx context.Context, user *User) {
	var orgName, rxLocalPart string
	if h.orgs != nil {
		orgs, err := h.orgs.ListForUser(ctx, user.ID)
		if err == nil && len(orgs) > 0 {
			orgName = orgs[0].Name
			rxLocalPart = orgs[0].RxLocalPart
		}
	}
	dashboardURL := h.frontendBaseURL
	if dashboardURL == "" {
		dashboardURL = "/"
	}
	subject, htmlBody, textBody := email.WelcomeEmail(
		strFromNull(user.FullName), orgName, dashboardURL,
		rxLocalPart, h.rxDomain,
	)
	h.sendOrLog(ctx, email.Message{
		To: user.Email, Subject: subject, HTML: htmlBody, Text: textBody,
	}, "welcome")
}

// sendOrLog dispatches a message via the configured mailer. Errors are
// logged but never fail the request — the user has already taken the
// action; we don't want a transient mail outage to wedge the API.
func (h *Handler) sendOrLog(ctx context.Context, msg email.Message, kind string) bool {
	if h.mailer == nil {
		log.Printf("email %s: no mailer configured (would send to %s)", kind, msg.To)
		return false
	}
	if err := h.mailer.Send(ctx, msg); err != nil {
		log.Printf("email %s: send failed: %v", kind, err)
		return false
	}
	return true
}

// buildFrontendURL composes a fully-qualified URL into the frontend, with
// a single query param tacked on. Falls back to a relative path when no
// frontend base is configured (useful in tests).
func (h *Handler) buildFrontendURL(path, key, value string) string {
	q := url.Values{key: {value}}.Encode()
	if h.frontendBaseURL == "" {
		return path + "?" + q
	}
	base := strings.TrimRight(h.frontendBaseURL, "/")
	return base + path + "?" + q
}

func userToResponse(u *User) userResponse {
	resp := userResponse{
		ID:        u.ID.String(),
		Email:     u.Email,
		FullName:  strFromNull(u.FullName),
		CreatedAt: u.CreatedAt,
	}
	if u.EmailVerifiedAt.Valid {
		resp.EmailVerifiedAt = u.EmailVerifiedAt.Time
	}
	return resp
}

func orgToResponse(o org.Organization, role org.Role) orgResponse {
	return orgResponse{
		ID: o.ID.String(), Kind: string(o.Kind), Name: o.Name, Slug: o.Slug,
		RxLocalPart: o.RxLocalPart, Currency: o.Currency, Role: string(role),
	}
}

func strFromNull(n sql.NullString) string {
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

// uuidFrom is exported for use by other packages that need to convert a
// path/query-string token to a UUID without importing google/uuid directly.
func uuidFrom(s string) (uuid.UUID, error) { return uuid.Parse(s) }
