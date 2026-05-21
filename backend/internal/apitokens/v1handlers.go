package apitokens

// v1handlers.go – public /v1 surface: document ingest + transaction listing.
//
// These handlers are mounted at /v1/orgs/{orgID}/… and authenticated via the
// API-token middleware (not the JWT middleware used for internal endpoints).
// They reuse the existing document.Store, extract.Service, and
// classify.ListTransactions — no new business logic is reimplemented here.

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// ─── Scopes used by the public API ────────────────────────────────────────

const (
	ScopeDocumentsWrite   = "documents:write"
	ScopeTransactionsRead = "transactions:read"
)

// ─── Interfaces (avoid import cycles) ─────────────────────────────────────

// DocumentCreator is the subset of document.Store used here.
type DocumentCreator interface {
	CreateAPIDocument(ctx context.Context, d *APIDocument) error
}

// TransactionLister is satisfied by a small wrapper we ship in this file.
type TransactionLister interface {
	ListTransactionsForAPI(ctx context.Context, orgID uuid.UUID, limit, offset int) ([]APITransaction, error)
}

// ExtractionRunner is satisfied by extract.Service.Run.
type ExtractionRunner interface {
	Run(ctx context.Context, docID, orgID uuid.UUID) error
}

// StoragePutter writes bytes to object storage.
type StoragePutter interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
}

// ─── V1 document types ─────────────────────────────────────────────────────

// APIDocument mirrors the documents table fields we set on API upload.
type APIDocument struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	StorageURL     string
	MimeType       string
	SizeBytes      int64
	OriginalName   string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// APITransaction is the stable public shape for transaction list items.
// Version: v1 — do not change field names or remove fields without bumping
// the API version.
type APITransaction struct {
	ID              string   `json:"id"`
	OrganizationID  string   `json:"organization_id"`
	DocumentID      string   `json:"document_id,omitempty"`
	Merchant        string   `json:"merchant,omitempty"`
	Description     string   `json:"description,omitempty"`
	Amount          *float64 `json:"amount,omitempty"`
	Currency        string   `json:"currency,omitempty"`
	PostedDate      string   `json:"posted_date,omitempty"`
	Direction       string   `json:"direction"`
	Status          string   `json:"status"`
	CategoryName    string   `json:"category_name,omitempty"`
}

// ─── V1Handler ─────────────────────────────────────────────────────────────

// V1Handler handles the public /v1 endpoints.
type V1Handler struct {
	db      *sql.DB        // direct db access for transaction list
	storage StoragePutter
	extract ExtractionRunner
}

// NewV1Handler wires the /v1 handler.
func NewV1Handler(db *sql.DB, storage StoragePutter, extract ExtractionRunner) *V1Handler {
	return &V1Handler{db: db, storage: storage, extract: extract}
}

// ─── POST /v1/orgs/{orgID}/documents ──────────────────────────────────────

const (
	v1MaxUploadBytes = 10 << 20 // 10 MB
)

var v1AllowedMimes = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/heic":      ".heic",
	"image/heif":      ".heif",
	"application/pdf": ".pdf",
}

