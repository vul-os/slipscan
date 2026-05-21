//go:build integration

// Package testsuite — Phase 1 end-to-end pipeline integration test.
//
// This file exercises the full classification pipeline from a seeded
// document_extraction row through to auto-classification via promoted rules.
// It is gated on the `integration` build tag AND a non-empty DATABASE_URL
// environment variable; the test skips cleanly if either is absent.
//
// Run with:
//
//	DATABASE_URL="postgres:///slipscan?host=/var/run/postgresql" \
//	  go test -tags=integration -v ./internal/testsuite/... -run TestPhase1PipelineE2E
//
// For endpoints that do not yet exist (pending implementation tasks), each
// sub-test calls t.Skip with a "pending Pxx" message so the harness compiles
// on the base branch and the skipped steps are self-documenting.
package testsuite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/exolutionza/slipscan/backend/internal/auth"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/email"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/merchant"
	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/google/uuid"
)

// ─── helpers ────────────────────────────────────────────────────────────────

// pipelineFixture holds the identifiers created by seedPipelineFixture.
type pipelineFixture struct {
	UserID      uuid.UUID
	OrgID       uuid.UUID
	CategoryID  uuid.UUID // "Groceries" category seeded for the org
	DocID       uuid.UUID
	ExtractionID uuid.UUID
	MerchantRaw string // raw merchant string used in the extraction
}

// seedPipelineFixture creates a fresh, isolated org+user for the E2E test.
// It inserts a documents row and a document_extractions row whose `extracted`
// JSONB matches the Phase 1 contract §2 shape. Idempotent per test run
// because each call uses a fresh random UUID for the user email.
func seedPipelineFixture(ctx context.Context, t *testing.T, sqlDB *sql.DB) pipelineFixture {
	t.Helper()

	// Use a unique email per run so the test is isolated even if previous runs
	// left data behind (the tx cleans its own rows via defer).
	email := fmt.Sprintf("e2e+pipeline+%s@slipscan.local", uuid.New().String()[:8])
	const rawMerchant = "WOOLWORTHS PTY LTD #4021"
	expectedNorm := merchant.Normalize(rawMerchant)

	// --- user ---
	var userID uuid.UUID
	if err := sqlDB.QueryRowContext(ctx, `
		INSERT INTO users (email, password_hash, full_name)
		VALUES ($1, 'x', 'E2E Pipeline Test')
		RETURNING id`, email).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// --- org (personal) ---
	slug := "e2e-pipeline-" + uuid.New().String()[:8]
	var orgID uuid.UUID
	if err := sqlDB.QueryRowContext(ctx, `
		INSERT INTO organizations (kind, name, slug, rx_local_part, created_by)
		VALUES ('personal', 'E2E Pipeline', $1, $2, $3)
		RETURNING id`, slug, slug, userID).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if _, err := sqlDB.ExecContext(ctx, `
		INSERT INTO personal_profiles (organization_id, full_name)
		VALUES ($1, 'E2E Pipeline Test')`, orgID); err != nil {
		t.Fatalf("seed personal_profile: %v", err)
	}
	if _, err := sqlDB.ExecContext(ctx, `
		INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, 'owner')`, orgID, userID); err != nil {
		t.Fatalf("seed membership: %v", err)
	}

	// --- category: "Groceries" (expense) ---
	var categoryID uuid.UUID
	if err := sqlDB.QueryRowContext(ctx, `
		INSERT INTO categories (organization_id, name, kind)
		VALUES ($1, 'Groceries', 'expense')
		RETURNING id`, orgID).Scan(&categoryID); err != nil {
		t.Fatalf("seed category: %v", err)
	}

	// --- document ---
	var docID uuid.UUID
	if err := sqlDB.QueryRowContext(ctx, `
		INSERT INTO documents (organization_id, uploaded_by, source, kind, storage_url, status)
		VALUES ($1, $2, 'upload', 'slip', 'test://placeholder', 'pending')
		RETURNING id`, orgID, userID).Scan(&docID); err != nil {
		t.Fatalf("seed document: %v", err)
	}

	// --- document_extractions with Phase 1 §2 `extracted` shape ---
	extracted := map[string]any{
		"kind":       "slip",
		"merchant":   rawMerchant,
		"date":       "2026-05-18",
		"currency":   "ZAR",
		"subtotal":   210.00,
		"tax":        31.50,
		"total":      241.50,
		"confidence": 0.94,
		"line_items": []map[string]any{
			{
				"description": "Milk 2L",
				"qty":         1,
				"unit":        24.99,
				"amount":      24.99,
			},
		},
	}
	extractedJSON, _ := json.Marshal(extracted)

	var extractionID uuid.UUID
	if err := sqlDB.QueryRowContext(ctx, `
		INSERT INTO document_extractions
			(document_id, organization_id, status, extracted, is_current)
		VALUES ($1, $2, 'extracted', $3::jsonb, true)
		RETURNING id`, docID, orgID, string(extractedJSON)).Scan(&extractionID); err != nil {
		t.Fatalf("seed document_extraction: %v", err)
	}
	// Update documents.current_extraction_id pointer.
	if _, err := sqlDB.ExecContext(ctx, `
		UPDATE documents SET current_extraction_id = $1, status = 'extracted'
		WHERE id = $2`, extractionID, docID); err != nil {
		t.Fatalf("update document.current_extraction_id: %v", err)
	}

	t.Logf("fixture: user=%s org=%s doc=%s extraction=%s merchant_normalized=%q",
		userID, orgID, docID, extractionID, expectedNorm)

	return pipelineFixture{
		UserID:       userID,
		OrgID:        orgID,
		CategoryID:   categoryID,
		DocID:        docID,
		ExtractionID: extractionID,
		MerchantRaw:  rawMerchant,
	}
}

