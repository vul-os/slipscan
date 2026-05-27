package mailrx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

// Config holds all tuneable parameters for the SMTP backend.
type Config struct {
	RxDomain     string // the domain part of inbound addresses, e.g. "mail.slipscan.app"
	MaxBytes     int64  // maximum message size in bytes
	AllowedTypes []string
	Hostname     string // SMTP greeting hostname; defaults to RxDomain
}

// OrgLookup is the minimal interface the backend needs from the org package.
// Keeping it as an interface makes unit testing straightforward.
type OrgLookup interface {
	ByRxLocalPart(ctx context.Context, localPart string) (*org.Organization, error)
}

// Backend implements github.com/emersion/go-smtp.Backend.
// It is the entry point for all inbound SMTP sessions.
type Backend struct {
	cfg      Config
	orgs     OrgLookup
	store    *Store
	storage  *storage.Client
	ingester *Ingester
}

// NewBackend constructs a Backend.
func NewBackend(cfg Config, orgs OrgLookup, store *Store, st *storage.Client) *Backend {
	if cfg.Hostname == "" {
		cfg.Hostname = cfg.RxDomain
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = 25 << 20
	}
	if len(cfg.AllowedTypes) == 0 {
		cfg.AllowedTypes = []string{
			"application/pdf",
			"image/jpeg",
			"image/png",
			"image/heic",
			"image/heif",
		}
	}
	return &Backend{
		cfg:      cfg,
		orgs:     orgs,
		store:    store,
		storage:  st,
		ingester: NewIngester(cfg, orgs, store, st),
	}
}

// NewSession is called by go-smtp for every incoming connection.
func (b *Backend) NewSession(_ *gosmtp.Conn) (gosmtp.Session, error) {
	return &session{backend: b}, nil
}

// session holds per-message state for one SMTP transaction.
type session struct {
	backend    *Backend
	from       string
	recipients []recipientOrg
}

type recipientOrg struct {
	address   string
	localPart string
	org       *org.Organization
}

func (s *session) Reset() {
	s.from = ""
	s.recipients = nil
}

func (s *session) Logout() error {
	return nil
}

// Mail is called when the client issues MAIL FROM.
func (s *session) Mail(from string, _ *gosmtp.MailOptions) error {
	s.from = from
	return nil
}

// Rcpt is called once per RCPT TO command. We validate the recipient against
// the org store immediately and reject unknown local-parts with 550.
func (s *session) Rcpt(to string, _ *gosmtp.RcptOptions) error {
	localPart, domain, ok := splitAddress(to)
	if !ok {
		return &gosmtp.SMTPError{
			Code:    550,
			Message: fmt.Sprintf("invalid address: %s", to),
		}
	}

	// Accept mail addressed to our domain only.
	if !strings.EqualFold(domain, s.backend.cfg.RxDomain) {
		return &gosmtp.SMTPError{
			Code:    550,
			Message: fmt.Sprintf("relay denied: unknown domain %s", domain),
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	o, err := s.backend.orgs.ByRxLocalPart(ctx, strings.ToLower(localPart))
	if err != nil {
		if errors.Is(err, org.ErrNotFound) {
			return &gosmtp.SMTPError{
				Code:    550,
				Message: fmt.Sprintf("unknown recipient: %s", localPart),
			}
		}
		log.Printf("mailrx rcpt lookup %s: %v", localPart, err)
		return &gosmtp.SMTPError{
			Code:    451,
			Message: "temporary lookup failure",
		}
	}

	s.recipients = append(s.recipients, recipientOrg{
		address:   to,
		localPart: strings.ToLower(localPart),
		org:       o,
	})
	return nil
}

// Data is called with the full RFC 822 message once all recipients are set.
// We buffer the raw bytes, parse MIME, store attachments to object storage,
// and insert DB rows — delegating all per-recipient work to the Ingester so
// there is exactly one code path shared with the HTTP ingest endpoint.
func (s *session) Data(r io.Reader) error {
	if len(s.recipients) == 0 {
		return &gosmtp.SMTPError{Code: 554, Message: "no valid recipients"}
	}

	// Buffer the entire message so we can store the raw bytes AND parse MIME.
	buf := new(bytes.Buffer)
	lr := io.LimitReader(r, s.backend.cfg.MaxBytes+1)
	n, err := io.Copy(buf, lr)
	if err != nil {
		return fmt.Errorf("mailrx data: read: %w", err)
	}
	if n > s.backend.cfg.MaxBytes {
		return &gosmtp.SMTPError{
			Code:    552,
			Message: "message exceeds maximum size",
		}
	}
	rawBytes := buf.Bytes()

	// Parse MIME once for all recipients.
	parsed, err := ParseMessage(bytes.NewReader(rawBytes), s.backend.cfg.MaxBytes, s.backend.cfg.AllowedTypes)
	if err != nil {
		log.Printf("mailrx data: parse: %v", err)
		// Still try to record the email as received so we have a trace.
		parsed = &ParsedMessage{
			FromAddress: s.from,
		}
	}
	if parsed.FromAddress == "" {
		parsed.FromAddress = s.from
	}
	if parsed.MessageID == "" {
		parsed.MessageID = generateFallbackMsgID()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Deliver to every accepted recipient org via the shared Ingester path.
	for _, recip := range s.recipients {
		_, domain, _ := splitAddress(recip.address)
		if err := s.backend.ingester.deliver(ctx, recip, domain, parsed, rawBytes); err != nil {
			log.Printf("mailrx deliver to %s: %v", recip.address, err)
			// Don't return the error — SMTP 250 is already implicit if we
			// accepted the recipient; we log and move on.
		}
	}

	return nil
}

// splitAddress splits "user@domain" into ("user", "domain", true).
func splitAddress(addr string) (local, domain string, ok bool) {
	// Strip display name "Foo Bar <foo@bar.com>" if present.
	addr = strings.TrimSpace(addr)
	if i := strings.LastIndex(addr, "<"); i >= 0 {
		if j := strings.LastIndex(addr, ">"); j > i {
			addr = addr[i+1 : j]
		}
	}
	addr = strings.TrimSpace(addr)
	i := strings.LastIndexByte(addr, '@')
	if i <= 0 || i == len(addr)-1 {
		return "", "", false
	}
	return addr[:i], addr[i+1:], true
}

// generateFallbackMsgID makes a unique message-id when the email has none.
func generateFallbackMsgID() string {
	return fmt.Sprintf("%s@mailrx-generated", uuid.NewString())
}

// ErrNoStorage is returned when no storage client is configured and raw
// email persistence is attempted. Used in tests.
var ErrNoStorage = errors.New("mailrx: no storage client configured")
