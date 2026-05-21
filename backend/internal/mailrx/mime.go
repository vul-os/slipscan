package mailrx

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"strings"

	"github.com/emersion/go-message/mail"
)

// Attachment holds a parsed email attachment ready for storage.
type Attachment struct {
	Filename    string
	ContentType string // normalised, e.g. "application/pdf"
	Data        []byte
}

// ParsedMessage is the result of parsing a raw RFC 822 message.
type ParsedMessage struct {
	MessageID   string
	FromAddress string
	Subject     string
	Attachments []Attachment
}

// ParseMessage reads a raw RFC 822 message from r and returns the parsed
// header fields plus all non-inline parts. maxBytes is a soft cap — the
// caller should enforce a hard limit via go-smtp's MaxMessageBytes before
// calling this.
//
// Unknown charsets are tolerated (go-message reports them but still parses).
func ParseMessage(r io.Reader, maxBytes int64, allowedTypes []string) (*ParsedMessage, error) {
	// Buffer the full message — we need it twice: once for parsing and once
	// for storing the raw bytes to B2.
	buf := new(bytes.Buffer)
	lr := io.LimitReader(r, maxBytes+1)
	n, err := io.Copy(buf, lr)
	if err != nil {
		return nil, fmt.Errorf("mailrx parse: read body: %w", err)
	}
	if n > maxBytes {
		return nil, fmt.Errorf("mailrx parse: message exceeds %d bytes", maxBytes)
	}

	mr, err := mail.CreateReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		// IsUnknownCharset errors still provide a usable reader.
		// For fatal parse errors we return them.
		return nil, fmt.Errorf("mailrx parse: create reader: %w", err)
	}
	defer mr.Close()

	msgID, _ := mr.Header.MessageID()
	subject, _ := mr.Header.Subject()
	fromAddr := headerFrom(mr.Header)

	allowed := makeAllowedSet(allowedTypes)
	var attachments []Attachment

	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Tolerate unknown-charset errors; skip any part we can't read.
			log.Printf("mailrx parse: skipping part: %v", err)
			continue
		}

		ah, ok := p.Header.(*mail.AttachmentHeader)
		if !ok {
			// Inline / text part — drain and skip.
			_, _ = io.Copy(io.Discard, p.Body)
			continue
		}

		ct, _, _ := ah.ContentType()
		ct = normalizeMIME(ct)

		filename, _ := ah.Filename()
		if filename == "" {
			filename = "attachment" + extForMIME(ct)
		}

		data, err := io.ReadAll(p.Body)
		if err != nil {
			log.Printf("mailrx parse: read attachment %q: %v", filename, err)
			continue
		}

		if !allowed[ct] {
			log.Printf("mailrx parse: skipping %q (%s): not in allowed types", filename, ct)
			continue
		}

		attachments = append(attachments, Attachment{
			Filename:    filepath.Base(filename),
			ContentType: ct,
			Data:        data,
		})
	}

	return &ParsedMessage{
		MessageID:   msgID,
		FromAddress: fromAddr,
		Subject:     subject,
		Attachments: attachments,
	}, nil
}

// RawBytes re-reads an already-buffered message body and returns the raw
// bytes. ParseMessage consumes the reader internally; pass the original
// bytes.Buffer to this helper after calling ParseMessage.
//
// We keep the raw bytes separate so they can be stored to B2 independently
// of the attachment parse.
func RawBytes(r io.Reader, maxBytes int64) ([]byte, error) {
	lr := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("mailrx: raw message exceeds %d bytes", maxBytes)
	}
	return data, nil
}

// --- helpers ---

func normalizeMIME(s string) string {
	if i := strings.IndexByte(s, ';'); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(strings.TrimSpace(s))
}

func makeAllowedSet(types []string) map[string]bool {
	m := make(map[string]bool, len(types))
	for _, t := range types {
		m[strings.ToLower(strings.TrimSpace(t))] = true
	}
	return m
}

func extForMIME(mime string) string {
	switch mime {
	case "application/pdf":
		return ".pdf"
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/heic", "image/heif":
		return ".heic"
	default:
		return ".bin"
	}
}

func headerFrom(h mail.Header) string {
	addrs, err := h.AddressList("From")
	if err != nil || len(addrs) == 0 {
		return ""
	}
	return addrs[0].Address
}
