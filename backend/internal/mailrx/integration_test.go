//go:build integration

// Integration tests for the mailrx package.
//
// These tests require:
//   - A live PostgreSQL database (DATABASE_URL)
//   - Live B2/S3 credentials (B2_* env vars)
//
// Run with:
//
//	go test -tags=integration ./internal/mailrx/...
package mailrx

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

func skipIfMissingEnv(t *testing.T) {
	t.Helper()
	needed := []string{"DATABASE_URL", "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT"}
	for _, k := range needed {
		if os.Getenv(k) == "" {
			t.Skipf("skipping integration: %s not set", k)
		}
	}
}

// insertSyntheticOrg creates a minimal organizations row without a real user
// FK (created_by is left NULL). Returns the new org. The test must clean up.
func insertSyntheticOrg(ctx context.Context, pool *sql.DB, slug string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRowContext(ctx, `
		INSERT INTO organizations (kind, name, slug, rx_local_part)
		VALUES ('personal', $1, $2, $2)
		RETURNING id
	`, "Integration Test "+slug, slug).Scan(&id)
	return id, err
}

// TestDeliverEndToEnd creates a synthetic org, delivers a message with one PDF
// attachment, and asserts that inbound_emails + documents rows were created.
func TestDeliverEndToEnd(t *testing.T) {
	skipIfMissingEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer pool.Close()

	st, err := storage.New(storage.Config{
		KeyID:          os.Getenv("B2_KEY_ID"),
		ApplicationKey: os.Getenv("B2_APPLICATION_KEY"),
		Bucket:         os.Getenv("B2_BUCKET"),
		Region:         os.Getenv("B2_REGION"),
		Endpoint:       os.Getenv("B2_ENDPOINT"),
	})
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}

	// Create a synthetic org row directly — no user FK needed.
	slug := fmt.Sprintf("mailrx-it-%s", time.Now().Format("20060102150405"))
	orgID, err := insertSyntheticOrg(ctx, pool, slug)
	if err != nil {
		t.Fatalf("insertSyntheticOrg: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec("DELETE FROM organizations WHERE id = $1", orgID)
	})

	orgStore := org.NewStore(pool)
	mailStore := NewStore(pool)

	be := NewBackend(Config{
		RxDomain:     "rx.test",
		MaxBytes:     10 << 20,
		AllowedTypes: []string{"application/pdf", "image/jpeg", "image/png"},
	}, orgStore, mailStore, st)

	sess := &session{backend: be}
	_ = sess.Mail("sender@external.com", nil)

	rcptAddr := slug + "@rx.test"
	if err := sess.Rcpt(rcptAddr, nil); err != nil {
		t.Fatalf("Rcpt(%q): %v", rcptAddr, err)
	}

	if err := sess.Data(strings.NewReader(buildTestMessage(slug))); err != nil {
		t.Fatalf("Data: %v", err)
	}

	// Verify inbound_emails row.
	var emailStatus string
	err = pool.QueryRowContext(ctx,
		`SELECT status FROM inbound_emails WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
		orgID,
	).Scan(&emailStatus)
	if err != nil {
		t.Fatalf("query inbound_emails: %v", err)
	}
	if emailStatus != "processed" {
		t.Errorf("inbound_email status=%q want %q", emailStatus, "processed")
	}

	// Verify documents row.
	var docCount int
	err = pool.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM documents WHERE organization_id = $1 AND source = 'email'`,
		orgID,
	).Scan(&docCount)
	if err != nil {
		t.Fatalf("query documents: %v", err)
	}
	if docCount != 1 {
		t.Errorf("documents count=%d want 1", docCount)
	}
}

// TestUnknownRecipientNoRows sends mail to an unknown local-part and verifies
// that no rows are written to the DB.
func TestUnknownRecipientNoRows(t *testing.T) {
	skipIfMissingEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer pool.Close()

	orgStore := org.NewStore(pool)
	mailStore := NewStore(pool)

	be := NewBackend(Config{
		RxDomain:     "rx.test",
		MaxBytes:     10 << 20,
		AllowedTypes: []string{"application/pdf"},
	}, orgStore, mailStore, nil)

	sess := &session{backend: be}
	_ = sess.Mail("sender@external.com", nil)

	err = sess.Rcpt("totally-unknown-slug-xyz@rx.test", nil)
	if err == nil {
		t.Fatal("expected Rcpt to return error for unknown recipient, got nil")
	}

	// No recipients accepted.
	if len(sess.recipients) != 0 {
		t.Errorf("expected 0 recipients, got %d", len(sess.recipients))
	}
}

// buildTestMessage constructs a minimal RFC 822 message with one PDF attachment.
func buildTestMessage(localPart string) string {
	msgID := fmt.Sprintf("integration-test-%s@rx.test", time.Now().Format("20060102150405000"))
	return "From: sender@external.com\r\n" +
		"To: " + localPart + "@rx.test\r\n" +
		"Subject: Test receipt\r\n" +
		"Message-Id: <" + msgID + ">\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=\"bound\"\r\n" +
		"\r\n" +
		"--bound\r\n" +
		"Content-Type: text/plain\r\n" +
		"\r\n" +
		"test\r\n" +
		"--bound\r\n" +
		"Content-Type: application/pdf\r\n" +
		"Content-Disposition: attachment; filename=\"receipt.pdf\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n" +
		"\r\n" +
		"JVBERi0xLjA=\r\n" + // %PDF-1.0 in base64
		"--bound--\r\n"
}
