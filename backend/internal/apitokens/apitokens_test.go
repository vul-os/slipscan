package apitokens

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─── token hash/verify ─────────────────────────────────────────────────────

func TestHashToken_Deterministic(t *testing.T) {
	h1 := hashToken("hello-world")
	h2 := hashToken("hello-world")
	if h1 != h2 {
		t.Fatal("hashToken must be deterministic")
	}
	h3 := hashToken("other-value")
	if h1 == h3 {
		t.Fatal("different plaintexts must produce different hashes")
	}
}

func TestVerifyToken(t *testing.T) {
	plain := "sk_live_abcdefghijklmnopqrstuvwxyz123456"
	hash := hashToken(plain)
	if !VerifyToken(plain, hash) {
		t.Fatal("VerifyToken should return true for matching pair")
	}
	if VerifyToken("wrong", hash) {
		t.Fatal("VerifyToken should return false for wrong plaintext")
	}
	if VerifyToken(plain, "badhash") {
		t.Fatal("VerifyToken should return false for wrong hash")
	}
}

func TestGenerate_Format(t *testing.T) {
	for _, kind := range []Kind{KindLive, KindTest, KindRestricted} {
		plain, prefix, hash, err := generate(kind)
		if err != nil {
			t.Fatalf("generate(%s): %v", kind, err)
		}
		// Token must start with "sk_<kind>_"
		expected := "sk_" + string(kind) + "_"
		if len(plain) < len(expected) || plain[:len(expected)] != expected {
			t.Errorf("kind=%s: token %q does not start with %q", kind, plain, expected)
		}
		// Prefix must be the first 12 chars.
		if prefix != plain[:12] {
			t.Errorf("kind=%s: prefix %q != token[:12] %q", kind, prefix, plain[:12])
		}
		// Hash must verify.
		if !VerifyToken(plain, hash) {
			t.Errorf("kind=%s: hash/verify round-trip failed", kind)
		}
	}
}

func TestPrefixOf(t *testing.T) {
	s := "sk_live_ABCDEFGHIJKLMNOP"
	if prefixOf(s) != s[:12] {
		t.Fatalf("prefixOf: got %q, want %q", prefixOf(s), s[:12])
	}
	short := "sk_live_A"
	if prefixOf(short) != short {
		t.Fatalf("prefixOf short: got %q, want %q", prefixOf(short), short)
	}
}

// ─── scope allow/deny matrix ───────────────────────────────────────────────

func TestToken_HasScope(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindLive,
		Scopes:         []string{"documents:write", "transactions:read"},
	}

	allowed := []string{"documents:write", "transactions:read"}
	denied := []string{"", "documents:read", "transactions:write", "admin:write", "documents:delete"}

	for _, s := range allowed {
		if !tok.HasScope(s) {
			t.Errorf("HasScope(%q) should be true", s)
		}
	}
	for _, s := range denied {
		if tok.HasScope(s) {
			t.Errorf("HasScope(%q) should be false", s)
		}
	}
}

// ─── test-vs-live separation ───────────────────────────────────────────────

func TestRequireLive_TestTokenRejected(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindTest,
		Scopes:         []string{"documents:write"},
	}

	handler := RequireLive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("test token on live-only endpoint: got %d, want %d", rr.Code, http.StatusForbidden)
	}
}

func TestRequireLive_LiveTokenAllowed(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindLive,
		Scopes:         []string{"documents:write"},
	}

	reached := false
	handler := RequireLive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("live token on live-only endpoint: got %d, want %d", rr.Code, http.StatusOK)
	}
	if !reached {
		t.Error("handler was not called for live token")
	}
}

func TestRequireLive_RestrictedTokenAllowed(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindRestricted,
		Scopes:         []string{"documents:write"},
	}

	handler := RequireLive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("restricted token on live-only endpoint: got %d, want %d", rr.Code, http.StatusOK)
	}
}

// ─── scope middleware ──────────────────────────────────────────────────────

func TestRequireScope_Allow(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindLive,
		Scopes:         []string{"transactions:read"},
	}

	reached := false
	handler := RequireScope("transactions:read")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		}),
	)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("correct scope: got %d, want %d", rr.Code, http.StatusOK)
	}
	if !reached {
		t.Error("handler was not called")
	}
}

func TestRequireScope_Deny(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindLive,
		Scopes:         []string{"transactions:read"},
	}

	handler := RequireScope("documents:write")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("wrong scope: got %d, want %d", rr.Code, http.StatusForbidden)
	}
}

// ─── rate-limit behaviour ──────────────────────────────────────────────────

func TestRateLimiter_AllowAndDeny(t *testing.T) {
	rl := NewRateLimiter()
	id := "test-token-id"
	limit := 5

	for i := 0; i < limit; i++ {
		if !rl.Allow(id, limit) {
			t.Fatalf("Allow should return true for request %d/%d", i+1, limit)
		}
	}
	// Next call must be denied.
	if rl.Allow(id, limit) {
		t.Fatal("Allow should return false after limit is reached")
	}
}

func TestRateLimiter_WindowReset(t *testing.T) {
	rl := NewRateLimiter()
	id := "window-test"
	limit := 2

	// Fill the window.
	rl.Allow(id, limit)
	rl.Allow(id, limit)
	if rl.Allow(id, limit) {
		t.Fatal("should be rate-limited")
	}

	// Manually expire the window.
	rl.mu.Lock()
	rl.buckets[id].windowEnd = time.Now().Add(-time.Second)
	rl.mu.Unlock()

	// Now the window should reset.
	if !rl.Allow(id, limit) {
		t.Fatal("window should have reset; Allow should return true")
	}
}

func TestRateLimiter_DefaultLimit(t *testing.T) {
	rl := NewRateLimiter()
	id := "default-limit-test"

	// limitPerMin = 0 should use DefaultRateLimitPerMin (60).
	for i := 0; i < DefaultRateLimitPerMin; i++ {
		if !rl.Allow(id, 0) {
			t.Fatalf("Allow with default limit should permit request %d/%d", i+1, DefaultRateLimitPerMin)
		}
	}
	if rl.Allow(id, 0) {
		t.Fatal("Allow should be denied after DefaultRateLimitPerMin")
	}
}

func TestRateLimiter_MultipleTokensIndependent(t *testing.T) {
	rl := NewRateLimiter()
	limit := 2

	rl.Allow("tok1", limit)
	rl.Allow("tok1", limit)
	// tok1 is now exhausted; tok2 should still be allowed.
	if !rl.Allow("tok2", limit) {
		t.Fatal("tok2 should not be affected by tok1's rate limit")
	}
}

// ─── WithToken / TokenFrom round-trip ─────────────────────────────────────

func TestContextRoundTrip(t *testing.T) {
	tok := &Token{
		ID:             uuid.New(),
		OrganizationID: uuid.New(),
		Kind:           KindTest,
		Scopes:         []string{"transactions:read"},
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(WithToken(req.Context(), tok))

	got, ok := TokenFrom(req.Context())
	if !ok {
		t.Fatal("TokenFrom should return ok=true after WithToken")
	}
	if got.ID != tok.ID {
		t.Fatalf("TokenFrom: got ID %v, want %v", got.ID, tok.ID)
	}
}
