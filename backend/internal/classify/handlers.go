package classify

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes the P1-02 HTTP endpoints:
//
//	POST /orgs/{orgID}/documents/{docID}/classify
//	GET  /orgs/{orgID}/transactions
type Handler struct {
	db         *sql.DB
	classifier *Classifier
}

// NewHandler returns a Handler wired to the given db and classifier.
func NewHandler(db *sql.DB, classifier *Classifier) *Handler {
	return &Handler{db: db, classifier: classifier}
}

// ─── POST /orgs/{orgID}/documents/{docID}/classify ─────────────────────────

// Classify (re-)runs classification on the document's current extraction.
// Idempotent: existing classifications are superseded (is_current flipped).
func (h *Handler) Classify(w http.ResponseWriter, r *http.Request) {
	orgID, ok := parseUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	docID, ok := parseUUID(r, "docID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_doc_id", "invalid document id")
		return
	}
	uid, ok := identity.UserIDFrom(r.Context())
	uploadedBy := uuid.NullUUID{}
	if ok {
		uploadedBy = uuid.NullUUID{UUID: uid, Valid: true}
	}

	txns, err := h.classifier.ClassifyDocument(r.Context(), orgID, docID, uploadedBy)
	if err != nil {
		if errors.Is(err, errors.New("classify: document has no current extraction")) {
			httpx.WriteError(w, http.StatusUnprocessableEntity, "no_extraction", err.Error())
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "classify_failed", err.Error())
		return
	}

	out := make([]transactionResponse, 0, len(txns))
	for _, t := range txns {
		out = append(out, txnToResponse(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"transactions": out})
}

// ─── GET /orgs/{orgID}/transactions ───────────────────────────────────────

// ListTransactions returns paginated transactions for the org.
//
// tx filter: accepts an optional ?document_id=<uuid> query parameter so the
// detail view can fetch one document's transactions server-side instead of
// filtering client-side.
func (h *Handler) ListTransactions(w http.ResponseWriter, r *http.Request) {
	orgID, ok := parseUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	limit := 50
	offset := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			offset = n
		}
	}

	// tx filter: parse optional document_id query parameter.
	var documentID *uuid.UUID
	if v := r.URL.Query().Get("document_id"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_document_id", "document_id must be a valid UUID")
			return
		}
		documentID = &id
	}

	rows, err := ListTransactions(r.Context(), h.db, orgID, limit, offset, documentID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list transactions")
		return
	}

	out := make([]transactionListItem, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowToListItem(row))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"transactions": out})
}

// ─── Response types ────────────────────────────────────────────────────────

type transactionResponse struct {
	ID                      string    `json:"id"`
	OrganizationID          string    `json:"organization_id"`
	DocumentID              string    `json:"document_id,omitempty"`
	Merchant                string    `json:"merchant,omitempty"`
	MerchantNormalized      string    `json:"merchant_normalized,omitempty"`
	Amount                  *float64  `json:"amount,omitempty"`
	Currency                string    `json:"currency,omitempty"`
	Tax                     *float64  `json:"tax,omitempty"`
	PostedDate              string    `json:"posted_date,omitempty"`
	Direction               string    `json:"direction"`
	Status                  string    `json:"status"`
	CurrentClassificationID string    `json:"current_classification_id,omitempty"`
	CreatedAt               time.Time `json:"created_at,omitempty"`
}

type transactionListItem struct {
	ID                      string   `json:"id"`
	OrganizationID          string   `json:"organization_id"`
	DocumentID              string   `json:"document_id,omitempty"`
	Merchant                string   `json:"merchant,omitempty"`
	MerchantNormalized      string   `json:"merchant_normalized,omitempty"`
	Description             string   `json:"description,omitempty"`
	Amount                  *float64 `json:"amount,omitempty"`
	Currency                string   `json:"currency,omitempty"`
	PostedDate              string   `json:"posted_date,omitempty"`
	Direction               string   `json:"direction"`
	Status                  string   `json:"status"`
	ClassificationSource    string   `json:"classification_source,omitempty"`
	ClassificationConfidence *float64 `json:"classification_confidence,omitempty"`
	CategoryID              string   `json:"category_id,omitempty"`
	CategoryName            string   `json:"category_name,omitempty"`
}

func txnToResponse(t *Transaction) transactionResponse {
	r := transactionResponse{
		ID:             t.ID.String(),
		OrganizationID: t.OrganizationID.String(),
		Merchant:       t.Merchant,
		MerchantNormalized: t.MerchantNormalized,
		Amount:         t.Amount,
		Currency:       t.Currency,
		Tax:            t.Tax,
		Direction:      t.Direction,
		Status:         t.Status,
	}
	if t.DocumentID.Valid {
		r.DocumentID = t.DocumentID.UUID.String()
	}
	if t.PostedDate != nil {
		r.PostedDate = t.PostedDate.Format("2006-01-02")
	}
	if t.CurrentClassificationID.Valid {
		r.CurrentClassificationID = t.CurrentClassificationID.UUID.String()
	}
	return r
}

func rowToListItem(row TransactionRow) transactionListItem {
	item := transactionListItem{
		ID:             row.ID.String(),
		OrganizationID: row.OrganizationID.String(),
		Direction:      row.Direction,
		Status:         row.Status,
	}
	if row.DocumentID.Valid {
		item.DocumentID = row.DocumentID.UUID.String()
	}
	if row.Merchant.Valid {
		item.Merchant = row.Merchant.String
	}
	if row.MerchantNormalized.Valid {
		item.MerchantNormalized = row.MerchantNormalized.String
	}
	if row.Description.Valid {
		item.Description = row.Description.String
	}
	if row.Amount.Valid {
		v := row.Amount.Float64
		item.Amount = &v
	}
	if row.Currency.Valid {
		item.Currency = row.Currency.String
	}
	if row.PostedDate.Valid {
		item.PostedDate = row.PostedDate.Time.Format("2006-01-02")
	}
	if row.ClassSource.Valid {
		item.ClassificationSource = row.ClassSource.String
	}
	if row.ClassConfidence.Valid {
		v := row.ClassConfidence.Float64
		item.ClassificationConfidence = &v
	}
	if row.ClassCategoryID.Valid {
		item.CategoryID = row.ClassCategoryID.UUID.String()
	}
	if row.CategoryName.Valid {
		item.CategoryName = row.CategoryName.String
	}
	return item
}

// ─── Path helpers ─────────────────────────────────────────────────────────

func parseUUID(r *http.Request, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(param))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
