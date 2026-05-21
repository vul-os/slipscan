package accounting_export

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ErrMappingNotFound is returned when no mapping row exists for the given key.
var ErrMappingNotFound = errors.New("accounting export mapping not found")

// ErrGrantNotFound is returned when no active oauth_grants row is found for the
// requested (org, provider) pair.
var ErrGrantNotFound = errors.New("oauth grant not found for provider")

// Mapping is a row from accounting_export_mappings.
type Mapping struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Provider       string
	LocalType      string
	LocalID        uuid.UUID
	ExternalID     string
	LastSyncedAt   sql.NullTime
	SyncError      sql.NullString
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Grant holds the OAuth token material stored in oauth_grants.
type Grant struct {
	ID                    uuid.UUID
	OrganizationID        uuid.UUID
	AccountEmail          sql.NullString
	AccessTokenEncrypted  []byte
	RefreshTokenEncrypted []byte
	TokenType             sql.NullString
	ExpiresAt             sql.NullTime
}

// Store handles all database access for the accounting_export package:
// mapping rows and oauth_grants token reads/writes.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store backed by the given *sql.DB pool.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─── Mapping operations ───────────────────────────────────────────────────────

// GetMapping looks up a single mapping row by (org, provider, localType, localID).
// Returns ErrMappingNotFound when absent.
func (s *Store) GetMapping(ctx context.Context, orgID uuid.UUID, provider, localType string, localID uuid.UUID) (*Mapping, error) {
	const q = `
		SELECT id, organization_id, provider, local_type, local_id, external_id,
		       last_synced_at, sync_error, created_at, updated_at
		FROM accounting_export_mappings
		WHERE organization_id = $1 AND provider = $2 AND local_type = $3 AND local_id = $4
	`
	var m Mapping
	err := s.db.QueryRowContext(ctx, q, orgID, provider, localType, localID).Scan(
		&m.ID, &m.OrganizationID, &m.Provider, &m.LocalType, &m.LocalID, &m.ExternalID,
		&m.LastSyncedAt, &m.SyncError, &m.CreatedAt, &m.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMappingNotFound
	}
	return &m, err
}

// UpsertMapping creates or updates a mapping row. On conflict it updates the
// external_id, clears sync_error and records last_synced_at = NOW().
func (s *Store) UpsertMapping(ctx context.Context, orgID uuid.UUID, provider, localType string, localID uuid.UUID, externalID string) error {
	const q = `
		INSERT INTO accounting_export_mappings
		    (organization_id, provider, local_type, local_id, external_id, last_synced_at, sync_error)
		VALUES ($1, $2, $3, $4, $5, NOW(), NULL)
		ON CONFLICT (organization_id, provider, local_type, local_id)
		DO UPDATE SET external_id = EXCLUDED.external_id,
		              last_synced_at = NOW(),
		              sync_error = NULL
	`
	_, err := s.db.ExecContext(ctx, q, orgID, provider, localType, localID, externalID)
	return err
}

// RecordSyncError stores an error message for the last push attempt.
func (s *Store) RecordSyncError(ctx context.Context, orgID uuid.UUID, provider, localType string, localID uuid.UUID, syncErr string) error {
	const q = `
		INSERT INTO accounting_export_mappings
		    (organization_id, provider, local_type, local_id, external_id, sync_error)
		VALUES ($1, $2, $3, $4, '', $5)
		ON CONFLICT (organization_id, provider, local_type, local_id)
		DO UPDATE SET sync_error = EXCLUDED.sync_error
	`
	_, err := s.db.ExecContext(ctx, q, orgID, provider, localType, localID, syncErr)
	return err
}

