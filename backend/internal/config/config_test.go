package config

import (
	"os"
	"testing"
	"time"
)

// clearEnv unsets all environment variables that config.Load() reads, then
// restores them after the test.
func clearEnv(t *testing.T) {
	t.Helper()
	keys := []string{
		"DATABASE_URL",
		"JWT_SECRET",
		"JWT_ACCESS_TTL",
		"JWT_REFRESH_TTL",
		"INVITATION_TTL",
		"PORT",
		"APP_BASE_URL",
		"FRONTEND_BASE_URL",
		"B2_KEY_ID",
		"B2_APPLICATION_KEY",
		"B2_BUCKET",
		"B2_REGION",
		"B2_ENDPOINT",
		"GEMINI_API_KEY",
		"AWS_REGION",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"EMAIL_FROM",
		"SES_CONFIGURATION_SET",
		"EMAIL_WORKER_ENABLED",
		"EMAIL_WORKER_INTERVAL",
	}
	saved := make(map[string]string, len(keys))
	for _, k := range keys {
		saved[k] = os.Getenv(k)
		_ = os.Unsetenv(k)
	}
	t.Cleanup(func() {
		for k, v := range saved {
			if v == "" {
				_ = os.Unsetenv(k)
			} else {
				_ = os.Setenv(k, v)
			}
		}
	})
}

// setMinimal sets the minimum set of env vars required for Load() to succeed.
func setMinimal(t *testing.T) {
	t.Helper()
	must := map[string]string{
		"DATABASE_URL":      "postgres://test:test@localhost:5432/testdb?sslmode=disable",
		"JWT_SECRET":        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"B2_KEY_ID":         "test-key-id",
		"B2_APPLICATION_KEY": "test-app-key",
		"B2_BUCKET":         "test-bucket",
		"B2_REGION":         "us-east-005",
		"B2_ENDPOINT":       "https://s3.us-east-005.backblazeb2.com",
		"GEMINI_API_KEY":    "test-gemini-key",
	}
	for k, v := range must {
		_ = os.Setenv(k, v)
	}
}

func TestLoad_RequiresDatabaseURL(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Unsetenv("DATABASE_URL")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when DATABASE_URL is missing")
	}
}

func TestLoad_RequiresJWTSecret(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Unsetenv("JWT_SECRET")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when JWT_SECRET is missing")
	}
}

func TestLoad_RequiresJWTSecretMinLength(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Setenv("JWT_SECRET", "tooshort")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when JWT_SECRET is shorter than 32 chars")
	}
}

// Storage requires the resolved key/secret/bucket/endpoint (via STORAGE_* or
// the legacy B2_* fallback). Region is optional — it defaults to "auto" (R2).
func TestLoad_RequiresStorageVars(t *testing.T) {
	required := []string{
		"B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT",
	}
	for _, missing := range required {
		t.Run("missing_"+missing, func(t *testing.T) {
			clearEnv(t)
			setMinimal(t)
			_ = os.Unsetenv(missing)
			_, err := Load()
			if err == nil {
				t.Fatalf("expected error when %s is missing", missing)
			}
		})
	}

	t.Run("region_optional_defaults_auto", func(t *testing.T) {
		clearEnv(t)
		setMinimal(t)
		_ = os.Unsetenv("B2_REGION")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("region should be optional: %v", err)
		}
		if cfg.StorageRegion != "auto" {
			t.Errorf("expected StorageRegion to default to \"auto\", got %q", cfg.StorageRegion)
		}
	})

	t.Run("storage_vars_satisfy_without_b2", func(t *testing.T) {
		clearEnv(t)
		setMinimal(t)
		for _, k := range []string{"B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_REGION", "B2_ENDPOINT"} {
			_ = os.Unsetenv(k)
		}
		_ = os.Setenv("STORAGE_KEY_ID", "r2-key")
		_ = os.Setenv("STORAGE_SECRET", "r2-secret")
		_ = os.Setenv("STORAGE_BUCKET", "slipscan-docs")
		_ = os.Setenv("STORAGE_ENDPOINT", "https://acct.r2.cloudflarestorage.com")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("STORAGE_* alone should satisfy storage config: %v", err)
		}
		if cfg.StorageBucket != "slipscan-docs" {
			t.Errorf("unexpected StorageBucket %q", cfg.StorageBucket)
		}
	})
}

func TestLoad_RequiresGeminiAPIKey(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Unsetenv("GEMINI_API_KEY")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when GEMINI_API_KEY is missing")
	}
}

func TestLoad_DefaultsPort(t *testing.T) {
	clearEnv(t)
	setMinimal(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Port != "8080" {
		t.Errorf("expected default port 8080, got %q", cfg.Port)
	}
}

func TestLoad_DefaultsAppBaseURL(t *testing.T) {
	clearEnv(t)
	setMinimal(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.AppBaseURL != "http://localhost:8080" {
		t.Errorf("expected default AppBaseURL http://localhost:8080, got %q", cfg.AppBaseURL)
	}
}

func TestLoad_DefaultsTokenTTLs(t *testing.T) {
	clearEnv(t)
	setMinimal(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Errorf("expected access TTL 15m, got %v", cfg.AccessTokenTTL)
	}
	if cfg.RefreshTTL != 7*24*time.Hour {
		t.Errorf("expected refresh TTL 168h, got %v", cfg.RefreshTTL)
	}
}

func TestLoad_CustomTTL(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Setenv("JWT_ACCESS_TTL", "30m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.AccessTokenTTL != 30*time.Minute {
		t.Errorf("expected access TTL 30m, got %v", cfg.AccessTokenTTL)
	}
}

func TestLoad_InvalidTTL(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Setenv("JWT_ACCESS_TTL", "not-a-duration")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid JWT_ACCESS_TTL")
	}
}

func TestLoad_EmailOptional(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	// No email env set — should still load OK and leave SES fields empty.

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.EmailFrom != "" {
		t.Errorf("expected empty EmailFrom, got %q", cfg.EmailFrom)
	}
	if cfg.AWSRegion != "" {
		t.Errorf("expected empty AWSRegion, got %q", cfg.AWSRegion)
	}
	if cfg.EmailWorkerEnabled {
		t.Errorf("expected EmailWorkerEnabled to default to false")
	}
}

func TestLoad_Success(t *testing.T) {
	clearEnv(t)
	setMinimal(t)
	_ = os.Setenv("PORT", "9090")
	_ = os.Setenv("APP_BASE_URL", "https://api.example.com")
	_ = os.Setenv("FRONTEND_BASE_URL", "https://example.com")
	_ = os.Setenv("AWS_REGION", "eu-west-1")
	_ = os.Setenv("EMAIL_FROM", "slip/scan <noreply@mail.slipscan.app>")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Port != "9090" {
		t.Errorf("expected port 9090, got %q", cfg.Port)
	}
	if cfg.AppBaseURL != "https://api.example.com" {
		t.Errorf("unexpected AppBaseURL %q", cfg.AppBaseURL)
	}
	if cfg.AWSRegion != "eu-west-1" {
		t.Errorf("expected AWSRegion eu-west-1, got %q", cfg.AWSRegion)
	}
	if cfg.EmailFrom != "slip/scan <noreply@mail.slipscan.app>" {
		t.Errorf("expected EmailFrom set, got %q", cfg.EmailFrom)
	}
	if string(cfg.JWTSecret) != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("unexpected JWTSecret")
	}
}