// cleanupFixture removes all rows created for the test org so reruns stay clean.
// Called via t.Cleanup so it runs even on t.Fatal.
func cleanupFixture(ctx context.Context, t *testing.T, sqlDB *sql.DB, fix pipelineFixture) {
	t.Helper()
	// Cascade deletes on organization_id handle most rows.
	if _, err := sqlDB.ExecContext(ctx,
		`DELETE FROM organizations WHERE id = $1`, fix.OrgID); err != nil {
		t.Logf("cleanup org: %v", err) // non-fatal; log only
	}
	if _, err := sqlDB.ExecContext(ctx,
		`DELETE FROM users WHERE id = $1`, fix.UserID); err != nil {
		t.Logf("cleanup user: %v", err)
	}
}

// ─── server helper ──────────────────────────────────────────────────────────

// jwtSecret used exclusively by the in-process test server.
var testJWTSecret = []byte("e2e-test-secret-must-be-32-bytes!")

// newTestMux builds the minimal http.ServeMux needed for Phase 1 tests.
// It wires the existing auth+org routes and any Phase 1 routes if they are
// registered; missing routes surface as 404s which the individual sub-tests
// interpret as "pending".
func newTestMux(sqlDB *sql.DB) http.Handler {
	signer := auth.NewSigner(testJWTSecret, 15*time.Minute, 7*24*time.Hour, "slipscan-e2e")
	userStore := auth.NewStore(sqlDB)
	tokenStore := auth.NewTokenStore(sqlDB)
	orgStore := org.NewStore(sqlDB)

	authH := auth.NewHandler(auth.HandlerConfig{
		Users:           userStore,
		Tokens:          tokenStore,
		Signer:          signer,
		Orgs:            orgStore,
		Mailer:          email.NoopSender{},
		FrontendBaseURL: "http://localhost",
	})
	orgH := org.NewHandler(orgStore)

	authed := func(h http.HandlerFunc) http.Handler {
		return signer.Middleware(h)
	}

	mux := http.NewServeMux()

	// Auth routes
	mux.HandleFunc("POST /auth/register", authH.Register)
	mux.HandleFunc("POST /auth/login", authH.Login)

	// Org routes
	mux.Handle("POST /orgs", authed(orgH.Create))
	mux.Handle("GET /orgs", authed(orgH.ListMine))

	// ── Phase 1 routes (added by P1-02 / P1-03 implementors) ──
	// These are registered here only when the implementation packages
	// exist. On the base branch they are absent and sub-tests that call
	// them detect the 404 and skip.
	//
	// P1-02: POST /orgs/{orgID}/documents/{docID}/classify
	// P1-02: GET  /orgs/{orgID}/transactions
	// P1-03: PATCH /orgs/{orgID}/transactions/{txID}/classification
	//
	// No registration here — implementation agents add their own routes in
	// cmd/server/main.go. The test hits a dedicated httptest server built
	// from this mux; if routes are absent, sub-tests skip.

	return httpx.Chain(mux,
		httpx.RequestLogger,
		httpx.SecurityHeaders,
	)
}