// ListMappings returns all mappings for an org + provider.
func (s *Store) ListMappings(ctx context.Context, orgID uuid.UUID, provider string) ([]Mapping, error) {
	const q = `
		SELECT id, organization_id, provider, local_type, local_id, external_id,
		       last_synced_at, sync_error, created_at, updated_at
		FROM accounting_export_mappings
		WHERE organization_id = $1 AND provider = $2
		ORDER BY created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Mapping
	for rows.Next() {
		var m Mapping
		if err := rows.Scan(
			&m.ID, &m.OrganizationID, &m.Provider, &m.LocalType, &m.LocalID, &m.ExternalID,
			&m.LastSyncedAt, &m.SyncError, &m.CreatedAt, &m.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ─── OAuth grant operations ───────────────────────────────────────────────────

// GetGrant fetches the active oauth_grants row for (org, provider).
// Returns ErrGrantNotFound when absent or revoked.
func (s *Store) GetGrant(ctx context.Context, orgID uuid.UUID, provider string) (*Grant, error) {
	const q = `
		SELECT id, organization_id, account_email,
		       access_token_encrypted, refresh_token_encrypted, token_type, expires_at
		FROM oauth_grants
		WHERE organization_id = $1 AND provider = $2 AND revoked_at IS NULL
		ORDER BY created_at DESC
		LIMIT 1
	`
	var g Grant
	err := s.db.QueryRowContext(ctx, q, orgID, provider).Scan(
		&g.ID, &g.OrganizationID, &g.AccountEmail,
		&g.AccessTokenEncrypted, &g.RefreshTokenEncrypted, &g.TokenType, &g.ExpiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGrantNotFound
	}
	return &g, err
}

// UpsertGrant creates or updates an oauth_grants row. On conflict (org, provider,
// account_email) it refreshes the token material and expiry.
func (s *Store) UpsertGrant(ctx context.Context, orgID, userID uuid.UUID, provider, accountEmail, tokenType string, accessEnc, refreshEnc []byte, expiresAt time.Time) error {
	const q = `
		INSERT INTO oauth_grants
		    (organization_id, user_id, provider, account_email,
		     access_token_encrypted, refresh_token_encrypted, token_type, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (organization_id, provider, account_email)
		DO UPDATE SET access_token_encrypted  = EXCLUDED.access_token_encrypted,
		              refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
		              token_type              = EXCLUDED.token_type,
		              expires_at              = EXCLUDED.expires_at,
		              revoked_at              = NULL
	`
	_, err := s.db.ExecContext(ctx, q, orgID, userID, provider, accountEmail, accessEnc, refreshEnc, tokenType, expiresAt)
	return err
}

// UpdateGrantTokens replaces the token material on an existing grant row,
// identified by grant ID. Used by the refresh path.
func (s *Store) UpdateGrantTokens(ctx context.Context, grantID uuid.UUID, accessEnc, refreshEnc []byte, expiresAt time.Time) error {
	const q = `
		UPDATE oauth_grants
		SET access_token_encrypted  = $1,
		    refresh_token_encrypted = $2,
		    expires_at              = $3
		WHERE id = $4
	`
	_, err := s.db.ExecContext(ctx, q, accessEnc, refreshEnc, expiresAt, grantID)
	return err
}

// RevokeGrant marks the active grant for (org, provider) as revoked.
func (s *Store) RevokeGrant(ctx context.Context, orgID uuid.UUID, provider string) error {
	const q = `
		UPDATE oauth_grants SET revoked_at = NOW()
		WHERE organization_id = $1 AND provider = $2 AND revoked_at IS NULL
	`
	_, err := s.db.ExecContext(ctx, q, orgID, provider)
	return err
}

// ─── Data read operations ─────────────────────────────────────────────────────

// GetContact fetches a contact row by (org, contactID) for push.
func (s *Store) GetContact(ctx context.Context, orgID, contactID uuid.UUID) (*Contact, error) {
	const q = `
		SELECT id, name, COALESCE(legal_name,''), COALESCE(email,''),
		       COALESCE(phone,''), COALESCE(tax_number,''),
		       COALESCE(address_line1,''), COALESCE(address_line2,''),
		       COALESCE(city,''), COALESCE(region,''),
		       COALESCE(postal_code,''), COALESCE(country,''), kind
		FROM contacts
		WHERE organization_id = $1 AND id = $2 AND NOT is_archived
	`
	var c Contact
	var kind string
	err := s.db.QueryRowContext(ctx, q, orgID, contactID).Scan(
		&c.ID, &c.Name, &c.LegalName, &c.Email,
		&c.Phone, &c.TaxNumber,
		&c.AddressLine1, &c.AddressLine2,
		&c.City, &c.Region, &c.PostalCode, &c.Country, &kind,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("contact not found")
	}
	if err != nil {
		return nil, err
	}
	c.Kind = kind
	return &c, nil
}

// ListUnexportedContacts returns contacts for the org that have no mapping yet.
func (s *Store) ListUnexportedContacts(ctx context.Context, orgID uuid.UUID, provider string) ([]Contact, error) {
	const q = `
		SELECT c.id, c.name, COALESCE(c.legal_name,''), COALESCE(c.email,''),
		       COALESCE(c.phone,''), COALESCE(c.tax_number,''),
		       COALESCE(c.address_line1,''), COALESCE(c.address_line2,''),
		       COALESCE(c.city,''), COALESCE(c.region,''),
		       COALESCE(c.postal_code,''), COALESCE(c.country,''), c.kind
		FROM contacts c
		LEFT JOIN accounting_export_mappings m
		    ON m.local_id = c.id
		    AND m.local_type = 'contact'
		    AND m.organization_id = c.organization_id
		    AND m.provider = $2
		WHERE c.organization_id = $1
		  AND NOT c.is_archived
		  AND (m.id IS NULL OR m.sync_error IS NOT NULL)
		ORDER BY c.name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Contact
	for rows.Next() {
		var c Contact
		if err := rows.Scan(
			&c.ID, &c.Name, &c.LegalName, &c.Email,
			&c.Phone, &c.TaxNumber,
			&c.AddressLine1, &c.AddressLine2,
			&c.City, &c.Region, &c.PostalCode, &c.Country, &c.Kind,
		); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetTransaction fetches a transaction + account/tax info for push.
func (s *Store) GetTransaction(ctx context.Context, orgID, txID uuid.UUID) (*Transaction, error) {
	const q = `
		SELECT t.id,
		       COALESCE(t.posted_date, CURRENT_DATE),
		       t.direction,
		       COALESCE(t.merchant, ''),
		       COALESCE(t.description, ''),
		       COALESCE(t.amount, 0),
		       COALESCE(t.currency, 'ZAR'),
		       COALESCE(t.tax, 0),
		       COALESCE(a.code, ''),
		       COALESCE(tr.code, ''),
		       COALESCE(t.contact_id, '00000000-0000-0000-0000-000000000000')
		FROM transactions t
		LEFT JOIN accounts  a  ON a.id  = t.account_id
		LEFT JOIN tax_rates tr ON tr.id = t.tax_rate_id
		WHERE t.organization_id = $1 AND t.id = $2
	`
	var tx Transaction
	var contactIDStr string
	err := s.db.QueryRowContext(ctx, q, orgID, txID).Scan(
		&tx.ID, &tx.PostedDate, &tx.Direction,
		&tx.Merchant, &tx.Description,
		&tx.Amount, &tx.Currency, &tx.Tax,
		&tx.AccountCode, &tx.TaxRateCode,
		&contactIDStr,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("transaction not found")
	}
	if err != nil {
		return nil, err
	}
	if cid, parseErr := uuid.Parse(contactIDStr); parseErr == nil {
		tx.ContactID = cid
	}
	return &tx, nil
}

// ListUnexportedTransactions returns verified transactions with no clean mapping.
func (s *Store) ListUnexportedTransactions(ctx context.Context, orgID uuid.UUID, provider string) ([]Transaction, error) {
	const q = `
		SELECT t.id,
		       COALESCE(t.posted_date, CURRENT_DATE),
		       t.direction,
		       COALESCE(t.merchant, ''),
		       COALESCE(t.description, ''),
		       COALESCE(t.amount, 0),
		       COALESCE(t.currency, 'ZAR'),
		       COALESCE(t.tax, 0),
		       COALESCE(a.code, ''),
		       COALESCE(tr.code, ''),
		       COALESCE(t.contact_id::text, '00000000-0000-0000-0000-000000000000')
		FROM transactions t
		LEFT JOIN accounts  a  ON a.id  = t.account_id
		LEFT JOIN tax_rates tr ON tr.id = t.tax_rate_id
		LEFT JOIN accounting_export_mappings m
		    ON m.local_id = t.id
		    AND m.local_type = 'transaction'
		    AND m.organization_id = t.organization_id
		    AND m.provider = $2
		WHERE t.organization_id = $1
		  AND t.status = 'verified'
		  AND (m.id IS NULL OR m.sync_error IS NOT NULL)
		ORDER BY t.posted_date DESC NULLS LAST
	`
	rows, err := s.db.QueryContext(ctx, q, orgID, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transaction
	for rows.Next() {
		var tx Transaction
		var contactIDStr string
		if err := rows.Scan(
			&tx.ID, &tx.PostedDate, &tx.Direction,
			&tx.Merchant, &tx.Description,
			&tx.Amount, &tx.Currency, &tx.Tax,
			&tx.AccountCode, &tx.TaxRateCode,
			&contactIDStr,
		); err != nil {
			return nil, err
		}
		if cid, parseErr := uuid.Parse(contactIDStr); parseErr == nil {
			tx.ContactID = cid
		}
		out = append(out, tx)
	}
	return out, rows.Err()
}
