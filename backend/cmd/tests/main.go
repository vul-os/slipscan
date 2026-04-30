// cmd/tests is the operational test runner.
//
// Each test lives in internal/testsuite and registers itself with
// testsuite.Register. This binary is the only entry point.
//
//	go run ./cmd/tests                       # run every registered test
//	go run ./cmd/tests insights              # run a single test by name
//	go run ./cmd/tests insights preview-email # run several
//	go run ./cmd/tests --list                # show what's registered
//	go run ./cmd/tests --org=<uuid>          # use an existing org instead of seeding
//	go run ./cmd/tests --no-seed --org=<uuid> # skip seed; required if --org points at real data
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/config"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/testsuite"
)

func main() {
	var (
		listOnly = flag.Bool("list", false, "list registered tests and exit")
		orgArg   = flag.String("org", "", "use this org UUID instead of the seeded one")
		noSeed   = flag.Bool("no-seed", false, "skip the seed step (DB tests then need --org)")
	)
	flag.Parse()

	if *listOnly {
		fmt.Println("registered tests:")
		for _, t := range testsuite.List() {
			tag := ""
			if t.NeedsDB {
				tag = " [needs DB]"
			}
			fmt.Printf("  %-16s%s  %s\n", t.Name, tag, t.Description)
		}
		return
	}

	selected, err := selectTests(flag.Args())
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	env := &testsuite.Env{}

	if anyNeedsDB(selected) {
		if err := config.LoadDotenv(".env"); err != nil {
			log.Fatalf("dotenv: %v", err)
		}
		cfg, err := config.Load()
		if err != nil {
			log.Fatalf("config: %v", err)
		}
		pool, err := db.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("db open: %v", err)
		}
		defer pool.Close()
		env.DB = pool

		switch {
		case *orgArg != "":
			env.OrgID = uuid.MustParse(*orgArg)
			fmt.Printf("using org %s (seed skipped)\n", env.OrgID)
		case *noSeed:
			log.Fatal("--no-seed requires --org=<uuid> for DB-backed tests")
		default:
			id, err := testsuite.Seed(ctx, pool)
			if err != nil {
				log.Fatalf("seed: %v", err)
			}
			env.OrgID = id
			fmt.Printf("seeded org %s\n", env.OrgID)
		}
	}

	var pass, fail int
	start := time.Now()
	for _, t := range selected {
		fmt.Printf("\n=== %s ===\n", t.Name)
		r := testsuite.RunOne(ctx, t, env)
		if r.Err != nil {
			fmt.Printf("FAIL  %s  (%s)  %v\n", t.Name, r.Duration.Round(time.Millisecond), r.Err)
			fail++
			continue
		}
		fmt.Printf("PASS  %s  (%s)\n", t.Name, r.Duration.Round(time.Millisecond))
		pass++
	}
	fmt.Printf("\n%d passed, %d failed in %s\n", pass, fail, time.Since(start).Round(time.Millisecond))
	if fail > 0 {
		os.Exit(1)
	}
}

func selectTests(names []string) ([]testsuite.Test, error) {
	if len(names) == 0 {
		return testsuite.List(), nil
	}
	var out []testsuite.Test
	var unknown []string
	for _, n := range names {
		if t, ok := testsuite.Get(n); ok {
			out = append(out, t)
			continue
		}
		unknown = append(unknown, n)
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("unknown test(s): %s — run with --list to see available", strings.Join(unknown, ", "))
	}
	return out, nil
}

func anyNeedsDB(ts []testsuite.Test) bool {
	for _, t := range ts {
		if t.NeedsDB {
			return true
		}
	}
	return false
}
