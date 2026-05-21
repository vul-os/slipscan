package accounting_export

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes HTTP endpoints for the Xero integration.
// All routes are grouped under /orgs/{orgID}/integrations/xero/.
type Handler struct {
	provider Provider
	store    *Store
	// oauthStates is an in-memory nonce store for CSRF protection on the
	// OAuth2 callback. For multi-instance deployments replace with a short-TTL
	// Redis/DB store.
	mu          sync.Mutex
	oauthStates map[string]uuid.UUID // nonce → orgID
}

// NewHandler returns a Handler wired to the given Provider.
func NewHandler(provider Provider, store *Store) *Handler {
	return &Handler{
		provider:    provider,
		store:       store,
		oauthStates: make(map[string]uuid.UUID),
	}
}

// ─── OAuth2 connect flow ──────────────────────────────────────────────────────

// Connect handles GET /orgs/{orgID}/integrations/xero/connect.
// Generates a CSRF nonce and redirects the user to the Xero consent screen.
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

	authURL := h.provider.AuthURL(orgID, state)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// Callback handles GET /orgs/{orgID}/integrations/xero/callback.
// Validates the CSRF state, exchanges the code for tokens, and stores them.
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	errParam := r.URL.Query().Get("error")

	if errParam != "" {
		httpx.WriteError(w, http.StatusBadRequest, "oauth_denied",
			"Xero authorisation was denied: "+errParam)
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

	uid, hasUser := identity.UserIDFrom(r.Context())
	if !hasUser {
		uid = uuid.Nil // callback may arrive without a session cookie; store with nil user
	}

	accountEmail, err := h.provider.ExchangeCode(r.Context(), orgID, uid, code)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "exchange_failed", err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"connected":     true,
		"provider":      h.provider.Name(),
		"account_email": accountEmail,
	})
}

// Status handles GET /orgs/{orgID}/integrations/xero/status.
// Returns whether the org has an active Xero connection.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	grant, err := h.store.GetGrant(r.Context(), orgID, h.provider.Name())
	if errors.Is(err, ErrGrantNotFound) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"connected": false,
			"provider":  h.provider.Name(),
		})
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "status_failed", err.Error())
		return
	}

	resp := map[string]any{
		"connected": true,
		"provider":  h.provider.Name(),
	}
	if grant.AccountEmail.Valid {
		resp["account_email"] = grant.AccountEmail.String
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

// Disconnect handles DELETE /orgs/{orgID}/integrations/xero/connect.
// Revokes the stored OAuth grant.
func (h *Handler) Disconnect(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	if err := h.store.RevokeGrant(r.Context(), orgID, h.provider.Name()); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "disconnect_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"disconnected": true})
}

// ─── Push action ─────────────────────────────────────────────────────────────

// pushRequest is the optional JSON body for the push endpoint.
// When IDs are empty the push targets all unsynced records.
type pushRequest struct {
	ContactIDs     []string `json:"contact_ids"`
	TransactionIDs []string `json:"transaction_ids"`
}

// pushReport summarises the outcome of a push operation.
type pushReport struct {
	ContactsPushed     int      `json:"contacts_pushed"`
	TransactionsPushed int      `json:"transactions_pushed"`
	Errors             []string `json:"errors,omitempty"`
}

// Push handles POST /orgs/{orgID}/integrations/xero/push.
// Pushes selected (or all unsynced) contacts and transactions to Xero.
// The operation is best-effort: per-record errors are collected and returned
// rather than aborting the whole batch.
func (h *Handler) Push(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	var req pushRequest
	// Body is optional — empty body = push all unsynced.
	if r.Body != nil && r.ContentLength != 0 {
		if err := httpx.DecodeJSON(r, &req); err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
			return
		}
	}

	ctx := r.Context()
	report := pushReport{}

	// ── Push contacts ──────────────────────────────────────────────────────
	var contacts []Contact
	if len(req.ContactIDs) > 0 {
		for _, idStr := range req.ContactIDs {
			cid, err := uuid.Parse(idStr)
			if err != nil {
				report.Errors = append(report.Errors, "invalid contact id: "+idStr)
				continue
			}
			c, err := h.store.GetContact(ctx, orgID, cid)
			if err != nil {
				report.Errors = append(report.Errors, "contact "+idStr+": "+err.Error())
				continue
			}
			contacts = append(contacts, *c)
		}
	} else {
		var err error
		contacts, err = h.store.ListUnexportedContacts(ctx, orgID, h.provider.Name())
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "list_contacts_failed", err.Error())
			return
		}
	}

	for _, c := range contacts {
		_, err := h.provider.PushContact(ctx, orgID, c)
		if err != nil {
			_ = h.store.RecordSyncError(ctx, orgID, h.provider.Name(), "contact", c.ID, err.Error())
			report.Errors = append(report.Errors, "contact "+c.ID.String()+": "+err.Error())
			continue
		}
		report.ContactsPushed++
	}

	// ── Push transactions ──────────────────────────────────────────────────
	var transactions []Transaction
	if len(req.TransactionIDs) > 0 {
		for _, idStr := range req.TransactionIDs {
			tid, err := uuid.Parse(idStr)
			if err != nil {
				report.Errors = append(report.Errors, "invalid transaction id: "+idStr)
				continue
			}
			tx, err := h.store.GetTransaction(ctx, orgID, tid)
			if err != nil {
				report.Errors = append(report.Errors, "transaction "+idStr+": "+err.Error())
				continue
			}
			transactions = append(transactions, *tx)
		}
	} else {
		var err error
		transactions, err = h.store.ListUnexportedTransactions(ctx, orgID, h.provider.Name())
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "list_transactions_failed", err.Error())
			return
		}
	}

	for _, tx := range transactions {
		_, err := h.provider.PushTransaction(ctx, orgID, tx)
		if err != nil {
			_ = h.store.RecordSyncError(ctx, orgID, h.provider.Name(), "transaction", tx.ID, err.Error())
			report.Errors = append(report.Errors, "transaction "+tx.ID.String()+": "+err.Error())
			continue
		}
		report.TransactionsPushed++
	}

	status := http.StatusOK
	if len(report.Errors) > 0 && report.ContactsPushed == 0 && report.TransactionsPushed == 0 {
		status = http.StatusUnprocessableEntity
	}
	httpx.WriteJSON(w, status, report)
}

// SyncStatus handles GET /orgs/{orgID}/integrations/xero/sync-status.
// Returns the mapping rows (with sync errors) for this org.
func (h *Handler) SyncStatus(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	mappings, err := h.store.ListMappings(r.Context(), orgID, h.provider.Name())
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	type row struct {
		LocalType  string `json:"local_type"`
		LocalID    string `json:"local_id"`
		ExternalID string `json:"external_id"`
		SyncedAt   any    `json:"last_synced_at"`
		SyncError  any    `json:"sync_error"`
	}
	out := make([]row, 0, len(mappings))
	for _, m := range mappings {
		r := row{LocalType: m.LocalType, LocalID: m.LocalID.String(), ExternalID: m.ExternalID}
		if m.LastSyncedAt.Valid {
			r.SyncedAt = m.LastSyncedAt.Time
		}
		if m.SyncError.Valid {
			r.SyncError = m.SyncError.String
		}
		out = append(out, r)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"mappings": out})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("orgID")
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

func generateNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
