package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoadEnvFile_ParsesKeyValuePairs verifies basic KEY=VALUE parsing.
func TestLoadEnvFile_ParsesKeyValuePairs(t *testing.T) {
	f := writeTempEnv(t, `
# comment
DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require

JWT_SECRET=mysecret
`)
	// Ensure these keys are unset before we load.
	unsetKeys(t, "DATABASE_URL", "JWT_SECRET")

	got := loadEnvFile(f)
	if got != "postgres://user:pass@host:5432/db?sslmode=require" {
		t.Errorf("expected DATABASE_URL, got %q", got)
	}
	if v := os.Getenv("JWT_SECRET"); v != "mysecret" {
		t.Errorf("expected JWT_SECRET=mysecret, got %q", v)
	}
}

// TestLoadEnvFile_QuotedValues verifies that single and double quotes are stripped.
func TestLoadEnvFile_QuotedValues(t *testing.T) {
	f := writeTempEnv(t, `
DATABASE_URL="postgres://quoted@host/db"
JWT_SECRET='singlequoted'
`)
	unsetKeys(t, "DATABASE_URL", "JWT_SECRET")

	got := loadEnvFile(f)
	if got != "postgres://quoted@host/db" {
		t.Errorf("expected unquoted DATABASE_URL, got %q", got)
	}
	if v := os.Getenv("JWT_SECRET"); v != "singlequoted" {
		t.Errorf("expected JWT_SECRET singlequoted, got %q", v)
	}
}

// TestLoadEnvFile_DoesNotOverrideExistingEnv verifies the "don't overwrite" rule.
func TestLoadEnvFile_DoesNotOverrideExistingEnv(t *testing.T) {
	f := writeTempEnv(t, `DATABASE_URL=from-file`)
	_ = os.Setenv("DATABASE_URL", "from-process")
	t.Cleanup(func() { _ = os.Unsetenv("DATABASE_URL") })

	// The file has DATABASE_URL but the env is already set — file must not win.
	got := loadEnvFile(f)
	// loadEnvFile returns the value it finds in the file, even if it doesn't
	// overwrite the env. Let's check that the env is still the process value.
	if v := os.Getenv("DATABASE_URL"); v != "from-process" {
		t.Errorf("env should not be overwritten; got %q", v)
	}
	// The returned URL is still from the file.
	if got != "from-file" {
		t.Errorf("loadEnvFile return value should be from-file, got %q", got)
	}
}

// TestLoadEnvFile_MissingFile returns empty string without crashing.
func TestLoadEnvFile_MissingFile(t *testing.T) {
	got := loadEnvFile("/nonexistent/path/.env.missing")
	if got != "" {
		t.Errorf("expected empty string for missing file, got %q", got)
	}
}

// TestLoadEnvFile_EmptyFile returns empty string.
func TestLoadEnvFile_EmptyFile(t *testing.T) {
	f := writeTempEnv(t, "")
	got := loadEnvFile(f)
	if got != "" {
		t.Errorf("expected empty string for empty file, got %q", got)
	}
}

// TestEnvFiles_MapContainsAllEnvs verifies that the envFiles map has all
// three expected keys.
func TestEnvFiles_MapContainsAllEnvs(t *testing.T) {
	for _, env := range []string{"local", "dev", "main"} {
		if _, ok := envFiles[env]; !ok {
			t.Errorf("envFiles missing key %q", env)
		}
	}
}

// TestEnvFiles_PathsAreAbsolute verifies all resolved paths are absolute.
func TestEnvFiles_PathsAreAbsolute(t *testing.T) {
	for env, path := range envFiles {
		if !filepath.IsAbs(path) {
			t.Errorf("envFiles[%q] = %q is not absolute", env, path)
		}
	}
}

// TestLoadDatabaseURL_FallsBackToEnvVar verifies that if the file has no
// DATABASE_URL, the function reads it from the environment.
func TestLoadDatabaseURL_FallsBackToEnvVar(t *testing.T) {
	// Point "local" at a temp file with no DATABASE_URL.
	f := writeTempEnv(t, "SOME_OTHER_VAR=foo")
	origPath := envFiles["local"]
	envFiles["local"] = f
	t.Cleanup(func() { envFiles["local"] = origPath })

	// Set the fallback env var.
	_ = os.Setenv("DATABASE_URL", "postgres://fallback@host/db")
	t.Cleanup(func() { _ = os.Unsetenv("DATABASE_URL") })

	url, _ := loadDatabaseURL("local")
	if url != "postgres://fallback@host/db" {
		t.Errorf("expected fallback DATABASE_URL, got %q", url)
	}
}

// TestLoadDatabaseURL_UsesEnvFilePrimaryForDev verifies .env.dev is loaded
// when --env=dev is specified.
func TestLoadDatabaseURL_UsesEnvFilePrimaryForDev(t *testing.T) {
	f := writeTempEnv(t, "DATABASE_URL=postgres://dev-host/devdb?sslmode=require")
	origPath := envFiles["dev"]
	envFiles["dev"] = f
	t.Cleanup(func() { envFiles["dev"] = origPath })

	// Ensure the environment variable is not already set.
	unsetKeys(t, "DATABASE_URL")

	url, envFile := loadDatabaseURL("dev")
	if url != "postgres://dev-host/devdb?sslmode=require" {
		t.Errorf("expected dev DATABASE_URL, got %q", url)
	}
	if envFile != f {
		t.Errorf("expected envFile %q, got %q", f, envFile)
	}
}

// TestLoadDatabaseURL_LocalFallbackToPlainDotEnv checks that --env=local
// falls back from .env.local to .env when the former doesn't exist.
func TestLoadDatabaseURL_LocalFallbackToPlainDotEnv(t *testing.T) {
	// Point .env.local at a non-existent path so the fallback triggers.
	origPath := envFiles["local"]
	envFiles["local"] = "/nonexistent/.env.local"
	t.Cleanup(func() { envFiles["local"] = origPath })

	// Create a real .env file in a temp dir and override repoRoot.
	tmpDir := t.TempDir()
	dotenv := filepath.Join(tmpDir, ".env")
	if err := os.WriteFile(dotenv, []byte("DATABASE_URL=postgres://local-fallback/db\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// Patch the repoRoot variable so loadDatabaseURL finds our temp .env.
	origRepoRoot := repoRoot
	repoRoot = tmpDir
	t.Cleanup(func() { repoRoot = origRepoRoot })

	unsetKeys(t, "DATABASE_URL")

	url, _ := loadDatabaseURL("local")
	if url != "postgres://local-fallback/db" {
		t.Errorf("expected local-fallback DATABASE_URL, got %q", url)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

// writeTempEnv writes content to a temporary env file and returns its path.
func writeTempEnv(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), ".env*")
	if err != nil {
		t.Fatalf("create temp env file: %v", err)
	}
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("write temp env file: %v", err)
	}
	_ = f.Close()
	return f.Name()
}

// unsetKeys unsets environment variables for the duration of the test.
func unsetKeys(t *testing.T, keys ...string) {
	t.Helper()
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
