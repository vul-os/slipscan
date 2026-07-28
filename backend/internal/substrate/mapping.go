//go:build dmtap

// Package substrate expresses FlowStock's replication in the shared DMTAP Sync
// algebra (substrate/SYNC.md capability ③), so that FlowStock stops carrying its
// own CRDT and carries the suite's instead.
//
// Nothing here changes FlowStock's architecture. Storage is still SQLite,
// transport is still the mutual-Ed25519 HTTP pull and the folder-sync JSONL
// path, identity is still the per-node Ed25519 key generated on first run. The
// engine is in-memory and does no I/O by design; what it replaces is the part
// that decides *which write wins*. It is off unless FLOWSTOCK_SUBSTRATE_SYNC is
// set, and the hand-rolled engine stays the default and stays reachable.
//
// # The mapping, and why each kind was chosen
//
// SYNC.md §4.10 requires an implementation to document, per modelled object,
// which primitive it chose and its answer to the selection test — because
// choosing §4.5 where §4.4 belongs is silent, permanent, converged data loss,
// and choosing §4.4 where §4.5 belongs is a resurrection bug. FlowStock models
// two things.
//
// ## Catalog rows → §4.4 LWW register (kind 3, lww-set)
//
//	target  "<table>/<row-id>"      field "row"
//	value   tstr, "v" + canonical JSON of the row  (live)
//	        tstr, "x" + canonical JSON of the row  (deleted)
//
// FlowStock already merges these last-writer-wins by HLC, so §4.4 is the
// faithful mapping rather than a reinterpretation.
//
// The delete flag is emphatically NOT a §4.5 death certificate. The selection
// test — "is there any user action that restores this thing, using the same
// ordinary operation that created it?" — is answered YES by the code: a delete
// is LocalPut(..., deleted: true) and a subsequent PUT of the same id is
// LocalPut(..., deleted: false), the identical ordinary write (see
// api.handleDeleteRow and api.handlePutRow). A product where re-creating a
// deleted SKU is an ordinary edit must not model that delete as a certificate
// that dominates every later write: a re-added product would stay invisible on
// every replica, with no error anywhere. So deletion is an ordinary LWW write of
// a discriminated value, exactly as §4.1.1 prescribes for a state ext-value
// cannot spell (it has no null).
//
// One register per row, not per column, because that is what FlowStock does
// today: writeRow replaces every column from the winning op. §4.1.1 is explicit
// that the merge unit is the whole value and that granularity lives in the
// address space, so per-column concurrency would be a behaviour *change* —
// available later by splitting the address (field = column name), and
// deliberately not taken here.
//
// The value is an opaque canonical payload rather than a native nested map for
// one hard reason: ext-value excludes floats (§4.1), and FlowStock's schema is
// full of REAL columns — price, cost_price, qty_delta. Encoding them natively
// would mean inventing a float encoding, which is exactly the sort of local
// invention adopting a shared substrate is meant to end. §4.1.1 permits an
// opaque payload and places the canonicalization obligation on the producer;
// canonicalJSON below discharges it.
//
// ## Stock movements and PO receipts → §4.3 OR-Set (kind 1, set-add)
//
//	target  "stock_movements" / "po_receipts"
//	value   tstr, "v" + canonical JSON of the row including its id
//
// These are FlowStock's insert-only ledgers: immutable facts, summed at read
// time (store.StockLevels, store.ReceivedByItem). §4.6's closing note names this
// exact case and this exact product — a counter that is a sum of immutable facts
// MAY be modelled as a set-add of an immutable record with a read-side SUM, "the
// flowstock choice" — and it is the right one here for reasons that outlive the
// citation:
//
//   - A movement is not a scalar. It carries variant, branch, kind, reference,
//     note, author and timestamp, and the product's whole audit story is that
//     every quantity change is a retained, attributable event. A PN-counter
//     (§4.6) is for "a scalar whose history need not be retained" — it would
//     converge on the right total and discard the ledger.
//   - No set-remove is ever minted, because the API refuses to delete or amend a
//     ledger row (handlePutRow, handleDeleteRow both reject these tables). An
//     OR-Set with no removes is a grow-only set, whose merge is plain union —
//     which is precisely what the existing INSERT OR IGNORE computes. The
//     mapping is therefore an identity on FlowStock's current behaviour, not a
//     new one to be validated against inventory correctness.
//   - The trap in the other direction is worth stating: §4.6's normative merge
//     is per-author union of op-id-keyed deltas, and its own text records that
//     the earlier per-author max was unsound for partial states. Both formulations
//     converge for FlowStock, but only the set-add form keeps the movement rows.
//
// Correcting a movement is an inverse movement, never an edit — which is the
// same reason §4.5 is wrong for the ledger too: there is nothing to delete.
//
// # What it costs
//
// Re-measured on an Apple M2 against the published engine module
// (github.com/vul-os/kotva/bindings/go v0.2.0), with
// `go test -tags dmtap -bench Open ./backend/internal/substrate` and by building
// ./backend/cmd/flowstock with and without `-tags dmtap`:
//
//	embedded engine artifact   427,731 bytes (418 KiB)
//	flowstock binary           15,301,826 → 19,049,826 bytes (+3.57 MiB, +24.5%)
//	Open, no cache             ~150 ms, once per process
//	Open, warm cache           ~7 ms    (~20x)
//
// The previous figures here were taken against the vendored copy of the binding
// and its 426,890-byte artifact: +3.58 MiB, ~118 ms, ~5.7 ms. The binary delta
// moved by 1,216 bytes — a rounding boundary, not a regression. The startup
// numbers did move: the artifact is 841 bytes larger and compiling it costs
// proportionally more, and these were taken on a busy laptop where cold Open
// ranged 148–190 ms across runs. Treat them as an order of magnitude, which is
// all the decision they inform needs.
//
// The binary delta is worth stating plainly, because the artifact size alone
// understates it by an order of magnitude: only 418 KiB of those 3.57 MiB is the
// engine. The rest is wazero's optimizing compiler, which is the price of
// running WebAssembly without cgo — and cgo was the alternative FlowStock cannot
// take, since it cross-compiles to a single static binary for laptops, shop
// counters, NASes and Pis.
//
// The startup cost is close to irrelevant here: FlowStock is a daemon that syncs
// on a one-minute timer, so it compiles once and amortizes over the process
// lifetime. It is not nothing on a shop-counter PC that gets power-cycled daily,
// which is why main.go passes a cache dir under the data directory and turns
// ~150ms into ~7ms for every start after the first.
package substrate

