// Package ledger implements the P2-03 business general ledger:
//
//   - Chart-of-accounts CRUD (accounts table, enforces is_system protection).
//   - Double-entry posting of classified/verified business transactions.
//   - Reversal on re-classification.
//   - Manual journal CRUD with balance enforcement (Σdebit = Σcredit).
//   - Contacts CRUD.
//   - Account ledger query and trial-balance query.
package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─── Sentinel errors ──────────────────────────────────────────────────────────

var (
	ErrNotFound        = errors.New("ledger: not found")
	ErrSystemAccount   = errors.New("ledger: system accounts cannot be modified or deleted")
	ErrUnbalanced      = errors.New("ledger: journal entries do not balance (Σdebit ≠ Σcredit)")
	ErrNoLines         = errors.New("ledger: journal must have at least two lines")
	ErrInvalidAmount   = errors.New("ledger: each line must have exactly one of debit or credit > 0")
	ErrForbidden       = errors.New("ledger: forbidden")
)

// ─── Domain types ─────────────────────────────────────────────────────────────

// Account represents a row in the accounts table.
type Account struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	ParentID       uuid.NullUUID
	Code           sql.NullString
	Name           string
	Type           string // account_type enum: asset|liability|equity|income|expense
	Subtype        sql.NullString
	Currency       string
	TaxRateID      uuid.NullUUID
	Description    sql.NullString
	IsArchived     bool
	IsSystem       bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// CreateAccountInput is validated input for creating an account.
type CreateAccountInput struct {
	ParentID    *uuid.UUID
	Code        string
	Name        string
	Type        string
	Subtype     string
	Currency    string
	TaxRateID   *uuid.UUID
	Description string
}

// UpdateAccountInput is the mutable subset of an account.
type UpdateAccountInput struct {
	Code        *string
	Name        *string
	Subtype     *string
	TaxRateID   *uuid.UUID
	Description *string
	IsArchived  *bool
}

// LedgerEntry is a single debit or credit line in ledger_entries.
type LedgerEntry struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	AccountID      uuid.UUID
	SourceType     string // ledger_source_type enum
	SourceID       uuid.UUID
	PostedDate     time.Time
	Debit          float64
	Credit         float64
	Currency       string
	Description    sql.NullString
	CreatedAt      time.Time
}

// ManualJournal is a row in manual_journals.
type ManualJournal struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	PostedDate     time.Time
	Narrative      sql.NullString
	Reference      sql.NullString
	CreatedBy      uuid.NullUUID
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Lines          []JournalLine // populated on read
}

// JournalLine is one side of a journal entry (stored as a ledger_entry).
type JournalLine struct {
	AccountID   uuid.UUID
	Debit       float64
	Credit      float64
	Description string
}

