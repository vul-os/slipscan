//go:build dmtap

package substrate_test

import (
	"context"
	"crypto/ed25519"
	"os"
	"testing"

	kotvasync "github.com/vul-os/kotva/bindings/go"

	"flowstock/backend/internal/substrate"
)

// The engine's cost, measured rather than assumed. FlowStock syncs on a timer
// inside a long-lived process, so compilation is paid once at startup and
// amortized — but a restart is a real event on a shop-counter PC, which is why
// the cached number matters and why main.go passes a cache dir.
//
//	go test -bench Open -benchtime 3x ./backend/internal/substrate/

func benchOpen(b *testing.B, cache string) {
	b.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		b.Fatal(err)
	}
	signer := kotvasync.InMemorySigner{PrivateKey: priv}
	b.ReportAllocs()
	for b.Loop() {
		eng, err := substrate.Open(context.Background(), substrate.Options{
			Signer: signer, NS: "bench", CacheDir: cache,
		})
		if err != nil {
			b.Fatal(err)
		}
		eng.Close(context.Background())
	}
}

// BenchmarkOpenCold compiles the engine from scratch every time: what a node
// pays on first start, or after the cache is cleared.
func BenchmarkOpenCold(b *testing.B) { benchOpen(b, "") }

// BenchmarkOpenCached is what every subsequent restart pays.
func BenchmarkOpenCached(b *testing.B) {
	dir, err := os.MkdirTemp("", "flowstock-bench-cache")
	if err != nil {
		b.Fatal(err)
	}
	defer os.RemoveAll(dir)
	// Warm it, so the measured runs are all hits.
	_, priv, _ := ed25519.GenerateKey(nil)
	eng, err := substrate.Open(context.Background(), substrate.Options{
		Signer: kotvasync.InMemorySigner{PrivateKey: priv}, NS: "bench", CacheDir: dir,
	})
	if err != nil {
		b.Fatal(err)
	}
	eng.Close(context.Background())
	benchOpen(b, dir)
}

// TestEngineArtifactSize records the embedded artifact's size in the test output
// so the number in the adoption notes can be checked rather than trusted.
func TestEngineArtifactSize(t *testing.T) {
	if kotvasync.EngineWasmSize == 0 {
		t.Fatal("the engine artifact is empty")
	}
	t.Logf("embedded engine artifact: %d bytes (%.0f KiB)",
		kotvasync.EngineWasmSize, float64(kotvasync.EngineWasmSize)/1024)
}
