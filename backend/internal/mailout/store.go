// Package mailout implements the outbox store, enqueue queue, and background
// delivery worker for durable transactional email via Amazon SES.
package mailout

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Job represents one row from email_outbox that has been claimed for delivery.
type Job struct {
	ID          uuid.UUID
	ToAddress   string
	FromAddress string
	Subject     string
	HTMLBody    string
	TextBody    string
	EmailKind   string
	Attempts    int
	MaxAttempts int
}

// EnqueueParams holds the data needed to insert a new email_outbox row.
type EnqueueParams struct {
	ToAddress      string
	FromAddress    string
	Subject        string
	HTMLBody       string
	TextBody       string
	EmailKind      string
	OrganizationID *uuid.UUID
	UserID         *uuid.UUID
	IdempotencyKey string // empty → no uniqueness guard
}

// Store is a sql.DB-backed outbox repository.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store backed by db.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Enqueue inserts a new pending row into email_outbox.
// When params.IdempotencyKey is non-empty, a duplicate insert is silently
// ignored (ON CONFLICT DO NOTHING).
func (s *Store) Enqueue(ctx context.Context, p EnqueueParams) error {
	const q = `
INSERT INTO email_outbox
    (to_address, from_address, subject, html_body, text_body, email_kind,
     organization_id, user_id, idempotency_key)
VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''))
ON CONFLICT (idempotency_key) DO NOTHING`

	var orgID, userID interface{}
	if p.OrganizationID != nil {
		orgID = *p.OrganizationID
	}
	if p.UserID != nil {
		userID = *p.UserID
	}

	_, err := s.db.ExecContext(ctx, q,
		p.ToAddress, p.FromAddress, p.Subject,
		p.HTMLBody, p.TextBody, p.EmailKind,
		orgID, userID, p.IdempotencyKey,
	)
	if err != nil {
		return fmt.Errorf("mailout: enqueue: %w", err)
	}
	return nil
}