// Contact is a row in the contacts table.
type Contact struct {
	ID                uuid.UUID
	OrganizationID    uuid.UUID
	Kind              string // contact_kind enum: customer|supplier|both
	Name              string
	LegalName         sql.NullString
	Email             sql.NullString
	Phone             sql.NullString
	TaxNumber         sql.NullString
	PaymentTermsDays  int
	DefaultAccountID  uuid.NullUUID
	DefaultTaxRateID  uuid.NullUUID
	Currency          sql.NullString
	AddressLine1      sql.NullString
	AddressLine2      sql.NullString
	City              sql.NullString
	Region            sql.NullString
	PostalCode        sql.NullString
	Country           sql.NullString
	Notes             sql.NullString
	IsArchived        bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// CreateContactInput is validated input for creating a contact.
type CreateContactInput struct {
	Kind             string
	Name             string
	LegalName        string
	Email            string
	Phone            string
	TaxNumber        string
	PaymentTermsDays int
	DefaultAccountID *uuid.UUID
	DefaultTaxRateID *uuid.UUID
	Currency         string
	AddressLine1     string
	AddressLine2     string
	City             string
	Region           string
	PostalCode       string
	Country          string
	Notes            string
}

// UpdateContactInput holds mutable fields for a contact update.
type UpdateContactInput struct {
	Kind             *string
	Name             *string
	LegalName        *string
	Email            *string
	Phone            *string
	TaxNumber        *string
	PaymentTermsDays *int
	IsArchived       *bool
	Notes            *string
}

// TrialBalanceLine is one row of the trial-balance report.
type TrialBalanceLine struct {
	AccountID   uuid.UUID
	AccountCode string
	AccountName string
	AccountType string
	TotalDebit  float64
	TotalCredit float64
}

// AccountLedgerEntry is one entry in an account's ledger view.
type AccountLedgerEntry struct {
	EntryID     uuid.UUID
	SourceType  string
	SourceID    uuid.UUID
	PostedDate  time.Time
	Debit       float64
	Credit      float64
	Description string
}

// ─── Store ────────────────────────────────────────────────────────────────────

// Store holds all ledger DB operations.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store backed by db.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ═══════════════════════════════════════════════════════════════════════════
// Accounts
// ═══════════════════════════════════════════════════════════════════════════

// ListAccounts returns all non-archived accounts for an org.
func (s *Store) ListAccounts(ctx context.Context, orgID uuid.UUID) ([]Account, error) {
	const q = `
		SELECT id, organization_id, parent_id, code, name, type, subtype, currency,
		       tax_rate_id, description, is_archived, is_system, created_at, updated_at
		FROM accounts
		WHERE organization_id = $1
		ORDER BY code NULLS LAST, name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(
			&a.ID, &a.OrganizationID, &a.ParentID, &a.Code, &a.Name, &a.Type,
			&a.Subtype, &a.Currency, &a.TaxRateID, &a.Description,
			&a.IsArchived, &a.IsSystem, &a.CreatedAt, &a.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetAccount returns a single account by id, restricted to the org.
func (s *Store) GetAccount(ctx context.Context, orgID, accountID uuid.UUID) (*Account, error) {
	const q = `
		SELECT id, organization_id, parent_id, code, name, type, subtype, currency,
		       tax_rate_id, description, is_archived, is_system, created_at, updated_at
		FROM accounts
		WHERE id = $1 AND organization_id = $2
	`
	var a Account
	err := s.db.QueryRowContext(ctx, q, accountID, orgID).Scan(
		&a.ID, &a.OrganizationID, &a.ParentID, &a.Code, &a.Name, &a.Type,
		&a.Subtype, &a.Currency, &a.TaxRateID, &a.Description,
		&a.IsArchived, &a.IsSystem, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// validAccountTypes is the set of allowed account_type enum values.
var validAccountTypes = map[string]bool{
	"asset": true, "liability": true, "equity": true,
	"income": true, "expense": true,
}

// CreateAccount inserts a new account row.
func (s *Store) CreateAccount(ctx context.Context, orgID uuid.UUID, in CreateAccountInput) (*Account, error) {
	if strings.TrimSpace(in.Name) == "" {
		return nil, fmt.Errorf("ledger: account name is required")
	}
	if !validAccountTypes[in.Type] {
		return nil, fmt.Errorf("ledger: invalid account type %q", in.Type)
	}
	if in.Currency == "" {
		return nil, fmt.Errorf("ledger: currency is required")
	}

	const q = `
		INSERT INTO accounts (organization_id, parent_id, code, name, type, subtype,
		                      currency, tax_rate_id, description)
		VALUES ($1, $2, NULLIF($3,''), $4, $5::account_type, NULLIF($6,''), $7, $8, NULLIF($9,''))
		RETURNING id, organization_id, parent_id, code, name, type, subtype, currency,
		          tax_rate_id, description, is_archived, is_system, created_at, updated_at
	`
	var a Account
	err := s.db.QueryRowContext(ctx, q,
		orgID, nullUUID(in.ParentID), in.Code, in.Name, in.Type,
		in.Subtype, in.Currency, nullUUID(in.TaxRateID), in.Description,
	).Scan(
		&a.ID, &a.OrganizationID, &a.ParentID, &a.Code, &a.Name, &a.Type,
		&a.Subtype, &a.Currency, &a.TaxRateID, &a.Description,
		&a.IsArchived, &a.IsSystem, &a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: create account: %w", err)
	}
	return &a, nil
}

// UpdateAccount patches mutable fields. Returns ErrSystemAccount if the
// account is a seeded system account.
func (s *Store) UpdateAccount(ctx context.Context, orgID, accountID uuid.UUID, in UpdateAccountInput) (*Account, error) {
	a, err := s.GetAccount(ctx, orgID, accountID)
	if err != nil {
		return nil, err
	}
	if a.IsSystem {
		// System accounts: allow archiving but not name/code changes.
		if in.Name != nil || in.Code != nil {
			return nil, ErrSystemAccount
		}
	}

	// Build dynamic update.
	setClauses := []string{"updated_at = NOW()"}
	args := []any{}
	argN := 1

	if in.Code != nil {
		setClauses = append(setClauses, fmt.Sprintf("code = NULLIF($%d, '')", argN))
		args = append(args, *in.Code)
		argN++
	}
	if in.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argN))
		args = append(args, *in.Name)
		argN++
	}
	if in.Subtype != nil {
		setClauses = append(setClauses, fmt.Sprintf("subtype = NULLIF($%d, '')", argN))
		args = append(args, *in.Subtype)
		argN++
	}
	if in.TaxRateID != nil {
		setClauses = append(setClauses, fmt.Sprintf("tax_rate_id = $%d", argN))
		args = append(args, *in.TaxRateID)
		argN++
	}
	if in.Description != nil {
		setClauses = append(setClauses, fmt.Sprintf("description = NULLIF($%d, '')", argN))
		args = append(args, *in.Description)
		argN++
	}
	if in.IsArchived != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_archived = $%d", argN))
		args = append(args, *in.IsArchived)
		argN++
	}

	args = append(args, accountID, orgID)
	q := fmt.Sprintf(`
		UPDATE accounts SET %s
		WHERE id = $%d AND organization_id = $%d
		RETURNING id, organization_id, parent_id, code, name, type, subtype, currency,
		          tax_rate_id, description, is_archived, is_system, created_at, updated_at
	`, strings.Join(setClauses, ", "), argN, argN+1)

	var updated Account
	err = s.db.QueryRowContext(ctx, q, args...).Scan(
		&updated.ID, &updated.OrganizationID, &updated.ParentID, &updated.Code, &updated.Name,
		&updated.Type, &updated.Subtype, &updated.Currency, &updated.TaxRateID,
		&updated.Description, &updated.IsArchived, &updated.IsSystem,
		&updated.CreatedAt, &updated.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("ledger: update account: %w", err)
	}
	return &updated, nil
}

// DeleteAccount removes an account. Returns ErrSystemAccount for system rows.
func (s *Store) DeleteAccount(ctx context.Context, orgID, accountID uuid.UUID) error {
	a, err := s.GetAccount(ctx, orgID, accountID)
	if err != nil {
		return err
	}
	if a.IsSystem {
		return ErrSystemAccount
	}
	_, err = s.db.ExecContext(ctx,
		`DELETE FROM accounts WHERE id = $1 AND organization_id = $2`,
		accountID, orgID,
	)
	return err
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction posting (double-entry)
// ═══════════════════════════════════════════════════════════════════════════

// PostTransaction generates balanced ledger_entries for a classified,
// verified business transaction. The classification determines the expense /
// income account; a bank/clearing account (code "090" – Bank Accounts) serves
// as the counter-account.
//
// If previous entries exist for this transaction they are deleted first
// (reversal), so re-classification is handled correctly.
//
// Rules:
//   - direction="debit"  (expense): DR expense-account / CR bank-account
//   - direction="credit" (income):  DR bank-account   / CR income-account
//   - direction="transfer": skip (handled separately)
//
// Returns ErrNotFound if the transaction or its account cannot be resolved.
func (s *Store) PostTransaction(ctx context.Context, orgID, transactionID uuid.UUID) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := s.postTransactionTx(ctx, tx, orgID, transactionID); err != nil {
		return err
	}
	return tx.Commit()
}

// postTransactionTx does the actual posting inside a caller-supplied transaction.
func (s *Store) postTransactionTx(ctx context.Context, tx *sql.Tx, orgID, transactionID uuid.UUID) error {
	// 1. Load the transaction with its current classification.
	type txRow struct {
		amount    float64
		currency  string
		direction string
		status    string
		postedDate time.Time
		accountID  uuid.NullUUID // from classification
		merchant  sql.NullString
	}
	const fetchQ = `
		SELECT t.amount, t.currency, t.direction, t.status,
		       COALESCE(t.posted_date, CURRENT_DATE),
		       tc.account_id,
		       t.merchant
		FROM transactions t
		LEFT JOIN transaction_classifications tc
			ON tc.id = t.current_classification_id
		WHERE t.id = $1 AND t.organization_id = $2
	`
	var row txRow
	err := tx.QueryRowContext(ctx, fetchQ, transactionID, orgID).Scan(
		&row.amount, &row.currency, &row.direction, &row.status,
		&row.postedDate, &row.accountID, &row.merchant,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("ledger: post transaction fetch: %w", err)
	}

	// 2. Only post verified transactions with a classification account.
	if row.status != "verified" {
		return nil
	}
	if !row.accountID.Valid {
		return nil // no account assigned yet — skip silently
	}
	if row.direction == "transfer" {
		return nil // transfers handled separately
	}
	if row.amount <= 0 {
		return nil
	}

	// 3. Reverse any existing ledger entries for this transaction.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM ledger_entries WHERE source_type = 'transaction' AND source_id = $1 AND organization_id = $2`,
		transactionID, orgID,
	); err != nil {
		return fmt.Errorf("ledger: reverse existing entries: %w", err)
	}

	// 4. Resolve the bank/clearing counter-account (code "090").
	var bankAccountID uuid.UUID
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM accounts WHERE organization_id = $1 AND code = '090' LIMIT 1`,
		orgID,
	).Scan(&bankAccountID)
	if errors.Is(err, sql.ErrNoRows) {
		// Fall back to any asset account.
		err = tx.QueryRowContext(ctx,
			`SELECT id FROM accounts WHERE organization_id = $1 AND type = 'asset' ORDER BY code NULLS LAST LIMIT 1`,
			orgID,
		).Scan(&bankAccountID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("ledger: no bank/asset account found for org")
	}
	if err != nil {
		return fmt.Errorf("ledger: resolve bank account: %w", err)
	}

	desc := sql.NullString{}
	if row.merchant.Valid {
		desc = row.merchant
	}

	amount := row.amount
	classAccID := row.accountID.UUID

	// 5. Write two balanced entries.
	const insertEntry = `
		INSERT INTO ledger_entries
			(organization_id, account_id, source_type, source_id, posted_date, debit, credit, currency, description)
		VALUES ($1, $2, 'transaction', $3, $4, $5, $6, $7, $8)
	`
	switch row.direction {
	case "debit": // expense: DR expense-account / CR bank-account
		if _, err := tx.ExecContext(ctx, insertEntry,
			orgID, classAccID, transactionID, row.postedDate, amount, 0, row.currency, desc,
		); err != nil {
			return fmt.Errorf("ledger: insert debit entry: %w", err)
		}
		if _, err := tx.ExecContext(ctx, insertEntry,
			orgID, bankAccountID, transactionID, row.postedDate, 0, amount, row.currency, desc,
		); err != nil {
			return fmt.Errorf("ledger: insert credit entry: %w", err)
		}
	case "credit": // income: DR bank-account / CR income-account
		if _, err := tx.ExecContext(ctx, insertEntry,
			orgID, bankAccountID, transactionID, row.postedDate, amount, 0, row.currency, desc,
		); err != nil {
			return fmt.Errorf("ledger: insert debit entry: %w", err)
		}
		if _, err := tx.ExecContext(ctx, insertEntry,
			orgID, classAccID, transactionID, row.postedDate, 0, amount, row.currency, desc,
		); err != nil {
			return fmt.Errorf("ledger: insert credit entry: %w", err)
		}
	}
	return nil
}

// ReverseTransaction deletes all ledger_entries for the given transaction.
// Called before re-posting when a classification changes.
func (s *Store) ReverseTransaction(ctx context.Context, orgID, transactionID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM ledger_entries WHERE source_type = 'transaction' AND source_id = $1 AND organization_id = $2`,
		transactionID, orgID,
	)
	return err
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual journals
// ═══════════════════════════════════════════════════════════════════════════

