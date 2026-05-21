// Package accounting_export provides a provider-agnostic interface for pushing
// slip/scan data (contacts, transactions, bills) to external accounting systems
// such as Xero and QuickBooks Online.
//
// Design goals:
//   - Provider-agnostic: callers depend only on Provider; adding QuickBooks
//     means writing a new struct that satisfies the interface, no caller changes.
//   - Idempotent: a mapping table (accounting_export_mappings) stores the
//     external ID so re-push updates the existing record instead of duplicating.
//   - Schema-mediated: reads from contacts, transactions, accounts, tax_rates
//     and the new mapping table; does NOT touch other packages' data.
package accounting_export

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ─── Domain types (subset of what we push) ───────────────────────────────────

// Contact is the slip/scan representation of a customer or supplier to be
// pushed to the external accounting system.
type Contact struct {
	ID          uuid.UUID
	Name        string
	LegalName   string
	Email       string
	Phone       string
	TaxNumber   string
	AddressLine1 string
	AddressLine2 string
	City        string
	Region      string
	PostalCode  string
	Country     string
	Kind        string // 'customer' | 'supplier' | 'both'
}

// Transaction is the slip/scan representation of a classified transaction to
// be pushed as a bank transaction or bill in the external accounting system.
type Transaction struct {
	ID          uuid.UUID
	PostedDate  time.Time
	Direction   string // 'debit' | 'credit'
	Merchant    string
	Description string
	Amount      float64
	Currency    string
	Tax         float64

	// Resolved from the classification / account/category join.
	AccountCode string // e.g. "200" — chart-of-accounts code in the external system
	TaxRateCode string // e.g. "TAX001" / "OUTPUT" — external tax rate code
	ContactID   uuid.UUID
}

// PushResult is returned for each record pushed. ExternalID is the ID assigned
// by the provider; it is persisted to accounting_export_mappings.
type PushResult struct {
	LocalID    uuid.UUID
	ExternalID string
	Updated    bool // true = updated existing; false = created new
}

// ─── Provider interface ───────────────────────────────────────────────────────

// Provider is the single interface that every accounting backend must satisfy.
// Callers (handlers, schedulers) only talk to this interface; concrete
// implementations (XeroProvider, QuickBooksProvider) are injected.
type Provider interface {
	// Name returns the short provider code used in logs and mapping rows.
	Name() string

	// AuthURL returns the OAuth2 authorisation URL the user must visit to
	// grant access. state should be a random, session-bound nonce.
	AuthURL(orgID uuid.UUID, state string) string

	// ExchangeCode exchanges an authorisation code for access+refresh tokens
	// and stores them in oauth_grants for the given org. Returns the
	// connected account email/identifier for display.
	ExchangeCode(ctx context.Context, orgID, userID uuid.UUID, code string) (accountEmail string, err error)

	// RefreshToken fetches a fresh access token for the given org, persisting
	// the new token to oauth_grants. It is called lazily before any API call
	// when the stored token has expired.
	RefreshToken(ctx context.Context, orgID uuid.UUID) error

	// PushContact creates or updates a contact in the external system.
	// The mapping table is used to decide create-vs-update.
	PushContact(ctx context.Context, orgID uuid.UUID, c Contact) (PushResult, error)

	// PushTransaction creates or updates a bank transaction (or bill for
	// ACCPAY type) in the external system.
	PushTransaction(ctx context.Context, orgID uuid.UUID, t Transaction) (PushResult, error)
}
