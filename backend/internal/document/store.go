// Package document persists uploaded receipts and the structured data Gemini
// extracted from them. Rows live in the existing `transactions` table — this
// package gives that table a receipt-shaped Go API.
package document

import (
	"context"
	"database/sql"
	"encoding/json"
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

type Document struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	UploadedBy      uuid.NullUUID
	ObjectKey       string
	Merchant        sql.NullString
	Amount          sql.NullFloat64
	Currency        sql.NullString
	TransactionDate sql.NullTime
	Tax             sql.NullFloat64
	PaymentMethod   sql.NullString
	Category        sql.NullString
	RawExtraction   json.RawMessage
	Notes           sql.NullString
	Status          Status
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Create(ctx context.Context, d *Document) error {
	const q = `
		INSERT INTO transactions (
			organization_id, uploaded_by, document_url,
			merchant, amount, currency, transaction_date,
			tax, payment_method, category, raw_extraction, notes, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id, created_at, updated_at
	`
	return s.db.QueryRowContext(ctx, q,
		d.OrganizationID, d.UploadedBy, d.ObjectKey,
		d.Merchant, d.Amount, d.Currency, d.TransactionDate,
		d.Tax, d.PaymentMethod, d.Category, d.RawExtraction, d.Notes, d.Status,
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
}

func (s *Store) ListByOrg(ctx context.Context, orgID uuid.UUID, limit int) ([]Document, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	const q = `
		SELECT id, organization_id, uploaded_by, document_url,
		       merchant, amount, currency, transaction_date,
		       tax, payment_method, category, raw_extraction, notes, status,
		       created_at, updated_at
		FROM transactions
		WHERE organization_id = $1
		ORDER BY transaction_date DESC NULLS LAST, created_at DESC
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

func (s *Store) GetByID(ctx context.Context, id, orgID uuid.UUID) (*Document, error) {
	const q = `
		SELECT id, organization_id, uploaded_by, document_url,
		       merchant, amount, currency, transaction_date,
		       tax, payment_method, category, raw_extraction, notes, status,
		       created_at, updated_at
		FROM transactions
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
	// raw_extraction is JSONB and may be NULL. Scan via []byte because
	// json.RawMessage isn't a sql.Scanner and rejects NULL with
	// "unsupported Scan, storing driver.Value type <nil>".
	var raw []byte
	if err := r.Scan(
		&d.ID, &d.OrganizationID, &d.UploadedBy, &d.ObjectKey,
		&d.Merchant, &d.Amount, &d.Currency, &d.TransactionDate,
		&d.Tax, &d.PaymentMethod, &d.Category, &raw, &d.Notes, &d.Status,
		&d.CreatedAt, &d.UpdatedAt,
	); err != nil {
		return err
	}
	if raw != nil {
		d.RawExtraction = json.RawMessage(raw)
	}
	return nil
}
