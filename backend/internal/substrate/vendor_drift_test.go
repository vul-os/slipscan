package substrate_test

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The vendored engine is checked twice, and the split matters.
//
// Upstream's own embed.go records that checking a .wasm into git has already
// cost a real bug: a committed module went stale against a fix in src/abi.rs,
// and every response whose Rust-side String capacity outran its length aborted
// the allocator. Nothing in git ties a binary blob to the source that produced
// it — so drift is invisible until it bites. FlowStock re-accepts that risk for
// the reason VENDOR.md gives, and buys guards with it.
//
//  1. TestVendoredTreeMatchesManifest runs everywhere, including CI, and needs
//     nothing but this repo. It is the guard that fires in the normal case: a
//     hand-edit of a vendored file, a half-finished refresh that updated the
//     .go files but not the .wasm, a corrupted checkout, a new file dropped in
//     unrecorded.
//
//  2. TestVendoredMatchesPinnedUpstream needs a sibling envoir checkout and
//     compares against the exact commit VENDOR.md pins — not that checkout's
//     working tree. Comparing against the working tree is what this file used
//     to do, and it is wrong twice over: it fails while someone has upstream
//     open in an editor, and it fails whenever upstream's HEAD moves ahead of
//     the pin, which is not drift but the whole point of pinning.
//
// Neither guard defends against someone editing a vendored file and the
// manifest in one commit; that is a code-review problem, not a test problem.
// What they rule out is the silent kind — bytes that stopped being the bytes
// this repo says they are, with nobody having decided that.

// vendoredFiles maps each vendored file to its path in the upstream repo.
// bindings/go is the module; LICENSE is the upstream repo's root MIT licence,
// copied in beside it so the vendored tree carries its own terms.
var vendoredFiles = map[string]string{
	"api.go":              "bindings/go/api.go",
	"dmtap_sync_abi.wasm": "bindings/go/dmtap_sync_abi.wasm",
	"embed.go":            "bindings/go/embed.go",
	"errors.go":           "bindings/go/errors.go",
	"go.mod":              "bindings/go/go.mod",
	"go.sum":              "bindings/go/go.sum",
	"runtime.go":          "bindings/go/runtime.go",
	"signer.go":           "bindings/go/signer.go",
	"types.go":            "bindings/go/types.go",
	"LICENSE":             "LICENSE-MIT",
}

// notVendored are FlowStock's own files in the vendored directory: its
// provenance record and the manifest itself. Everything else in there has to be
// accounted for.
var notVendored = map[string]bool{
	"VENDOR.md":      true,
	"SHA256SUMS.txt": true,
}

func vendorDir() string {
	return filepath.Join("..", "..", "..", "third_party", "dmtapsync")
}

// TestVendoredTreeMatchesManifest asserts the vendored tree is exactly what
// third_party/dmtapsync/SHA256SUMS.txt says it is: every recorded file present
// and hashing to the recorded digest, and no unrecorded file alongside them.
//
// It fails closed. A missing or empty manifest is a failure, not a skip —
// "there is nothing to check against" is the state this guard exists to make
// impossible.
func TestVendoredTreeMatchesManifest(t *testing.T) {
	dir := vendorDir()
	manifestPath := filepath.Join(dir, "SHA256SUMS.txt")

	manifest, err := readManifest(manifestPath)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate it from inside %s with `shasum -a 256 <files> > SHA256SUMS.txt`)",
			manifestPath, err, dir)
	}
	if len(manifest) == 0 {
		t.Fatalf("%s records no files; the vendored layout has changed", manifestPath)
	}

	for _, name := range sortedKeys(manifest) {
		want := manifest[name]
		got, err := sha256File(filepath.Join(dir, name))
		if err != nil {
			t.Errorf("%s is recorded in SHA256SUMS.txt but unreadable: %v", name, err)
			continue
		}
		if got != want {
			t.Errorf("%s does not match SHA256SUMS.txt\n  recorded %s\n  on disk  %s\n"+
				"  either the file was edited in place (don't — see VENDOR.md) or a refresh "+
				"left the manifest behind", name, want, got)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read vendored dir: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || notVendored[name] {
			continue
		}
		if _, recorded := manifest[name]; !recorded {
			t.Errorf("%s is in the vendored tree but not in SHA256SUMS.txt; record it or remove it", name)
		}
		if _, known := vendoredFiles[name]; !known {
			t.Errorf("%s has no upstream path in vendoredFiles; the vendored layout has changed "+
				"and the drift check no longer covers it", name)
		}
	}
}

