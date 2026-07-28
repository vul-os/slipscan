//go:build dmtap

package substrate_test

// The engine gate, after the vendored copy went away.
//
// # What this replaces, and why it is not the same test
//
// FlowStock used to vendor the Go binding wholesale into a third_party/ tree,
// because the binding's old home was never a fetchable module. Two tests
// guarded that copy: one hashed the tree against a manifest, one diffed it
// against a pinned upstream commit. Both answered exactly one
// question — "are these the bytes we wrote down?" — and both are now
// unanswerable and unnecessary: there is no copy, and go.sum answers that
// question for the module at a cryptographic strength a hand-kept SHA256SUMS.txt
// never had. `go build` will not proceed past a hash mismatch, so the byte-level
// guard is now enforced by the toolchain on every single build rather than by a
// test someone has to run.
//
// Deleting the guard and stopping there would have been the wrong trade. go.sum
// proves the module is the module; it proves nothing about whether the module's
// ENGINE still computes the algebra FlowStock's merge semantics depend on. The
// artifact inside v0.2.0 is not the artifact that was vendored — it is a fresh
// build from the kotva repo, 427,731 bytes against the vendored copy's 426,890 —
// so "the bytes are pinned" is a statement about a .wasm nobody in this repo had
// ever executed. That is precisely the gap this file closes.
//
// # What it asserts
//
// The frozen SYNC conformance vectors (substrate/SYNC.md §10, frozen in the
// kotva repo at conformance/vectors/sync_vectors.json) driven through the engine
// FlowStock actually links, and compared byte-for-byte against the values the
// spec froze. Encodings, merge verdicts, tie-breaks, death domination, PN-counter
// union semantics, observable-state roots and the §12 refusal codes.
//
// It never skips. Every input and every expectation is a literal in `spec`
// below, copied out of sync_vectors.json, so this file needs no checkout, no
// network and no environment variable — it needs only the module go.mod already
// requires. A second test (TestFrozenVectorsMatchTheSpecFile) re-derives every
// one of those literals from the real vectors file when a kotva checkout is
// present, so the copy cannot silently drift from the spec; THAT one may skip,
// loudly, naming how many values went unverified.
//
// A failure here means the engine's algebra moved. It is never "the harness
// needs adjusting": there is one implementation of these rules and one frozen
// set of answers, and FlowStock's stock ledger and catalog merge on top of them.

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	kotvasync "github.com/vul-os/kotva/bindings/go"
)

// receiverNowMS is the vectors' fixed receiver clock, and vectorWallMS the wall
// component every op in them carries. Their HLC wall is a 2023-11-14 timestamp,
// so the suite is driven at a frozen "now" 800s after the ops rather than at a
// real clock. These are the same two constants the engine's own harness uses.
const (
	receiverNowMS = 1_700_000_900_000
	vectorWallMS  = 1_700_000_100_000
)

// --- the frozen spec values ---------------------------------------------------------------------

// frozenValue is one scalar copied out of conformance/vectors/sync_vectors.json:
// which vector it belongs to, its slash path inside that vector's JSON object,
// and the value. Inputs and expectations alike — an input silently changing is
// as much a broken proof as an expectation silently changing.
type frozenValue struct {
	vector string
	path   string
	value  string
}

