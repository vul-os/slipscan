package bankfeed

// handlers.go — HTTP handlers for the bank-feed integration.
//
// Routes (wired in cmd/server/main.go under the // P3-01 comment):
//
//	GET  /orgs/{orgID}/integrations/bankfeed/connect       → Connect
//	GET  /integrations/bankfeed/callback                   → Callback
//	GET  /orgs/{orgID}/integrations/bankfeed/connections   → ListConnections
//	GET  /orgs/{orgID}/integrations/bankfeed/connections/{connID} → GetConnection
//	DELETE /orgs/{orgID}/integrations/bankfeed/connections/{connID} → Disconnect
//	POST /orgs/{orgID}/integrations/bankfeed/connections/{connID}/sync → TriggerSync
//	POST /integrations/bankfeed/webhook                    → Webhook

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes HTTP endpoints for the bank-feed integration.
type Handler struct {
	provider Provider
	store    *Store
	syncer   *Syncer

	// oauthStates maps CSRF nonce → orgID (in-memory; replace with
	// a short-TTL DB store for multi-node deployments).
	mu          sync.Mutex
	oauthStates map[string]uuid.UUID
}

// NewHandler constructs a Handler.
func NewHandler(provider Provider, store *Store, syncer *Syncer) *Handler {
	return &Handler{
		provider:    provider,
		store:       store,
		syncer:      syncer,
		oauthStates: make(map[string]uuid.UUID),
	}
}

// ─── Connect flow ─────────────────────────────────────────────────────────────

// Connect handles GET /orgs/{orgID}/integrations/bankfeed/connect.
// Generates a CSRF nonce and redirects the user to the provider's link UI.
func (h *Handler) Connect(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	state, err := generateNonce()
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "nonce_error", "could not generate state")
		return
	}
	h.mu.Lock()
	h.oauthStates[state] = orgID
	h.mu.Unlock()

	linkURL, err := h.provider.LinkURL(r.Context(), orgID, state)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "link_url_error", err.Error())
		return
	}
	// Return the provider link as JSON rather than redirecting: this endpoint is
	// JWT-header-authed, so the frontend reads link_url then navigates the window.
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"link_url": linkURL})
}

// Callback handles GET /integrations/bankfeed/callback.
// Validates CSRF state, exchanges the code, persists connection rows, and
// kicks off an initial sync.
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	errParam := r.URL.Query().Get("error")

	if errParam != "" {
		httpx.WriteError(w, http.StatusBadRequest, "oauth_denied",
			"bank-feed authorisation was denied: "+errParam)
		return
	}
	if state == "" || code == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing_params", "state and code are required")
		return
	}

	h.mu.Lock()
	orgID, ok := h.oauthStates[state]
	if ok {
		delete(h.oauthStates, state)
	}
	h.mu.Unlock()

	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_state", "unknown or expired OAuth state")
		return
	}

	userID, _ := identity.UserIDFrom(r.Context())

	// Exchange the OAuth code for tokens + account list.
	accounts, accessToken, refreshToken, expiresAt, err := h.provider.ExchangeCode(r.Context(), code)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "exchange_failed", err.Error())
		return
	}

	// Persist one bank_feed_connections row per linked account.
	var connIDs []string
	for _, la := range accounts {
		conn, err := h.store.CreateConnection(
			r.Context(), orgID, userID,
			h.provider.Name(), la,
			accessToken, refreshToken,
			consentExpiry(expiresAt),
		)
		if err != nil {
			log.Printf("bankfeed: create connection for account %s: %v", la.ProviderAccountID, err)
			continue
		}
		// Mark connected.
		_ = h.store.UpdateConnectionStatus(r.Context(), conn.ID, StatusConnected, "", "")

		// Trigger background initial sync.
		if h.syncer != nil {
			go func(c *Connection, at string) {
				ctx := r.Context()
				if err := h.syncer.SyncConnection(ctx, c, at); err != nil {
					log.Printf("bankfeed: initial sync connection %s: %v", c.ID, err)
				}
			}(conn, accessToken)
		}
		connIDs = append(connIDs, conn.ID.String())
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"connected":      true,
		"provider":       string(h.provider.Name()),
		"connection_ids": connIDs,
	})
}

// ─── Connection management ────────────────────────────────────────────────────

// ListConnections handles GET /orgs/{orgID}/integrations/bankfeed/connections.
func (h *Handler) ListConnections(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	conns, err := h.store.ListConnections(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	type connRow struct {
		ID              string  `json:"id"`
		Provider        string  `json:"provider"`
		InstitutionName string  `json:"institution_name"`
		Mask            string  `json:"mask"`
		Status          string  `json:"status"`
		LastSyncedAt    *string `json:"last_synced_at,omitempty"`
		ErrorMessage    *string `json:"error_message,omitempty"`
	}
	rows := make([]connRow, 0, len(conns))
	for _, c := range conns {
		row := connRow{
			ID:              c.ID.String(),
			Provider:        c.Provider,
			InstitutionName: c.InstitutionName,
			Mask:            c.Mask,
			Status:          string(c.Status),
		}
		if c.LastSyncedAt.Valid {
			s := c.LastSyncedAt.Time.Format(time.RFC3339)
			row.LastSyncedAt = &s
		}
		if c.ErrorMessage.Valid {
			row.ErrorMessage = &c.ErrorMessage.String
		}
		rows = append(rows, row)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"connections": rows})
}

