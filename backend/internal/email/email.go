// Package email is a thin Resend client. It implements only what the app
// actually sends today (transactional invitations) so we don't pull in a
// vendor SDK that would also need to be kept up to date.
package email

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const resendAPI = "https://api.resend.com/emails"

// Sender abstracts away the transport so handlers can take a Sender and
// tests can pass a no-op fake.
type Sender interface {
	Send(ctx context.Context, msg Message) error
}

// Message is the minimal shape Resend's /emails endpoint accepts.
// Sender must be a verified domain on the Resend account, or the shared
// `onboarding@resend.dev` (which only delivers to addresses verified on
// the same Resend account).
type Message struct {
	From    string
	To      string
	Subject string
	HTML    string
	Text    string
}

type ResendClient struct {
	apiKey string
	from   string
	hc     *http.Client
}

func NewResend(apiKey, from string) *ResendClient {
	return &ResendClient{
		apiKey: apiKey,
		from:   from,
		hc:     &http.Client{Timeout: 10 * time.Second},
	}
}

type resendRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html,omitempty"`
	Text    string   `json:"text,omitempty"`
}

func (c *ResendClient) Send(ctx context.Context, msg Message) error {
	if c.apiKey == "" {
		return errors.New("resend: api key not configured")
	}
	from := msg.From
	if from == "" {
		from = c.from
	}
	if from == "" {
		return errors.New("resend: missing from address")
	}
	body, err := json.Marshal(resendRequest{
		From: from, To: []string{msg.To}, Subject: msg.Subject,
		HTML: msg.HTML, Text: msg.Text,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendAPI, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	// Surface Resend's error body verbatim — usually a useful one-liner like
	// "domain not verified" or "to address not allowed in test mode".
	b, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	return fmt.Errorf("resend: %d %s", res.StatusCode, string(b))
}

// NoopSender is used when RESEND_API_KEY isn't set — invitation creation
// still works, the admin just has to share the link manually.
type NoopSender struct{}

func (NoopSender) Send(context.Context, Message) error { return nil }
