// Package testsuite holds the operational tests we run by hand against a
// real Neon DB. These are not `go test` unit tests — they exercise full
// code paths (insights SQL builder, email template rendering, …) and
// often need a populated database. Each test registers itself in init();
// cmd/tests is the runner.
package testsuite

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
)

// Env is what every test receives. DB and OrgID are zero for tests that
// don't need them; check the Test.NeedsDB flag to know which is which.
type Env struct {
	DB    *sql.DB
	OrgID uuid.UUID
}

type Test struct {
	Name        string
	Description string
	NeedsDB     bool
	Run         func(ctx context.Context, env *Env) error
}

var registry = map[string]Test{}

func Register(t Test) {
	if _, dup := registry[t.Name]; dup {
		panic("testsuite: duplicate test " + t.Name)
	}
	registry[t.Name] = t
}

func List() []Test {
	out := make([]Test, 0, len(registry))
	for _, t := range registry {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func Get(name string) (Test, bool) {
	t, ok := registry[name]
	return t, ok
}

type Result struct {
	Name     string
	Err      error
	Duration time.Duration
}

func RunOne(ctx context.Context, t Test, env *Env) Result {
	start := time.Now()
	if t.NeedsDB && env.DB == nil {
		return Result{Name: t.Name, Err: fmt.Errorf("test %q needs DB but none provided", t.Name), Duration: time.Since(start)}
	}
	err := t.Run(ctx, env)
	return Result{Name: t.Name, Err: err, Duration: time.Since(start)}
}