// TestVendoredMatchesPinnedUpstream compares the vendored tree against the
// upstream commit VENDOR.md pins, read out of git so the comparison is
// deterministic regardless of what state the sibling checkout is left in.
//
// It skips only when there is no sibling checkout to read, which is a genuine
// "nothing here to compare against" — and the manifest guard above has already
// run by then.
func TestVendoredMatchesPinnedUpstream(t *testing.T) {
	upstream := findUpstream()
	if upstream == "" {
		t.Skip("no sibling envoir checkout; set FLOWSTOCK_ENVOIR_DIR to compare against the pinned commit")
	}
	commit := pinnedCommit(t)

	// A pinned commit the sibling checkout does not have is not drift — it is a
	// checkout that has not fetched. Say which, rather than report a mismatch.
	if err := exec.Command("git", "-C", upstream, "cat-file", "-e", commit+"^{commit}").Run(); err != nil {
		t.Skipf("the envoir checkout at %s does not have the pinned commit %s; fetch it to enable this check",
			upstream, commit)
	}

	for _, name := range sortedKeys(vendoredFiles) {
		upPath := vendoredFiles[name]
		want, err := exec.Command("git", "-C", upstream, "show", commit+":"+upPath).Output()
		if err != nil {
			t.Errorf("upstream %s at %s: %v", upPath, commit[:7], err)
			continue
		}
		got, err := os.ReadFile(filepath.Join(vendorDir(), name))
		if err != nil {
			t.Errorf("read vendored %s: %v", name, err)
			continue
		}
		if sha256.Sum256(want) != sha256.Sum256(got) {
			t.Errorf("%s has drifted from upstream %s at %s\n  upstream %s\n  vendored %s\n"+
				"  refresh it and update third_party/dmtapsync/VENDOR.md and SHA256SUMS.txt",
				name, upPath, commit[:7], sum(want), sum(got))
		}
	}
}

// pinnedCommit reads the commit VENDOR.md records, so the pin is written down
// once and the test cannot quietly disagree with the prose.
func pinnedCommit(t *testing.T) string {
	t.Helper()
	path := filepath.Join(vendorDir(), "VENDOR.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "| Commit") {
			continue
		}
		// The row reads: | Commit | `<sha>` (date) |. Take the first
		// backtick-delimited run that looks like a full commit id.
		for _, field := range strings.Split(line, "`") {
			f := strings.TrimSpace(field)
			if len(f) == 40 && isHex(f) {
				return f
			}
		}
	}
	t.Fatalf("%s records no 40-character commit in its `Commit` row", path)
	return ""
}

func findUpstream() string {
	if dir := os.Getenv("FLOWSTOCK_ENVOIR_DIR"); dir != "" {
		return dir
	}
	// The conventional side-by-side layout: .../vulos/flowstock and .../vulos/envoir.
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	guess := filepath.Join(wd, "..", "..", "..", "..", "envoir")
	if _, err := os.Stat(filepath.Join(guess, "bindings", "go", "api.go")); err == nil {
		return guess
	}
	return ""
}

// readManifest parses the sha256sum/shasum format: "<digest>  <name>", with an
// optional '*' marking binary mode on the name.
func readManifest(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		digest, name, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		name = strings.TrimPrefix(strings.TrimSpace(name), "*")
		if len(digest) != 64 || !isHex(digest) || name == "" {
			continue
		}
		out[name] = digest
	}
	return out, sc.Err()
}

func sha256File(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return sum(b), nil
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
