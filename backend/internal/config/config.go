package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL    string
	JWTSecret      []byte
	AccessTokenTTL time.Duration
	RefreshTTL     time.Duration
	InvitationTTL  time.Duration
	Port            string
	AppBaseURL      string
	FrontendBaseURL string

	B2KeyID          string
	B2ApplicationKey string
	B2Bucket         string
	B2Region         string
	B2Endpoint       string

	GeminiAPIKey string

	// Email sending via Amazon SES + outbox queue.
	// All fields are optional — when EMAIL_FROM or AWS_REGION is unset the
	// application falls back to NoopSender and logs a warning.
	AWSRegion           string
	AWSAccessKeyID      string
	AWSSecretAccessKey  string
	EmailFrom           string
	SESConfigurationSet string
	// EmailWorkerEnabled gates the background outbox delivery worker.
	// Set to "true" on EXACTLY ONE fleet member (same leader-guard pattern as
	// FX_SYNC_ENABLED) to avoid duplicate sends on multi-node deployments.
	EmailWorkerEnabled   bool
	EmailWorkerInterval  string // optional, e.g. "10s"; empty → default 5s

	// Mail receiver (cmd/mailrx)
	RxDomain        string
	MailrxAddr      string
	MailrxMaxBytes  int64
	MailrxAllowedTypes []string

	// FX / exchange-rate sync.
	// ExchangeRateAPIKey is optional. When empty, the free Frankfurter.app
	// provider is used (no account required, no secret needed).
	ExchangeRateAPIKey string
	// ExchangeRateBase is the base currency for all stored rates (default USD).
	ExchangeRateBase string
	// FXSyncEnabled gates the hourly scheduler. Set to "true" on exactly ONE
	// fleet member to enforce the <=24 calls/day single-runner constraint.
	FXSyncEnabled bool

	// P1-03: correction-learning loop
	// ClassifyPromotionThreshold is the number of identical user corrections
	// (same merchant_normalized → same category) before a classification_rules
	// row is upserted. Defaults to 2 when 0. Set via CLASSIFY_PROMOTION_THRESHOLD.
	ClassifyPromotionThreshold int
	// P1-04: Cross-tenant merchant signal aggregation.
	// SignalsAggEnabled gates the periodic aggregation job. Set to "true" on
	// exactly ONE fleet member (same leader-guard pattern as FX_SYNC_ENABLED).
	SignalsAggEnabled bool
	// SignalsMinOrgs is the minimum number of distinct organisations that must
	// agree on a (merchant, category) pairing before it is written to
	// merchant_signals. Defaults to 2.
	SignalsMinOrgs int

	// P2-05: Xero / QuickBooks export.
	// XeroClientID and XeroClientSecret are the OAuth2 app credentials from
	// https://developer.xero.com/app/manage. XeroRedirectURL must match the
	// redirect URI registered in the Xero developer portal exactly.
	// When any of these is blank the Xero integration is disabled gracefully
	// (connect routes return 503).
	XeroClientID     string
	XeroClientSecret string
	XeroRedirectURL  string

	// P3-01: Bank-feed aggregator (Stitch / SA-first).
	// StitchClientID, StitchClientSecret and StitchRedirectURL are the OAuth2
	// credentials from https://stitch.money/developers.
	// StitchWebhookSecret is the shared secret used to validate webhook
	// signatures (X-Stitch-Signature header).
	// When StitchClientID is blank the integration is disabled gracefully
	// (routes return 503).
	//
	// BankfeedSyncEnabled gates the periodic scheduler.  Set to "true" on
	// EXACTLY ONE fleet member (same leader-guard pattern as FX_SYNC_ENABLED).
	// BankfeedSyncInterval controls how often connections are polled (default 4h).
	StitchClientID      string
	StitchClientSecret  string
	StitchRedirectURL   string
	StitchWebhookSecret string
	BankfeedSyncEnabled bool
}