import (
	"bytes"
	"encoding/json"
	"fmt"

	kotvasync "github.com/vul-os/kotva/bindings/go"

	"flowstock/backend/internal/store"
)

// Op kinds (§4.2). Read from the engine at startup rather than hard-coded — see
// kinds() — because SYNC.md's own adoption notes say never to hard-code them.
type kinds struct {
	setAdd uint8
	lwwSet uint8
}

// Value discriminators (§4.1.1). ext-value has no null, so "deleted" and
// "holds an empty payload" are distinguished explicitly rather than inferred.
const (
	markLive    = "v"
	markDeleted = "x"
	// lwwField is the single register per catalog row. Named rather than empty
	// so a future per-column decomposition is a visible change.
	lwwField = "row"
)

// rowTarget addresses one catalog row.
func rowTarget(tbl, rowID string) string { return tbl + "/" + rowID }

// canonicalJSON re-encodes a payload deterministically: object keys sorted at
// every depth (encoding/json sorts map keys), numbers preserved as their exact
// source literal via json.Number rather than round-tripped through float64.
//
// This discharges §4.1.1's opaque-payload obligation. It matters concretely:
// §4.4 breaks an exact HLC tie by comparing det_cbor(value) bytes, so a
// serializer whose key order varied for equal content would make the tie-break
// depend on the serializer instead of on the data.
func canonicalJSON(raw json.RawMessage) (string, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "{}", nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", fmt.Errorf("substrate: payload is not JSON: %w", err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("substrate: payload is not canonicalizable: %w", err)
	}
	return string(out), nil
}

