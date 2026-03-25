package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

func main() {
	env := flag.String("env", "local", "environment: local, dev, main")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		fmt.Println("Usage: go run database/migrate.go [--env local|dev|main] <command>")
		fmt.Println("Commands: up, down, reset, create <name>")
		os.Exit(1)
	}

	command := args[0]

	if command == "create" {
		if len(args) < 2 {
			fmt.Println("Usage: go run database/migrate.go create <name>")
			os.Exit(1)
		}
		createMigration(args[1])
		return
	}

	envFile := envFilePath(*env)
	if err := godotenv.Load(envFile); err != nil {
		fmt.Fprintf(os.Stderr, "Error loading %s: %v\n", envFile, err)
		os.Exit(1)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL not set")
		os.Exit(1)
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		fmt.Fprintf(os.Stderr, "Error pinging database: %v\n", err)
		os.Exit(1)
	}

	ensureMigrationsTable(db)

	switch command {
	case "up":
		runUp(db)
	case "down":
		runDown(db)
	case "reset":
		runReset(db)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", command)
		os.Exit(1)
	}
}

func envFilePath(env string) string {
	switch env {
	case "dev":
		return ".env.dev"
	case "main":
		return ".env.main"
	default:
		return ".env"
	}
}

func ensureMigrationsTable(db *sql.DB) {
	query := `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`
	if _, err := db.Exec(query); err != nil {
		fmt.Fprintf(os.Stderr, "Error creating migrations table: %v\n", err)
		os.Exit(1)
	}
}

func migrationsDir() string {
	return filepath.Join("database", "migrations")
}

func getMigrationFiles() []string {
	pattern := filepath.Join(migrationsDir(), "*.sql")
	files, err := filepath.Glob(pattern)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading migrations: %v\n", err)
		os.Exit(1)
	}
	sort.Strings(files)
	return files
}

func versionFromFile(filename string) string {
	base := filepath.Base(filename)
	return strings.TrimSuffix(base, ".sql")
}

func parseSections(content string) (up string, down string) {
	parts := strings.SplitN(content, "-- down", 2)
	up = strings.TrimSpace(parts[0])
	if len(parts) > 1 {
		down = strings.TrimSpace(parts[1])
	}
	return
}

func appliedVersions(db *sql.DB) map[string]bool {
	rows, err := db.Query("SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error querying migrations: %v\n", err)
		os.Exit(1)
	}
	defer rows.Close()

	applied := make(map[string]bool)
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			fmt.Fprintf(os.Stderr, "Error scanning migration: %v\n", err)
			os.Exit(1)
		}
		applied[v] = true
	}
	return applied
}

func runUp(db *sql.DB) {
	files := getMigrationFiles()
	applied := appliedVersions(db)
	ran := 0

	for _, f := range files {
		version := versionFromFile(f)
		if applied[version] {
			continue
		}
		content, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading %s: %v\n", f, err)
			os.Exit(1)
		}

		upSQL, _ := parseSections(string(content))
		if upSQL == "" {
			fmt.Fprintf(os.Stderr, "Empty up section in %s\n", f)
			os.Exit(1)
		}

		tx, err := db.Begin()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting transaction: %v\n", err)
			os.Exit(1)
		}

		if _, err := tx.Exec(upSQL); err != nil {
			tx.Rollback()
			fmt.Fprintf(os.Stderr, "Error running %s: %v\n", f, err)
			os.Exit(1)
		}

		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			tx.Rollback()
			fmt.Fprintf(os.Stderr, "Error recording migration %s: %v\n", version, err)
			os.Exit(1)
		}

		if err := tx.Commit(); err != nil {
			fmt.Fprintf(os.Stderr, "Error committing %s: %v\n", version, err)
			os.Exit(1)
		}

		fmt.Printf("Applied: %s\n", version)
		ran++
	}

	if ran == 0 {
		fmt.Println("No pending migrations.")
	} else {
		fmt.Printf("Applied %d migration(s).\n", ran)
	}
}

func runDown(db *sql.DB) {
	applied := appliedVersions(db)
	if len(applied) == 0 {
		fmt.Println("No migrations to roll back.")
		return
	}

	var versions []string
	for v := range applied {
		versions = append(versions, v)
	}
	sort.Strings(versions)
	latest := versions[len(versions)-1]

	migrationFile := filepath.Join(migrationsDir(), latest+".sql")
	content, err := os.ReadFile(migrationFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading %s: %v\n", migrationFile, err)
		os.Exit(1)
	}

	_, downSQL := parseSections(string(content))
	if downSQL == "" {
		fmt.Fprintf(os.Stderr, "No down section in %s\n", migrationFile)
		os.Exit(1)
	}

	tx, err := db.Begin()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error starting transaction: %v\n", err)
		os.Exit(1)
	}

	if _, err := tx.Exec(downSQL); err != nil {
		tx.Rollback()
		fmt.Fprintf(os.Stderr, "Error running down for %s: %v\n", migrationFile, err)
		os.Exit(1)
	}

	if _, err := tx.Exec("DELETE FROM schema_migrations WHERE version = $1", latest); err != nil {
		tx.Rollback()
		fmt.Fprintf(os.Stderr, "Error removing migration record %s: %v\n", latest, err)
		os.Exit(1)
	}

	if err := tx.Commit(); err != nil {
		fmt.Fprintf(os.Stderr, "Error committing rollback %s: %v\n", latest, err)
		os.Exit(1)
	}

	fmt.Printf("Rolled back: %s\n", latest)
}

func runReset(db *sql.DB) {
	for {
		applied := appliedVersions(db)
		if len(applied) == 0 {
			break
		}
		runDown(db)
	}
	fmt.Println("All migrations rolled back. Running up...")
	runUp(db)
}

func createMigration(name string) {
	timestamp := time.Now().UTC().Format("20060102150405")
	filename := fmt.Sprintf("%s_%s.sql", timestamp, name)
	path := filepath.Join(migrationsDir(), filename)

	template := `-- up

-- down
`
	if err := os.WriteFile(path, []byte(template), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error creating %s: %v\n", path, err)
		os.Exit(1)
	}

	fmt.Printf("Created: %s\n", path)
}
