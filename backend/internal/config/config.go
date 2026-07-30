// Package config loads FlowStock's runtime configuration. A config file is
// optional — with none present, sensible defaults apply (loopback, port 8787,
// data in ~/.flowstock) so `flowstock` just runs.
package config

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

type Config struct {
	// Port is the HTTP listen port. Default 8787.
	Port string `json:"port"`
	// Host is the interface to bind. Default "127.0.0.1" (loopback only).
	// Set "0.0.0.0" to accept connections from other machines/branches.
	Host string `json:"host,omitempty"`
	// DataDir holds flowstock.db. Default ~/.flowstock.
	DataDir string `json:"data_dir,omitempty"`
	// Password, if set, gates the app behind a single owner password.
	// Empty (default) = open (suitable for a trusted single-user machine).
	Password string `json:"password,omitempty"`
	// FrameAncestors controls which origins may embed FlowStock in an iframe
	// (for the Vulos OS shell). Empty (default) = 'self' only.
	FrameAncestors string `json:"frame_ancestors,omitempty"`
	// SyncSecretFallback, when true, lets an already-enrolled sync peer keep
	// authenticating with the shared secret alone instead of a request
	// signature. Default false = mutual key auth is required once a peer has
	// enrolled a key (the mesh fails closed). This is a compatibility escape
	// hatch for mixed-version fleets.
	SyncSecretFallback bool `json:"sync_secret_fallback,omitempty"`
	// SubstrateSync selects the merge authority: the shared DMTAP sync engine
	// (substrate/SYNC.md), or FlowStock's own hand-rolled CRDT.
	//
	// Unset (nil) defers to the binary's own build-time default — see
	// defaultUseSubstrate (default_dmtap.go / default_builtin.go). A binary
	// built with `-tags dmtap` defaults to the substrate, because carrying the
	// suite's audited, vector-verified algebra beats carrying a second private
	// one. A plain build carries no substrate binding at all and defaults to
	// the built-in engine. Either way, set this explicitly to override: false
	// pins a node to the built-in engine (the escape hatch if the substrate
	// ever misbehaves in the field, and the only valid value on a plain
	// build); true forces the substrate on and is fatal at startup on a binary
	// that was not built with dmtap support.
	//
	// It is a deployment-wide switch, not a per-node preference. The two
	// engines are each convergent but do not share a total order — FlowStock
	// breaks an HLC tie on node id, the substrate on the author's public key —
	// so a mesh running both can pick different winners for the same pair of
	// concurrent writes. Every node in a workspace must agree; sync.SyncPeer
	// refuses a round across a mismatch rather than let that diverge silently.
	SubstrateSync *bool `json:"substrate_sync,omitempty"`
	// SubstrateAcceptUnsignedOps, when true, lets a substrate node merge a
	// remote op that carries no signed envelope. Default false = fail closed:
	// with the substrate as merge authority every replicated change is verified
	// on its own signature rather than trusted for having arrived over an
	// authenticated connection (substrate/SOVEREIGNTY.md R-SOV-3.2).
	//
	// The only reason to turn it on is a fleet mid-migration off the built-in
	// engine, whose peers still hold pre-switch ops with no envelope. It is a
	// temporary state, not a deployment mode, and it MUST NOT be on for a node
	// bound to a public address.
	SubstrateAcceptUnsignedOps bool `json:"substrate_accept_unsigned_ops,omitempty"`
}

const configName = "flowstock.config.json"

// Load resolves configuration from (in order) the file, environment overrides,
// and defaults.
func Load() *Config {
	cfg := &Config{}

	if data, found := readConfigFile(); data != nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			log.Fatalf("parse %s: %v", found, err)
		}
		log.Printf("loaded config from %s", found)
	}

	// Environment overrides.
	if v := os.Getenv("FLOWSTOCK_PORT"); v != "" {
		cfg.Port = v
	}
	if v := os.Getenv("FLOWSTOCK_HOST"); v != "" {
		cfg.Host = v
	}
	if v := os.Getenv("FLOWSTOCK_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("FLOWSTOCK_PASSWORD"); v != "" {
		cfg.Password = v
	}
	if v := os.Getenv("FLOWSTOCK_FRAME_ANCESTORS"); v != "" {
		cfg.FrameAncestors = v
	}
	if v := os.Getenv("FLOWSTOCK_SYNC_SECRET_FALLBACK"); v == "1" || v == "true" {
		cfg.SyncSecretFallback = true
	}
	// Accepts both directions, because this one now has a non-false default and
	// an operator needs a way to say "no" from the environment alone.
	switch os.Getenv("FLOWSTOCK_SUBSTRATE_SYNC") {
	case "1", "true":
		on := true
		cfg.SubstrateSync = &on
	case "0", "false":
		off := false
		cfg.SubstrateSync = &off
	}
	if v := os.Getenv("FLOWSTOCK_SUBSTRATE_ACCEPT_UNSIGNED_OPS"); v == "1" || v == "true" {
		cfg.SubstrateAcceptUnsignedOps = true
	}

	// Defaults.
	if cfg.Port == "" {
		cfg.Port = "8787"
	}
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.DataDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cfg.DataDir = filepath.Join(home, ".flowstock")
		} else {
			cfg.DataDir = ".flowstock"
		}
	}
	if abs, err := filepath.Abs(cfg.DataDir); err == nil {
		cfg.DataDir = abs
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("create data dir %s: %v", cfg.DataDir, err)
	}
	return cfg
}

// DBPath is the path to the SQLite database file.
func (c *Config) DBPath() string { return filepath.Join(c.DataDir, "flowstock.db") }

// Addr is the host:port listen address.
func (c *Config) Addr() string { return fmt.Sprintf("%s:%s", c.Host, c.Port) }

// UseSubstrate reports whether the shared DMTAP sync engine is the merge
// authority. Unset defers to the build's own default — see the SubstrateSync
// field and defaultUseSubstrate.
func (c *Config) UseSubstrate() bool {
	if c.SubstrateSync != nil {
		return *c.SubstrateSync
	}
	return defaultUseSubstrate
}

func readConfigFile() ([]byte, string) {
	// 1. Walk up from cwd.
	if cwd, err := os.Getwd(); err == nil {
		dir := cwd
		for {
			p := filepath.Join(dir, configName)
			if d, err := os.ReadFile(p); err == nil {
				return d, p
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	// 2. ~/.config/flowstock/ and ~/.flowstock/
	if home, err := os.UserHomeDir(); err == nil {
		for _, p := range []string{
			filepath.Join(home, ".config", "flowstock", configName),
			filepath.Join(home, ".flowstock", configName),
		} {
			if d, err := os.ReadFile(p); err == nil {
				return d, p
			}
		}
	}
	// 3. Next to the executable.
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), configName)
		if d, err := os.ReadFile(p); err == nil {
			return d, p
		}
	}
	return nil, ""
}