// ledgerValue is the OR-Set element for one immutable ledger row. The row id is
// folded into the element because element identity in §4.3 is the value itself:
// two movements of the same quantity on the same day at the same branch are
// distinct facts and must not collapse into one member.
func ledgerValue(op store.Op) (json.RawMessage, error) {
	body, err := canonicalJSON(op.Payload)
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		return nil, fmt.Errorf("substrate: ledger payload is not an object: %w", err)
	}
	m["id"], _ = json.Marshal(op.RowID)
	canon, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return kotvasync.Text(markLive + string(canon)), nil
}

// rowValue is the LWW value for one catalog row, discriminated live/deleted.
func rowValue(op store.Op) (json.RawMessage, error) {
	body, err := canonicalJSON(op.Payload)
	if err != nil {
		return nil, err
	}
	mark := markLive
	if op.Deleted {
		mark = markDeleted
	}
	return kotvasync.Text(mark + body), nil
}

// decodeRowValue reads back what rowValue wrote.
func decodeRowValue(tagged json.RawMessage) (payload json.RawMessage, deleted bool, err error) {
	var v struct {
		Tstr *string `json:"tstr"`
	}
	if err := json.Unmarshal(tagged, &v); err != nil || v.Tstr == nil {
		return nil, false, fmt.Errorf("substrate: engine value is not a tagged text: %s", tagged)
	}
	s := *v.Tstr
	if s == "" {
		return nil, false, fmt.Errorf("substrate: engine value carries no discriminator")
	}
	switch s[:1] {
	case markLive:
		return json.RawMessage(s[1:]), false, nil
	case markDeleted:
		return json.RawMessage(s[1:]), true, nil
	default:
		// Fail closed rather than guess. Inferring liveness from a value the
		// algebra treats as an ordinary write is the thing §4.1.1 prohibits.
		return nil, false, fmt.Errorf("substrate: unknown value discriminator %q", s[:1])
	}
}

// syncOp expresses a FlowStock op as a SyncOp. author is the hex Ed25519 public
// key of the node that minted it — which is also the op's HLC author, so the key
// an op claims and the key it is signed with are the same by construction.
func syncOp(op store.Op, author string, k kinds, ns string) (kotvasync.Op, error) {
	ms, counter, _, ok := store.ParseHLC(op.HLC)
	if !ok {
		return kotvasync.Op{}, fmt.Errorf("substrate: unparseable hlc %q", op.HLC)
	}
	if ms < 0 {
		return kotvasync.Op{}, fmt.Errorf("substrate: negative wall clock in hlc %q", op.HLC)
	}
	hlc := kotvasync.HLC{Wall: uint64(ms), Counter: counter, Author: author}

	if store.IsInsertOnly(op.Tbl) {
		if op.Deleted {
			// Unreachable through the API, which refuses to delete a ledger
			// row, and refused here too rather than silently mapped to
			// something that would converge on the wrong ledger.
			return kotvasync.Op{}, fmt.Errorf("substrate: %s is insert-only; a delete has no mapping", op.Tbl)
		}
		val, err := ledgerValue(op)
		if err != nil {
			return kotvasync.Op{}, err
		}
		return kotvasync.Op{Kind: k.setAdd, NS: ns, Target: op.Tbl, Value: val, HLC: hlc}, nil
	}

	val, err := rowValue(op)
	if err != nil {
		return kotvasync.Op{}, err
	}
	field := lwwField
	return kotvasync.Op{
		Kind:   k.lwwSet,
		NS:     ns,
		Target: rowTarget(op.Tbl, op.RowID),
		Field:  &field,
		Value:  val,
		HLC:    hlc,
	}, nil
}
