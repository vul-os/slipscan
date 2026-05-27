package mailrx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

// IngestStore is the persistence interface required by Ingester.
// *Store satisfies this interface; tests may supply a lightweight fake.
type IngestStore interface {
	InsertInboundEmail(ctx context.Context, e *InboundEmail) error
	MarkEmailProcessed(ctx context.Context, id uuid.UUID, status, errMsg string) error
	InsertDocument(ctx context.Context, d *Doc) error
}

// Ingester is the transport-neutral core of the inbound-mail pipeline.
// Both the SMTP backend (session.deliver) and the HTTP ingest endpoint
// call Ingest so there is exactly one code path for parsing, storing, and
// recording inbound messages.
type Ingester struct {
	cfg     Config
	orgs    OrgLookup
	store   IngestStore
	storage *storage.Client
}

// NewIngester constructs an Ingester.  storage may be nil — storage operations
// are silently skipped when no client is provided (same behaviour as the
// existing SMTP path).
func NewIngester(cfg Config, orgs OrgLookup, store IngestStore, st *storage.Client) *Ingester {
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
	return &Ingester{
		cfg:     cfg,
		orgs:    orgs,
		store:   store,
		storage: st,
	}
}

// ErrUnknownRecipient is returned by Ingest when the recipient local-part does
// not match any known organisation.
var ErrUnknownRecipient = errors.New("mailrx: unknown recipient")

// Ingest processes one inbound RFC 822 message delivered to recipient.
//
// recipient is the full "localpart@domain" address (or just the local-part; if
// no "@" is present, cfg.RxDomain is appended automatically so callers that
// pass only the local-part work correctly).
//
// raw is the complete RFC 822 wire bytes.  It must not exceed cfg.MaxBytes.
//
// The method:
//  1. Resolves the org by the recipient local-part (returns ErrUnknownRecipient
//     if unknown so the HTTP handler can return 400/404 appropriately).
//  2. Parses MIME headers + attachments via ParseMessage.
//  3. Stores the raw .eml + each attachment to object storage.
//  4. Inserts inbound_emails + documents rows.
//  5. Returns nil on success (or a non-nil error on hard failure).
func (ing *Ingester) Ingest(ctx context.Context, raw []byte, recipient string) error {
	// Normalise recipient — if no "@" present, append the configured domain.
	if !strings.ContainsRune(recipient, '@') {
		recipient = recipient + "@" + ing.cfg.RxDomain
	}

	localPart, domain, ok := splitAddress(recipient)
	if !ok {
		return fmt.Errorf("mailrx ingest: invalid recipient address %q", recipient)
	}

	// Resolve org.
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	o, err := ing.orgs.ByRxLocalPart(lookupCtx, strings.ToLower(localPart))
	if err != nil {
		if errors.Is(err, org.ErrNotFound) {
			return fmt.Errorf("%w: %s", ErrUnknownRecipient, localPart)
		}
		return fmt.Errorf("mailrx ingest: org lookup %s: %w", localPart, err)
	}

	// Parse MIME.
	parsed, parseErr := ParseMessage(bytes.NewReader(raw), ing.cfg.MaxBytes, ing.cfg.AllowedTypes)
	if parseErr != nil {
		log.Printf("mailrx ingest: parse: %v", parseErr)
		// Degrade gracefully — still record reception.
		parsed = &ParsedMessage{}
	}
	if parsed.MessageID == "" {
		parsed.MessageID = generateFallbackMsgID()
	}

	recip := recipientOrg{
		address:   recipient,
		localPart: strings.ToLower(localPart),
		org:       o,
	}
	return ing.deliver(ctx, recip, domain, parsed, raw)
}

// deliver is the shared storage+DB write path shared by both Ingest (HTTP) and
// the SMTP session.
func (ing *Ingester) deliver(ctx context.Context, recip recipientOrg, domain string, parsed *ParsedMessage, rawBytes []byte) error {
	o := recip.org
	localPart := recip.localPart

	// 1. Store raw email.
	rawKey := storageKeyForEmail(o.ID, parsed.MessageID)
	rawStorageURL := ""
	if ing.storage != nil {
		if err := ing.storage.Put(ctx, rawKey, rawBytes, "message/rfc822"); err != nil {
			log.Printf("mailrx store raw email: %v", err)
		} else {
			rawStorageURL = rawKey
		}
	}

	// 2. Insert inbound_emails row.
	fromAddr := parsed.FromAddress
	email := &InboundEmail{
		OrganizationID:     uuid.NullUUID{UUID: o.ID, Valid: true},
		MessageID:          parsed.MessageID,
		FromAddress:        fromAddr,
		RecipientLocalPart: localPart,
		RecipientDomain:    strings.ToLower(domain),
		Subject:            parsed.Subject,
		RawStorageURL:      rawStorageURL,
		SizeBytes:          int64(len(rawBytes)),
		Status:             "received",
	}

	if err := ing.store.InsertInboundEmail(ctx, email); err != nil {
		return fmt.Errorf("insert inbound_email: %w", err)
	}

	// 3. Process attachments.
	var savedCount int
	var lastErr string

	for _, att := range parsed.Attachments {
		attKey := storageKeyForAttachment(o.ID, extForMIME(att.ContentType))
		if ing.storage != nil {
			if err := ing.storage.Put(ctx, attKey, att.Data, att.ContentType); err != nil {
				log.Printf("mailrx store attachment %q: %v", att.Filename, err)
				lastErr = err.Error()
				continue
			}
		}

		doc := &Doc{
			OrganizationID: o.ID,
			InboundEmailID: uuid.NullUUID{UUID: email.ID, Valid: true},
			Source:         "email",
			Kind:           "unknown",
			StorageURL:     attKey,
			MimeType:       att.ContentType,
			SizeBytes:      int64(len(att.Data)),
			OriginalName:   att.Filename,
			Status:         "pending",
		}
		if err := ing.store.InsertDocument(ctx, doc); err != nil {
			log.Printf("mailrx insert document %q: %v", att.Filename, err)
			lastErr = err.Error()
			continue
		}
		savedCount++
	}

	// 4. Mark email status.
	finalStatus := "processed"
	finalErr := ""
	if savedCount == 0 && len(parsed.Attachments) > 0 {
		finalStatus = "rejected"
		finalErr = "no usable attachments; " + lastErr
	}

	if err := ing.store.MarkEmailProcessed(ctx, email.ID, finalStatus, finalErr); err != nil {
		log.Printf("mailrx mark processed %s: %v", email.ID, err)
	}

	log.Printf("mailrx delivered msg=%s org=%s attachments=%d status=%s",
		parsed.MessageID, o.Slug, savedCount, finalStatus)
	return nil
}
