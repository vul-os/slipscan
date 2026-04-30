package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/exolutionza/slipscan/backend/internal/config"
)

const usage = `usage: migrate <command> [args]

commands:
  up               Apply all pending migrations
  down [N]         Roll back N migrations (default 1)
  version          Print current schema version
  force <version>  Force the schema to a specific version (use with care)
`

func main() {
	flag.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		flag.Usage()
		os.Exit(2)
	}

	if err := config.LoadDotenv(".env"); err != nil {
		log.Fatalf("dotenv: %v", err)
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	m, err := migrate.New("file://"+cfg.MigrationsDir, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("migrate init: %v", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			log.Printf("source close: %v", srcErr)
		}
		if dbErr != nil {
			log.Printf("db close: %v", dbErr)
		}
	}()

	switch args[0] {
	case "up":
		if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			log.Fatalf("up: %v", err)
		}
	case "down":
		n := 1
		if len(args) > 1 {
			parsed, err := strconv.Atoi(args[1])
			if err != nil || parsed < 1 {
				log.Fatalf("down: N must be a positive integer")
			}
			n = parsed
		}
		if err := m.Steps(-n); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			log.Fatalf("down: %v", err)
		}
	case "version":
		v, dirty, err := m.Version()
		if err != nil {
			if errors.Is(err, migrate.ErrNilVersion) {
				fmt.Println("no migrations applied")
				return
			}
			log.Fatalf("version: %v", err)
		}
		fmt.Printf("version=%d dirty=%t\n", v, dirty)
	case "force":
		if len(args) < 2 {
			log.Fatal("force: version required")
		}
		v, err := strconv.Atoi(args[1])
		if err != nil {
			log.Fatalf("force: invalid version: %v", err)
		}
		if err := m.Force(v); err != nil {
			log.Fatalf("force: %v", err)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}

	v, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return
	}
	fmt.Printf("ok (version=%d dirty=%t)\n", v, dirty)
}