// spec is every byte this file froze out of the suite. Tests below read ONLY
// through specValue(), which fails on an unknown key, so no value can be used
// here without also being covered by TestFrozenVectorsMatchTheSpecFile.
var spec = []frozenValue{
	// --- sync_op_lww_canonical (sync_op_encode)
	{"sync_op_lww_canonical", "input/kind", "3"},
	{"sync_op_lww_canonical", "input/target", "a"},
	{"sync_op_lww_canonical", "input/field", "x"},
	{"sync_op_lww_canonical", "input/value_tstr", "v"},
	{"sync_op_lww_canonical", "input/hlc/wall", "1700000100000"},
	{"sync_op_lww_canonical", "input/hlc/counter", "0"},
	{"sync_op_lww_canonical", "input/hlc/author_hex", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_op_lww_canonical", "expected/cbor_hex", "a60103026003616104617805617606a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	// --- sync_op_cose_sign1_bind (sync_op_cose_sign1_verify)
	{"sync_op_cose_sign1_bind", "input/sync_op_cbor_hex", "a60103026003616104617805617606a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_op_cose_sign1_bind", "input/signer_seed_hex", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
	{"sync_op_cose_sign1_bind", "input/signer_pubkey_hex", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_op_cose_sign1_bind", "input/cose_sign1_hex", "845826a20127045820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeba0583fa60103026003616104617805617606a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb584054d80d8c792de1595d7f2686efb26b5e8e8a572760091070254aa8009e36b380eb14cfbe28dfbd9b68b77727333f32bdb497fee6d692177a6927232f0fa3180a"},
	{"sync_op_cose_sign1_bind", "input/tampered_payload_cose_sign1_hex", "845826a20127045820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeba0583fa60103026003616104617805617606a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aea584054d80d8c792de1595d7f2686efb26b5e8e8a572760091070254aa8009e36b380eb14cfbe28dfbd9b68b77727333f32bdb497fee6d692177a6927232f0fa3180a"},
	{"sync_op_cose_sign1_bind", "input/substituted_kid_cose_sign1_hex", "845826a2012704582068460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc144a0583fa60103026003616104617805617606a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb584054d80d8c792de1595d7f2686efb26b5e8e8a572760091070254aa8009e36b380eb14cfbe28dfbd9b68b77727333f32bdb497fee6d692177a6927232f0fa3180a"},
	{"sync_op_cose_sign1_bind", "expected/op_id_hex", "1e0fbb168d0841e8a865e8eb2270ee6b70b4eaeb1500816e32519bbbfa4393b145"},
	{"sync_op_cose_sign1_bind", "expected/verifies", "true"},
	{"sync_op_cose_sign1_bind", "expected/tampered_payload/error_code", "0x0A02"},
	{"sync_op_cose_sign1_bind", "expected/substituted_kid/error_code", "0x0A02"},
	// --- sync_author_unauthorized (sync_author_admission)
	{"sync_author_unauthorized", "input/op_hlc_author_hex", "814722de71c5b14e748dff322ae7f7c415cee558766495292cd6c4c0a6a9df28"},
	{"sync_author_unauthorized", "input/admitted_authors_hex/0", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_author_unauthorized", "input/admitted_authors_hex/1", "68460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc144"},
	{"sync_author_unauthorized", "expected/error_code", "0x0A01"},
	{"sync_author_unauthorized", "expected/error_name", "ERR_SYNC_AUTHOR_UNAUTHORIZED"},
	// --- sync_lww_hlc_winner (sync_lww_merge)
	{"sync_lww_hlc_winner", "input/ops_cbor_hex/0", "a6010302600364646f633104657469746c6505616d06a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_lww_hlc_winner", "input/ops_cbor_hex/1", "a6010302600364646f633104657469746c6505616e06a3011b0000018bcfe6eea00201035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_lww_hlc_winner", "expected/winner_value", "n"},
	{"sync_lww_hlc_winner", "expected/winner_hlc_hex", "a3011b0000018bcfe6eea00201035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_lww_hlc_winner", "expected/apply_order_independent", "true"},
	// --- sync_lww_exact_tie (sync_lww_merge)
	{"sync_lww_exact_tie", "input/ops_cbor_hex/0", "a6010302600364646f633104657469746c6505616d06a3011b0000018bcfe6eea00205035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_lww_exact_tie", "input/ops_cbor_hex/1", "a6010302600364646f633104657469746c6505616e06a3011b0000018bcfe6eea00205035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_lww_exact_tie", "expected/winner_value", "n"},
	// --- sync_orset_add_wins (sync_orset_merge)
	{"sync_orset_add_wins", "input/element", "e1"},
	{"sync_orset_add_wins", "input/ops_cbor_hex/0", "a5010102600364746167730562653106a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_orset_add_wins", "input/ops_cbor_hex/1", "a6010202600364746167730562653106a3011b0000018bcfe6eea0020103582068460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc1440781a2015820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb02a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_orset_add_wins", "input/ops_cbor_hex/2", "a5010102600364746167730562653106a3011b0000018bcfe6eea00202035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_orset_add_wins", "expected/present", "true"},
	{"sync_orset_add_wins", "expected/surviving_add_tag_hlc_hex", "a3011b0000018bcfe6eea00202035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	// --- sync_orset_future_add_remove_rejected (sync_orset_remove_validity)
	{"sync_orset_future_add_remove_rejected", "input/op_cbor_hex", "a6010202600364746167730562653206a3011b0000018bcfe6eea0020103582068460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc1440781a2015820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb02a3011b0000018bcfe6eea0020a035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_orset_future_add_remove_rejected", "expected/error_code", "0x0A03"},
	{"sync_orset_future_add_remove_rejected", "expected/error_name", "ERR_SYNC_OP_INVALID"},
	// --- sync_death_domination (sync_death_domination)
	{"sync_death_domination", "input/death_op_cbor_hex", "a501040260036472656331046672656461637406a3011b0000018bcfe6eea00201035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_death_domination", "input/concurrent_add_op_cbor_hex", "a501010260036472656331056c726563312d7061796c6f616406a3011b0000018bcfe6eea0020503582068460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc144"},
	{"sync_death_domination", "expected/present", "false"},
	// --- sync_death_tie_failsafe (sync_death_tie)
	{"sync_death_tie_failsafe", "input/death_op_cbor_hex", "a501040260036472656332046672656461637406a3011b0000018bcfe6eea00207035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_death_tie_failsafe", "input/live_op_cbor_hex", "a50104026003647265633204646c69766506a3011b0000018bcfe6eea00207035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_death_tie_failsafe", "expected/winner", "Deleted"},
	{"sync_death_tie_failsafe", "expected/class", "redact"},
	// --- sync_pn_counter_convergence (sync_pn_merge)
	{"sync_pn_counter_convergence", "input/ops_cbor_hex/0", "a601050260036673746f636b310463717479050506a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_pn_counter_convergence", "input/ops_cbor_hex/1", "a601050260036673746f636b310463717479052106a3011b0000018bcfe6eea0020003582068460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc144"},
	{"sync_pn_counter_convergence", "input/ops_cbor_hex/2", "a601050260036673746f636b310463717479050506a3011b0000018bcfe6eea00200035820ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_pn_counter_convergence", "input/op_ids_hex/0", "1ea2245a7695ab52c8add0c78d1a0c460a1675d99d382c42b101dd31576c287c70"},
	{"sync_pn_counter_convergence", "input/op_ids_hex/1", "1e0992ac8741d89dd2c979074a27ea91156a79e3bdf1e54d10d25b6b1283899414"},
	{"sync_pn_counter_convergence", "input/op_ids_hex/2", "1ea2245a7695ab52c8add0c78d1a0c460a1675d99d382c42b101dd31576c287c70"},
	{"sync_pn_counter_convergence", "expected/total", "3"},
	{"sync_pn_counter_convergence", "expected/distinct_op_ids", "2"},
	{"sync_pn_counter_convergence", "expected/replay_is_noop", "true"},
	// --- sync_pn_counter_foreign_reject (sync_counter_foreign_check)
	{"sync_pn_counter_foreign_reject", "input/op_hlc_author_hex", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_pn_counter_foreign_reject", "input/target_entry_author_hex", "68460ebef3b138164ec7fd8610e95800df7598f70f2f2ea7db5172ac74ebc144"},
	{"sync_pn_counter_foreign_reject", "expected/error_code", "0x0A06"},
	// --- sync_snapshot_root_determinism (sync_snapshot_state_root)
	{"sync_snapshot_root_determinism", "input/empty_state_sections", "6"},
	{"sync_snapshot_root_determinism", "expected/observable_state_cbor_hex", "8681826474616773626531818364646f6331657469746c65616e81836673746f636b31637174790381826472656331667265646163748182656c696e6531836561746f6d30615961588283614161426131836142606162"},
	{"sync_snapshot_root_determinism", "expected/root_hex", "1e63918ccc89f4d158e4dda9b09510876d87205348efd6093713379b598559119a"},
	{"sync_snapshot_root_determinism", "expected/empty_state_cbor_hex", "86808080808080"},
	{"sync_snapshot_root_determinism", "expected/empty_state_root_hex", "1e1610e4e4daff4ab509238e06cd1674e22045cade2d8e079acb167834548826b6"},
	// --- sync_ns_cross_namespace_ref_rejected (sync_ns_leak_check)
	{"sync_ns_cross_namespace_ref_rejected", "input/op_ns", "x"},
	{"sync_ns_cross_namespace_ref_rejected", "input/ref_target_actual_ns", "y"},
	{"sync_ns_cross_namespace_ref_rejected", "expected/error_code", "0x0A0A"},
	{"sync_ns_cross_namespace_ref_rejected", "expected/error_name", "ERR_SYNC_NS_LEAK"},
	// --- sync_gc_stability_cut (sync_gc_stability_cut)
	{"sync_gc_stability_cut", "input/live_replica_watermarks/0/max_applied_hlc/wall", "1700000100000"},
	{"sync_gc_stability_cut", "input/live_replica_watermarks/0/max_applied_hlc/counter", "10"},
	{"sync_gc_stability_cut", "input/live_replica_watermarks/0/max_applied_hlc/author_hex", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_gc_stability_cut", "input/live_replica_watermarks/1/max_applied_hlc/wall", "1700000100000"},
	{"sync_gc_stability_cut", "input/live_replica_watermarks/1/max_applied_hlc/counter", "15"},
	{"sync_gc_stability_cut", "input/live_replica_watermarks/1/max_applied_hlc/author_hex", "ca57eed30e4a7274ef4c648f56f58f880b20d2ca25725d9e5c13c83c08c09aeb"},
	{"sync_gc_stability_cut", "expected/stability_cut_counter", "10"},
	{"sync_gc_stability_cut", "expected/stale_replica_excluded", "true"},
}

// wantFrozenValues and wantDrivenVectors are floors, not decoration. An equality
// of "vectors driven == vectors listed" holds at 0 == 0, which is exactly how a
// gate ends up passing by doing nothing; these say what "nothing" would look
// like. Fourteen of the suite's 24 vectors are driven here — the ten that are
// not (RGA ordering, movable-tree cycles, fast-join, reconciliation, sparse
// namespace scoping) exercise algebra FlowStock's mapping never reaches.
const (
	wantFrozenValues  = 76
	wantDrivenVectors = 14
)

// specIndex is spec, keyed, built once and checked for duplicates on the way —
// two rows for one key would let a later edit silently shadow an earlier value.
var specIndex = func() map[string]string {
	m := make(map[string]string, len(spec))
	for _, f := range spec {
		k := f.vector + "|" + f.path
		if _, dup := m[k]; dup {
			panic("duplicate frozen value for " + k)
		}
		m[k] = f.value
	}
	return m
}()

// specValue reads a frozen value, failing on an unknown key so that nothing in
// this file can quietly use a constant the cross-check does not cover.
func specValue(t *testing.T, vector, path string) string {
	t.Helper()
	v, ok := specIndex[vector+"|"+path]
	if !ok {
		t.Fatalf("%s: no frozen value at %q — add it to spec (and bump wantFrozenValues) "+
			"rather than inlining it, or it escapes TestFrozenVectorsMatchTheSpecFile",
			vector, path)
	}
	return v
}

// specBytes is specValue for a hex-encoded frozen value.
func specBytes(t *testing.T, vector, path string) []byte {
	t.Helper()
	b, err := hex.DecodeString(specValue(t, vector, path))
	if err != nil {
		t.Fatalf("%s %s: frozen value is not hex: %v", vector, path, err)
	}
	return b
}

// --- harness -------------------------------------------------------------------------------------

// driven records which vectors a run actually exercised, so the coverage
// assertion at the end counts work done rather than intentions declared.
type harness struct {
	in     *kotvasync.Instance
	driven map[string]bool
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := t.Context()
	rt, err := kotvasync.New(ctx)
	if err != nil {
		t.Fatalf("compiling the engine: %v", err)
	}
	in, err := rt.Instance(ctx)
	if err != nil {
		rt.Close(ctx)
		t.Fatalf("instantiating the engine: %v", err)
	}
	t.Cleanup(func() { in.Close(ctx); rt.Close(ctx) })
	return &harness{in: in, driven: map[string]bool{}}
}

// engineWith returns a fresh replica with the given ops applied in the given
// order. Ambient-authenticated ingest is the vectors' path: they are raw op
// bytes, not envelopes, and their signatures are the subject of exactly one
// vector (sync_op_cose_sign1_bind) which drives the signed path explicitly.
func (h *harness) engineWith(t *testing.T, opHexes ...string) *kotvasync.Engine {
	t.Helper()
	eng, err := h.in.NewEngine()
	if err != nil {
		t.Fatalf("creating a replica: %v", err)
	}
	t.Cleanup(func() { eng.Close() })
	for i, oh := range opHexes {
		raw, err := hex.DecodeString(oh)
		if err != nil {
			t.Fatalf("op %d is not hex: %v", i, err)
		}
		if _, err := eng.IngestAmbientAuthenticated(raw, receiverNowMS); err != nil {
			t.Fatalf("ingesting op %d: %v", i, err)
		}
	}
	return eng
}

// targetOf reads an op's target out of the op itself rather than restating it
// here, so a retargeted vector cannot pass against the object this file expected.
func (h *harness) targetOf(t *testing.T, opHex string) (target, field string) {
	t.Helper()
	raw, err := hex.DecodeString(opHex)
	if err != nil {
		t.Fatalf("op is not hex: %v", err)
	}
	op, err := h.in.DecodeOp(raw)
	if err != nil {
		t.Fatalf("decoding op: %v", err)
	}
	if op.Field != nil {
		field = *op.Field
	}
	return op.Target, field
}

// tstr reads a tagged text value's contents, failing on any other tag: §2.2's
// whole point is that a text string and a byte string are not interchangeable,
// so unwrapping one as the other here would launder exactly the bug the tagging
// exists to catch.
func tstr(t *testing.T, v json.RawMessage) string {
	t.Helper()
	var tagged struct {
		Tstr *string `json:"tstr"`
	}
	if err := json.Unmarshal(v, &tagged); err != nil {
		t.Fatalf("value %s is not a tagged value: %v", v, err)
	}
	if tagged.Tstr == nil {
		t.Fatalf("value %s is not a tagged TEXT value", v)
	}
	return *tagged.Tstr
}

func eq(t *testing.T, what, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s\n  got  %s\n  want %s", what, got, want)
	}
}

func refusal(t *testing.T, what string, err error, code string) {
	t.Helper()
	if err == nil {
		t.Errorf("%s: accepted, want refusal %s — this is a fail-open", what, code)
		return
	}
	se, ok := kotvasync.AsSyncError(err)
	if !ok {
		t.Errorf("%s: refused with %v, which is not a substrate refusal at all", what, err)
		return
	}
	if se.Code != code {
		t.Errorf("%s: refused %s (%s), want %s", what, se.Code, se.Name, code)
	}
}

// --- the gate ------------------------------------------------------------------------------------

// TestTheSkewCheckGuardsTheFutureAndNotThePast pins the §3 asymmetry the whole
// suite below — and FlowStock's own startup path — depends on.
//
// The vectors are ingested 800s after their own wall clock, far outside the
// engine's skew bound, and that is deliberate: an op from the PAST is a replay,
// which every node does at startup, and refusing it would mean a node could
// never reload its own oplog. substrate.go's wallOf() relies on exactly this.
// An op from the FUTURE is the one that has to be refused, because accepting it
// lets a peer with a wrong clock park a write nothing can ever outrank.
//
// If the bound ever became symmetric, all fourteen vectors below would start
// refusing 0x0A05 and the suite would read as "the algebra changed". This says
// which it is, in one line, before that happens.
func TestTheSkewCheckGuardsTheFutureAndNotThePast(t *testing.T) {
	h := newHarness(t)
	v, err := h.in.Version()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("engine %s, substrate %s, suite %d, skew bound %d ms; vectors driven %d ms after "+
		"their own wall clock", v.Engine, v.Substrate, v.Suite, v.HLCSkewMS,
		uint64(receiverNowMS-vectorWallMS))

	op := specBytes(t, "sync_op_lww_canonical", "expected/cbor_hex")

	// Far in the past, well beyond the bound: accepted.
	if err := h.in.ValidateOp(op, receiverNowMS); err != nil {
		t.Fatalf("an op %d ms OLDER than the receiver's clock was refused (%v), but the skew "+
			"bound is only %d ms — replaying a stored oplog at startup would now fail",
			receiverNowMS-vectorWallMS, err, v.HLCSkewMS)
	}

	// One millisecond beyond the bound into the future: refused, with the §12 code.
	future := uint64(vectorWallMS) - v.HLCSkewMS - 1
	refusal(t, "an op from beyond the skew bound", h.in.ValidateOp(op, future), "0x0A05")

	// Just inside it: accepted. Without this the check above would also pass
	// against an engine that refused everything.
	if err := h.in.ValidateOp(op, uint64(vectorWallMS)-v.HLCSkewMS+1); err != nil {
		t.Errorf("an op just INSIDE the %d ms skew bound was refused: %v", v.HLCSkewMS, err)
	}
}

// TestEngineDrivesTheFrozenConformanceVectors is the gate. It never skips.
func TestEngineDrivesTheFrozenConformanceVectors(t *testing.T) {
	h := newHarness(t)

	h.opEncoding(t)
	h.coseEnvelope(t)
	h.authorAdmission(t)
	h.lwwWinner(t)
	h.lwwExactTie(t)
	h.orSetAddWins(t)
	h.orSetFutureRemoveRefused(t)
	h.deathDomination(t)
	h.deathTie(t)
	h.pnCounterUnion(t)
	h.pnCounterForeignEntry(t)
	h.observableStateRoot(t)
	h.namespaceLeak(t)
	h.stabilityCut(t)

	names := make([]string, 0, len(h.driven))
	for n := range h.driven {
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) != wantDrivenVectors {
		t.Fatalf("drove %d conformance vectors, expected %d: %s\n"+
			"A vector that stops being driven must be removed deliberately, not by a subtest "+
			"quietly returning early — that is how a gate ends up asserting nothing.",
			len(names), wantDrivenVectors, strings.Join(names, ", "))
	}
	t.Logf("drove %d/%d frozen SYNC conformance vectors through the linked engine: %s",
		len(names), wantDrivenVectors, strings.Join(names, ", "))
}

// SYNC-OP-01 — deterministic CBOR: one op, one canonical encoding.
func (h *harness) opEncoding(t *testing.T) {
	const v = "sync_op_lww_canonical"
	defer func() { h.driven[v] = true }()

	kinds, err := h.in.OpKinds()
	if err != nil {
		t.Fatal(err)
	}
	// The vector states the kind numerically; the engine names it. Holding the
	// two together is what stops a renumbered §4.2 kind from passing silently.
	eq(t, v+": lww_set kind", strconv.Itoa(int(kinds.LWWSet)), specValue(t, v, "input/kind"))

	field := specValue(t, v, "input/field")
	wall, err := strconv.ParseUint(specValue(t, v, "input/hlc/wall"), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	counter, err := strconv.ParseUint(specValue(t, v, "input/hlc/counter"), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.in.EncodeOp(kotvasync.Op{
		Kind:   kinds.LWWSet,
		NS:     "",
		Target: specValue(t, v, "input/target"),
		Field:  &field,
		Value:  kotvasync.Text(specValue(t, v, "input/value_tstr")),
		HLC: kotvasync.HLC{
			Wall:    wall,
			Counter: uint32(counter),
			Author:  specValue(t, v, "input/hlc/author_hex"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": canonical op bytes", hex.EncodeToString(got), specValue(t, v, "expected/cbor_hex"))
}

// SYNC-OP-02 — the COSE_Sign1 envelope, and the two ways of forging one.
func (h *harness) coseEnvelope(t *testing.T) {
	const v = "sync_op_cose_sign1_bind"
	defer func() { h.driven[v] = true }()

	op := specBytes(t, v, "input/sync_op_cbor_hex")

	id, err := h.in.OpID(op)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": op id", hex.EncodeToString(id), specValue(t, v, "expected/op_id_hex"))

	// Ed25519 is deterministic (RFC 8032), so signing the frozen op with the
	// frozen seed must reproduce the frozen envelope byte for byte. That covers
	// the domain-separation tag and the whole Sig_structure without this file
	// having to restate either.
	seed := specBytes(t, v, "input/signer_seed_hex")
	priv := ed25519.NewKeyFromSeed(seed)
	eq(t, v+": derived public key",
		hex.EncodeToString(priv.Public().(ed25519.PublicKey)),
		specValue(t, v, "input/signer_pubkey_hex"))

	cose, err := h.in.SignOp(op, kotvasync.InMemorySigner{PrivateKey: priv})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": COSE_Sign1 envelope", hex.EncodeToString(cose), specValue(t, v, "input/cose_sign1_hex"))

	back, err := h.in.VerifySignedOp(specBytes(t, v, "input/cose_sign1_hex"))
	if err != nil {
		t.Errorf("%s: the frozen envelope did not verify (%v), but the vector says verifies=%s",
			v, err, specValue(t, v, "expected/verifies"))
	} else {
		eq(t, v+": verified payload", hex.EncodeToString(back), specValue(t, v, "input/sync_op_cbor_hex"))
	}

	_, err = h.in.VerifySignedOp(specBytes(t, v, "input/tampered_payload_cose_sign1_hex"))
	refusal(t, v+": tampered payload", err, specValue(t, v, "expected/tampered_payload/error_code"))

	_, err = h.in.VerifySignedOp(specBytes(t, v, "input/substituted_kid_cose_sign1_hex"))
	refusal(t, v+": substituted kid", err, specValue(t, v, "expected/substituted_kid/error_code"))
}

// SYNC-AUTH-01 — an op from an author nobody admitted.
func (h *harness) authorAdmission(t *testing.T) {
	const v = "sync_author_unauthorized"
	defer func() { h.driven[v] = true }()

	admitted := []string{
		specValue(t, v, "input/admitted_authors_hex/0"),
		specValue(t, v, "input/admitted_authors_hex/1"),
	}
	err := h.in.CheckAdmitted(specBytes(t, v, "input/op_hlc_author_hex"), admitted)
	refusal(t, v+": unadmitted author", err, specValue(t, v, "expected/error_code"))
	if se, ok := kotvasync.AsSyncError(err); ok {
		eq(t, v+": refusal name", se.Name, specValue(t, v, "expected/error_name"))
	}

	// The vector's premise, executed: an ADMITTED author must be accepted, or
	// "rejects the unadmitted one" would also be true of a check that rejects
	// everything.
	if err := h.in.CheckAdmitted(specBytes(t, v, "input/admitted_authors_hex/0"), admitted); err != nil {
		t.Errorf("%s: an admitted author was refused: %v", v, err)
	}
}

// SYNC-LWW-01 — the higher HLC wins, whatever order the writes arrive in.
func (h *harness) lwwWinner(t *testing.T) {
	const v = "sync_lww_hlc_winner"
	defer func() { h.driven[v] = true }()

	a := specValue(t, v, "input/ops_cbor_hex/0")
	b := specValue(t, v, "input/ops_cbor_hex/1")
	target, field := h.targetOf(t, a)

	for _, order := range [][2]string{{a, b}, {b, a}} {
		cell, err := h.engineWith(t, order[0], order[1]).LWWCell(target, field)
		if err != nil {
			t.Fatal(err)
		}
		if cell == nil {
			t.Fatalf("%s: no winning cell for %s.%s", v, target, field)
		}
		eq(t, v+": winning value", tstr(t, cell.Value), specValue(t, v, "expected/winner_value"))
		gotHLC, err := h.in.EncodeHLC(cell.HLC)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v+": winning hlc", hex.EncodeToString(gotHLC), specValue(t, v, "expected/winner_hlc_hex"))
	}
}

// SYNC-LWW-02 — an exact HLC tie is broken by the larger canonical value bytes.
func (h *harness) lwwExactTie(t *testing.T) {
	const v = "sync_lww_exact_tie"
	defer func() { h.driven[v] = true }()

	a := specValue(t, v, "input/ops_cbor_hex/0")
	b := specValue(t, v, "input/ops_cbor_hex/1")
	target, field := h.targetOf(t, a)

	for _, order := range [][2]string{{a, b}, {b, a}} {
		cell, err := h.engineWith(t, order[0], order[1]).LWWCell(target, field)
		if err != nil {
			t.Fatal(err)
		}
		if cell == nil {
			t.Fatalf("%s: no winning cell for %s.%s", v, target, field)
		}
		eq(t, v+": tie winner", tstr(t, cell.Value), specValue(t, v, "expected/winner_value"))
	}
}

// SYNC-ORSET-01 — add-wins, and the surviving tag is the evidence.
func (h *harness) orSetAddWins(t *testing.T) {
	const v = "sync_orset_add_wins"
	defer func() { h.driven[v] = true }()

	ops := []string{
		specValue(t, v, "input/ops_cbor_hex/0"),
		specValue(t, v, "input/ops_cbor_hex/1"),
		specValue(t, v, "input/ops_cbor_hex/2"),
	}
	target, _ := h.targetOf(t, ops[0])
	element := kotvasync.Text(specValue(t, v, "input/element"))

	eng := h.engineWith(t, ops...)
	present, err := eng.SetContains(target, element)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": element present", strconv.FormatBool(present), specValue(t, v, "expected/present"))

	tags, err := eng.SetSurvivingTags(target, element)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 1 {
		t.Fatalf("%s: %d surviving add-tags, want exactly 1 — the observed-remove tombstoned "+
			"the wrong set of them", v, len(tags))
	}
	gotHLC, err := h.in.EncodeHLC(tags[0].HLC)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": surviving add-tag", hex.EncodeToString(gotHLC),
		specValue(t, v, "expected/surviving_add_tag_hlc_hex"))
}

// SYNC-ORSET-02 — a remove citing an add that has not happened is causally
// impossible, and must be refused by the validator AND by ingest.
func (h *harness) orSetFutureRemoveRefused(t *testing.T) {
	const v = "sync_orset_future_add_remove_rejected"
	defer func() { h.driven[v] = true }()

	op := specBytes(t, v, "input/op_cbor_hex")

	err := h.in.ValidateOp(op, receiverNowMS)
	refusal(t, v+": validator", err, specValue(t, v, "expected/error_code"))
	if se, ok := kotvasync.AsSyncError(err); ok {
		eq(t, v+": refusal name", se.Name, specValue(t, v, "expected/error_name"))
	}

	eng, err := h.in.NewEngine()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { eng.Close() })
	_, ingestErr := eng.IngestAmbientAuthenticated(op, receiverNowMS)
	refusal(t, v+": ingest", ingestErr, specValue(t, v, "expected/error_code"))
}

// SYNC-DEATH-01 — a death certificate dominates a concurrent add with a
// numerically GREATER HLC. This is the one FlowStock's soft deletes ride on.
func (h *harness) deathDomination(t *testing.T) {
	const v = "sync_death_domination"
	defer func() { h.driven[v] = true }()

	death := specValue(t, v, "input/death_op_cbor_hex")
	add := specValue(t, v, "input/concurrent_add_op_cbor_hex")
	target, _ := h.targetOf(t, death)

	addRaw, err := hex.DecodeString(add)
	if err != nil {
		t.Fatal(err)
	}
	addOp, err := h.in.DecodeOp(addRaw)
	if err != nil {
		t.Fatal(err)
	}

	// The vector's premise: the add really does outrank the death in the HLC
	// order, so "not present" is domination and not merely a lower timestamp.
	deathRaw, err := hex.DecodeString(death)
	if err != nil {
		t.Fatal(err)
	}
	deathOp, err := h.in.DecodeOp(deathRaw)
	if err != nil {
		t.Fatal(err)
	}
	cmp, err := h.in.CompareHLC(addOp.HLC, deathOp.HLC)
	if err != nil {
		t.Fatal(err)
	}
	if cmp <= 0 {
		t.Fatalf("%s: the vector's concurrent add no longer outranks the death certificate; "+
			"this stopped being a test of domination", v)
	}

	for _, order := range [][2]string{{death, add}, {add, death}} {
		present, err := h.engineWith(t, order[0], order[1]).SetContains(target, addOp.Value)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v+": element present", strconv.FormatBool(present), specValue(t, v, "expected/present"))
	}
}

// SYNC-DEATH-02 — at an EXACT tie, Deleted beats Live. Fail-safe, both orders.
func (h *harness) deathTie(t *testing.T) {
	const v = "sync_death_tie_failsafe"
	defer func() { h.driven[v] = true }()

	dead := specValue(t, v, "input/death_op_cbor_hex")
	live := specValue(t, v, "input/live_op_cbor_hex")
	object, _ := h.targetOf(t, dead)

	wantDeleted := specValue(t, v, "expected/winner") == "Deleted"
	for _, order := range [][2]string{{dead, live}, {live, dead}} {
		st, err := h.engineWith(t, order[0], order[1]).DeathState(object)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v+": tie winner", strconv.FormatBool(st.Deleted), strconv.FormatBool(wantDeleted))
		if st.Class == nil {
			t.Errorf("%s: no deletion class on a dominated object", v)
			continue
		}
		eq(t, v+": deletion class", *st.Class, specValue(t, v, "expected/class"))
	}
}

// SYNC-PN-01 — the §4.6 correction C-01: per-author UNION of op-id-keyed
// deltas, not a per-author max. FlowStock's stock-on-hand is a sum of movements,
// so a merge that collapses two of one author's deltas to the larger one is a
// wrong number on a shop counter, not an abstract divergence.
func (h *harness) pnCounterUnion(t *testing.T) {
	const v = "sync_pn_counter_convergence"
	defer func() { h.driven[v] = true }()

	ops := []string{
		specValue(t, v, "input/ops_cbor_hex/0"),
		specValue(t, v, "input/ops_cbor_hex/1"),
		specValue(t, v, "input/ops_cbor_hex/2"),
	}
	target, field := h.targetOf(t, ops[0])

	// The op-ids the vector froze, recomputed: ops 0 and 2 are byte-identical,
	// so the third op is a TRUE replay and dedup, not addition, is what makes
	// the total right.
	distinct := map[string]bool{}
	for i, oh := range ops {
		raw, err := hex.DecodeString(oh)
		if err != nil {
			t.Fatal(err)
		}
		id, err := h.in.OpID(raw)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, fmt.Sprintf("%s: op %d id", v, i), hex.EncodeToString(id),
			specValue(t, v, fmt.Sprintf("input/op_ids_hex/%d", i)))
		distinct[hex.EncodeToString(id)] = true
	}
	eq(t, v+": distinct op ids", strconv.Itoa(len(distinct)), specValue(t, v, "expected/distinct_op_ids"))

	total, err := h.engineWith(t, ops...).CounterTotal(target, field)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": counter total", total, specValue(t, v, "expected/total"))

	// The associativity subcase the vector spells out: {0} ⊔ {1,2} must equal
	// the full replay. A per-author max join passes the line above and fails here.
	left := h.engineWith(t, ops[0])
	right := h.engineWith(t, ops[1], ops[2])
	if err := left.Merge(right); err != nil {
		t.Fatal(err)
	}
	merged, err := left.CounterTotal(target, field)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": partial-merge total", merged, specValue(t, v, "expected/total"))
}

