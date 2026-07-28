//go:build !dmtap

// Package substrate, in this build, carries no dependency on
// github.com/vul-os/kotva/bindings/go at all — that binding, and the real
// Engine that wraps it (substrate.go, mapping.go), only compile with
// `-tags dmtap`. This file exists so that the packages which reference the
// seam unconditionally (main.go, api.Server.Substrate) still type-check and
// link in a plain `go build ./...`: they see the same Engine type and the
// same function/method names, just backed by a stub that can never succeed.
//
// FlowStock's own runtime guard (config.Config.UseSubstrate, which defaults
// to false in this build — see default_builtin.go) means OpenForStore below
// is only ever called if an operator explicitly forces
// FLOWSTOCK_SUBSTRATE_SYNC=1 against a binary that was not built with the
// dmtap tag. That is a configuration error, not a runtime condition to
// degrade gracefully from, so it fails closed with ErrNotBuilt exactly like
// main.go already fails closed on any other substrate.OpenForStore error —
// no change to main.go was needed.
package substrate

import (
	"context"
	"encoding/json"
	"errors"

	"flowstock/backend/internal/store"
)

// ErrNotBuilt is returned by Open and OpenForStore in a binary built without
// the dmtap tag: there is no shared sync engine compiled in to open.
var ErrNotBuilt = errors.New("substrate: this binary was built without dmtap support (rebuild with `-tags dmtap` to enable the shared DMTAP sync engine)")

// Engine stands in for the real substrate engine. Its zero value is never
// handed out — Open and OpenForStore always return nil — so no method below
// is reachable in normal operation; they exist only so the seam's shape
// (main.go, api.Server.Substrate) is identical across both builds.
type Engine struct{}

// Options mirrors the real package's Options for shape parity across builds.
type Options struct {
	NS       string
	CacheDir string
}

// Stats mirrors the real package's counters shape.
type Stats struct {
	Ingested  int `json:"ingested"`
	Minted    int `json:"minted"`
	LegacyOps int `json:"legacy_ops"`
	Refused   int `json:"refused"`
}

// Open always fails: no engine is compiled into this binary.
func Open(ctx context.Context, opt Options) (*Engine, error) { return nil, ErrNotBuilt }

// OpenForStore always fails: no engine is compiled into this binary. main.go
// calls this exactly where it calls the real one, gated by
// cfg.UseSubstrate() — which defaults to false in this build, so the call is
// reached at all only when an operator has explicitly forced the substrate on
// against a binary that cannot honor it.
func OpenForStore(ctx context.Context, st *store.Store, cacheDir string) (*Engine, error) {
	return nil, ErrNotBuilt
}

// Close is never reached: no *Engine is ever constructed.
func (e *Engine) Close(ctx context.Context) error { return nil }

// Mint, Ingest, Resolve and NoteLegacy exist only so *Engine satisfies
// store.Merger in this build too; never reached, since no *Engine is ever
// installed as a store's merger.
func (e *Engine) Mint(op store.Op) (string, error) { return "", ErrNotBuilt }
func (e *Engine) Ingest(op store.Op) error         { return ErrNotBuilt }
func (e *Engine) Resolve(tbl, rowID string) (json.RawMessage, string, bool, bool) {
	return nil, "", false, false
}
func (e *Engine) NoteLegacy() {}

// StateRoot and Stats back api.handleSubstrate, which is compiled
// unconditionally. Never reached: handleSubstrate only calls them when
// s.Substrate != nil, and no non-nil *Engine ever exists in this build.
func (e *Engine) StateRoot() (string, error) { return "", ErrNotBuilt }
func (e *Engine) Stats() Stats               { return Stats{} }

// compile-time proof the stub satisfies the same seam as the real engine.
var _ store.Merger = (*Engine)(nil)
