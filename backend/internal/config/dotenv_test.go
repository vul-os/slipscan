package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotenv_SetsVarsFromFile(t *testing.T) {
	f := tempDotenv(t, "DOTENV_TEST_VAR=hello\nDOTENV_OTHER=world\n")
	t.Cleanup(func() {
		_ = os.Unsetenv("DOTENV_TEST_VAR")
		_ = os.Unsetenv("DOTENV_OTHER")
	})

	if err := LoadDotenv(f); err != nil {
		t.Fatalf("LoadDotenv: %v", err)
	}
	if got := os.Getenv("DOTENV_TEST_VAR"); got != "hello" {
		t.Errorf("expected DOTENV_TEST_VAR=hello, got %q", got)
	}
	if got := os.Getenv("DOTENV_OTHER"); got != "world" {
		t.Errorf("expected DOTENV_OTHER=world, got %q", got)
	}
}

func TestLoadDotenv_SkipsComments(t *testing.T) {
	f := tempDotenv(t, "# this is a comment\nDOTENV_REAL=yes\n")
	t.Cleanup(func() { _ = os.Unsetenv("DOTENV_REAL") })

	if err := LoadDotenv(f); err != nil {
		t.Fatalf("LoadDotenv: %v", err)
	}
	if got := os.Getenv("DOTENV_REAL"); got != "yes" {
		t.Errorf("expected DOTENV_REAL=yes, got %q", got)
	}
}

func TestLoadDotenv_DoesNotOverrideExisting(t *testing.T) {
	_ = os.Setenv("DOTENV_EXISTS", "original")
	t.Cleanup(func() { _ = os.Unsetenv("DOTENV_EXISTS") })

	f := tempDotenv(t, "DOTENV_EXISTS=overridden\n")
	if err := LoadDotenv(f); err != nil {
		t.Fatalf("LoadDotenv: %v", err)
	}
	if got := os.Getenv("DOTENV_EXISTS"); got != "original" {
		t.Errorf("existing var should not be overridden; got %q", got)
	}
}

func TestLoadDotenv_MissingFileIsNoop(t *testing.T) {
	err := LoadDotenv("/nonexistent/path/.env.test")
	if err != nil {
		t.Errorf("missing file should not error; got %v", err)
	}
}

func TestLoadDotenv_StripsQuotes(t *testing.T) {
	f := tempDotenv(t, `DOTENV_QUOTED="double" `+"\n"+`DOTENV_SINGLE='single'`+"\n")
	t.Cleanup(func() {
		_ = os.Unsetenv("DOTENV_QUOTED")
		_ = os.Unsetenv("DOTENV_SINGLE")
	})

	if err := LoadDotenv(f); err != nil {
		t.Fatalf("LoadDotenv: %v", err)
	}
	if got := os.Getenv("DOTENV_QUOTED"); got != "double" {
		t.Errorf("expected DOTENV_QUOTED=double (no quotes), got %q", got)
	}
	if got := os.Getenv("DOTENV_SINGLE"); got != "single" {
		t.Errorf("expected DOTENV_SINGLE=single (no quotes), got %q", got)
	}
}

func TestResolveDotenv_AbsolutePathUsedDirectly(t *testing.T) {
	f := tempDotenv(t, "")
	resolved, ok := resolveDotenv(f)
	if !ok {
		t.Fatal("expected ok=true for absolute path")
	}
	if resolved != f {
		t.Errorf("expected %q, got %q", f, resolved)
	}
}

func TestResolveDotenv_WalksUpFromCWD(t *testing.T) {
	// Create a temp dir hierarchy: root/sub/subsub
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	subsub := filepath.Join(sub, "subsub")
	_ = os.MkdirAll(subsub, 0755)

	// Write the .env file at root level.
	envFile := filepath.Join(root, ".testenv999")
	_ = os.WriteFile(envFile, []byte(""), 0644)

	// Change cwd to subsub (deepest) and ask resolveDotenv to find .testenv999
	origDir, _ := os.Getwd()
	_ = os.Chdir(subsub)
	defer func() { _ = os.Chdir(origDir) }()

	resolved, ok := resolveDotenv(".testenv999")
	if !ok {
		t.Fatal("expected ok=true, file should be found by walking up")
	}
	if resolved != envFile {
		t.Errorf("expected %q, got %q", envFile, resolved)
	}
}

func TestResolveDotenv_NotFoundReturnsFalse(t *testing.T) {
	// Use a name that definitely won't exist in any parent.
	_, ok := resolveDotenv(".env-nonexistent-xyz-abc-123")
	if ok {
		t.Error("expected ok=false for non-existent file")
	}
}

// tempDotenv creates a temp file with the given content and returns its path.
func tempDotenv(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), ".env*")
	if err != nil {
		t.Fatalf("create temp dotenv: %v", err)
	}
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("write temp dotenv: %v", err)
	}
	_ = f.Close()
	return f.Name()
}
