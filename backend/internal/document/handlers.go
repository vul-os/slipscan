package document

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/auth"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/ocr"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

const (
	maxUploadBytes      = 10 << 20 // 10 MB
	presignTTL          = 10 * time.Minute
	uploadFormFieldName = "file"
)

var allowedMimes = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/heic":      ".heic",
	"image/heif":      ".heif",
	"application/pdf": ".pdf",
}

type Handler struct {
	store    *Store
	storage  *storage.Client
	ocr      *ocr.Client
	maxBytes int64
}

func NewHandler(store *Store, st *storage.Client, oc *ocr.Client) *Handler {
	return &Handler{store: store, storage: st, ocr: oc, maxBytes: maxUploadBytes}
}

type documentResponse struct {
	ID              string          `json:"id"`
	OrganizationID  string          `json:"organization_id"`
	UploadedBy      string          `json:"uploaded_by,omitempty"`
	ObjectKey       string          `json:"object_key"`
	ImageURL        string          `json:"image_url,omitempty"`
	Merchant        string          `json:"merchant,omitempty"`
	Amount          *float64        `json:"amount,omitempty"`
	Currency        string          `json:"currency,omitempty"`
	TransactionDate string          `json:"transaction_date,omitempty"`
	Tax             *float64        `json:"tax,omitempty"`
	PaymentMethod   string          `json:"payment_method,omitempty"`
	Category        string          `json:"category,omitempty"`
	Notes           string          `json:"notes,omitempty"`
	Status          string          `json:"status"`
	RawExtraction   json.RawMessage `json:"raw_extraction,omitempty"`
	ExtractionError string          `json:"extraction_error,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
}

// Upload accepts a multipart file under the "file" field, writes it to B2,
// runs Gemini extraction synchronously, persists the result, and returns
// the saved document. If extraction fails the document is still saved
// with status="pending" and extraction_error set.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing identity")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)
	if err := r.ParseMultipartForm(h.maxBytes); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_upload", "could not parse multipart form (max 10MB)")
		return
	}
	file, header, err := r.FormFile(uploadFormFieldName)
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
	mime := normalizeMime(header.Header.Get("Content-Type"))
	ext, ok := allowedMimes[mime]
	if !ok {
		httpx.WriteError(w, http.StatusUnsupportedMediaType, "unsupported_type",
			"file must be image/jpeg, image/png, image/webp, image/heic, or application/pdf")
		return
	}

	// Object key: org/{orgID}/{YYYY/MM}/{uuid}{ext}. Date partition keeps
	// the bucket browsable; the UUID prevents collisions.
	now := time.Now().UTC()
	objectKey := fmt.Sprintf("org/%s/%04d/%02d/%s%s",
		orgID.String(), now.Year(), now.Month(), uuid.NewString(), ext)

	if err := h.storage.Put(r.Context(), objectKey, data, mime); err != nil {
		httpx.WriteError(w, http.StatusBadGateway, "storage_failed", "could not store file")
		return
	}

	// Run extraction. Gemini errors don't block the upload — we save the
	// row with status=pending so the image isn't orphaned.
	extractCtx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	receipt, rawJSON, extractErr := h.ocr.Extract(extractCtx, data, mime)

	doc := &Document{
		OrganizationID: orgID,
		UploadedBy:     uuid.NullUUID{UUID: uid, Valid: true},
		ObjectKey:      objectKey,
		Status:         StatusPending,
	}
	if extractErr == nil {
		applyReceipt(doc, receipt, rawJSON)
	}
	if err := h.store.Create(r.Context(), doc); err != nil {
		// We already wrote to B2; rolling that back leaves the bucket clean
		// but we don't want a row mismatch. Best effort cleanup.
		_ = h.storage.Delete(r.Context(), objectKey)
		httpx.WriteError(w, http.StatusInternalServerError, "save_failed", "could not save document")
		return
	}

	resp := toResponse(doc, "")
	if extractErr != nil {
		resp.ExtractionError = extractErr.Error()
	}
	httpx.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	docs, err := h.store.ListByOrg(r.Context(), orgID, limit)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list documents")
		return
	}

	out := make([]documentResponse, 0, len(docs))
	for i := range docs {
		out = append(out, toResponse(&docs[i], ""))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"documents": out})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	orgID, ok := orgIDFromPath(r)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	id, err := uuid.Parse(r.PathValue("docID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_doc_id", "invalid document id")
		return
	}

	doc, err := h.store.GetByID(r.Context(), id, orgID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "document not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "lookup_failed", "could not load document")
		return
	}

	imageURL, err := h.storage.PresignGet(r.Context(), doc.ObjectKey, presignTTL)
	if err != nil {
		// Presigning failure shouldn't fail the read entirely; just skip the URL.
		imageURL = ""
	}
	httpx.WriteJSON(w, http.StatusOK, toResponse(doc, imageURL))
}

func applyReceipt(d *Document, r *ocr.Receipt, raw json.RawMessage) {
	d.RawExtraction = raw
	if r == nil {
		return
	}
	if r.Merchant != nil {
		d.Merchant = sql.NullString{String: *r.Merchant, Valid: true}
	}
	if r.Total != nil {
		d.Amount = sql.NullFloat64{Float64: *r.Total, Valid: true}
	}
	if r.Currency != nil {
		c := strings.ToUpper(strings.TrimSpace(*r.Currency))
		if len(c) == 3 {
			d.Currency = sql.NullString{String: c, Valid: true}
		}
	}
	if r.Date != nil {
		if t, err := time.Parse("2006-01-02", *r.Date); err == nil {
			d.TransactionDate = sql.NullTime{Time: t, Valid: true}
		}
	}
	if r.Tax != nil {
		d.Tax = sql.NullFloat64{Float64: *r.Tax, Valid: true}
	}
	if r.PaymentMethod != nil {
		d.PaymentMethod = sql.NullString{String: *r.PaymentMethod, Valid: true}
	}
	if r.Category != nil && *r.Category != "" {
		d.Category = sql.NullString{String: strings.ToLower(strings.TrimSpace(*r.Category)), Valid: true}
	}
	if r.Notes != nil {
		d.Notes = sql.NullString{String: *r.Notes, Valid: true}
	}
}

func toResponse(d *Document, imageURL string) documentResponse {
	r := documentResponse{
		ID:             d.ID.String(),
		OrganizationID: d.OrganizationID.String(),
		ObjectKey:      d.ObjectKey,
		ImageURL:       imageURL,
		Status:         string(d.Status),
		RawExtraction:  d.RawExtraction,
		CreatedAt:      d.CreatedAt,
		UpdatedAt:      d.UpdatedAt,
	}
	if d.UploadedBy.Valid {
		r.UploadedBy = d.UploadedBy.UUID.String()
	}
	if d.Merchant.Valid {
		r.Merchant = d.Merchant.String
	}
	if d.Amount.Valid {
		v := d.Amount.Float64
		r.Amount = &v
	}
	if d.Currency.Valid {
		r.Currency = d.Currency.String
	}
	if d.TransactionDate.Valid {
		r.TransactionDate = d.TransactionDate.Time.Format("2006-01-02")
	}
	if d.Tax.Valid {
		v := d.Tax.Float64
		r.Tax = &v
	}
	if d.PaymentMethod.Valid {
		r.PaymentMethod = d.PaymentMethod.String
	}
	if d.Category.Valid {
		r.Category = d.Category.String
	}
	if d.Notes.Valid {
		r.Notes = d.Notes.String
	}
	return r
}

// normalizeMime drops any "; charset=..." trailing on a Content-Type.
func normalizeMime(s string) string {
	if i := strings.IndexByte(s, ';'); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(strings.TrimSpace(s))
}

func orgIDFromPath(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("orgID"))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
