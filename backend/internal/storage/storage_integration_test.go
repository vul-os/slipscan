//go:build integration

package storage

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

// TestB2RoundTrip exercises Put / PresignGet / Delete against the live
// B2 endpoint. Reads creds from the same env vars the server uses.
//
// Run with:  go test -tags=integration ./internal/storage/...
func TestB2RoundTrip(t *testing.T) {
	cfg := Config{
		KeyID:          os.Getenv("B2_KEY_ID"),
		ApplicationKey: os.Getenv("B2_APPLICATION_KEY"),
		Bucket:         os.Getenv("B2_BUCKET"),
		Region:         os.Getenv("B2_REGION"),
		Endpoint:       os.Getenv("B2_ENDPOINT"),
	}
	if cfg.KeyID == "" || cfg.ApplicationKey == "" || cfg.Bucket == "" || cfg.Endpoint == "" {
		t.Skip("B2_* env vars not set; skipping live B2 test")
	}

	c, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	payload := make([]byte, 4096)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}

	key := fmt.Sprintf("smoketest/%d.bin", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := c.Put(ctx, key, payload, "application/octet-stream"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	t.Logf("PUT ok: %s (%d bytes)", key, len(payload))

	url, err := c.PresignGet(ctx, key, 5*time.Minute)
	if err != nil {
		t.Fatalf("PresignGet: %v", err)
	}
	t.Logf("Presigned URL: %s", url)

	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET presigned: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("presigned GET status %d: %s", resp.StatusCode, string(body))
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if len(got) != len(payload) {
		t.Fatalf("size mismatch: put=%d got=%d", len(payload), len(got))
	}
	for i := range got {
		if got[i] != payload[i] {
			t.Fatalf("byte %d mismatch", i)
		}
	}
	t.Logf("Round-trip bytes match")

	if err := c.Delete(ctx, key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	t.Logf("DELETE ok: %s", key)
}