// SYNC-PN-02 — an author may not mutate another author's counter entry.
func (h *harness) pnCounterForeignEntry(t *testing.T) {
	const v = "sync_pn_counter_foreign_reject"
	defer func() { h.driven[v] = true }()

	own := specBytes(t, v, "input/op_hlc_author_hex")
	foreign := specBytes(t, v, "input/target_entry_author_hex")

	refusal(t, v+": foreign entry", h.in.CheckCounterEntry(own, foreign),
		specValue(t, v, "expected/error_code"))
	if err := h.in.CheckCounterEntry(own, own); err != nil {
		t.Errorf("%s: an author was refused its OWN entry: %v", v, err)
	}
}

// SYNC-SNAP-01 — the §6.1.1 observable-state root. Two replicas that have
// converged agree on this 33-byte address, which is the check FlowStock's own
// convergence test compares rather than rendered rows.
func (h *harness) observableStateRoot(t *testing.T) {
	const v = "sync_snapshot_root_determinism"
	defer func() { h.driven[v] = true }()

	body := specBytes(t, v, "expected/observable_state_cbor_hex")
	root, err := h.in.ObservableStateRoot(body)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": state root", hex.EncodeToString(root), specValue(t, v, "expected/root_hex"))

	// A decode/encode round trip must not move a byte: the body IS the identity.
	decoded, err := h.in.DecodeObservableState(body)
	if err != nil {
		t.Fatal(err)
	}
	reencoded, err := h.in.EncodeObservableState(decoded)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": round-tripped state body", hex.EncodeToString(reencoded),
		specValue(t, v, "expected/observable_state_cbor_hex"))

	sections, err := strconv.Atoi(specValue(t, v, "input/empty_state_sections"))
	if err != nil {
		t.Fatal(err)
	}
	empty, err := h.in.EncodeObservableStateJSON(
		`{"orset":[],"lww":[],"pn":[],"death":[],"rga":[],"tree":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": empty state body", hex.EncodeToString(empty),
		specValue(t, v, "expected/empty_state_cbor_hex"))
	if got := len(empty) - 1; got != sections {
		t.Errorf("%s: the empty state encodes %d sections, the vector freezes %d", v, got, sections)
	}
	emptyRoot, err := h.in.ObservableStateRoot(empty)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v+": empty state root", hex.EncodeToString(emptyRoot),
		specValue(t, v, "expected/empty_state_root_hex"))
	if hex.EncodeToString(emptyRoot) == hex.EncodeToString(root) {
		t.Errorf("%s: an empty state and a populated one hash to the same root", v)
	}
}

// SYNC-NS-02 — a cross-namespace reference is refused. FlowStock uses the
// workspace org id as the namespace, so this is the algebra-level half of the
// guarantee that two workspaces cannot merge.
func (h *harness) namespaceLeak(t *testing.T) {
	const v = "sync_ns_cross_namespace_ref_rejected"
	defer func() { h.driven[v] = true }()

	opNS := specValue(t, v, "input/op_ns")
	otherNS := specValue(t, v, "input/ref_target_actual_ns")

	err := h.in.CheckNsRef(opNS, otherNS)
	refusal(t, v+": cross-namespace reference", err, specValue(t, v, "expected/error_code"))
	if se, ok := kotvasync.AsSyncError(err); ok {
		eq(t, v+": refusal name", se.Name, specValue(t, v, "expected/error_name"))
	}
	// Same-namespace references must still be allowed, or this check would be
	// "refuse everything" wearing a registry code.
	if err := h.in.CheckNsRef(opNS, opNS); err != nil {
		t.Errorf("%s: a SAME-namespace reference was refused: %v", v, err)
	}
}

// SYNC-GC-01 — the stability cut is the minimum over live watermarks, and it
// fails closed when any live replica's watermark is unknown.
func (h *harness) stabilityCut(t *testing.T) {
	const v = "sync_gc_stability_cut"
	defer func() { h.driven[v] = true }()

	mark := func(i int) *kotvasync.HLC {
		base := fmt.Sprintf("input/live_replica_watermarks/%d/max_applied_hlc/", i)
		wall, err := strconv.ParseUint(specValue(t, v, base+"wall"), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		counter, err := strconv.ParseUint(specValue(t, v, base+"counter"), 10, 32)
		if err != nil {
			t.Fatal(err)
		}
		return &kotvasync.HLC{Wall: wall, Counter: uint32(counter), Author: specValue(t, v, base+"author_hex")}
	}
	r1, r2 := mark(0), mark(1)

	cut, err := h.in.StabilityCut([]*kotvasync.HLC{r1, r2})
	if err != nil {
		t.Fatal(err)
	}
	if cut == nil {
		t.Fatalf("%s: no cut from two known watermarks", v)
	}
	eq(t, v+": stability cut counter", strconv.FormatUint(uint64(cut.Counter), 10),
		specValue(t, v, "expected/stability_cut_counter"))

	// The fail-closed half: an unknown watermark must never be read as
	// "caught up". Truncating history on incomplete knowledge loses ops.
	unknown, err := h.in.StabilityCut([]*kotvasync.HLC{r1, r2, nil})
	if err != nil {
		t.Fatal(err)
	}
	if unknown != nil {
		t.Errorf("%s: a cut of %+v was computed with a replica's watermark unknown — "+
			"GC on incomplete knowledge is how a truncation loses an op", v, *unknown)
	}
}

// --- the frozen values against the spec they were copied from ------------------------------------

// requireSpecEnv, when set to "1", turns the skip below into a failure. CI sets
// it and checks the kotva substrate repo out beside this one, so there the
// comparison either happens or the job goes red.
//
// It is opt-in rather than always-on because a developer laptop legitimately has
// no kotva checkout — and unlike the vendored-tree check this replaces, the gate
// above still asserts the ENGINE's full behaviour without it. What is unverified
// in a skip is narrow and nameable: whether the literals in this file are still
// the spec's literals.
const requireSpecEnv = "FLOWSTOCK_REQUIRE_SPEC_VECTOR_CHECK"

// kotvaDirEnv points at a kotva checkout. Empty falls back to the conventional
// side-by-side layout.
const kotvaDirEnv = "FLOWSTOCK_KOTVA_DIR"

// TestFrozenVectorsMatchTheSpecFile re-derives every literal in `spec` from
// conformance/vectors/sync_vectors.json, so this file's copy of the frozen
// values cannot drift from the frozen values themselves.
//
// This is the one place a skip is possible, and it prints what it gave up on and
// how many values that was. It never reports success for a comparison it did not
// make, and it fails — never skips — on a mismatch, a missing vector, or a
// missing path.
func TestFrozenVectorsMatchTheSpecFile(t *testing.T) {
	// Cheap invariant, checked here because this is the test that owns `spec`:
	// the table must not have been gutted. An empty table would make every
	// comparison below vacuously succeed.
	if len(spec) != wantFrozenValues {
		t.Fatalf("spec holds %d frozen values, expected %d — update wantFrozenValues deliberately "+
			"when adding or removing one", len(spec), wantFrozenValues)
	}

	path := specFilePath()
	if path == "" {
		skipOrFail(t, fmt.Sprintf("no kotva checkout found (set %s, or place one at ../kotva)", kotvaDirEnv))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		skipOrFail(t, fmt.Sprintf("the vectors file at %s is unreadable: %v", path, err))
	}

	var file struct {
		Vectors []map[string]any `json:"vectors"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&file); err != nil {
		t.Fatalf("%s is not the expected vectors document: %v", path, err)
	}
	byName := map[string]map[string]any{}
	for _, v := range file.Vectors {
		if n, ok := v["name"].(string); ok {
			byName[n] = v
		}
	}
	if len(byName) == 0 {
		t.Fatalf("%s names no vectors at all", path)
	}

	// compared counts values this run actually resolved in the file AND diffed.
	// Asserted against the table at the end, so a run that covered only part of
	// it — a renamed vector, a moved path — fails rather than passing on partial
	// work.
	compared := 0
	for _, f := range spec {
		vec, ok := byName[f.vector]
		if !ok {
			t.Errorf("%s: the suite no longer has a vector by this name", f.vector)
			continue
		}
		got, err := walkJSON(vec, f.path)
		if err != nil {
			t.Errorf("%s %s: %v", f.vector, f.path, err)
			continue
		}
		if got != f.value {
			t.Errorf("%s %s has drifted from %s\n  spec file %s\n  this file %s\n"+
				"  update the literal here (and re-run the gate) rather than the other way round",
				f.vector, f.path, path, got, f.value)
		}
		compared++
	}

	if compared != len(spec) {
		t.Errorf("compared %d of %d frozen values against %s — the cross-check did not cover the "+
			"whole table", compared, len(spec), path)
	}
	if compared < wantFrozenValues {
		t.Fatalf("only %d frozen value(s) were checked against the spec, and the table holds %d; "+
			"this check has been narrowed to near-nothing", compared, wantFrozenValues)
	}
	t.Logf("re-derived %d/%d frozen values across %d vectors from %s",
		compared, len(spec), wantDrivenVectors, path)
}

