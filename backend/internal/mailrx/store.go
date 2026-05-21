// Package mailrx provides the inbound-mail SMTP server and its persistence
// layer. The DB half lives here so it can be tested without a live socket.
package mailrx

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// InboundEmail mirrors the inbound_emails row that we insert.
type InboundEmail struct {
	ID                 uuid.UUID
	OrganizationID     uuid.NullUUID
	MessageID          string
	FromAddress        string
	RecipientLocalPart string
	RecipientDomain    string
	Subject            string
	ReceivedByVM       string
	RawStorageURL      string
	SizeBytes          int64
	Status             string // received | processed | rejected | failed
	Error              sql.NullString
	ProcessedAt        sql.NullTime
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// Doc is a minimal representation of the documents row we insert per attachment.
type Doc struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	InboundEmailID uuid.NullUUID
	Source         string // always "email"
	Kind           string // always "unknown" initially
	StorageURL     string
	MimeType       string
	SizeBytes      int64
	OriginalName   string
	Status         string // always "pending" initially
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Store is the persistence layer for mailrx. It uses a plain *sql.DB so it is
// testable without a live socket — the same approach as internal/org and
// internal/document.
type Store struct{ db *sql.DB }

// NewStore creates a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// InsertInboundEmail persists a new inbound_emails row and returns it with
// server-generated fields (id, created_at, updated_at) filled in.
func (s *Store) InsertInboundEmail(ctx context.Context, e *InboundEmail) error {
	const q = `
		INSERT INTO inbound_emails (
			organization_id, message_id,
			from_address, recipient_local_part, recipient_domain,
			subject, received_by_vm, raw_storage_url, size_bytes,
			status, error
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, created_at, updated_at
	`
	return s.db.QueryRowContext(ctx, q,
		e.OrganizationID,
		e.MessageID,
		e.FromAddress,
		e.RecipientLocalPart,
		e.RecipientDomain,
		nullString(e.Subject),
		nullString(e.ReceivedByVM),
		nullString(e.RawStorageURL),
		nullInt64(e.SizeBytes),
		e.Status,
		e.Error,
	).Scan(&e.ID, &e.CreatedAt, &e.UpdatedAt)
}

// MarkEmailProcessed sets status='processed' or 'failed' on the given row.
func (s *Store) MarkEmailProcessed(ctx context.Context, id uuid.UUID, status string, errMsg string) error {
	var errVal sql.NullString
	if errMsg != "" {
		errVal = sql.NullString{String: errMsg, Valid: true}
	}
	var processedAt sql.NullTime
	if status == "processed" || status == "rejected" {
		processedAt = sql.NullTime{Time: time.Now().UTC(), Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE inbound_emails
		SET status = $2, processed_at = $3, error = $4
		WHERE id = $1
	`, id, status, processedAt, errVal)
	return err
}

// InsertDocument persists a new documents row for an email attachment.
func (s *Store) InsertDocument(ctx context.Context, d *Doc) error {
	const q = `
		INSERT INTO documents (
			organization_id, inbound_email_id, source, kind,
			storage_url, mime_type, size_bytes, original_name, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, created_at, updated_at
	`
	return s.db.QueryRowContext(ctx, q,
		d.OrganizationID,
		d.InboundEmailID,
		d.Source,
		d.Kind,
		d.StorageURL,
		nullString(d.MimeType),
		nullInt64(d.SizeBytes),
		nullString(d.OriginalName),
		d.Status,
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
}

// nullString converts a plain string to sql.NullString; empty → NULL.
func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// nullInt64 converts an int64 to sql.NullInt64; 0 → NULL.
func nullInt64(n int64) sql.NullInt64 {
	return sql.NullInt64{Int64: n, Valid: n > 0}
}

// storageKeyForEmail returns the B2 object key for a raw email.
func storageKeyForEmail(orgID uuid.UUID, msgID string) string {
	now := time.Now().UTC()
	safe := sanitizeForKey(msgID)
	return fmt.Sprintf("org/%s/email/%04d/%02d/%s.eml",
		orgID.String(), now.Year(), now.Month(), safe)
}

// storageKeyForAttachment returns the B2 object key for an email attachment.
func storageKeyForAttachment(orgID uuid.UUID, ext string) string {
	now := time.Now().UTC()
	return fmt.Sprintf("org/%s/%04d/%02d/%s%s",
		orgID.String(), now.Year(), now.Month(), uuid.NewString(), ext)
}

// sanitizeForKey replaces characters not safe in an S3 key with underscores.
func sanitizeForKey(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	if len(out) == 0 {
		return uuid.NewString()
	}
	if len(out) > 100 {
		out = out[:100]
	}
	return string(out)
}
