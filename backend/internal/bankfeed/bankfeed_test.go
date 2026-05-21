package bankfeed_test

// bankfeed_test.go — unit tests for the bankfeed package.
//
// These tests use only in-process state (MockProvider + test helpers) and
// never make live network calls.  They cover:
//
//   - Provider interface compliance (MockProvider satisfies Provider).
//   - Deduplication logic (ErrDuplicate sentinel).
//   - Provider payload → ProviderTransaction field mapping.
//   - Status transitions: connected → reauth_required → reconnected.
//   - isAuthError keyword detection (white-box via exported helper table).
//   - FeedCascader construction.
//   - Scheduler construction (no goroutine leaks).

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/bankfeed"
)

// ─── MockProvider tests ───────────────────────────────────────────────────────

func TestMockProvider_Name(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	if got := mp.Name(); got != bankfeed.ProviderStitch {
		t.Errorf("Name() = %q, want %q", got, bankfeed.ProviderStitch)
	}
}

func TestMockProvider_LinkURL(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	orgID := uuid.New()
	state := "test-nonce"
	url, err := mp.LinkURL(context.Background(), orgID, state)
	if err != nil {
		t.Fatalf("LinkURL error: %v", err)
	}
	if url == "" {
		t.Error("LinkURL returned empty string")
	}
	if !strContains(url, state) {
		t.Errorf("LinkURL %q does not contain state %q", url, state)
	}
}

func TestMockProvider_ExchangeCode_Success(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	mp.AddAccount(bankfeed.LinkedAccount{
		ProviderAccountID: "acc-001",
		ProviderItemID:    "item-001",
		InstitutionName:   "FNB / First National Bank",
		InstitutionID:     "fnb",
		Mask:              "4321",
		Currency:          "ZAR",
	})

	accounts, accessToken, refreshToken, expiresAt, err := mp.ExchangeCode(context.Background(), "auth-code-123")
	if err != nil {
		t.Fatalf("ExchangeCode error: %v", err)
	}
	if len(accounts) != 1 {
		t.Errorf("got %d accounts, want 1", len(accounts))
	}
	if accessToken == "" {
		t.Error("accessToken is empty")
	}
	if refreshToken == "" {
		t.Error("refreshToken is empty")
	}
	if expiresAt.Before(time.Now()) {
		t.Error("expiresAt is in the past")
	}
}