func Load() (*Config, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, errors.New("DATABASE_URL is required")
	}

	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		return nil, errors.New("JWT_SECRET must be at least 32 characters")
	}

	accessTTL, err := durationOr("JWT_ACCESS_TTL", 15*time.Minute)
	if err != nil {
		return nil, err
	}
	refreshTTL, err := durationOr("JWT_REFRESH_TTL", 7*24*time.Hour)
	if err != nil {
		return nil, err
	}
	inviteTTL, err := durationOr("INVITATION_TTL", 7*24*time.Hour)
	if err != nil {
		return nil, err
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	b2KeyID := os.Getenv("B2_KEY_ID")
	b2AppKey := os.Getenv("B2_APPLICATION_KEY")
	b2Bucket := os.Getenv("B2_BUCKET")
	b2Region := os.Getenv("B2_REGION")
	b2Endpoint := os.Getenv("B2_ENDPOINT")
	if b2KeyID == "" || b2AppKey == "" || b2Bucket == "" || b2Region == "" || b2Endpoint == "" {
		return nil, errors.New("B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_REGION, B2_ENDPOINT are all required")
	}

	geminiKey := os.Getenv("GEMINI_API_KEY")
	if geminiKey == "" {
		return nil, errors.New("GEMINI_API_KEY is required")
	}

	return &Config{
		DatabaseURL:    dbURL,
		JWTSecret:      []byte(secret),
		AccessTokenTTL: accessTTL,
		RefreshTTL:     refreshTTL,
		InvitationTTL:  inviteTTL,
		Port:            port,
		AppBaseURL:      getOr("APP_BASE_URL", "http://localhost:8080"),
		FrontendBaseURL: getOr("FRONTEND_BASE_URL", "http://localhost:5173"),

		B2KeyID:          b2KeyID,
		B2ApplicationKey: b2AppKey,
		B2Bucket:         b2Bucket,
		B2Region:         b2Region,
		B2Endpoint:       b2Endpoint,

		GeminiAPIKey: geminiKey,

		AWSRegion:           os.Getenv("AWS_REGION"),
		AWSAccessKeyID:      os.Getenv("AWS_ACCESS_KEY_ID"),
		AWSSecretAccessKey:  os.Getenv("AWS_SECRET_ACCESS_KEY"),
		EmailFrom:           os.Getenv("EMAIL_FROM"),
		SESConfigurationSet: os.Getenv("SES_CONFIGURATION_SET"),
		EmailWorkerEnabled:  os.Getenv("EMAIL_WORKER_ENABLED") == "true",
		EmailWorkerInterval: os.Getenv("EMAIL_WORKER_INTERVAL"),

		RxDomain:        getOr("RX_DOMAIN", "mail.slipscan.app"),
		MailrxAddr:      getOr("MAILRX_ADDR", ":2525"),
		MailrxMaxBytes:  mailrxMaxBytes(),
		MailrxAllowedTypes: mailrxAllowedTypes(),

		ExchangeRateAPIKey: os.Getenv("EXCHANGE_RATE_API_KEY"),
		ExchangeRateBase:   getOr("EXCHANGE_RATE_BASE", "USD"),
		FXSyncEnabled:      os.Getenv("FX_SYNC_ENABLED") == "true",

		ClassifyPromotionThreshold: classifyPromotionThreshold(),
		SignalsAggEnabled:          os.Getenv("SIGNALS_AGG_ENABLED") == "true",
		SignalsMinOrgs:             signalsMinOrgs(),

		// P2-05: Xero integration (optional — missing secrets disable the feature).
		XeroClientID:     os.Getenv("XERO_CLIENT_ID"),
		XeroClientSecret: os.Getenv("XERO_CLIENT_SECRET"),
		XeroRedirectURL:  getOr("XERO_REDIRECT_URL", "http://localhost:8080/integrations/xero/callback"),

		// P3-01: Stitch bank-feed integration (optional — missing client_id disables).
		StitchClientID:      os.Getenv("STITCH_CLIENT_ID"),
		StitchClientSecret:  os.Getenv("STITCH_CLIENT_SECRET"),
		StitchRedirectURL:   getOr("STITCH_REDIRECT_URL", "http://localhost:8080/integrations/bankfeed/callback"),
		StitchWebhookSecret: os.Getenv("STITCH_WEBHOOK_SECRET"),
		BankfeedSyncEnabled: os.Getenv("BANKFEED_SYNC_ENABLED") == "true",
	}, nil
}

// mailrxMaxBytes returns the maximum inbound message size in bytes.
// Defaults to 25 MB.
func mailrxMaxBytes() int64 {
	v := os.Getenv("MAILRX_MAX_MESSAGE_BYTES")
	if v == "" {
		return 25 << 20 // 25 MB
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return 25 << 20
	}
	return n
}

// mailrxAllowedTypes returns the list of allowed MIME types for attachments.
// Defaults to pdf, jpeg, png, heic.
func mailrxAllowedTypes() []string {
	v := os.Getenv("MAILRX_ALLOWED_TYPES")
	if v == "" {
		return []string{
			"application/pdf",
			"image/jpeg",
			"image/png",
			"image/heic",
			"image/heif",
		}
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, strings.ToLower(t))
		}
	}
	return out
}

// classifyPromotionThreshold returns the correction count threshold for rule
// promotion. Defaults to 0 (which classify.CorrectionsConfig.WithDefaults will
// interpret as DefaultPromotionThreshold = 2). Negative or non-numeric values
// are treated as 0.
func classifyPromotionThreshold() int {
	v := os.Getenv("CLASSIFY_PROMOTION_THRESHOLD")
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// signalsMinOrgs returns the minimum distinct-orgs threshold for merchant
// signal trust. Defaults to 2 (i.e. at least 2 distinct orgs must agree).
func signalsMinOrgs() int {
	v := os.Getenv("SIGNALS_MIN_ORGS")
	if v == "" {
		return 2
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 2
	}
	return n
}

func getOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func durationOr(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
