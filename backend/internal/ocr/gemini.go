// Package ocr extracts structured receipt data from images and PDFs using
// Google's Gemini API. Talks to the REST endpoint directly to avoid pulling
// in the full Google Cloud SDK.
package ocr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

const (
	defaultModel = "gemini-2.5-flash"
	apiBase      = "https://generativelanguage.googleapis.com/v1beta/models"
)

// ErrRateLimited is returned when Gemini's per-minute quota is exhausted.
// Callers should surface a friendly retry message rather than the raw
// upstream response.
var ErrRateLimited = errors.New("ocr: rate limited")

type Client struct {
	apiKey string
	model  string
	http   *http.Client
}

func New(apiKey string) *Client {
	return &Client{
		apiKey: apiKey,
		model:  defaultModel,
		http:   &http.Client{Timeout: 60 * time.Second},
	}
}

// Model returns the underlying Gemini model name (used for logging and
// for callers that want to issue text-only generation directly).
func (c *Client) Model() string { return c.model }

// LineItem describes one purchased line on a receipt. Pointers so missing
// values round-trip as JSON null instead of zero.
type LineItem struct {
	Description *string  `json:"description,omitempty"`
	Qty         *float64 `json:"qty,omitempty"`
	UnitPrice   *float64 `json:"unit_price,omitempty"`
	Total       *float64 `json:"total,omitempty"`
}

// Receipt is the structured output we ask Gemini to produce. Every field is
// optional — Gemini returns null for anything it can't read confidently.
type Receipt struct {
	Merchant      *string    `json:"merchant,omitempty"`
	Date          *string    `json:"date,omitempty"`
	Total         *float64   `json:"total,omitempty"`
	Currency      *string    `json:"currency,omitempty"`
	Tax           *float64   `json:"tax,omitempty"`
	PaymentMethod *string    `json:"payment_method,omitempty"`
	Category      *string    `json:"category,omitempty"`
	LineItems     []LineItem `json:"line_items,omitempty"`
	Notes         *string    `json:"notes,omitempty"`
	Confidence    *float64   `json:"confidence,omitempty"`
}

// Categories is the closed set the extractor can emit. Kept here (not in
// the prompt) so callers — including the natural-language search feature —
// share a single source of truth.
var Categories = []string{
	"meals", "travel", "lodging", "fuel", "groceries", "office",
	"software", "utilities", "entertainment", "health", "shopping",
	"services", "other",
}

const extractPrompt = `You are a receipt parser. Extract the data from the attached image or PDF.

Rules:
- Use null for any field you can't read confidently. Don't guess.
- Numbers are decimals only. No currency symbols, no thousand-separators.
- date is ISO 8601 (YYYY-MM-DD).
- currency is a 3-letter ISO code (USD, ZAR, EUR, GBP, etc.).
- payment_method is one of: cash, card, transfer, other.
- Pick the category that best fits the merchant + line items; use "other" if nothing fits.
- If you can't classify a line item cleanly, omit it; if no line items at all, return [].
- confidence is a self-rating from 0.0 (guessed) to 1.0 (read clearly). Be honest so admins know which fields to verify.`

// receiptSchema is Gemini's responseSchema. Forcing the shape server-side
// is dramatically more reliable than relying on the model to follow a
// JSON-shaped prompt — parse failures drop to ~zero, and we don't need
// to defend against markdown fences or hallucinated fields.
var receiptSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"merchant":       map[string]any{"type": "string", "nullable": true},
		"date":           map[string]any{"type": "string", "nullable": true},
		"total":          map[string]any{"type": "number", "nullable": true},
		"currency":       map[string]any{"type": "string", "nullable": true},
		"tax":            map[string]any{"type": "number", "nullable": true},
		"payment_method": map[string]any{"type": "string", "nullable": true, "enum": []string{"cash", "card", "transfer", "other"}},
		"category":       map[string]any{"type": "string", "nullable": true, "enum": Categories},
		"line_items": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"description": map[string]any{"type": "string", "nullable": true},
					"qty":         map[string]any{"type": "number", "nullable": true},
					"unit_price":  map[string]any{"type": "number", "nullable": true},
					"total":       map[string]any{"type": "number", "nullable": true},
				},
			},
		},
		"notes":      map[string]any{"type": "string", "nullable": true},
		"confidence": map[string]any{"type": "number", "nullable": true},
	},
}