// GetConnection handles GET /orgs/{orgID}/integrations/bankfeed/connections/{connID}.
func (h *Handler) GetConnection(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	connID, ok := connIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_conn_id", "invalid connection id")
		return
	}
	conn, err := h.store.GetConnection(r.Context(), orgID, connID)
	if errors.Is(err, ErrConnectionNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "connection not found")
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "get_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, connectionToJSON(conn))
}

// Disconnect handles DELETE /orgs/{orgID}/integrations/bankfeed/connections/{connID}.
// Sets status=disconnected; does not delete the row so history is preserved.
func (h *Handler) Disconnect(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	connID, ok := connIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_conn_id", "invalid connection id")
		return
	}
	// Verify ownership.
	if _, err := h.store.GetConnection(r.Context(), orgID, connID); errors.Is(err, ErrConnectionNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "connection not found")
		return
	}
	if err := h.store.UpdateConnectionStatus(r.Context(), connID, StatusDisconnected, "", ""); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "disconnect_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"disconnected": true})
}

// TriggerSync handles POST /orgs/{orgID}/integrations/bankfeed/connections/{connID}/sync.
// Triggers an on-demand sync for a single connection.
func (h *Handler) TriggerSync(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	connID, ok := connIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_conn_id", "invalid connection id")
		return
	}
	conn, err := h.store.GetConnection(r.Context(), orgID, connID)
	if errors.Is(err, ErrConnectionNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "connection not found")
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "get_failed", err.Error())
		return
	}
	if conn.Status != StatusConnected {
		httpx.WriteError(w, http.StatusConflict, "not_connected",
			"connection is not in 'connected' state (status: "+string(conn.Status)+")")
		return
	}

	go func() {
		if err := h.syncer.SyncConnection(r.Context(), conn, conn.AccessTokenEncrypted); err != nil {
			log.Printf("bankfeed: manual sync connection %s: %v", conn.ID, err)
		}
	}()

	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{"syncing": true, "connection_id": conn.ID.String()})
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

// Webhook handles POST /integrations/bankfeed/webhook.
// Validates the provider signature, extracts the event type, and triggers a
// sync for the affected account.
func (h *Handler) Webhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB cap
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "read_error", "could not read body")
		return
	}

	// Collect headers for signature validation.
	headers := map[string]string{}
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}

	if err := h.provider.ValidateWebhook(body, headers); err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_signature", err.Error())
		return
	}

	eventType, err := h.provider.WebhookEventType(body)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "parse_error", err.Error())
		return
	}

	log.Printf("bankfeed: webhook event=%s", eventType)

	// For transaction-related events, identify the affected connection and
	// trigger a sync.  The exact event type names vary by provider; here we
	// handle the Stitch 'payment.initiated' and 'transaction.settled' events.
	switch eventType {
	case "transaction.settled", "payment.initiated", "transactions":
		// Best-effort: re-sync all connected accounts.  In a production build,
		// parse the accountId from the webhook body and target just that account.
		if h.syncer != nil {
			go func() {
				if err := h.syncer.SyncAll(r.Context()); err != nil {
					log.Printf("bankfeed: webhook-triggered sync: %v", err)
				}
			}()
		}
	case "reauth_required", "identity.verification_required":
		// Surface re-auth state.  Parse accountId from payload to target the
		// specific connection.  For now, log and acknowledge.
		log.Printf("bankfeed: reauth required from webhook")
	}

	w.WriteHeader(http.StatusNoContent)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("orgID")
	id, err := uuid.Parse(raw)
	return id, err == nil
}

func connIDFromPath(r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("connID")
	id, err := uuid.Parse(raw)
	return id, err == nil
}

func generateNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func consentExpiry(tokenExpiry time.Time) *time.Time {
	// Stitch consent is typically 90 days; use token expiry as a floor.
	exp := tokenExpiry.Add(90 * 24 * time.Hour)
	return &exp
}

func connectionToJSON(c *Connection) map[string]any {
	out := map[string]any{
		"id":               c.ID.String(),
		"provider":         c.Provider,
		"institution_name": c.InstitutionName,
		"institution_id":   c.InstitutionID,
		"mask":             c.Mask,
		"status":           string(c.Status),
		"created_at":       c.CreatedAt,
		"updated_at":       c.UpdatedAt,
	}
	if c.LastSyncedAt.Valid {
		out["last_synced_at"] = c.LastSyncedAt.Time
	}
	if c.ErrorCode.Valid {
		out["error_code"] = c.ErrorCode.String
	}
	if c.ErrorMessage.Valid {
		out["error_message"] = c.ErrorMessage.String
	}
	return out
}
