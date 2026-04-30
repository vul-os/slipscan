package config

import (
	"errors"
	"fmt"
	"os"
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

	ResendAPIKey string
	ResendFrom   string
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

		ResendAPIKey: os.Getenv("RESEND_API_KEY"),
		ResendFrom:   os.Getenv("RESEND_FROM"),
	}, nil
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
