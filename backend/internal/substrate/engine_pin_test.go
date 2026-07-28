package substrate_test

// The engine's provenance, asserted in BOTH build configurations.
//
// This file has no build tag on purpose. The conformance gate next door needs
// the engine and so is behind `-tags dmtap`; these checks are about what go.mod
// and go.sum say, which is true of a plain build too — and a plain build is
// where a re-vendored copy or a local `replace` would most easily slip back in
// unnoticed, because nothing in it imports the binding at all.
//
// It is the successor to vendor_drift_test.go's TestVendoredTreeMatchesManifest:
// the guard that runs everywhere, needs nothing but this repo, and fires in the
// normal case. What it guards changed with the dependency. There is no vendored
// tree to hash any more — go.sum pins the module's content at a strength a
// hand-maintained SHA256SUMS.txt never had, and the toolchain enforces it on
// every build rather than only when a test is run. What is left that a tool does
// NOT enforce is the shape of the dependency: that it is still a fetched,
// version-pinned module rather than a path, and that the vendored tree stayed
// deleted.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// enginePin is the module version this repo builds against. It is written down
// twice by design — here and in go.mod — because a test that reads the version
// out of go.mod and then asserts go.mod contains it proves nothing at all.
// Bumping the engine is therefore a two-line, deliberate edit, and the second
// line is in a file a reviewer is looking at.
const (
	engineModule  = "github.com/vul-os/kotva/bindings/go"
	engineVersion = "v0.2.0"
)

// vendoredDir is the tree this module replaced. Named so the assertion below
// says what it is looking for rather than testing a bare path.
const vendoredDir = "third_party/dmtapsync"

func repoRoot(t *testing.T) string {
	t.Helper()
	// This package sits at backend/internal/substrate.
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolving the repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("no go.mod at the presumed repo root %s: %v", root, err)
	}
	return root
}

// TestEngineIsAPinnedModuleNotAVendoredCopy asserts the four properties that
// together mean "the engine is fetched and pinned":
//
//  1. go.mod requires the module at the recorded version;
//  2. nothing redirects it with a replace — a `replace` to a sibling checkout
//     builds on one laptop and fails everywhere else, which is the worst of the
//     available failure modes and the reason the copy was vendored originally;
//  3. go.sum carries BOTH hashes for that exact version, so `go build` refuses
//     to proceed on substituted content;
//  4. the vendored tree is gone, so there is no second copy to drift.
//
// Each check reports through a counter, and the count is asserted at the end: a
// run that fell out early — an unreadable go.sum, a parse that matched nothing —
// fails rather than passing on the checks it did manage.
func TestEngineIsAPinnedModuleNotAVendoredCopy(t *testing.T) {
	root := repoRoot(t)
	checked := 0

	gomod, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	gosum, err := os.ReadFile(filepath.Join(root, "go.sum"))
	if err != nil {
		t.Fatalf("read go.sum: %v", err)
	}

	// 1. required, at the pinned version.
	requireRe := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(engineModule) + `\s+(\S+)`)
	m := requireRe.FindSubmatch(gomod)
	switch {
	case m == nil:
		t.Errorf("go.mod does not require %s at all", engineModule)
	case string(m[1]) != engineVersion:
		t.Errorf("go.mod requires %s %s, but this test pins %s — if the bump is intended, "+
			"change engineVersion here too and re-run the conformance gate against the new engine",
			engineModule, m[1], engineVersion)
	}
	checked++

	// 2. not redirected. Any replace at all whose left-hand side is the engine
	// module, whether to a path or to another module — and in either syntax: the
	// single-line `replace X => Y` form and the `replace ( X => Y )` block form,
	// whose inner lines carry no `replace` keyword of their own.
	mod := regexp.QuoteMeta(engineModule)
	replaceRe := regexp.MustCompile(`(?m)^\s*(?:replace\s+)?` + mod + `\s+(?:\S+\s+)?=>`)
	if loc := replaceRe.Find(gomod); loc != nil {
		t.Errorf("go.mod redirects %s with %q. The engine must be fetched and pinned: a replace "+
			"to a local path builds on the machine that has that path and nowhere else.",
			engineModule, strings.TrimSpace(string(loc)))
	}
	checked++

	// 3. both go.sum lines, for this exact version.
	for _, suffix := range []string{" h1:", "/go.mod h1:"} {
		want := engineModule + " " + engineVersion + suffix
		if !strings.Contains(string(gosum), want) {
			t.Errorf("go.sum has no %q line for %s %s — the module's content is not pinned, "+
				"and `go mod tidy` would silently accept different bytes",
				strings.TrimSuffix(strings.TrimPrefix(suffix, " "), " h1:"), engineModule, engineVersion)
		}
		checked++
	}

	// 4. the vendored tree stayed deleted.
	if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(vendoredDir))); err == nil {
		t.Errorf("%s exists again (%v). Two copies of the engine is the state this repo left: "+
			"whichever one go.mod is not pointing at is dead weight that drifts unobserved.",
			vendoredDir, info.Mode())
	} else if !os.IsNotExist(err) {
		t.Errorf("cannot tell whether %s exists: %v", vendoredDir, err)
	}
	checked++

	const wantChecked = 5
	if checked != wantChecked {
		t.Fatalf("ran %d of %d provenance checks — this gate did not cover what it claims to",
			checked, wantChecked)
	}
}