// ClaimDue selects up to limit due rows (status pending or failed,
// next_attempt_at <= now()), marks them sending, and returns them.
// The update is done inside a transaction with FOR UPDATE SKIP LOCKED
// so concurrent workers never claim the same row.
func (s *Store) ClaimDue(ctx context.Context, limit int) ([]Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("mailout: begin claim tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	const selectQ = `
SELECT id, to_address, from_address, subject,
       COALESCE(html_body, ''), COALESCE(text_body, ''),
       email_kind, attempts, max_attempts
FROM   email_outbox
WHERE  status IN ('pending', 'failed')
  AND  next_attempt_at <= now()
ORDER  BY next_attempt_at
FOR    UPDATE SKIP LOCKED
LIMIT  $1`

	rows, err := tx.QueryContext(ctx, selectQ, limit)
	if err != nil {
		return nil, fmt.Errorf("mailout: claim query: %w", err)
	}
	defer rows.Close()

	var jobs []Job
	var ids []uuid.UUID
	for rows.Next() {
		var j Job
		if err := rows.Scan(
			&j.ID, &j.ToAddress, &j.FromAddress, &j.Subject,
			&j.HTMLBody, &j.TextBody,
			&j.EmailKind, &j.Attempts, &j.MaxAttempts,
		); err != nil {
			return nil, fmt.Errorf("mailout: claim scan: %w", err)
		}
		jobs = append(jobs, j)
		ids = append(ids, j.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mailout: claim rows: %w", err)
	}

	if len(ids) == 0 {
		return nil, tx.Commit()
	}

	// Build WHERE id IN ($1, $2, ...) for stdlib pgx compatibility.
	updateSQL, args := buildInClause(ids)
	if _, err := tx.ExecContext(ctx, updateSQL, args...); err != nil {
		return nil, fmt.Errorf("mailout: claim update: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("mailout: claim commit: %w", err)
	}
	return jobs, nil
}

// buildInClause constructs "UPDATE email_outbox SET status='sending', updated_at=now() WHERE id IN ($1,$2,...)"
// with positional placeholders for the stdlib pgx driver.
func buildInClause(ids []uuid.UUID) (string, []interface{}) {
	args := make([]interface{}, len(ids))
	placeholders := make([]byte, 0, len(ids)*5)
	for i, id := range ids {
		if i > 0 {
			placeholders = append(placeholders, ',')
		}
		placeholders = append(placeholders, '$')
		// itoa inline
		n := i + 1
		var buf [10]byte
		pos := 10
		for n >= 10 {
			pos--
			buf[pos] = byte(n%10) + '0'
			n /= 10
		}
		pos--
		buf[pos] = byte(n) + '0'
		placeholders = append(placeholders, buf[pos:]...)
		args[i] = id
	}
	q := "UPDATE email_outbox SET status = 'sending', updated_at = now() WHERE id IN (" +
		string(placeholders) + ")"
	return q, args
}

// MarkSent marks job id as sent and records the provider message id.
func (s *Store) MarkSent(ctx context.Context, id uuid.UUID, providerMessageID string) error {
	const q = `
UPDATE email_outbox
SET    status = 'sent',
       provider_message_id = $2,
       sent_at = now(),
       updated_at = now()
WHERE  id = $1`
	if _, err := s.db.ExecContext(ctx, q, id, providerMessageID); err != nil {
		return fmt.Errorf("mailout: mark sent %s: %w", id, err)
	}
	return nil
}

// MarkRetry increments the attempt counter and schedules the next delivery.
func (s *Store) MarkRetry(ctx context.Context, id uuid.UUID, attempts int, nextAttemptAt time.Time, lastErr string) error {
	const q = `
UPDATE email_outbox
SET    status = 'failed',
       attempts = $2,
       next_attempt_at = $3,
       last_error = $4,
       updated_at = now()
WHERE  id = $1`
	if _, err := s.db.ExecContext(ctx, q, id, attempts, nextAttemptAt, lastErr); err != nil {
		return fmt.Errorf("mailout: mark retry %s: %w", id, err)
	}
	return nil
}

// MarkDead moves the row to dead status (no further delivery attempts).
func (s *Store) MarkDead(ctx context.Context, id uuid.UUID, lastErr string) error {
	const q = `
UPDATE email_outbox
SET    status = 'dead',
       last_error = $2,
       updated_at = now()
WHERE  id = $1`
	if _, err := s.db.ExecContext(ctx, q, id, lastErr); err != nil {
		return fmt.Errorf("mailout: mark dead %s: %w", id, err)
	}
	return nil
}

// IsSuppressed reports whether address is on the email_suppressions list.
func (s *Store) IsSuppressed(ctx context.Context, address string) (bool, error) {
	const q = `SELECT EXISTS(SELECT 1 FROM email_suppressions WHERE address = $1)`
	var exists bool
	if err := s.db.QueryRowContext(ctx, q, address).Scan(&exists); err != nil {
		return false, fmt.Errorf("mailout: is suppressed %s: %w", address, err)
	}
	return exists, nil
}

// Suppress upserts address into email_suppressions.
// reason should be one of "bounce", "complaint", or "manual".
// address is trimmed of leading/trailing whitespace; CITEXT handles
// case-insensitive matching on the database side.
func (s *Store) Suppress(ctx context.Context, address, reason, detail string) error {
	const q = `
INSERT INTO email_suppressions (address, reason, detail)
VALUES ($1, $2, $3)
ON CONFLICT (address) DO UPDATE
    SET reason = EXCLUDED.reason,
        detail = EXCLUDED.detail`
	address = strings.TrimSpace(address)
	if _, err := s.db.ExecContext(ctx, q, address, reason, detail); err != nil {
		return fmt.Errorf("mailout: suppress %s: %w", address, err)
	}
	return nil
}