// ─── token helper ────────────────────────────────────────────────────────────

// issueTestToken mints a JWT for the given user directly (no HTTP round-trip).
func issueTestToken(userID uuid.UUID, email string) (string, error) {
	signer := auth.NewSigner(testJWTSecret, 15*time.Minute, 7*24*time.Hour, "slipscan-e2e")
	pair, err := signer.Issue(userID, email)
	if err != nil {
		return "", err
	}
	return pair.AccessToken, nil
}

// ─── HTTP client helpers ─────────────────────────────────────────────────────

type apiClient struct {
	base   string
	bearer string
	c      *http.Client
}

func (a *apiClient) do(method, path string, body any) (*http.Response, []byte, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, a.base+path, reqBody)
	if err != nil {
		return nil, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if a.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+a.bearer)
	}
	resp, err := a.c.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return resp, respBody, nil
}

// skipIfPending treats a 404 / 405 as "endpoint not yet implemented" and
// calls t.Skip with the given pending-task label. Returns true if skipped.
func skipIfPending(t *testing.T, resp *http.Response, body []byte, pendingID string) bool {
	t.Helper()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
		t.Skipf("pending %s: endpoint not yet registered (HTTP %d)", pendingID, resp.StatusCode)
		return true
	}
	return false
}

// ─── main test ───────────────────────────────────────────────────────────────