// TestNothingStillReadsTheVendoredPath is the grep, as a test.
//
// Deleting a directory and leaving a reference to it behind is how a build
// breaks for the next person rather than for the person who deleted it. The
// vendored module's import path and its directory are both dead names now, and
// a source file, a workflow or a doc that still mentions one is either stale
// prose or a broken reference.
//
// It walks the repo rather than shelling out to grep so it runs identically in
// CI and on a laptop, and it asserts a floor on the number of files it looked at
// — a walk that silently matched nothing because it started in the wrong
// directory would otherwise pass.
func TestNothingStillReadsTheVendoredPath(t *testing.T) {
	root := repoRoot(t)

	// The dead names. The old module path cannot resolve any more; the old
	// package name is not what the binding is called; the vendored directory
	// does not exist.
	dead := []string{
		"github.com/vul-os/envoir/bindings/go",
		"third_party/dmtapsync",
		"dmtapsync.",
	}

	// Directories with no bearing on the build: dependencies, build output,
	// version control, test artifacts. CHANGELOG.md is excluded by name because
	// it is a historical record — it SHOULD still say the vendored copy once
	// existed, and rewriting history to satisfy a grep would be the wrong fix.
	skipDirs := map[string]bool{
		".git": true, "node_modules": true, "dist": true, "test-results": true,
		"playwright-report": true,
	}
	skipFiles := map[string]bool{
		"CHANGELOG.md": true,
		// This file names the dead strings in order to look for them.
		"engine_pin_test.go": true,
	}
	// Only text the build or the docs actually read.
	exts := map[string]bool{
		".go": true, ".mod": true, ".sum": true, ".md": true, ".yml": true, ".yaml": true,
		".json": true, ".sh": true, ".mjs": true, ".js": true, ".jsx": true,
	}

	scanned := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if skipFiles[d.Name()] || !exts[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		// package-lock.json is 250 KB of dependency hashes and mentions none of
		// these names; skipping it keeps this test fast without weakening it.
		if d.Name() == "package-lock.json" {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		rel, _ := filepath.Rel(root, path)
		for _, name := range dead {
			if strings.Contains(string(body), name) {
				t.Errorf("%s still refers to %q, which no longer exists", rel, name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the repo: %v", err)
	}

	// A floor, not decoration: this repo has well over a hundred files of these
	// kinds, so a walk that scanned a handful started somewhere wrong and its
	// clean result means nothing.
	const minScanned = 100
	if scanned < minScanned {
		t.Fatalf("scanned only %d files under %s, expected at least %d — the walk did not cover "+
			"the repo, so finding no stale references proves nothing", scanned, root, minScanned)
	}
	t.Logf("scanned %d files under %s for %d dead names", scanned, root, len(dead))
}