// Extract sends the image bytes to Gemini and returns the parsed Receipt
// plus the raw JSON text (for storage in raw_extraction).
func (c *Client) Extract(ctx context.Context, imageBytes []byte, mimeType string) (*Receipt, json.RawMessage, error) {
	if len(imageBytes) == 0 {
		return nil, nil, errors.New("ocr: empty image")
	}

	encoded := base64.StdEncoding.EncodeToString(imageBytes)
	reqBody := map[string]any{
		"contents": []map[string]any{{
			"parts": []map[string]any{
				{"text": extractPrompt},
				{"inline_data": map[string]any{
					"mime_type": mimeType,
					"data":      encoded,
				}},
			},
		}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema":   receiptSchema,
			"temperature":      0.1,
		},
	}

	text, err := c.callJSON(ctx, reqBody)
	if err != nil {
		return nil, nil, err
	}

	var receipt Receipt
	if err := json.Unmarshal([]byte(text), &receipt); err != nil {
		return nil, json.RawMessage(text), fmt.Errorf("ocr: parse extraction: %w", err)
	}
	return &receipt, json.RawMessage(text), nil
}

// ExtractWithSchema sends image bytes to Gemini with a caller-supplied prompt
// and response schema, returning the raw JSON bytes. This is used by the
// extraction pipeline (internal/extract) so each document kind can have its
// own structured schema without duplicating the HTTP transport logic.
func (c *Client) ExtractWithSchema(ctx context.Context, imageBytes []byte, mimeType, prompt string, schema map[string]any) (json.RawMessage, error) {
	if len(imageBytes) == 0 {
		return nil, errors.New("ocr: empty image")
	}
	encoded := base64.StdEncoding.EncodeToString(imageBytes)
	reqBody := map[string]any{
		"contents": []map[string]any{{
			"parts": []map[string]any{
				{"text": prompt},
				{"inline_data": map[string]any{
					"mime_type": mimeType,
					"data":      encoded,
				}},
			},
		}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema":   schema,
			"temperature":      0.1,
		},
	}
	text, err := c.callJSON(ctx, reqBody)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(text), nil
}

// GenerateJSON is a generic helper for callers that want structured-output
// generation (e.g. the search feature translating NL → query filter). The
// caller supplies a prompt and a JSON schema; we handle transport, retries,
// and the candidate-extraction boilerplate.
func (c *Client) GenerateJSON(ctx context.Context, prompt string, schema map[string]any, temperature float64) (json.RawMessage, error) {
	reqBody := map[string]any{
		"contents": []map[string]any{{
			"parts": []map[string]any{{"text": prompt}},
		}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema":   schema,
			"temperature":      temperature,
		},
	}
	text, err := c.callJSON(ctx, reqBody)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(text), nil
}

// callJSON does the HTTP round-trip and pulls the JSON text out of the
// candidates envelope, with one retry on transient 5xx / 429.
func (c *Client) callJSON(ctx context.Context, reqBody map[string]any) (string, error) {
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("ocr: marshal request: %w", err)
	}

	url := fmt.Sprintf("%s/%s:generateContent?key=%s", apiBase, c.model, c.apiKey)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			// Exponential-ish backoff with jitter. Two attempts max — Gemini's
			// own infra retries internally, so a long retry chain just hides
			// real outages and burns the request timeout.
			delay := time.Duration(400+rand.Intn(400)) * time.Millisecond
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(delay):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return "", fmt.Errorf("ocr: build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("ocr: call gemini: %w", err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests {
			// Wrap so handlers can return a clean 429 instead of the raw
			// (and quite long) Gemini error JSON.
			lastErr = fmt.Errorf("%w: %s", ErrRateLimited, truncate(string(body), 200))
			continue
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("ocr: gemini status %d: %s", resp.StatusCode, truncate(string(body), 200))
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("ocr: gemini status %d: %s", resp.StatusCode, string(body))
		}

		text, err := extractText(body)
		if err != nil {
			return "", err
		}
		return text, nil
	}
	return "", lastErr
}

func extractText(body []byte) (string, error) {
	var envelope struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		PromptFeedback struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("ocr: parse envelope: %w", err)
	}
	if envelope.PromptFeedback.BlockReason != "" {
		return "", fmt.Errorf("ocr: gemini blocked: %s", envelope.PromptFeedback.BlockReason)
	}
	if len(envelope.Candidates) == 0 || len(envelope.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("ocr: gemini returned no candidates")
	}
	// Even with responseSchema set, defend against markdown fences in case the
	// model regresses or we drop the schema later.
	return stripFences(envelope.Candidates[0].Content.Parts[0].Text), nil
}

func stripFences(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
