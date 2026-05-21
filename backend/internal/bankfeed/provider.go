// Package bankfeed provides a provider-agnostic interface for connecting bank
// accounts and automatically importing transactions into slip/scan.
//
// # Architecture
//
// The package follows the same store/handler/scheduler split as
// internal/accounting_export and internal/fx:
//
//   - provider.go   – the Provider interface + domain types.
//   - store.go      – all DB access (bank_feed_connections, bank_statements,
//     statement_lines, transactions, oauth_grants).
//   - handlers.go   – HTTP handlers (connect, callback, status, webhook, sync).
//   - scheduler.go  – leader-guarded periodic poller.
//   - mock.go       – deterministic fake for unit tests (build tag: !live).
//
// # SA-first provider recommendation
//
// Recommended: Stitch (https://stitch.money)
//
//   - SA-first, covers FNB / Standard Bank / ABSA / Nedbank / Capitec.
//   - GraphQL API; access token + refresh token flow; webhook push.
//   - Pricing: per linked account / month (competitive vs TrueLayer UK).
//   - Data scopes: account details, balances, transactions (merchantName,
//     merchantCategory, amount, currency, transactionType).
//   - POPIA-aligned; SA data residency.
//   - Sandbox: full mock sandbox, no live bank required for development.
//
// Runner-up: Mono (https://mono.co.za)
//
//   - Also SA-first; REST API; broader SSA coverage (Nigeria, Kenya).
//   - Simpler API but smaller SA bank list than Stitch.
//   - Less mature sandbox at time of writing.
//
// International fallback: Plaid (already in bank_feed_provider enum)
//   - Use for UK/US/EU connections after the SA market is established.
//
// The Provider interface is designed so any of the above drops in without
// touching callers.  The 'stitch' enum value was added to bank_feed_provider
// in migration 20260521000003; 'plaid' can be wired in future.
//
// # Live integration gate
//
// Live HTTP calls to Stitch are gated behind the `live` build tag:
//
//	go build -tags live ./...
//
// Without the tag the mock provider is compiled in (safe for CI / unit tests).
package bankfeed

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ─── Domain types ─────────────────────────────────────────────────────────────

// ProviderName is the short string code for each bank-feed backend. It maps to
// the bank_feed_provider DB enum (extended with 'stitch' in migration
// 20260521000003).
type ProviderName string

const (
	ProviderStitch   ProviderName = "stitch"
	ProviderPlaid    ProviderName = "plaid"
	ProviderManual   ProviderName = "manual"
	ProviderYodlee   ProviderName = "yodlee"
	ProviderTrueLayer ProviderName = "truelayer"
	ProviderSaltEdge ProviderName = "salt_edge"
)

// LinkedAccount is a bank account returned by the provider after a successful
// link.  One provider item (user consent) can expose multiple accounts.
type LinkedAccount struct {
	// ProviderAccountID is the opaque account identifier within the provider.
	ProviderAccountID string
	// ProviderItemID identifies the consent / item that groups multiple accounts
	// (e.g. one Stitch linkToken can link chequing + savings).
	ProviderItemID string
	// InstitutionID is the provider's code for the bank (e.g. "fnb", "absa").
	InstitutionID string
	// InstitutionName is the human-readable bank name ("FNB / First National Bank").
	InstitutionName string
	// Mask is the last 4 digits of the account number for display (never the
	// full account number).
	Mask string
	// Currency is the ISO-4217 code (usually "ZAR" for SA accounts).
	Currency string
	// AccountType is a hint: "cheque", "savings", "credit", "loan", …
	AccountType string
}

// ProviderTransaction is a single transaction returned by the provider's
// transactions endpoint.  It is provider-neutral; each concrete provider
// maps its wire format to this struct.
type ProviderTransaction struct {
	// ProviderTxnID is the stable, provider-assigned transaction identifier.
	// Used for deduplication (unique per connection in statement_lines).
	ProviderTxnID string
	// Date is the posted / settled date (not the authorisation date).
	Date time.Time
	// Description is the raw narrative / merchant string from the bank.
	Description string
	// Amount is always positive; Direction indicates debit/credit.
	Amount float64
	// Currency ISO-4217 code.
	Currency string
	// Direction is "debit" (money leaves) or "credit" (money arrives).
	Direction string
	// Balance is the running balance after this transaction, if available.
	Balance *float64
	// Raw holds the full provider JSON payload for audit / reconciliation.
	Raw map[string]any
}

// ConnectParams carries the information needed to persist a newly-linked
// account after the OAuth callback is complete.
type ConnectParams struct {
	OrganizationID    uuid.UUID
	UserID            uuid.UUID
	LinkedAccount     LinkedAccount
	AccessToken       string
	RefreshToken      string
	TokenExpiresAt    time.Time
	ConsentExpiresAt  *time.Time
}

// FeedStatus mirrors the bank_feed_status DB enum.
type FeedStatus string

const (
	StatusPending       FeedStatus = "pending"
	StatusConnected     FeedStatus = "connected"
	StatusReauthRequired FeedStatus = "reauth_required"
	StatusError         FeedStatus = "error"
	StatusDisconnected  FeedStatus = "disconnected"
)

// ─── Provider interface ───────────────────────────────────────────────────────

// Provider is the single interface every bank-feed backend must satisfy.
// Callers (handlers, scheduler) only speak to this interface; concrete
// implementations are injected at startup and gated behind build tags.
type Provider interface {
	// Name returns the short provider code (maps to bank_feed_provider enum).
	Name() ProviderName

	// LinkURL returns the URL the user must visit to initiate the bank-link
	// flow (e.g. Stitch LinkToken consent screen).  state is a CSRF nonce
	// that the provider will echo back in the callback.
	LinkURL(ctx context.Context, orgID uuid.UUID, state string) (string, error)

	// ExchangeCode processes the OAuth callback code / token, returns the
	// set of linked accounts and raw token material.  The caller persists
	// these via Store.
	ExchangeCode(ctx context.Context, code string) ([]LinkedAccount, string, string, time.Time, error)
	// Returns: accounts, accessToken, refreshToken, expiresAt, error.

	// RefreshToken obtains a fresh access token using the stored refresh
	// token.  Returns the new access token, refresh token, and expiry.
	RefreshToken(ctx context.Context, refreshToken string) (string, string, time.Time, error)

	// Accounts returns the accounts linked under the given provider item.
	// Used after the initial connect to populate bank_feed_connections rows.
	Accounts(ctx context.Context, accessToken, providerItemID string) ([]LinkedAccount, error)

	// FetchTransactions returns transactions for a single linked account.
	// from/to bound the fetch window; cursor is the provider's pagination
	// token from the previous call (empty on first call).
	// Returns transactions, next cursor (empty when exhausted), and any error.
	FetchTransactions(ctx context.Context, accessToken, providerAccountID string, from, to time.Time, cursor string) ([]ProviderTransaction, string, error)

	// WebhookEventType extracts the event type string from a raw webhook
	// payload so the handler can route it correctly without parsing the
	// full body twice.
	WebhookEventType(payload []byte) (string, error)

	// ValidateWebhook verifies the request signature / HMAC so only genuine
	// provider callbacks are processed.
	ValidateWebhook(payload []byte, headers map[string]string) error
}
