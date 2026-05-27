package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/mailrx"
	"github.com/exolutionza/slipscan/backend/internal/org"
)

// --- test fixtures ---

// minimalRFC822 is a tiny but structurally valid RFC 822 message with no
// attachments (text-only) so the ingester can complete without storage.
const minimalRFC822 = "From: sender@external.com\r\n" +
	"To: acme@rx.test\r\n" +
	"Subject: Test\r\n" +
	"Message-Id: <test-001@rx.test>\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: text/plain\r\n" +
	"\r\n" +
	"hello\r\n"

// --- stub OrgLookup ---

type fakeOrgLookup struct {
	orgs map[string]*org.Organization
}

func newFakeOrgLookup(slugs ...string) *fakeOrgLookup {
	f := &fakeOrgLookup{orgs: make(map[string]*org.Organization, len(slugs))}
	for _, slug := range slugs {
		f.orgs[slug] = &org.Organization{
			ID:          uuid.New(),
			Slug:        slug,
			RxLocalPart: slug,
		}
	}
	return f
}

func (f *fakeOrgLookup) ByRxLocalPart(_ context.Context, localPart string) (*org.Organization, error) {
	o, ok := f.orgs[localPart]
	if !ok {
		return nil, org.ErrNotFound
	}
	return o, nil
}

// --- stub IngestStore ---

// fakeIngestStore satisfies mailrx.IngestStore without a real database.
type fakeIngestStore struct {
	emails []*mailrx.InboundEmail
	docs   []*mailrx.Doc
}

func (s *fakeIngestStore) InsertInboundEmail(_ context.Context, e *mailrx.InboundEmail) error {
	e.ID = uuid.New()
	e.CreatedAt = time.Now()
	e.UpdatedAt = time.Now()
	s.emails = append(s.emails, e)
	return nil
}

func (s *fakeIngestStore) MarkEmailProcessed(_ context.Context, _ uuid.UUID, _, _ string) error {
	return nil
}

func (s *fakeIngestStore) InsertDocument(_ context.Context, d *mailrx.Doc) error {
	d.ID = uuid.New()
	d.CreatedAt = time.Now()
	d.UpdatedAt = time.Now()
	s.docs = append(s.docs, d)
	return nil
}

// --- helpers ---

// buildIngesterWithStore builds an Ingester backed by the given org lookup and
// in-memory store.  No storage client is provided, so raw-email / attachment
// writes are silently skipped.
func buildIngesterWithStore(orgs mailrx.OrgLookup, store mailrx.IngestStore) *mailrx.Ingester {
	return mailrx.NewIngester(mailrx.Config{
		RxDomain:     "rx.test",
		MaxBytes:     1 << 20,
		AllowedTypes: []string{"application/pdf", "image/jpeg", "image/png"},
	}, orgs, store, nil /* no storage client */)
}

// --- tests ---

// TestInboundEmailHandler_Disabled verifies the route returns 404 when no
// secret is configured.
func TestInboundEmailHandler_Disabled(t *testing.T) {
	store := &fakeIngestStore{}
	ing := buildIngesterWithStore(newFakeOrgLookup("acme"), store)
	handler := inboundEmailHandler("" /* empty = disabled */, 1<<20, ing)

	req := httptest.NewRequest("POST", "/internal/inbound-email?recipient=acme",
		bytes.NewBufferString(minimalRFC822))
	req.Header.Set("X-Inbound-Secret", "anything")

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("disabled route: got %d, want 404", rr.Code)
	}
}

// TestInboundEmailHandler_Auth verifies that the shared-secret check is
// enforced: wrong or missing header returns 401; correct header proceeds.
func TestInboundEmailHandler_Auth(t *testing.T) {
	const secret = "super-secret-value"

	tests := []struct {
		name       string
		sentSecret string
		wantStatus int
	}{
		{"no secret header", "", http.StatusUnauthorized},
		{"wrong secret", "wrong-secret", http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{}
			ing := buildIngesterWithStore(newFakeOrgLookup("acme"), store)
			handler := inboundEmailHandler(secret, 1<<20, ing)

			body := bytes.NewBufferString(minimalRFC822)
			req := httptest.NewRequest("POST", "/internal/inbound-email?recipient=acme", body)
			if tt.sentSecret != "" {
				req.Header.Set("X-Inbound-Secret", tt.sentSecret)
			}

			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Errorf("%s: got %d, want %d", tt.name, rr.Code, tt.wantStatus)
			}
		})
	}
}

// TestInboundEmailHandler_HappyPath verifies the full successful path:
// correct secret + known recipient + valid body → 202 + inbound_emails row.
func TestInboundEmailHandler_HappyPath(t *testing.T) {
	const secret = "s3cr3t"

	store := &fakeIngestStore{}
	orgs := newFakeOrgLookup("acme")
	ing := buildIngesterWithStore(orgs, store)
	handler := inboundEmailHandler(secret, 1<<20, ing)

	req := httptest.NewRequest("POST", "/internal/inbound-email?recipient=acme",
		bytes.NewBufferString(minimalRFC822))
	req.Header.Set("X-Inbound-Secret", secret)
	req.Header.Set("Content-Type", "message/rfc822")

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusAccepted {
		t.Errorf("happy path: got %d, want 202; body=%s", rr.Code, rr.Body.String())
	}
	if len(store.emails) != 1 {
		t.Errorf("happy path: expected 1 inbound_email row, got %d", len(store.emails))
	}
}

// TestInboundEmailHandler_MissingRecipient verifies 400 when the recipient
// query param is absent.
func TestInboundEmailHandler_MissingRecipient(t *testing.T) {
	const secret = "s3cr3t"
	store := &fakeIngestStore{}
	ing := buildIngesterWithStore(newFakeOrgLookup("acme"), store)
	handler := inboundEmailHandler(secret, 1<<20, ing)

	req := httptest.NewRequest("POST", "/internal/inbound-email" /* no ?recipient= */,
		bytes.NewBufferString(minimalRFC822))
	req.Header.Set("X-Inbound-Secret", secret)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("missing recipient: got %d, want 400", rr.Code)
	}
}

// TestInboundEmailHandler_EmptyBody verifies 400 when the body is empty.
func TestInboundEmailHandler_EmptyBody(t *testing.T) {
	const secret = "s3cr3t"
	store := &fakeIngestStore{}
	ing := buildIngesterWithStore(newFakeOrgLookup("acme"), store)
	handler := inboundEmailHandler(secret, 1<<20, ing)

	req := httptest.NewRequest("POST", "/internal/inbound-email?recipient=acme",
		bytes.NewReader(nil))
	req.Header.Set("X-Inbound-Secret", secret)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("empty body: got %d, want 400", rr.Code)
	}
}

// TestInboundEmailHandler_UnknownRecipient verifies 400 when the recipient
// does not match any known org slug.
func TestInboundEmailHandler_UnknownRecipient(t *testing.T) {
	const secret = "s3cr3t"
	store := &fakeIngestStore{}
	ing := buildIngesterWithStore(newFakeOrgLookup() /* no orgs */, store)
	handler := inboundEmailHandler(secret, 1<<20, ing)

	req := httptest.NewRequest("POST", "/internal/inbound-email?recipient=nobody",
		bytes.NewBufferString(minimalRFC822))
	req.Header.Set("X-Inbound-Secret", secret)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("unknown recipient: got %d, want 400", rr.Code)
	}
}