// validateJournalLines checks that lines are non-empty and balanced.
func validateJournalLines(lines []JournalLine) error {
	if len(lines) < 2 {
		return ErrNoLines
	}
	var totalDebit, totalCredit float64
	for _, l := range lines {
		// Exactly one side must be positive.
		if (l.Debit > 0 && l.Credit > 0) || (l.Debit == 0 && l.Credit == 0) {
			return ErrInvalidAmount
		}
		totalDebit += l.Debit
		totalCredit += l.Credit
	}
	// Allow for floating-point epsilon.
	diff := totalDebit - totalCredit
	if diff < 0 {
		diff = -diff
	}
	if diff > 0.001 {
		return ErrUnbalanced
	}
	return nil
}

// CreateManualJournal inserts a journal and its lines atomically.
// Returns ErrUnbalanced if Σdebit ≠ Σcredit.
func (s *Store) CreateManualJournal(
	ctx context.Context,
	orgID uuid.UUID,
	postedDate time.Time,
	narrative, reference string,
	createdBy *uuid.UUID,
	lines []JournalLine,
) (*ManualJournal, error) {
	if err := validateJournalLines(lines); err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	const insertJournal = `
		INSERT INTO manual_journals (organization_id, posted_date, narrative, reference, created_by)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5)
		RETURNING id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at
	`
	var j ManualJournal
	if err := tx.QueryRowContext(ctx, insertJournal,
		orgID, postedDate, narrative, reference, nullUUID(createdBy),
	).Scan(
		&j.ID, &j.OrganizationID, &j.PostedDate, &j.Narrative,
		&j.Reference, &j.CreatedBy, &j.CreatedAt, &j.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("ledger: insert journal: %w", err)
	}

	// Resolve account currency from first line's account (use org default otherwise).
	// We need the currency for each line — look up account currency per entry.
	for _, l := range lines {
		var currency string
		if err := tx.QueryRowContext(ctx,
			`SELECT currency FROM accounts WHERE id = $1 AND organization_id = $2`,
			l.AccountID, orgID,
		).Scan(&currency); err != nil {
			return nil, fmt.Errorf("ledger: resolve account %s currency: %w", l.AccountID, err)
		}

		const insertLine = `
			INSERT INTO ledger_entries
				(organization_id, account_id, source_type, source_id, posted_date, debit, credit, currency, description)
			VALUES ($1, $2, 'manual_journal', $3, $4, $5, $6, $7, NULLIF($8,''))
		`
		if _, err := tx.ExecContext(ctx, insertLine,
			orgID, l.AccountID, j.ID, j.PostedDate, l.Debit, l.Credit, currency, l.Description,
		); err != nil {
			return nil, fmt.Errorf("ledger: insert journal line: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	j.Lines = lines
	return &j, nil
}

// ListManualJournals returns journals for an org in reverse date order.
func (s *Store) ListManualJournals(ctx context.Context, orgID uuid.UUID) ([]ManualJournal, error) {
	const q = `
		SELECT id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at
		FROM manual_journals
		WHERE organization_id = $1
		ORDER BY posted_date DESC, created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ManualJournal
	for rows.Next() {
		var j ManualJournal
		if err := rows.Scan(
			&j.ID, &j.OrganizationID, &j.PostedDate, &j.Narrative,
			&j.Reference, &j.CreatedBy, &j.CreatedAt, &j.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// GetManualJournal returns a single journal with its lines.
func (s *Store) GetManualJournal(ctx context.Context, orgID, journalID uuid.UUID) (*ManualJournal, error) {
	const jq = `
		SELECT id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at
		FROM manual_journals
		WHERE id = $1 AND organization_id = $2
	`
	var j ManualJournal
	err := s.db.QueryRowContext(ctx, jq, journalID, orgID).Scan(
		&j.ID, &j.OrganizationID, &j.PostedDate, &j.Narrative,
		&j.Reference, &j.CreatedBy, &j.CreatedAt, &j.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	const lq = `
		SELECT account_id, debit, credit, COALESCE(description, '')
		FROM ledger_entries
		WHERE source_type = 'manual_journal' AND source_id = $1 AND organization_id = $2
		ORDER BY created_at
	`
	rows, err := s.db.QueryContext(ctx, lq, journalID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var l JournalLine
		if err := rows.Scan(&l.AccountID, &l.Debit, &l.Credit, &l.Description); err != nil {
			return nil, err
		}
		j.Lines = append(j.Lines, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &j, nil
}

// DeleteManualJournal removes a journal and all its ledger_entries.
func (s *Store) DeleteManualJournal(ctx context.Context, orgID, journalID uuid.UUID) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Delete entries first (no FK cascade on source_id since it's a bare UUID).
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM ledger_entries WHERE source_type = 'manual_journal' AND source_id = $1 AND organization_id = $2`,
		journalID, orgID,
	); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM manual_journals WHERE id = $1 AND organization_id = $2`,
		journalID, orgID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// ═══════════════════════════════════════════════════════════════════════════
// Contacts
// ═══════════════════════════════════════════════════════════════════════════

// validContactKinds is the set of allowed contact_kind enum values.
var validContactKinds = map[string]bool{"customer": true, "supplier": true, "both": true}

// ListContacts returns all contacts for an org.
func (s *Store) ListContacts(ctx context.Context, orgID uuid.UUID) ([]Contact, error) {
	const q = `
		SELECT id, organization_id, kind, name, legal_name, email, phone, tax_number,
		       payment_terms_days, default_account_id, default_tax_rate_id, currency,
		       address_line1, address_line2, city, region, postal_code, country, notes,
		       is_archived, created_at, updated_at
		FROM contacts
		WHERE organization_id = $1
		ORDER BY name
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Contact
	for rows.Next() {
		var c Contact
		if err := rows.Scan(
			&c.ID, &c.OrganizationID, &c.Kind, &c.Name, &c.LegalName, &c.Email, &c.Phone,
			&c.TaxNumber, &c.PaymentTermsDays, &c.DefaultAccountID, &c.DefaultTaxRateID,
			&c.Currency, &c.AddressLine1, &c.AddressLine2, &c.City, &c.Region,
			&c.PostalCode, &c.Country, &c.Notes, &c.IsArchived, &c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContact returns a single contact by id.
func (s *Store) GetContact(ctx context.Context, orgID, contactID uuid.UUID) (*Contact, error) {
	const q = `
		SELECT id, organization_id, kind, name, legal_name, email, phone, tax_number,
		       payment_terms_days, default_account_id, default_tax_rate_id, currency,
		       address_line1, address_line2, city, region, postal_code, country, notes,
		       is_archived, created_at, updated_at
		FROM contacts
		WHERE id = $1 AND organization_id = $2
	`
	var c Contact
	err := s.db.QueryRowContext(ctx, q, contactID, orgID).Scan(
		&c.ID, &c.OrganizationID, &c.Kind, &c.Name, &c.LegalName, &c.Email, &c.Phone,
		&c.TaxNumber, &c.PaymentTermsDays, &c.DefaultAccountID, &c.DefaultTaxRateID,
		&c.Currency, &c.AddressLine1, &c.AddressLine2, &c.City, &c.Region,
		&c.PostalCode, &c.Country, &c.Notes, &c.IsArchived, &c.CreatedAt, &c.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// CreateContact inserts a new contact.
func (s *Store) CreateContact(ctx context.Context, orgID uuid.UUID, in CreateContactInput) (*Contact, error) {
	if strings.TrimSpace(in.Name) == "" {
		return nil, fmt.Errorf("ledger: contact name is required")
	}
	if in.Kind == "" {
		in.Kind = "customer"
	}
	if !validContactKinds[in.Kind] {
		return nil, fmt.Errorf("ledger: invalid contact kind %q", in.Kind)
	}
	if in.PaymentTermsDays < 0 {
		return nil, fmt.Errorf("ledger: payment_terms_days must be non-negative")
	}

	const q = `
		INSERT INTO contacts (organization_id, kind, name, legal_name, email, phone, tax_number,
		                      payment_terms_days, default_account_id, default_tax_rate_id, currency,
		                      address_line1, address_line2, city, region, postal_code, country, notes)
		VALUES ($1, $2::contact_kind, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
		        $8, $9, $10, NULLIF($11,''), NULLIF($12,''), NULLIF($13,''), NULLIF($14,''),
		        NULLIF($15,''), NULLIF($16,''), NULLIF($17,''), NULLIF($18,''))
		RETURNING id, organization_id, kind, name, legal_name, email, phone, tax_number,
		          payment_terms_days, default_account_id, default_tax_rate_id, currency,
		          address_line1, address_line2, city, region, postal_code, country, notes,
		          is_archived, created_at, updated_at
	`
	var c Contact
	err := s.db.QueryRowContext(ctx, q,
		orgID, in.Kind, in.Name, in.LegalName, in.Email, in.Phone, in.TaxNumber,
		in.PaymentTermsDays, nullUUID(in.DefaultAccountID), nullUUID(in.DefaultTaxRateID),
		in.Currency, in.AddressLine1, in.AddressLine2, in.City, in.Region,
		in.PostalCode, in.Country, in.Notes,
	).Scan(
		&c.ID, &c.OrganizationID, &c.Kind, &c.Name, &c.LegalName, &c.Email, &c.Phone,
		&c.TaxNumber, &c.PaymentTermsDays, &c.DefaultAccountID, &c.DefaultTaxRateID,
		&c.Currency, &c.AddressLine1, &c.AddressLine2, &c.City, &c.Region,
		&c.PostalCode, &c.Country, &c.Notes, &c.IsArchived, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: create contact: %w", err)
	}
	return &c, nil
}

// UpdateContact patches mutable contact fields.
func (s *Store) UpdateContact(ctx context.Context, orgID, contactID uuid.UUID, in UpdateContactInput) (*Contact, error) {
	setClauses := []string{"updated_at = NOW()"}
	args := []any{}
	argN := 1

	if in.Kind != nil {
		if !validContactKinds[*in.Kind] {
			return nil, fmt.Errorf("ledger: invalid contact kind %q", *in.Kind)
		}
		setClauses = append(setClauses, fmt.Sprintf("kind = $%d::contact_kind", argN))
		args = append(args, *in.Kind)
		argN++
	}
	if in.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argN))
		args = append(args, *in.Name)
		argN++
	}
	if in.LegalName != nil {
		setClauses = append(setClauses, fmt.Sprintf("legal_name = NULLIF($%d, '')", argN))
		args = append(args, *in.LegalName)
		argN++
	}
	if in.Email != nil {
		setClauses = append(setClauses, fmt.Sprintf("email = NULLIF($%d, '')", argN))
		args = append(args, *in.Email)
		argN++
	}
	if in.Phone != nil {
		setClauses = append(setClauses, fmt.Sprintf("phone = NULLIF($%d, '')", argN))
		args = append(args, *in.Phone)
		argN++
	}
	if in.TaxNumber != nil {
		setClauses = append(setClauses, fmt.Sprintf("tax_number = NULLIF($%d, '')", argN))
		args = append(args, *in.TaxNumber)
		argN++
	}
	if in.PaymentTermsDays != nil {
		setClauses = append(setClauses, fmt.Sprintf("payment_terms_days = $%d", argN))
		args = append(args, *in.PaymentTermsDays)
		argN++
	}
	if in.IsArchived != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_archived = $%d", argN))
		args = append(args, *in.IsArchived)
		argN++
	}
	if in.Notes != nil {
		setClauses = append(setClauses, fmt.Sprintf("notes = NULLIF($%d, '')", argN))
		args = append(args, *in.Notes)
		argN++
	}

	args = append(args, contactID, orgID)
	q := fmt.Sprintf(`
		UPDATE contacts SET %s
		WHERE id = $%d AND organization_id = $%d
		RETURNING id, organization_id, kind, name, legal_name, email, phone, tax_number,
		          payment_terms_days, default_account_id, default_tax_rate_id, currency,
		          address_line1, address_line2, city, region, postal_code, country, notes,
		          is_archived, created_at, updated_at
	`, strings.Join(setClauses, ", "), argN, argN+1)

	var c Contact
	err := s.db.QueryRowContext(ctx, q, args...).Scan(
		&c.ID, &c.OrganizationID, &c.Kind, &c.Name, &c.LegalName, &c.Email, &c.Phone,
		&c.TaxNumber, &c.PaymentTermsDays, &c.DefaultAccountID, &c.DefaultTaxRateID,
		&c.Currency, &c.AddressLine1, &c.AddressLine2, &c.City, &c.Region,
		&c.PostalCode, &c.Country, &c.Notes, &c.IsArchived, &c.CreatedAt, &c.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("ledger: update contact: %w", err)
	}
	return &c, nil
}

// DeleteContact removes a contact.
func (s *Store) DeleteContact(ctx context.Context, orgID, contactID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM contacts WHERE id = $1 AND organization_id = $2`,
		contactID, orgID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Queries — account ledger + trial balance
// ═══════════════════════════════════════════════════════════════════════════

// AccountLedger returns all ledger entries for one account within a date range.
// from/to are inclusive; a zero time.Time means unbounded.
func (s *Store) AccountLedger(
	ctx context.Context,
	orgID, accountID uuid.UUID,
	from, to time.Time,
) ([]AccountLedgerEntry, error) {
	// Verify account belongs to org.
	if _, err := s.GetAccount(ctx, orgID, accountID); err != nil {
		return nil, err
	}

	args := []any{orgID, accountID}
	cond := "WHERE organization_id = $1 AND account_id = $2"
	argN := 3

	if !from.IsZero() {
		cond += fmt.Sprintf(" AND posted_date >= $%d", argN)
		args = append(args, from)
		argN++
	}
	if !to.IsZero() {
		cond += fmt.Sprintf(" AND posted_date <= $%d", argN)
		args = append(args, to)
		argN++
	}

	q := fmt.Sprintf(`
		SELECT id, source_type, source_id, posted_date, debit, credit,
		       COALESCE(description, '')
		FROM ledger_entries
		%s
		ORDER BY posted_date, created_at
	`, cond)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AccountLedgerEntry
	for rows.Next() {
		var e AccountLedgerEntry
		if err := rows.Scan(
			&e.EntryID, &e.SourceType, &e.SourceID, &e.PostedDate,
			&e.Debit, &e.Credit, &e.Description,
		); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// TrialBalance returns all accounts with their total debits and credits.
// The caller may filter by date range (zero = unbounded).
// A well-formed ledger always has Σdebit = Σcredit across all lines.
func (s *Store) TrialBalance(
	ctx context.Context,
	orgID uuid.UUID,
	from, to time.Time,
) ([]TrialBalanceLine, error) {
	args := []any{orgID}
	dateCond := ""
	argN := 2

	if !from.IsZero() {
		dateCond += fmt.Sprintf(" AND le.posted_date >= $%d", argN)
		args = append(args, from)
		argN++
	}
	if !to.IsZero() {
		dateCond += fmt.Sprintf(" AND le.posted_date <= $%d", argN)
		args = append(args, to)
		argN++
	}

	q := fmt.Sprintf(`
		SELECT a.id, COALESCE(a.code,''), a.name, a.type::text,
		       COALESCE(SUM(le.debit), 0), COALESCE(SUM(le.credit), 0)
		FROM accounts a
		LEFT JOIN ledger_entries le
			ON le.account_id = a.id AND le.organization_id = $1 %s
		WHERE a.organization_id = $1
		GROUP BY a.id, a.code, a.name, a.type
		ORDER BY a.type, a.code NULLS LAST, a.name
	`, dateCond)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TrialBalanceLine
	for rows.Next() {
		var l TrialBalanceLine
		if err := rows.Scan(
			&l.AccountID, &l.AccountCode, &l.AccountName, &l.AccountType,
			&l.TotalDebit, &l.TotalCredit,
		); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func nullUUID(u *uuid.UUID) interface{} {
	if u == nil {
		return nil
	}
	return *u
}
