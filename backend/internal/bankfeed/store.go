package bankfeed

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrConnectionNotFound is returned when no bank_feed_connections row exists
// for the requested key.
var ErrConnectionNotFound = errors.New("bank feed connection not found")

// ErrDuplicate is returned by UpsertLine when the provider_txn_id already
// exists for the connection (idempotent: caller should skip, not abort).
var ErrDuplicate = errors.New("provider transaction already imported")

// Connection mirrors a bank_feed_connections row.
type Connection struct {
	ID                    uuid.UUID
	OrganizationID        uuid.UUID
	AccountID             uuid.NullUUID
	CreatedBy             uuid.NullUUID
	Provider              string
	ProviderItemID        string
	ProviderAccountID     string
	InstitutionName       string
	InstitutionID         string
	Mask                  string
	AccessTokenEncrypted  string
	RefreshTokenEncrypted string
	Cursor                string
	Status                FeedStatus
	ErrorCode             sql.NullString
	ErrorMessage          sql.NullString
	LastSyncedAt          sql.NullTime
	ConsentExpiresAt      sql.NullTime
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// Store handles all DB access for the bankfeed package.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store backed by the given *sql.DB pool.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─── Connection operations ────────────────────────────────────────────────────

// CreateConnection inserts (or upserts on re-link) a bank_feed_connections row.
// provider is the short ProviderName string matching the bank_feed_provider enum.
func (s *Store) CreateConnection(ctx context.Context, orgID, userID uuid.UUID, provider ProviderName, la LinkedAccount, accessEnc, refreshEnc string, consentExp *time.Time) (*Connection, error) {
	var consentExpVal interface{}
	if consentExp != nil {
		consentExpVal = *consentExp
	}

	const q = `
		INSERT INTO bank_feed_connections (
			organization_id, created_by, provider,
			provider_item_id, provider_account_id,
			institution_name, institution_id, mask,
			access_token_encrypted, refresh_token_encrypted,
			status, consent_expires_at
		) VALUES (
			$1, $2, $3::bank_feed_provider,
			$4, $5,
			$6, $7, $8,
			$9, $10,
			'pending'::bank_feed_status, $11
		)
		ON CONFLICT (provider, provider_item_id, provider_account_id) DO UPDATE
		SET access_token_encrypted  = EXCLUDED.access_token_encrypted,
		    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
		    consent_expires_at      = EXCLUDED.consent_expires_at,
		    status                  = 'pending'::bank_feed_status,
		    error_code              = NULL,
		    error_message           = NULL,
		    updated_at              = NOW()
		RETURNING id, organization_id, provider, provider_item_id, provider_account_id,
		          institution_name, institution_id, mask, status, created_at, updated_at
	`
	conn := &Connection{}
	var providerStr, statusStr string
	err := s.db.QueryRowContext(ctx, q,
		orgID, userID, string(provider),
		la.ProviderItemID, la.ProviderAccountID,
		la.InstitutionName, la.InstitutionID, la.Mask,
		accessEnc, refreshEnc,
		consentExpVal,
	).Scan(
		&conn.ID, &conn.OrganizationID, &providerStr,
		&conn.ProviderItemID, &conn.ProviderAccountID,
		&conn.InstitutionName, &conn.InstitutionID, &conn.Mask,
		&statusStr, &conn.CreatedAt, &conn.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	conn.Provider = providerStr
	conn.Status = FeedStatus(statusStr)
	conn.AccessTokenEncrypted = accessEnc
	conn.RefreshTokenEncrypted = refreshEnc
	return conn, nil
}

// GetConnection returns a bank_feed_connections row by ID and org.
func (s *Store) GetConnection(ctx context.Context, orgID, connID uuid.UUID) (*Connection, error) {
	const q = `
		SELECT id, organization_id, account_id, created_by,
		       provider, provider_item_id, provider_account_id,
		       institution_name, institution_id, mask,
		       access_token_encrypted, refresh_token_encrypted,
		       COALESCE(cursor, ''), status,
		       error_code, error_message, last_synced_at, consent_expires_at,
		       created_at, updated_at
		FROM bank_feed_connections
		WHERE organization_id = $1 AND id = $2
	`
	var c Connection
	var providerStr, statusStr string
	err := s.db.QueryRowContext(ctx, q, orgID, connID).Scan(
		&c.ID, &c.OrganizationID, &c.AccountID, &c.CreatedBy,
		&providerStr, &c.ProviderItemID, &c.ProviderAccountID,
		&c.InstitutionName, &c.InstitutionID, &c.Mask,
		&c.AccessTokenEncrypted, &c.RefreshTokenEncrypted,
		&c.Cursor, &statusStr,
		&c.ErrorCode, &c.ErrorMessage, &c.LastSyncedAt, &c.ConsentExpiresAt,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrConnectionNotFound
	}
	if err != nil {
		return nil, err
	}
	c.Provider = providerStr
	c.Status = FeedStatus(statusStr)
	return &c, nil
}

// ListConnections returns all bank_feed_connections for an org.
func (s *Store) ListConnections(ctx context.Context, orgID uuid.UUID) ([]Connection, error) {
	const q = `
		SELECT id, organization_id, account_id, created_by,
		       provider, provider_item_id, provider_account_id,
		       institution_name, institution_id, mask,
		       access_token_encrypted, refresh_token_encrypted,
		       COALESCE(cursor, ''), status,
		       error_code, error_message, last_synced_at, consent_expires_at,
		       created_at, updated_at
		FROM bank_feed_connections
		WHERE organization_id = $1
		ORDER BY created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		var c Connection
		var providerStr, statusStr string
		if err := rows.Scan(
			&c.ID, &c.OrganizationID, &c.AccountID, &c.CreatedBy,
			&providerStr, &c.ProviderItemID, &c.ProviderAccountID,
			&c.InstitutionName, &c.InstitutionID, &c.Mask,
			&c.AccessTokenEncrypted, &c.RefreshTokenEncrypted,
			&c.Cursor, &statusStr,
			&c.ErrorCode, &c.ErrorMessage, &c.LastSyncedAt, &c.ConsentExpiresAt,
			&c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		c.Provider = providerStr
		c.Status = FeedStatus(statusStr)
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListDueConnections returns connected accounts eligible for a poll cycle.
// "Due" means last_synced_at is more than minAge ago (or never synced).
func (s *Store) ListDueConnections(ctx context.Context, minAge time.Duration) ([]Connection, error) {
	const q = `
		SELECT id, organization_id, account_id, created_by,
		       provider, provider_item_id, provider_account_id,
		       institution_name, institution_id, mask,
		       access_token_encrypted, refresh_token_encrypted,
		       COALESCE(cursor, ''), status,
		       error_code, error_message, last_synced_at, consent_expires_at,
		       created_at, updated_at
		FROM bank_feed_connections
		WHERE status = 'connected'::bank_feed_status
		  AND (last_synced_at IS NULL OR last_synced_at < NOW() - $1::interval)
		ORDER BY last_synced_at ASC NULLS FIRST
	`
	interval := formatDuration(minAge)
	rows, err := s.db.QueryContext(ctx, q, interval)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		var c Connection
		var providerStr, statusStr string
		if err := rows.Scan(
			&c.ID, &c.OrganizationID, &c.AccountID, &c.CreatedBy,
			&providerStr, &c.ProviderItemID, &c.ProviderAccountID,
			&c.InstitutionName, &c.InstitutionID, &c.Mask,
			&c.AccessTokenEncrypted, &c.RefreshTokenEncrypted,
			&c.Cursor, &statusStr,
			&c.ErrorCode, &c.ErrorMessage, &c.LastSyncedAt, &c.ConsentExpiresAt,
			&c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		c.Provider = providerStr
		c.Status = FeedStatus(statusStr)
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateConnectionStatus sets status (and optional error fields) for a connection.
func (s *Store) UpdateConnectionStatus(ctx context.Context, connID uuid.UUID, status FeedStatus, errCode, errMsg string) error {
	const q = `
		UPDATE bank_feed_connections
		SET status        = $2::bank_feed_status,
		    error_code    = NULLIF($3, ''),
		    error_message = NULLIF($4, ''),
		    updated_at    = NOW()
		WHERE id = $1
	`
	_, err := s.db.ExecContext(ctx, q, connID, string(status), errCode, errMsg)
	return err
}

// MarkSynced records last_synced_at = NOW() and advances the cursor.
func (s *Store) MarkSynced(ctx context.Context, connID uuid.UUID, nextCursor string) error {
	const q = `
		UPDATE bank_feed_connections
		SET last_synced_at = NOW(),
		    cursor         = NULLIF($2, ''),
		    status         = 'connected'::bank_feed_status,
		    error_code     = NULL,
		    error_message  = NULL,
		    updated_at     = NOW()
		WHERE id = $1
	`
	_, err := s.db.ExecContext(ctx, q, connID, nextCursor)
	return err
}

// UpdateTokens replaces encrypted token material after a refresh.
func (s *Store) UpdateTokens(ctx context.Context, connID uuid.UUID, accessEnc, refreshEnc string, expiresAt time.Time) error {
	const q = `
		UPDATE bank_feed_connections
		SET access_token_encrypted  = $2,
		    refresh_token_encrypted = $3,
		    consent_expires_at      = $4,
		    updated_at              = NOW()
		WHERE id = $1
	`
	_, err := s.db.ExecContext(ctx, q, connID, accessEnc, refreshEnc, expiresAt)
	return err
}

// ─── Statement + line upsert ──────────────────────────────────────────────────

// EnsureStatement creates (or retrieves the existing) bank_statement row for
// a feed connection + period.  Returns the statement ID.
func (s *Store) EnsureStatement(ctx context.Context, orgID, connID uuid.UUID, periodStart, periodEnd time.Time, currency string) (uuid.UUID, error) {
	const q = `
		INSERT INTO bank_statements (
			organization_id, bank_feed_connection_id,
			period_start, period_end, currency, status
		) VALUES (
			$1, $2, $3, $4, $5, 'pending'::document_status
		)
		ON CONFLICT DO NOTHING
		RETURNING id
	`
	var id uuid.UUID
	err := s.db.QueryRowContext(ctx, q, orgID, connID, periodStart, periodEnd, currency).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		// Row already exists — fetch it.
		const sel = `
			SELECT id FROM bank_statements
			WHERE organization_id = $1
			  AND bank_feed_connection_id = $2
			  AND period_start = $3
			  AND period_end   = $4
		`
		err = s.db.QueryRowContext(ctx, sel, orgID, connID, periodStart, periodEnd).Scan(&id)
	}
	return id, err
}

// UpsertLine inserts a statement_lines row keyed on (bank_feed_connection_id,
// provider_txn_id).  On conflict (duplicate) it returns ErrDuplicate so the
// caller can skip without aborting the batch.
func (s *Store) UpsertLine(ctx context.Context, orgID, statementID, connID uuid.UUID, pt ProviderTransaction) (uuid.UUID, bool, error) {
	rawBytes, err := json.Marshal(pt.Raw)
	if err != nil {
		rawBytes = []byte("{}")
	}

	var id uuid.UUID
	const q = `
		INSERT INTO statement_lines (
			statement_id, organization_id,
			bank_feed_connection_id, provider_txn_id,
			line_date, description, amount, balance, raw
		) VALUES (
			$1, $2,
			$3, $4,
			$5, $6, $7, $8, $9
		)
		ON CONFLICT (bank_feed_connection_id, provider_txn_id)
		    WHERE provider_txn_id IS NOT NULL
		DO NOTHING
		RETURNING id
	`
	err = s.db.QueryRowContext(ctx, q,
		statementID, orgID,
		connID, pt.ProviderTxnID,
		pt.Date, pt.Description, pt.Amount, pt.Balance, rawBytes,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, false, ErrDuplicate
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	return id, true, nil
}

// LinkTransaction sets statement_lines.transaction_id after a transaction row
// has been created for a line.
func (s *Store) LinkTransaction(ctx context.Context, lineID, txID uuid.UUID) error {
	const q = `UPDATE statement_lines SET transaction_id = $2 WHERE id = $1`
	_, err := s.db.ExecContext(ctx, q, lineID, txID)
	return err
}

// ─── Transaction creation (for feed lines) ───────────────────────────────────

// CreateTransaction inserts a new transactions row sourced from a feed line.
// Returns the new transaction ID.
func (s *Store) CreateTransaction(ctx context.Context, orgID uuid.UUID, pt ProviderTransaction) (uuid.UUID, error) {
	const q = `
		INSERT INTO transactions (
			organization_id, merchant, merchant_normalized,
			description, amount, currency,
			posted_date, direction, status
		) VALUES (
			$1, $2, $3,
			$4, $5, $6,
			$7, $8::transaction_direction, 'pending'::transaction_status
		)
		RETURNING id
	`
	normalized := normalizeMerchant(pt.Description)
	var id uuid.UUID
	err := s.db.QueryRowContext(ctx, q,
		orgID, pt.Description, normalized,
		pt.Description, pt.Amount, pt.Currency,
		pt.Date, pt.Direction,
	).Scan(&id)
	return id, err
}

// ─── OAuth grant helpers ──────────────────────────────────────────────────────

// UpsertOAuthGrant persists (or refreshes) an oauth_grants row.
// provider must be one of the oauth_provider enum values.  For bank-feed
// providers not yet in the oauth_provider enum we use 'paystack' as a
// placeholder — add the proper enum value when you have DB access.
// NOTE: bank-feed tokens are stored directly on bank_feed_connections
// (access_token_encrypted / refresh_token_encrypted), so this method is only
// used when you want a unified token view in oauth_grants as well.
func (s *Store) UpsertOAuthGrant(ctx context.Context, orgID, userID uuid.UUID, provider, accountEmail string, accessEnc, refreshEnc []byte, expiresAt time.Time) error {
	const q = `
		INSERT INTO oauth_grants
		    (organization_id, user_id, provider, account_email,
		     access_token_encrypted, refresh_token_encrypted, token_type, expires_at)
		VALUES ($1, $2, $3::oauth_provider, $4, $5, $6, 'Bearer', $7)
		ON CONFLICT (organization_id, provider, account_email)
		DO UPDATE SET access_token_encrypted  = EXCLUDED.access_token_encrypted,
		              refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
		              expires_at              = EXCLUDED.expires_at,
		              revoked_at              = NULL
	`
	_, err := s.db.ExecContext(ctx, q, orgID, userID, provider, accountEmail, accessEnc, refreshEnc, expiresAt)
	return err
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// normalizeMerchant trims, lowercases and collapses spaces in a merchant
// string, mirroring the logic used by the classify package.
func normalizeMerchant(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	// Collapse consecutive whitespace.
	words := strings.Fields(s)
	return strings.Join(words, " ")
}

// formatDuration formats a time.Duration as a Postgres interval string,
// e.g. 4h → "4 hours", 30m → "30 minutes".
func formatDuration(d time.Duration) string {
	if d >= time.Hour {
		return formatFloat(d.Hours()) + " hours"
	}
	return formatFloat(d.Minutes()) + " minutes"
}

func formatFloat(f float64) string {
	// Trim trailing zeros from a float formatted to 2 decimal places.
	s := trimTrailingZeros(f)
	return s
}

func trimTrailingZeros(f float64) string {
	// Use strconv-free approach: just format to enough precision.
	if f == float64(int64(f)) {
		// Integer value.
		var b [20]byte
		n := formatInt(b[:], int64(f))
		return string(b[:n])
	}
	// Fallback: 2 decimal places, trim zeros.
	s := formatFrac(f, 6)
	for len(s) > 1 && s[len(s)-1] == '0' {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] == '.' {
		s = s[:len(s)-1]
	}
	return s
}

func formatInt(buf []byte, v int64) int {
	if v == 0 {
		buf[0] = '0'
		return 1
	}
	i := len(buf)
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	copy(buf, buf[i:])
	return len(buf) - i
}

func formatFrac(f float64, prec int) string {
	// Simple fixed-precision formatter avoiding strconv import dependency
	// for this internal helper.  Precision is capped at 9 digits.
	if prec > 9 {
		prec = 9
	}
	neg := f < 0
	if neg {
		f = -f
	}
	intPart := int64(f)
	frac := f - float64(intPart)
	// Scale frac.
	scale := int64(1)
	for i := 0; i < prec; i++ {
		scale *= 10
	}
	fracPart := int64(frac*float64(scale) + 0.5)
	if fracPart >= scale {
		intPart++
		fracPart = 0
	}
	var buf [32]byte
	n := formatInt(buf[:], intPart)
	result := string(buf[:n])
	if neg {
		result = "-" + result
	}
	fracStr := ""
	tmp := fracPart
	digits := make([]byte, prec)
	for i := prec - 1; i >= 0; i-- {
		digits[i] = byte('0' + tmp%10)
		tmp /= 10
	}
	fracStr = string(digits)
	return result + "." + fracStr
}
