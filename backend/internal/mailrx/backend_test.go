package mailrx

import (
	"context"
	"errors"
	"strings"
	"testing"

	gosmtp "github.com/emersion/go-smtp"

	"github.com/exolutionza/slipscan/backend/internal/org"
)

// --- stub org lookup ---

type stubOrgs struct {
	orgs map[string]*org.Organization
}

func (s *stubOrgs) ByRxLocalPart(_ context.Context, localPart string) (*org.Organization, error) {
	o, ok := s.orgs[strings.ToLower(localPart)]
	if !ok {
		return nil, org.ErrNotFound
	}
	return o, nil
}

func newStubOrgs(slugs ...string) *stubOrgs {
	s := &stubOrgs{orgs: make(map[string]*org.Organization)}
	for _, slug := range slugs {
		o := &org.Organization{Slug: slug, RxLocalPart: slug}
		s.orgs[slug] = o
	}
	return s
}

// --- recipient validation tests ---

func TestSplitAddress(t *testing.T) {
	tests := []struct {
		addr       string
		wantLocal  string
		wantDomain string
		wantOK     bool
	}{
		{"alice@example.com", "alice", "example.com", true},
		{"ALICE@Example.COM", "ALICE", "Example.COM", true},
		{"Alice Wonderland <alice@example.com>", "alice", "example.com", true},
		{"@example.com", "", "", false},
		{"noatsign", "", "", false},
		{"foo@", "", "", false},
	}

	for _, tt := range tests {
		local, domain, ok := splitAddress(tt.addr)
		if ok != tt.wantOK {
			t.Errorf("splitAddress(%q): ok=%v want %v", tt.addr, ok, tt.wantOK)
			continue
		}
		if !tt.wantOK {
			continue
		}
		if local != tt.wantLocal || domain != tt.wantDomain {
			t.Errorf("splitAddress(%q): got (%q, %q) want (%q, %q)",
				tt.addr, local, domain, tt.wantLocal, tt.wantDomain)
		}
	}
}

func TestRcptValidation(t *testing.T) {
	orgs := newStubOrgs("acme", "globex")
	be := NewBackend(Config{RxDomain: "mail.example.com"}, orgs, nil, nil)

	tests := []struct {
		to       string
		wantErr  bool
		wantCode int
	}{
		// Known org, correct domain.
		{"acme@mail.example.com", false, 0},
		// Known org, case-insensitive local-part.
		{"ACME@mail.example.com", false, 0},
		// Unknown local-part → 550.
		{"unknown@mail.example.com", true, 550},
		// Wrong domain → 550.
		{"acme@other.com", true, 550},
		// Malformed address → 550.
		{"notanaddress", true, 550},
	}

	for _, tt := range tests {
		sess := &session{backend: be}
		err := sess.Rcpt(tt.to, nil)
		if tt.wantErr {
			if err == nil {
				t.Errorf("Rcpt(%q): expected error, got nil", tt.to)
				continue
			}
			var smtpErr *gosmtp.SMTPError
			if errors.As(err, &smtpErr) {
				if smtpErr.Code != tt.wantCode {
					t.Errorf("Rcpt(%q): code=%d want %d", tt.to, smtpErr.Code, tt.wantCode)
				}
			}
		} else {
			if err != nil {
				t.Errorf("Rcpt(%q): unexpected error: %v", tt.to, err)
			}
		}
	}
}

// TestRcptCaseInsensitive checks that local-part matching is
// case-insensitive (the schema stores lowercase).
func TestRcptCaseInsensitive(t *testing.T) {
	orgs := newStubOrgs("acme-corp")
	be := NewBackend(Config{RxDomain: "rx.test"}, orgs, nil, nil)

	for _, addr := range []string{"acme-corp@rx.test", "ACME-CORP@rx.test", "Acme-Corp@rx.test"} {
		sess := &session{backend: be}
		if err := sess.Rcpt(addr, nil); err != nil {
			t.Errorf("Rcpt(%q): unexpected error: %v", addr, err)
		}
		if len(sess.recipients) != 1 {
			t.Errorf("Rcpt(%q): expected 1 recipient, got %d", addr, len(sess.recipients))
		}
	}
}