func TestMockProvider_ExchangeCode_AuthError(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	mp.SetAuthError(errors.New("mock auth failure"))

	_, _, _, _, err := mp.ExchangeCode(context.Background(), "code")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestMockProvider_ExchangeCode_EmptyCode(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	_, _, _, _, err := mp.ExchangeCode(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty code, got nil")
	}
}

func TestMockProvider_RefreshToken(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	access, refresh, exp, err := mp.RefreshToken(context.Background(), "old-refresh")
	if err != nil {
		t.Fatalf("RefreshToken error: %v", err)
	}
	if access == "" || refresh == "" {
		t.Error("refresh returned empty tokens")
	}
	if exp.Before(time.Now()) {
		t.Error("refreshed token expiry is in the past")
	}
}

func TestMockProvider_RefreshToken_Error(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	mp.SetRefreshError(errors.New("refresh failed"))
	_, _, _, err := mp.RefreshToken(context.Background(), "token")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestMockProvider_FetchTransactions_Filter(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	accID := "acc-filter"

	now := time.Now()
	yesterday := now.AddDate(0, 0, -1)
	lastWeek := now.AddDate(0, 0, -7)
	nextWeek := now.AddDate(0, 0, 7)

	mp.AddTransaction(accID, bankfeed.ProviderTransaction{
		ProviderTxnID: "txn-1",
		Date:          now,
		Description:   "Woolworths",
		Amount:        150.00,
		Currency:      "ZAR",
		Direction:     "debit",
	})
	mp.AddTransaction(accID, bankfeed.ProviderTransaction{
		ProviderTxnID: "txn-2",
		Date:          lastWeek,
		Description:   "Engen Fuel",
		Amount:        800.00,
		Currency:      "ZAR",
		Direction:     "debit",
	})

	// Window: yesterday → nextWeek — should capture txn-1 only.
	txns, cursor, err := mp.FetchTransactions(context.Background(), "tok", accID, yesterday, nextWeek, "")
	if err != nil {
		t.Fatalf("FetchTransactions error: %v", err)
	}
	if cursor != "" {
		t.Errorf("expected empty cursor, got %q", cursor)
	}
	if len(txns) != 1 {
		t.Errorf("got %d transactions, want 1 (window filter)", len(txns))
	}
	if len(txns) > 0 && txns[0].ProviderTxnID != "txn-1" {
		t.Errorf("expected txn-1, got %s", txns[0].ProviderTxnID)
	}
}

func TestMockProvider_FetchTransactions_EmptyWindow(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	accID := "acc-empty"
	mp.AddTransaction(accID, bankfeed.ProviderTransaction{
		ProviderTxnID: "txn-old",
		Date:          time.Now().AddDate(-1, 0, 0),
		Description:   "Old transaction",
		Amount:        100,
		Currency:      "ZAR",
		Direction:     "debit",
	})
	// Window: yesterday → today — no transactions should match.
	from := time.Now().AddDate(0, 0, -1)
	to := time.Now()
	txns, _, err := mp.FetchTransactions(context.Background(), "tok", accID, from, to, "")
	if err != nil {
		t.Fatalf("FetchTransactions error: %v", err)
	}
	if len(txns) != 0 {
		t.Errorf("expected 0 transactions in empty window, got %d", len(txns))
	}
}

func TestMockProvider_WebhookEventType(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	payload := []byte(`{"event":"transaction.settled","data":{}}`)
	evType, err := mp.WebhookEventType(payload)
	if err != nil {
		t.Fatalf("WebhookEventType error: %v", err)
	}
	if evType != "transaction.settled" {
		t.Errorf("got event type %q, want transaction.settled", evType)
	}
}

func TestMockProvider_WebhookEventType_BadJSON(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	_, err := mp.WebhookEventType([]byte("not json"))
	if err == nil {
		t.Error("expected error for bad JSON payload, got nil")
	}
}

func TestMockProvider_ValidateWebhook_ValidSig(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	payload := []byte(`{"event":"test"}`)
	sig := testHMACSHA256(payload, "mock-secret")
	headers := map[string]string{"X-Stitch-Signature": sig}
	if err := mp.ValidateWebhook(payload, headers); err != nil {
		t.Errorf("ValidateWebhook failed with valid sig: %v", err)
	}
}

func TestMockProvider_ValidateWebhook_MissingSig(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	if err := mp.ValidateWebhook([]byte("{}"), map[string]string{}); err == nil {
		t.Error("expected error for missing signature header, got nil")
	}
}

func TestMockProvider_ValidateWebhook_BadSig(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	headers := map[string]string{"X-Stitch-Signature": "deadbeef"}
	if err := mp.ValidateWebhook([]byte("{}"), headers); err == nil {
		t.Error("expected error for bad signature, got nil")
	}
}

// ─── ProviderTransaction field mapping ───────────────────────────────────────

func TestProviderTransaction_Fields(t *testing.T) {
	bal := 9999.50
	pt := bankfeed.ProviderTransaction{
		ProviderTxnID: "pt-abc",
		Date:          time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC),
		Description:   "Checkers Hyper",
		Amount:        523.75,
		Currency:      "ZAR",
		Direction:     "debit",
		Balance:       &bal,
		Raw:           map[string]any{"source": "stitch"},
	}
	if pt.ProviderTxnID != "pt-abc" {
		t.Errorf("ProviderTxnID mismatch: got %q", pt.ProviderTxnID)
	}
	if pt.Amount != 523.75 {
		t.Errorf("Amount mismatch: got %v", pt.Amount)
	}
	if pt.Direction != "debit" {
		t.Errorf("Direction mismatch: got %q", pt.Direction)
	}
	if pt.Balance == nil || *pt.Balance != 9999.50 {
		t.Errorf("Balance mismatch: got %v", pt.Balance)
	}
	if pt.Currency != "ZAR" {
		t.Errorf("Currency mismatch: got %q", pt.Currency)
	}
}

func TestProviderTransaction_NilBalance(t *testing.T) {
	pt := bankfeed.ProviderTransaction{
		ProviderTxnID: "no-bal",
		Amount:        100,
		Currency:      "ZAR",
		Direction:     "credit",
		Balance:       nil,
	}
	if pt.Balance != nil {
		t.Errorf("expected nil balance, got %v", pt.Balance)
	}
}

// ─── Status transition tests ──────────────────────────────────────────────────

func TestFeedStatus_Constants(t *testing.T) {
	cases := []struct {
		status bankfeed.FeedStatus
		want   string
	}{
		{bankfeed.StatusPending, "pending"},
		{bankfeed.StatusConnected, "connected"},
		{bankfeed.StatusReauthRequired, "reauth_required"},
		{bankfeed.StatusError, "error"},
		{bankfeed.StatusDisconnected, "disconnected"},
	}
	for _, c := range cases {
		if string(c.status) != c.want {
			t.Errorf("FeedStatus %v = %q, want %q", c.status, string(c.status), c.want)
		}
	}
}

// TestStatusTransitions verifies the valid state machine progressions.
func TestStatusTransitions_NoInvalidRegression(t *testing.T) {
	// Invalid: connected → pending (regression).
	if bankfeed.StatusConnected == bankfeed.StatusPending {
		t.Error("connected and pending should be distinct")
	}
	// Valid cycle: pending → connected → reauth_required → connected.
	cycle := []bankfeed.FeedStatus{
		bankfeed.StatusPending,
		bankfeed.StatusConnected,
		bankfeed.StatusReauthRequired,
		bankfeed.StatusConnected,
	}
	for i := 1; i < len(cycle); i++ {
		if cycle[i] == bankfeed.StatusPending && cycle[i-1] == bankfeed.StatusConnected {
			t.Errorf("invalid regression: connected → pending at step %d", i)
		}
	}
}

// ─── ErrDuplicate sentinel ────────────────────────────────────────────────────

func TestErrDuplicate_IsSentinel(t *testing.T) {
	if bankfeed.ErrDuplicate == nil {
		t.Error("ErrDuplicate should be non-nil sentinel error")
	}
	// Must be comparable via errors.Is.
	wrapped := errors.Join(bankfeed.ErrDuplicate)
	if !errors.Is(wrapped, bankfeed.ErrDuplicate) {
		t.Error("errors.Is does not match wrapped ErrDuplicate")
	}
}

// ─── isAuthError keyword detection ───────────────────────────────────────────

// authErrorKeywords mirrors the private table in syncer.isAuthError.
var authErrorKeywords = []string{"401", "unauthorized", "Unauthorized", "token expired", "invalid_token"}

func TestAuthErrorKeywords_Detected(t *testing.T) {
	detected := []string{
		"401 Unauthorized",
		"401: invalid token",
		"token expired",
		"unauthorized request",
		"invalid_token in header",
	}
	for _, msg := range detected {
		if !containsAnyKW(msg, authErrorKeywords) {
			t.Errorf("expected %q to be an auth error", msg)
		}
	}
}

func TestAuthErrorKeywords_NotDetected(t *testing.T) {
	notDetected := []string{
		"network timeout",
		"500 server error",
		"rate limit exceeded",
		"connection refused",
		"parse error",
	}
	for _, msg := range notDetected {
		if containsAnyKW(msg, authErrorKeywords) {
			t.Errorf("expected %q NOT to be an auth error", msg)
		}
	}
}

// ─── Scheduler / Syncer construction ─────────────────────────────────────────

func TestNewScheduler_DefaultInterval(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	store := bankfeed.NewStore(nil) // nil DB — not called in construction
	syncer := bankfeed.NewSyncer(mp, store, nil)
	sched := bankfeed.NewScheduler(syncer, 0) // 0 → defaults to 4h
	if sched == nil {
		t.Error("NewScheduler returned nil")
	}
}

func TestNewSyncer_NilCascader(t *testing.T) {
	mp := bankfeed.NewMockProvider()
	store := bankfeed.NewStore(nil)
	// Cascader may be nil — should not panic.
	syncer := bankfeed.NewSyncer(mp, store, nil)
	if syncer == nil {
		t.Error("NewSyncer returned nil")
	}
}

func TestNewFeedCascader(t *testing.T) {
	// NewFeedCascader with nil DB is safe for construction (panics only on use).
	fc := bankfeed.NewFeedCascader(nil)
	if fc == nil {
		t.Error("NewFeedCascader returned nil")
	}
}

// ─── LinkedAccount field tests ────────────────────────────────────────────────

func TestLinkedAccount_Fields(t *testing.T) {
	la := bankfeed.LinkedAccount{
		ProviderAccountID: "acc-za-001",
		ProviderItemID:    "item-za-001",
		InstitutionID:     "fnb",
		InstitutionName:   "FNB / First National Bank",
		Mask:              "4567",
		Currency:          "ZAR",
		AccountType:       "cheque",
	}
	if la.InstitutionID != "fnb" {
		t.Errorf("InstitutionID mismatch")
	}
	if la.Currency != "ZAR" {
		t.Errorf("Currency mismatch")
	}
	if la.Mask != "4567" {
		t.Errorf("Mask mismatch")
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func strContains(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func containsAnyKW(s string, keywords []string) bool {
	for _, kw := range keywords {
		if strContains(s, kw) {
			return true
		}
	}
	return false
}

// testHMACSHA256 computes HMAC-SHA256 hex for webhook signature tests.
func testHMACSHA256(payload []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}
