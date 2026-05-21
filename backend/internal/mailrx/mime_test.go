package mailrx

import (
	"bytes"
	"strings"
	"testing"
)

// multiAttachmentFixture is a minimal RFC 822 message with:
//   - one PDF attachment (allowed)
//   - one PNG attachment (allowed)
//   - one JPEG attachment (allowed)
//   - one MP4 attachment (NOT allowed)
//
// The body uses base64 encoding with trivial 1-byte payloads so the test
// doesn't depend on any real file content.
const multiAttachmentFixture = `From: sender@example.com
To: acme@rx.test
Subject: My receipts
Message-Id: <test-msg-id@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary42"

--boundary42
Content-Type: text/plain

Here are my receipts.
--boundary42
Content-Type: application/pdf
Content-Disposition: attachment; filename="receipt.pdf"
Content-Transfer-Encoding: base64

YQ==
--boundary42
Content-Type: image/png
Content-Disposition: attachment; filename="photo.png"
Content-Transfer-Encoding: base64

Yg==
--boundary42
Content-Type: image/jpeg
Content-Disposition: attachment; filename="scan.jpg"
Content-Transfer-Encoding: base64

Yw==
--boundary42
Content-Type: video/mp4
Content-Disposition: attachment; filename="movie.mp4"
Content-Transfer-Encoding: base64

ZA==
--boundary42--
`

var defaultAllowed = []string{
	"application/pdf",
	"image/jpeg",
	"image/png",
	"image/heic",
	"image/heif",
}

func TestParseMessageMultiAttachment(t *testing.T) {
	r := strings.NewReader(multiAttachmentFixture)
	parsed, err := ParseMessage(r, 1<<20, defaultAllowed)
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}

	if parsed.MessageID != "test-msg-id@example.com" {
		t.Errorf("MessageID=%q want %q", parsed.MessageID, "test-msg-id@example.com")
	}
	if parsed.FromAddress != "sender@example.com" {
		t.Errorf("FromAddress=%q want %q", parsed.FromAddress, "sender@example.com")
	}
	if parsed.Subject != "My receipts" {
		t.Errorf("Subject=%q want %q", parsed.Subject, "My receipts")
	}

	// Should have 3 attachments (pdf, png, jpg) — mp4 filtered out.
	if len(parsed.Attachments) != 3 {
		t.Errorf("len(Attachments)=%d want 3", len(parsed.Attachments))
		for i, a := range parsed.Attachments {
			t.Logf("  [%d] %s (%s) %d bytes", i, a.Filename, a.ContentType, len(a.Data))
		}
		return
	}

	wantTypes := []string{"application/pdf", "image/png", "image/jpeg"}
	for i, att := range parsed.Attachments {
		if att.ContentType != wantTypes[i] {
			t.Errorf("Attachment[%d].ContentType=%q want %q", i, att.ContentType, wantTypes[i])
		}
		if len(att.Data) == 0 {
			t.Errorf("Attachment[%d].Data is empty", i)
		}
	}
}

func TestParseMessageTypeFilter(t *testing.T) {
	// Only allow PDF.
	r := strings.NewReader(multiAttachmentFixture)
	parsed, err := ParseMessage(r, 1<<20, []string{"application/pdf"})
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if len(parsed.Attachments) != 1 {
		t.Errorf("len(Attachments)=%d want 1", len(parsed.Attachments))
	}
	if len(parsed.Attachments) > 0 && parsed.Attachments[0].ContentType != "application/pdf" {
		t.Errorf("Attachment[0].ContentType=%q want %q", parsed.Attachments[0].ContentType, "application/pdf")
	}
}

func TestParseMessageSizeLimit(t *testing.T) {
	large := bytes.Repeat([]byte("x"), 512)
	body := "From: a@b.com\r\nTo: c@d.com\r\n\r\n" + string(large)
	_, err := ParseMessage(strings.NewReader(body), 100, defaultAllowed)
	if err == nil {
		t.Fatal("expected error for oversized message, got nil")
	}
}

func TestParseMessageNoAttachments(t *testing.T) {
	const noAttachment = `From: a@example.com
To: acme@rx.test
Subject: Hello
Message-Id: <hello@example.com>
MIME-Version: 1.0
Content-Type: text/plain

Just a plain text email, no attachment.
`
	parsed, err := ParseMessage(strings.NewReader(noAttachment), 1<<20, defaultAllowed)
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if len(parsed.Attachments) != 0 {
		t.Errorf("expected 0 attachments, got %d", len(parsed.Attachments))
	}
	if parsed.MessageID != "hello@example.com" {
		t.Errorf("MessageID=%q", parsed.MessageID)
	}
}

func TestNormalizeMIME(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"application/pdf", "application/pdf"},
		{"Application/PDF", "application/pdf"},
		{"image/jpeg; charset=utf-8", "image/jpeg"},
		{"  image/png  ", "image/png"},
	}
	for _, tt := range tests {
		got := normalizeMIME(tt.in)
		if got != tt.want {
			t.Errorf("normalizeMIME(%q)=%q want %q", tt.in, got, tt.want)
		}
	}
}

func TestExtForMIME(t *testing.T) {
	tests := []struct {
		mime string
		ext  string
	}{
		{"application/pdf", ".pdf"},
		{"image/jpeg", ".jpg"},
		{"image/png", ".png"},
		{"image/heic", ".heic"},
		{"image/heif", ".heic"},
		{"text/plain", ".bin"},
	}
	for _, tt := range tests {
		got := extForMIME(tt.mime)
		if got != tt.ext {
			t.Errorf("extForMIME(%q)=%q want %q", tt.mime, got, tt.ext)
		}
	}
}