type v1DocumentResponse struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	Source         string    `json:"source"`    // always "api"
	Status         string    `json:"status"`    // "pending" (extraction starts async)
	StorageURL     string    `json:"storage_url"`
	MimeType       string    `json:"mime_type,omitempty"`
	SizeBytes      int64     `json:"size_bytes,omitempty"`
	OriginalName   string    `json:"original_name,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// CreateDocument handles POST /v1/orgs/{orgID}/documents.
// Accepts multipart/form-data with a "file" field.
// The document is persisted with source='api' and extraction is triggered
// asynchronously — the response returns immediately with status="pending".
func (h *V1Handler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromV1Path(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	tok, ok := TokenFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "API token required")
		return
	}
	// Belt-and-suspenders scope check (middleware should already have enforced
	// this, but be explicit at the handler level).
	if !tok.HasScope(ScopeDocumentsWrite) {
		httpx.WriteError(w, http.StatusForbidden, "insufficient_scope",
			"token requires '"+ScopeDocumentsWrite+"' scope")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, v1MaxUploadBytes)
	if err := r.ParseMultipartForm(v1MaxUploadBytes); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_upload",
			"could not parse multipart form (max 10 MB)")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "missing_file", `expected a file under field "file"`)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "read_failed", "could not read uploaded file")
		return
	}

	mime := normalizeMimeV1(header.Header.Get("Content-Type"))
	ext, ok := v1AllowedMimes[mime]
	if !ok {
		httpx.WriteError(w, http.StatusUnsupportedMediaType, "unsupported_type",
			"file must be image/jpeg, image/png, image/webp, image/heic, or application/pdf")
		return
	}

	now := time.Now().UTC()
	docID := uuid.New()
	objectKey := fmt.Sprintf("org/%s/%04d/%02d/%s%s",
		orgID.String(), now.Year(), now.Month(), docID.String(), ext)

	if err := h.storage.Put(r.Context(), objectKey, data, mime); err != nil {
		httpx.WriteError(w, http.StatusBadGateway, "storage_failed", "could not store file")
		return
	}

	// Insert the documents row with source='api'.
	const insertQ = `
		INSERT INTO documents
			(id, organization_id, source, storage_url, mime_type, size_bytes,
			 original_name, status)
		VALUES ($1, $2, 'api', $3, $4, $5, $6, 'pending')
		RETURNING id, created_at, updated_at
	`
	var createdAt, updatedAt time.Time
	err = h.db.QueryRowContext(r.Context(), insertQ,
		docID, orgID, objectKey, mime, int64(len(data)), header.Filename,
	).Scan(&docID, &createdAt, &updatedAt)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "save_failed", "could not save document")
		return
	}

	// Trigger extraction asynchronously so the HTTP response is fast.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := h.extract.Run(ctx, docID, orgID); err != nil {
			// Logged inside extract.Service.Run; no further action needed here.
			_ = err
		}
	}()

	httpx.WriteJSON(w, http.StatusCreated, v1DocumentResponse{
		ID:             docID.String(),
		OrganizationID: orgID.String(),
		Source:         "api",
		Status:         "pending",
		StorageURL:     objectKey,
		MimeType:       mime,
		SizeBytes:      int64(len(data)),
		OriginalName:   header.Filename,
		CreatedAt:      createdAt,
	})
}

// ─── GET /v1/orgs/{orgID}/transactions ─────────────────────────────────────

// ListTransactions handles GET /v1/orgs/{orgID}/transactions.
// Returns a stable paginated list of the org's transactions.
func (h *V1Handler) ListTransactions(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromV1Path(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	tok, ok := TokenFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "missing_token", "API token required")
		return
	}
	if !tok.HasScope(ScopeTransactionsRead) {
		httpx.WriteError(w, http.StatusForbidden, "insufficient_scope",
			"token requires '"+ScopeTransactionsRead+"' scope")
		return
	}

	limit := 50
	offset := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	txns, err := h.listTransactions(r.Context(), orgID, limit, offset)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list transactions")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"transactions": txns,
		"limit":        limit,
		"offset":       offset,
	})
}

// listTransactions queries the transactions table directly, joining the
// current classification + category name.  This mirrors classify.ListTransactions
// without importing that package (to keep the dependency graph clean).
func (h *V1Handler) listTransactions(ctx context.Context, orgID uuid.UUID, limit, offset int) ([]APITransaction, error) {
	const q = `
		SELECT
			t.id, t.organization_id, t.document_id,
			t.merchant, t.description,
			t.amount, t.currency, t.posted_date,
			t.direction, t.status,
			c.name
		FROM transactions t
		LEFT JOIN transaction_classifications tc
			ON tc.id = t.current_classification_id
		LEFT JOIN categories c
			ON c.id = tc.category_id
		WHERE t.organization_id = $1
		ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
		LIMIT $2 OFFSET $3
	`
	rows, err := h.db.QueryContext(ctx, q, orgID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []APITransaction
	for rows.Next() {
		var (
			id             uuid.UUID
			orgIDScan      uuid.UUID
			docID          uuid.NullUUID
			merchant       sql.NullString
			description    sql.NullString
			amount         sql.NullFloat64
			currency       sql.NullString
			postedDate     sql.NullTime
			direction      string
			status         string
			categoryName   sql.NullString
		)
		if err := rows.Scan(
			&id, &orgIDScan, &docID,
			&merchant, &description,
			&amount, &currency, &postedDate,
			&direction, &status,
			&categoryName,
		); err != nil {
			return nil, err
		}
		txn := APITransaction{
			ID:             id.String(),
			OrganizationID: orgIDScan.String(),
			Direction:      direction,
			Status:         status,
		}
		if docID.Valid {
			txn.DocumentID = docID.UUID.String()
		}
		if merchant.Valid {
			txn.Merchant = merchant.String
		}
		if description.Valid {
			txn.Description = description.String
		}
		if amount.Valid {
			v := amount.Float64
			txn.Amount = &v
		}
		if currency.Valid {
			txn.Currency = strings.TrimSpace(currency.String)
		}
		if postedDate.Valid {
			txn.PostedDate = postedDate.Time.Format("2006-01-02")
		}
		if categoryName.Valid {
			txn.CategoryName = categoryName.String
		}
		out = append(out, txn)
	}
	return out, rows.Err()
}

// ─── helpers ──────────────────────────────────────────────────────────────

func orgIDFromV1Path(r *http.Request) (uuid.UUID, bool) {
	tok, ok := TokenFrom(r.Context())
	if !ok {
		return uuid.Nil, false
	}
	raw := r.PathValue("orgID")
	if raw == "" {
		return tok.OrganizationID, true
	}
	pathID, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	// Tokens are org-scoped: reject cross-org access.
	if pathID != tok.OrganizationID {
		return uuid.Nil, false
	}
	return tok.OrganizationID, true
}

func normalizeMimeV1(s string) string {
	if i := strings.IndexByte(s, ';'); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(strings.TrimSpace(s))
}

