package document

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/auth"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
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

// PipelineFn is the auto-pipeline callback type. It is called asynchronously
// after a successful upload and must not panic. Errors are logged internally.
// auto-pipeline: injectable so tests can verify the trigger fires without
// making live Gemini calls.
type PipelineFn func(ctx context.Context, docID, orgID uuid.UUID, uploadedBy uuid.NullUUID)

type Handler struct {
	store    *Store
	storage  *storage.Client
	maxBytes int64
	// auto-pipeline: non-nil triggers extract+classify after each upload.
	pipeline PipelineFn
}

// NewHandler constructs an upload Handler. Pass nil for pipelineFn to
// disable auto-triggering (useful in tests that do not have Gemini).
func NewHandler(store *Store, st *storage.Client, pipelineFn PipelineFn) *Handler {
	return &Handler{store: store, storage: st, maxBytes: maxUploadBytes, pipeline: pipelineFn}
}

type documentResponse struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	UploadedBy     string    `json:"uploaded_by,omitempty"`
	ObjectKey      string    `json:"object_key"`
	ImageURL       string    `json:"image_url,omitempty"`
	MimeType       string    `json:"mime_type,omitempty"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// Upload accepts a multipart file under the "file" field, stores it in B2,
// persists a documents row, and returns 201 immediately.
//
// auto-pipeline: if a pipeline function is configured it is launched in a
// goroutine so extract+classify run asynchronously without blocking the HTTP
// response. Any pipeline failure is logged but never surfaces to the caller —
// the upload is already durable with status=pending.
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

	doc := &Document{
		OrganizationID: orgID,
		UploadedBy:     uuid.NullUUID{UUID: uid, Valid: true},
		ObjectKey:      objectKey,
		MimeType:       mime,
		SizeBytes:      int64(len(data)),
		Status:         StatusPending,
	}
	if err := h.store.Create(r.Context(), doc); err != nil {
		// Best-effort cleanup: remove the orphaned object from B2.
		_ = h.storage.Delete(r.Context(), objectKey)
		httpx.WriteError(w, http.StatusInternalServerError, "save_failed", "could not save document")
		return
	}

	// auto-pipeline: launch extract → classify in a background goroutine.
	// A fresh context gives the pipeline a 5-minute budget independent of
	// the HTTP request lifecycle. Failure is logged; the upload is unaffected.
	if h.pipeline != nil {
		uploadedBy := uuid.NullUUID{UUID: uid, Valid: true}
		docID := doc.ID // capture before goroutine
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			slog.InfoContext(bgCtx, "auto-pipeline: starting",
				"doc_id", docID.String(), "org_id", orgID.String())
			h.pipeline(bgCtx, docID, orgID, uploadedBy)
		}()
	}

	httpx.WriteJSON(w, http.StatusCreated, toResponse(doc, ""))
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

func toResponse(d *Document, imageURL string) documentResponse {
	r := documentResponse{
		ID:             d.ID.String(),
		OrganizationID: d.OrganizationID.String(),
		ObjectKey:      d.ObjectKey,
		ImageURL:       imageURL,
		MimeType:       d.MimeType,
		Status:         string(d.Status),
		CreatedAt:      d.CreatedAt,
		UpdatedAt:      d.UpdatedAt,
	}
	if d.UploadedBy.Valid {
		r.UploadedBy = d.UploadedBy.UUID.String()
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
