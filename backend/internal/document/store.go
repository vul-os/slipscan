// Package document persists uploaded receipts into the `documents` table so
// the extraction pipeline (internal/extract) can process them.
package document

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

type Status string

const (
	StatusPending  Status = "pending"
	StatusVerified Status = "verified"
	StatusRejected Status = "rejected"
)

var ErrNotFound = errors.New("document not found")

// Document mirrors the minimal columns of the `documents` table needed by
// the upload handler. Extraction results live in document_extractions.
type Document struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	UploadedBy     uuid.NullUUID
	ObjectKey      string // maps to documents.storage_url
	MimeType       string
	SizeBytes      int64
	Status         Status
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create inserts a new row into the `documents` table.
// The extract pipeline reads this table by document id.
func (s *Store) Create(ctx context.Context, d *Document) error {
	const q = `
		INSERT INTO documents (
			organization_id, uploaded_by, source, kind,
			storage_url, mime_type, size_bytes, status
		) VALUES ($1, $2, 'upload', 'unknown', $3, $4, $5, $6)
		RETURNING id, created_at, updated_at
	`
	return s.db.QueryRowContext(ctx, q,
		d.OrganizationID, d.UploadedBy, d.ObjectKey,
		nullString(d.MimeType), nullInt64(d.SizeBytes), string(d.Status),
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
}

// ListByOrg returns documents for the org ordered newest first.
func (s *Store) ListByOrg(ctx context.Context, orgID uuid.UUID, limit int) ([]Document, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	const q = `
		SELECT id, organization_id, uploaded_by,
		       storage_url, COALESCE(mime_type,''), COALESCE(size_bytes,0),
		       status, created_at, updated_at
		FROM documents
		WHERE organization_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Document
	for rows.Next() {
		var d Document
		if err := scanDocument(rows, &d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetByID fetches one document, verifying org ownership.
func (s *Store) GetByID(ctx context.Context, id, orgID uuid.UUID) (*Document, error) {
	const q = `
		SELECT id, organization_id, uploaded_by,
		       storage_url, COALESCE(mime_type,''), COALESCE(size_bytes,0),
		       status, created_at, updated_at
		FROM documents
		WHERE id = $1 AND organization_id = $2
	`
	var d Document
	row := s.db.QueryRowContext(ctx, q, id, orgID)
	if err := scanDocument(row, &d); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &d, nil
}

// scanner is the shared interface of *sql.Row and *sql.Rows so we can
// scan a Document from either a single-row Get or a multi-row List.
type scanner interface {
	Scan(dest ...any) error
}

func scanDocument(r scanner, d *Document) error {
	return r.Scan(
		&d.ID, &d.OrganizationID, &d.UploadedBy,
		&d.ObjectKey, &d.MimeType, &d.SizeBytes,
		&d.Status, &d.CreatedAt, &d.UpdatedAt,
	)
}

// nullString converts a plain string to sql.NullString; empty → NULL.
func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// nullInt64 converts an int64 to sql.NullInt64; 0 → NULL.
func nullInt64(n int64) sql.NullInt64 {
	return sql.NullInt64{Int64: n, Valid: n > 0}
}