// notVerified is the exact sentence a skip has to print: what was not checked,
// and how many values went unchecked. A skip that does not say what it gave up
// on reads like a pass in a log.
func notVerified(reason string) string {
	return fmt.Sprintf(
		"NOT VERIFIED: %s. The %d frozen values in this file were NOT re-derived from "+
			"conformance/vectors/sync_vectors.json, so a literal here that no longer matches the "+
			"spec would go unnoticed. The engine gate "+
			"(TestEngineDrivesTheFrozenConformanceVectors) still ran in full against all %d "+
			"vectors. Set %s=1 to make this a failure instead of a skip.",
		reason, len(spec), wantDrivenVectors, requireSpecEnv)
}

func skipOrFail(t *testing.T, reason string) {
	t.Helper()
	msg := notVerified(reason)
	if os.Getenv(requireSpecEnv) == "1" {
		t.Fatalf("%s is set, so this is a failure: %s", requireSpecEnv, msg)
	}
	t.Skip(msg)
}

// specFilePath resolves the frozen vectors in a kotva checkout, or "" if there
// is none to read.
func specFilePath() string {
	const rel = "conformance/vectors/sync_vectors.json"
	if dir := os.Getenv(kotvaDirEnv); dir != "" {
		return filepath.Join(dir, filepath.FromSlash(rel))
	}
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	// Tests run in backend/internal/substrate; the conventional side-by-side
	// layout is .../vulos/flowstock and .../vulos/kotva.
	guess := filepath.Join(wd, "..", "..", "..", "..", "kotva", filepath.FromSlash(rel))
	if _, err := os.Stat(guess); err == nil {
		return guess
	}
	return ""
}

// walkJSON resolves a slash path inside a decoded vector and renders the scalar
// it lands on the same way `spec` spells one: numbers by their JSON literal,
// booleans as true/false, strings as themselves. Anything else is an error
// rather than a silently stringified structure.
func walkJSON(root any, path string) (string, error) {
	cur := root
	for _, seg := range strings.Split(path, "/") {
		switch node := cur.(type) {
		case map[string]any:
			v, ok := node[seg]
			if !ok {
				return "", fmt.Errorf("no key %q at this level", seg)
			}
			cur = v
		case []any:
			i, err := strconv.Atoi(seg)
			if err != nil {
				return "", fmt.Errorf("%q is not an index into an array", seg)
			}
			if i < 0 || i >= len(node) {
				return "", fmt.Errorf("index %d is out of range (%d elements)", i, len(node))
			}
			cur = node[i]
		default:
			return "", fmt.Errorf("cannot descend into %T at %q", cur, seg)
		}
	}
	switch v := cur.(type) {
	case string:
		return v, nil
	case json.Number:
		return v.String(), nil
	case bool:
		return strconv.FormatBool(v), nil
	default:
		return "", fmt.Errorf("resolves to %T, which is not a scalar this table can hold", cur)
	}
}
