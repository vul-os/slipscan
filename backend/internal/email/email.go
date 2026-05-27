// Package email defines the Sender interface and message type used by
// transactional email throughout the application.  The SES implementation
// lives in ses.go; a no-op sender (for environments where email is disabled)
// is defined here.
package email

import "context"

// Sender abstracts away the transport so handlers can accept a Sender and
// tests can pass a no-op fake.
type Sender interface {
	Send(ctx context.Context, msg Message) error
}

// Message is the minimal shape required to send a transactional email.
type Message struct {
	From    string
	To      string
	Subject string
	HTML    string
	Text    string
}

// NoopSender is used when email sending is not configured — invitation and
// verification creation still work, the admin just has to share the link
// manually.
type NoopSender struct{}

func (NoopSender) Send(context.Context, Message) error { return nil }
