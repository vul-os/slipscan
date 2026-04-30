// Run pending SQL migrations against a Postgres database.
//
// Tracks applied migrations in a _migrations table so each file only runs once.
// Migration files live in backend/migrations and follow the pattern
// 20260430120000_name.sql — they are applied in lexicographic order.
//
// Usage:
//
//    go run ./cmd/migrate                    # local (default), apply pending
//    go run ./cmd/migrate --env=dev          # uses .env.dev
//    go run ./cmd/migrate --env=local        # uses .env.local (or .env)
//    go run ./cmd/migrate --status           # show migration status
//    go run ./cmd/migrate --reset            # drop schema and re-run all
//    go run ./cmd/migrate --env=dev --reset  # reset dev database
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

var (
	_, srcFile, _, _ = runtime.Caller(0)
	here             = filepath.Dir(srcFile)
	backendRoot      = filepath.Join(here, "..", "..")
	repoRoot         = filepath.Join(backendRoot, "..")
	migrationsDir    = filepath.Join(backendRoot, "migrations")
	envFiles         = map[string]string{
		"main":  filepath.Join(repoRoot, ".env.main"),
		"dev":   filepath.Join(repoRoot, ".env.dev"),
		"local": filepath.Join(repoRoot, ".env.local"),
	}
)

const trackingTable = `
CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`

// loadEnvFile reads an env file and sets all KEY=VALUE pairs into the process
// environment (skipping blank lines, comments, and already-set vars).
// Returns the DATABASE_URL found in the file, or "" if not present.
func loadEnvFile(envFile string) string {
	data, err := os.ReadFile(envFile)
	if err != nil {
		return ""
	}
	var dbURL string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, val, _ := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		val = strings.Trim(val, `"'`)
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, val)
		}
		if key == "DATABASE_URL" {
			dbURL = val
		}
	}
	return dbURL
}

func loadDatabaseURL(env string) (string, string) {
	envFile := envFiles[env]
	if env == "local" {
		if _, err := os.Stat(envFile); err != nil {
			envFile = filepath.Join(repoRoot, ".env")
		}
	}
	if dbURL := loadEnvFile(envFile); dbURL != "" {
		return dbURL, envFile
	}
	if url := os.Getenv("DATABASE_URL"); url != "" {
		return url, envFile
	}
	fmt.Fprintf(os.Stderr, "ERROR: DATABASE_URL not found in %s\n", envFile)
	os.Exit(1)
	return "", envFile
}

func connect(ctx context.Context, dbURL string) *pgx.Conn {
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: could not connect: %v\n", err)
		os.Exit(1)
	}
	return conn
}

func ensureTracking(ctx context.Context, conn *pgx.Conn) {
	if _, err := conn.Exec(ctx, trackingTable); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: could not create tracking table: %v\n", err)
		os.Exit(1)
	}
}

func getApplied(ctx context.Context, conn *pgx.Conn) map[string]bool {
	rows, err := conn.Query(ctx, "SELECT filename FROM _migrations")
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
	defer rows.Close()
	applied := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil {
			applied[name] = true
		}
	}
	return applied
}

func getMigrationFiles() []string {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: reading migrations dir: %v\n", err)
		os.Exit(1)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	return files
}

func applyFile(ctx context.Context, conn *pgx.Conn, path, name string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "    ERROR: %v\n", err)
		return false
	}
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "    ERROR: begin tx: %v\n", err)
		return false
	}
	if _, err := tx.Exec(ctx, string(data)); err != nil {
		_ = tx.Rollback(ctx)
		fmt.Fprintf(os.Stderr, "    ERROR: %v\n", err)
		return false
	}
	if _, err := tx.Exec(ctx, "INSERT INTO _migrations (filename) VALUES ($1)", name); err != nil {
		_ = tx.Rollback(ctx)
		fmt.Fprintf(os.Stderr, "    ERROR: record migration: %v\n", err)
		return false
	}
	if err := tx.Commit(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "    ERROR: commit: %v\n", err)
		return false
	}
	return true
}

func cmdMigrate(ctx context.Context, conn *pgx.Conn) {
	ensureTracking(ctx, conn)
	applied := getApplied(ctx, conn)
	files := getMigrationFiles()

	var pending []string
	for _, f := range files {
		if !applied[f] {
			pending = append(pending, f)
		}
	}

	if len(pending) == 0 {
		fmt.Println("Everything up to date.")
		return
	}

	fmt.Printf("%d pending migration(s):\n\n", len(pending))
	for _, f := range pending {
		fmt.Printf("  → %s ... ", f)
		if applyFile(ctx, conn, filepath.Join(migrationsDir, f), f) {
			fmt.Println("ok")
		} else {
			fmt.Println("FAILED — aborting")
			os.Exit(1)
		}
	}
	fmt.Println("\nDone!")
}

func cmdStatus(ctx context.Context, conn *pgx.Conn) {
	ensureTracking(ctx, conn)
	applied := getApplied(ctx, conn)
	files := getMigrationFiles()

	fmt.Printf("%-50s STATUS\n", "FILE")
	fmt.Println(strings.Repeat("-", 62))
	pending := 0
	for _, f := range files {
		if applied[f] {
			fmt.Printf("  ✓ %-48s applied\n", f)
		} else {
			fmt.Printf("  • %-48s PENDING\n", f)
			pending++
		}
	}
	fmt.Printf("\n%d migrations, %d pending\n", len(files), pending)
}

func cmdReset(ctx context.Context, conn *pgx.Conn) {
	fmt.Println("Dropping all objects in public schema...")
	if _, err := conn.Exec(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
	fmt.Print("Re-running all migrations...\n\n")
	cmdMigrate(ctx, conn)
}

func main() {
	env := flag.String("env", "local", "Target environment: local (default), dev, or main")
	status := flag.Bool("status", false, "Show migration status")
	reset := flag.Bool("reset", false, "Drop schema and re-run all")
	flag.Parse()

	if _, ok := envFiles[*env]; !ok {
		fmt.Fprintf(os.Stderr, "ERROR: unknown --env %q (must be local, dev, or main)\n", *env)
		os.Exit(2)
	}
	if *reset && *env == "main" {
		fmt.Fprintln(os.Stderr, "refusing to --reset with --env=main")
		os.Exit(1)
	}

	dbURL, envFile := loadDatabaseURL(*env)
	fmt.Printf("env: %s  (%s)\n", *env, filepath.Base(envFile))
	if len(dbURL) > 60 {
		fmt.Printf("db:  %s...\n\n", dbURL[:60])
	} else {
		fmt.Printf("db:  %s\n\n", dbURL)
	}

	ctx := context.Background()
	conn := connect(ctx, dbURL)
	defer conn.Close(ctx)

	switch {
	case *status:
		cmdStatus(ctx, conn)
	case *reset:
		cmdReset(ctx, conn)
	default:
		cmdMigrate(ctx, conn)
	}
}
