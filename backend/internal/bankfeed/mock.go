package bankfeed

// MockProvider is a deterministic in-memory Provider for unit tests.
// It is always compiled (no build tag required); the live Stitch provider
// is gated behind the 'live' build tag in stitch.go.
//
// Usage in tests:
//
//	mp := bankfeed.NewMockProvider()
//	mp.AddAccount(bankfeed.LinkedAccount{ProviderAccountID: "acc-1", ...})
//	mp.AddTransaction("acc-1", bankfeed.ProviderTransaction{...})

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

// MockProvider satisfies the Provider interface using in-memory state.
// Thread-safe for concurrent test access.
type MockProvider struct {
	mu           sync.Mutex
	accounts     []LinkedAccount
	transactions map[string][]ProviderTransaction // providerAccountID → txns
	// authError, if non-nil, is returned by ExchangeCode.
	authError error
	// refreshError, if non-nil, is returned by RefreshToken.
	refreshError error
	// webhookSecret is used for ValidateWebhook HMAC check.
	webhookSecret string
	// linkURL is the URL returned by LinkURL.
	linkURL string
}

// NewMockProvider returns a ready-to-use MockProvider.
func NewMockProvider() *MockProvider {
	return &MockProvider{
		transactions:  make(map[string][]ProviderTransaction),
		webhookSecret: "mock-secret",
		linkURL:       "https://mock.stitch.money/link?state=",
	}
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

// AddAccount adds a linked account to the mock's account list.
func (m *MockProvider) AddAccount(la LinkedAccount) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.accounts = append(m.accounts, la)
}

// AddTransaction appends a ProviderTransaction for the given providerAccountID.
func (m *MockProvider) AddTransaction(providerAccountID string, pt ProviderTransaction) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.transactions[providerAccountID] = append(m.transactions[providerAccountID], pt)
}

// SetAuthError causes ExchangeCode to return the given error.
func (m *MockProvider) SetAuthError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.authError = err
}

// SetRefreshError causes RefreshToken to return the given error.
func (m *MockProvider) SetRefreshError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refreshError = err
}

// ─── Provider interface ───────────────────────────────────────────────────────

// Name returns "stitch" so mock rows are stored under the same provider code
// as the live implementation.
func (m *MockProvider) Name() ProviderName { return ProviderStitch }

// LinkURL returns a deterministic mock URL with the state appended.
func (m *MockProvider) LinkURL(_ context.Context, _ uuid.UUID, state string) (string, error) {
	return m.linkURL + state, nil
}

// ExchangeCode returns a fixed access+refresh token pair and the first
// registered account, unless authError is set.
func (m *MockProvider) ExchangeCode(_ context.Context, code string) ([]LinkedAccount, string, string, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.authError != nil {
		return nil, "", "", time.Time{}, m.authError
	}
	if code == "" {
		return nil, "", "", time.Time{}, errors.New("mock: empty code")
	}
	exp := time.Now().Add(1 * time.Hour)
	return append([]LinkedAccount(nil), m.accounts...), "mock-access-" + code, "mock-refresh-" + code, exp, nil
}

// RefreshToken returns a new mock access token, or refreshError if set.
func (m *MockProvider) RefreshToken(_ context.Context, refreshToken string) (string, string, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refreshError != nil {
		return "", "", time.Time{}, m.refreshError
	}
	exp := time.Now().Add(1 * time.Hour)
	return "mock-access-refreshed-" + refreshToken, refreshToken, exp, nil
}

// Accounts returns the registered mock accounts.
func (m *MockProvider) Accounts(_ context.Context, _, _ string) ([]LinkedAccount, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]LinkedAccount(nil), m.accounts...), nil
}

// FetchTransactions returns all registered transactions for the account.
// It respects the from/to filter and ignores cursor for simplicity.
func (m *MockProvider) FetchTransactions(_ context.Context, _, providerAccountID string, from, to time.Time, _ string) ([]ProviderTransaction, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.transactions[providerAccountID]
	var out []ProviderTransaction
	for _, t := range all {
		if (t.Date.Equal(from) || t.Date.After(from)) && (t.Date.Equal(to) || t.Date.Before(to)) {
			out = append(out, t)
		}
	}
	return out, "", nil // empty cursor = exhausted
}

// WebhookEventType extracts the "event" field from a JSON payload.
func (m *MockProvider) WebhookEventType(payload []byte) (string, error) {
	var body struct {
		Event string `json:"event"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return "", fmt.Errorf("mock: parse webhook: %w", err)
	}
	return body.Event, nil
}

// ValidateWebhook checks an HMAC-SHA256 signature in the "X-Stitch-Signature"
// header using the mock webhook secret.
func (m *MockProvider) ValidateWebhook(payload []byte, headers map[string]string) error {
	sig, ok := headers["X-Stitch-Signature"]
	if !ok {
		return errors.New("mock: missing X-Stitch-Signature header")
	}
	mac := hmac.New(sha256.New, []byte(m.webhookSecret))
	mac.Write(payload)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return errors.New("mock: invalid webhook signature")
	}
	return nil
}