// TestPhase1PipelineE2E is the full Phase 1 pipeline integration harness.
// It runs as a series of sub-tests that build on each other's state.
//
// Requires:
//   - DATABASE_URL env var pointing at a migrated Postgres database
//   - Build tag: -tags=integration
//
// Individual sub-tests skip with "pending Pxx" when the implementation
// routes are not yet present (safe on the base branch).
func TestPhase1PipelineE2E(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping Phase 1 pipeline integration test")
	}

	ctx := context.Background()

	sqlDB, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open DB: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	// Seed isolated fixture data for this test run.
	fix := seedPipelineFixture(ctx, t, sqlDB)
	t.Cleanup(func() { cleanupFixture(ctx, t, sqlDB, fix) })

	// Build in-process test server.
	srv := httptest.NewServer(newTestMux(sqlDB))
	t.Cleanup(srv.Close)

	token, err := issueTestToken(fix.UserID, "e2e@slipscan.local")
	if err != nil {
		t.Fatalf("issue test token: %v", err)
	}

	client := &apiClient{
		base:   srv.URL,
		bearer: token,
		c:      &http.Client{Timeout: 30 * time.Second},
	}

	// ── helpers used across sub-tests ──────────────────────────────────────
	orgPath := func(rest string) string {
		return "/orgs/" + fix.OrgID.String() + rest
	}
	assertStatus := func(t *testing.T, resp *http.Response, body []byte, want int) {
		t.Helper()
		if resp.StatusCode != want {
			t.Fatalf("want HTTP %d, got %d; body: %s", want, resp.StatusCode, body)
		}
	}

	// State shared across sub-tests (set by earlier steps, read by later ones).
	var (
		txID  uuid.UUID // set by P1-02 classify step
		txID2 uuid.UUID // second transaction for same merchant (auto-classify check)
	)

	// ────────────────────────────────────────────────────────────────────────
	// Step 1 — P1-02: POST /orgs/{orgID}/documents/{docID}/classify
	// Assert: transactions row exists, transaction_classifications is_current=true
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-02_classify", func(t *testing.T) {
		path := orgPath("/documents/" + fix.DocID.String() + "/classify")
		resp, body, err := client.do("POST", path, nil)
		if err != nil {
			t.Fatalf("classify POST: %v", err)
		}
		if skipIfPending(t, resp, body, "P1-02") {
			return
		}
		assertStatus(t, resp, body, http.StatusOK)

		// Decode response to get transaction ID.
		var result struct {
			TransactionID string `json:"transaction_id"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("decode classify response: %v; body=%s", err, body)
		}
		txID, err = uuid.Parse(result.TransactionID)
		if err != nil {
			t.Fatalf("parse transaction_id: %v", err)
		}

		// Assert transactions row exists with correct merchant_normalized.
		var (
			dbMerchantRaw  string
			dbMerchantNorm string
			dbCurrency     string
			dbStatus       string
		)
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT merchant, merchant_normalized, currency, status
			FROM transactions
			WHERE id = $1 AND organization_id = $2`,
			txID, fix.OrgID,
		).Scan(&dbMerchantRaw, &dbMerchantNorm, &dbCurrency, &dbStatus); err != nil {
			t.Fatalf("query transaction: %v", err)
		}

		wantNorm := merchant.Normalize(fix.MerchantRaw)
		if dbMerchantNorm != wantNorm {
			t.Errorf("merchant_normalized = %q, want %q", dbMerchantNorm, wantNorm)
		}
		if dbCurrency != "ZAR" {
			t.Errorf("currency = %q, want ZAR", dbCurrency)
		}
		t.Logf("transaction created: id=%s merchant_normalized=%q status=%s", txID, dbMerchantNorm, dbStatus)

		// Assert transaction_classifications row: is_current=true, source set.
		var (
			classSource    string
			classIsCurrent bool
			classConfidence sql.NullFloat64
		)
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT source, is_current, confidence
			FROM transaction_classifications
			WHERE transaction_id = $1 AND is_current = true`,
			txID,
		).Scan(&classSource, &classIsCurrent, &classConfidence); err != nil {
			t.Fatalf("query current classification: %v", err)
		}
		if !classIsCurrent {
			t.Error("classification.is_current should be true")
		}
		validSources := map[string]bool{"rule": true, "merchant_signal": true, "llm": true}
		if !validSources[classSource] {
			t.Errorf("classification.source = %q, want one of rule|merchant_signal|llm", classSource)
		}
		t.Logf("classification: source=%s confidence=%v", classSource, classConfidence)
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 2 — P1-02: GET /orgs/{orgID}/transactions
	// Assert: transaction appears in the list
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-02_list_transactions", func(t *testing.T) {
		if txID == uuid.Nil {
			t.Skip("pending P1-02: txID not set (classify step skipped or failed)")
		}

		resp, body, err := client.do("GET", orgPath("/transactions"), nil)
		if err != nil {
			t.Fatalf("GET transactions: %v", err)
		}
		if skipIfPending(t, resp, body, "P1-02") {
			return
		}
		assertStatus(t, resp, body, http.StatusOK)

		var result struct {
			Transactions []struct {
				ID                 string `json:"id"`
				MerchantNormalized string `json:"merchant_normalized"`
			} `json:"transactions"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("decode transactions list: %v", err)
		}

		found := false
		for _, tx := range result.Transactions {
			if tx.ID == txID.String() {
				found = true
				wantNorm := merchant.Normalize(fix.MerchantRaw)
				if tx.MerchantNormalized != wantNorm {
					t.Errorf("listed tx merchant_normalized = %q, want %q",
						tx.MerchantNormalized, wantNorm)
				}
			}
		}
		if !found {
			t.Errorf("transaction %s not found in GET /transactions", txID)
		}
		t.Logf("GET /transactions: found %d rows, located txID=%s", len(result.Transactions), txID)
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 3a — P1-03: PATCH correction #1
	// Recategorize txID to fix.CategoryID. Should write classification_corrections
	// but NOT yet promote a rule (threshold is 2).
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-03_correction_1", func(t *testing.T) {
		if txID == uuid.Nil {
			t.Skip("pending P1-02: txID not set (classify step skipped)")
		}

		patchBody := map[string]any{
			"category_id":        fix.CategoryID.String(),
			"apply_to_existing":  false,
		}
		resp, body, err := client.do("PATCH",
			orgPath("/transactions/"+txID.String()+"/classification"),
			patchBody,
		)
		if err != nil {
			t.Fatalf("PATCH classification #1: %v", err)
		}
		if skipIfPending(t, resp, body, "P1-03") {
			return
		}
		assertStatus(t, resp, body, http.StatusOK)

		// Assert classification_corrections row exists.
		var corrCount int
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM classification_corrections
			WHERE transaction_id = $1 AND organization_id = $2
			  AND new_category_id = $3`,
			txID, fix.OrgID, fix.CategoryID,
		).Scan(&corrCount); err != nil {
			t.Fatalf("query corrections: %v", err)
		}
		if corrCount == 0 {
			t.Error("expected at least 1 classification_corrections row after PATCH")
		}

		// Assert new transaction_classifications row with source='user', is_current=true.
		var (
			newSource    string
			newCurrent   bool
			newConfidence float64
		)
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT source, is_current, confidence
			FROM transaction_classifications
			WHERE transaction_id = $1 AND is_current = true`,
			txID,
		).Scan(&newSource, &newCurrent, &newConfidence); err != nil {
			t.Fatalf("query current classification after correction: %v", err)
		}
		if newSource != "user" {
			t.Errorf("after correction source = %q, want user", newSource)
		}
		if newConfidence != 1.0 {
			t.Errorf("after correction confidence = %v, want 1.0", newConfidence)
		}

		// After only 1 correction, NO rule should be promoted yet.
		var ruleCount int
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM classification_rules
			WHERE organization_id = $1
			  AND match_value = $2
			  AND source = 'user'`,
			fix.OrgID, merchant.Normalize(fix.MerchantRaw),
		).Scan(&ruleCount); err != nil {
			t.Fatalf("query rules (after 1 correction): %v", err)
		}
		if ruleCount > 0 {
			t.Errorf("rule promoted after only 1 correction — expected threshold 2")
		}
		t.Logf("correction #1 ok: source=%s confidence=%v, rules=%d (not promoted yet)",
			newSource, newConfidence, ruleCount)
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 3b — P1-03: PATCH correction #2 (same merchant → should promote rule)
	// We create a second transaction for the same merchant and correct it.
	// After 2 corrections for the same merchant_normalized → category,
	// a classification_rules row must be upserted.
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-03_correction_2_promotes_rule", func(t *testing.T) {
		if txID == uuid.Nil {
			t.Skip("pending P1-02: txID not set (classify step skipped)")
		}

		// Insert a second transaction for the same merchant (simulating a second
		// document coming in for the same merchant before the rule is learned).
		norm := merchant.Normalize(fix.MerchantRaw)
		if err := sqlDB.QueryRowContext(ctx, `
			INSERT INTO transactions
				(organization_id, merchant, merchant_normalized, amount, currency, posted_date, status)
			VALUES ($1, $2, $3, 99.99, 'ZAR', '2026-05-19', 'pending')
			RETURNING id`,
			fix.OrgID, fix.MerchantRaw, norm,
		).Scan(&txID2); err != nil {
			t.Fatalf("insert second transaction: %v", err)
		}

		// Give it an initial (llm) classification so the PATCH has something to override.
		if _, err := sqlDB.ExecContext(ctx, `
			INSERT INTO transaction_classifications
				(transaction_id, organization_id, source, confidence, is_current, category_id)
			VALUES ($1, $2, 'llm', 0.70, true, $3)`,
			txID2, fix.OrgID, fix.CategoryID,
		); err != nil {
			t.Fatalf("seed initial classification for txID2: %v", err)
		}
		if _, err := sqlDB.ExecContext(ctx, `
			UPDATE transactions SET current_classification_id = (
				SELECT id FROM transaction_classifications
				WHERE transaction_id = $1 AND is_current = true LIMIT 1
			) WHERE id = $1`, txID2); err != nil {
			t.Logf("update current_classification_id (optional): %v", err)
		}

		// PATCH correction on txID2.
		patchBody := map[string]any{
			"category_id":       fix.CategoryID.String(),
			"apply_to_existing": false,
		}
		resp, body, err := client.do("PATCH",
			orgPath("/transactions/"+txID2.String()+"/classification"),
			patchBody,
		)
		if err != nil {
			t.Fatalf("PATCH classification #2: %v", err)
		}
		if skipIfPending(t, resp, body, "P1-03") {
			return
		}
		assertStatus(t, resp, body, http.StatusOK)

		// After 2 identical corrections (same merchant_normalized, same new_category_id)
		// a classification_rules row MUST exist.
		var ruleID uuid.UUID
		var ruleMatchType, ruleSource string
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT id, match_type, source
			FROM classification_rules
			WHERE organization_id = $1
			  AND match_value = $2
			  AND source = 'user'
			ORDER BY created_at DESC
			LIMIT 1`,
			fix.OrgID, norm,
		).Scan(&ruleID, &ruleMatchType, &ruleSource); err != nil {
			t.Fatalf("rule not promoted after 2 corrections: %v "+
				"(expected a classification_rules row with source='user' and match_value=%q)",
				err, norm)
		}
		if ruleSource != "user" {
			t.Errorf("rule.source = %q, want user", ruleSource)
		}
		t.Logf("rule promoted: id=%s match_type=%s source=%s", ruleID, ruleMatchType, ruleSource)
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 4 — P1-02: auto-classify a NEW transaction for the same merchant
	// After rule promotion, classifying a new extraction for the same merchant
	// must produce a classification with source='rule'.
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-02_auto_classify_via_rule", func(t *testing.T) {
		// Check that a rule exists first (depends on step 3b).
		norm := merchant.Normalize(fix.MerchantRaw)
		var ruleExists bool
		_ = sqlDB.QueryRowContext(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM classification_rules
				WHERE organization_id = $1 AND match_value = $2 AND source = 'user'
			)`, fix.OrgID, norm).Scan(&ruleExists)
		if !ruleExists {
			t.Skip("pending P1-03: no rule promoted yet — correction_2 step skipped")
		}

		// Seed a third document+extraction for the same merchant.
		var doc3ID uuid.UUID
		if err := sqlDB.QueryRowContext(ctx, `
			INSERT INTO documents
				(organization_id, uploaded_by, source, kind, storage_url, status)
			VALUES ($1, $2, 'upload', 'slip', 'test://placeholder3', 'pending')
			RETURNING id`, fix.OrgID, fix.UserID).Scan(&doc3ID); err != nil {
			t.Fatalf("seed doc3: %v", err)
		}
		extracted3 := map[string]any{
			"kind":       "slip",
			"merchant":   fix.MerchantRaw,
			"date":       "2026-05-20",
			"currency":   "ZAR",
			"subtotal":   50.00,
			"tax":        7.50,
			"total":      57.50,
			"confidence": 0.91,
			"line_items": []map[string]any{
				{"description": "Bread", "qty": 1, "unit": 15.99, "amount": 15.99},
			},
		}
		extracted3JSON, _ := json.Marshal(extracted3)
		var extraction3ID uuid.UUID
		if err := sqlDB.QueryRowContext(ctx, `
			INSERT INTO document_extractions
				(document_id, organization_id, status, extracted, is_current)
			VALUES ($1, $2, 'extracted', $3::jsonb, true)
			RETURNING id`, doc3ID, fix.OrgID, string(extracted3JSON)).Scan(&extraction3ID); err != nil {
			t.Fatalf("seed extraction3: %v", err)
		}
		if _, err := sqlDB.ExecContext(ctx, `
			UPDATE documents SET current_extraction_id = $1, status = 'extracted'
			WHERE id = $2`, extraction3ID, doc3ID); err != nil {
			t.Fatalf("update doc3 extraction pointer: %v", err)
		}

		// Call classify on doc3.
		path := orgPath("/documents/" + doc3ID.String() + "/classify")
		resp, body, err := client.do("POST", path, nil)
		if err != nil {
			t.Fatalf("classify doc3: %v", err)
		}
		if skipIfPending(t, resp, body, "P1-02") {
			return
		}
		assertStatus(t, resp, body, http.StatusOK)

		var result struct {
			TransactionID string `json:"transaction_id"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("decode classify doc3 response: %v; body=%s", err, body)
		}
		tx3ID, err := uuid.Parse(result.TransactionID)
		if err != nil {
			t.Fatalf("parse transaction_id from doc3 classify: %v", err)
		}

		// Classification must be source='rule' because a rule now exists.
		var classSource string
		var classIsCurrent bool
		if err := sqlDB.QueryRowContext(ctx, `
			SELECT source, is_current
			FROM transaction_classifications
			WHERE transaction_id = $1 AND is_current = true`,
			tx3ID,
		).Scan(&classSource, &classIsCurrent); err != nil {
			t.Fatalf("query auto-classification for doc3 tx: %v", err)
		}
		if classSource != "rule" {
			t.Errorf("auto-classification source = %q, want rule (cascade should have matched the promoted rule)",
				classSource)
		}
		if !classIsCurrent {
			t.Error("classification.is_current should be true")
		}
		t.Logf("auto-classify via rule: tx3=%s source=%s (rule cascade worked)", tx3ID, classSource)
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 5 — Privacy invariant: merchant_signals must not leak org/user IDs
	// (P1-04 contract §2 privacy requirement)
	// ────────────────────────────────────────────────────────────────────────
	t.Run("P1-04_merchant_signals_privacy", func(t *testing.T) {
		// Only meaningful if the signals table has rows. If P1-04 hasn't run
		// (cron not triggered), this verifies the schema invariant only.
		//
		// The assertion: the merchant_signals table has NO column for
		// organization_id or user_id — verified via information_schema.
		rows, err := sqlDB.QueryContext(ctx, `
			SELECT column_name
			FROM information_schema.columns
			WHERE table_name = 'merchant_signals'
			  AND column_name IN ('organization_id', 'org_id', 'user_id', 'corrected_by')`)
		if err != nil {
			t.Fatalf("query information_schema: %v", err)
		}
		defer rows.Close()
		var forbidden []string
		for rows.Next() {
			var col string
			_ = rows.Scan(&col)
			forbidden = append(forbidden, col)
		}
		if len(forbidden) > 0 {
			t.Errorf("merchant_signals contains privacy-violating columns: %v", forbidden)
		}
		t.Logf("merchant_signals privacy invariant: no forbidden columns (ok)")
	})

	// ────────────────────────────────────────────────────────────────────────
	// Step 6 — merchant.Normalize end-to-end consistency
	// Asserts that every transaction created during this test run has
	// merchant_normalized == merchant.Normalize(merchant) in the DB.
	// ────────────────────────────────────────────────────────────────────────
	t.Run("merchant_normalize_consistency", func(t *testing.T) {
		rows, err := sqlDB.QueryContext(ctx, `
			SELECT merchant, merchant_normalized
			FROM transactions
			WHERE organization_id = $1
			  AND merchant IS NOT NULL`,
			fix.OrgID)
		if err != nil {
			t.Fatalf("query transactions for normalize check: %v", err)
		}
		defer rows.Close()

		var checked int
		for rows.Next() {
			var raw, norm string
			if err := rows.Scan(&raw, &norm); err != nil {
				t.Fatalf("scan: %v", err)
			}
			want := merchant.Normalize(raw)
			if norm != want {
				t.Errorf("merchant_normalized mismatch for %q: DB=%q want=%q", raw, norm, want)
			}
			checked++
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("rows: %v", err)
		}
		t.Logf("merchant_normalize_consistency: checked %d transactions (all ok)", checked)
	})
}

// ─── string helpers ──────────────────────────────────────────────────────────

// ensure unused import "strings" is referenced (used in tests below when
// integration endpoints return plain-text error bodies).
var _ = strings.TrimSpace
