//go:build dmtap

package substrate

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"

	kotvasync "github.com/vul-os/kotva/bindings/go"

	"flowstock/backend/internal/store"
)

// Engine is FlowStock's handle on the shared sync engine: one compiled runtime,
// one instance, one replica.
//
// It satisfies store.Merger. Every method takes the mutex because a wazero
// instance's linear memory is shared mutable state and the binding's own
// contract is that an Instance is correct but serialized; FlowStock's write path
// is already single-writer (store.mu), so serializing costs nothing here.
type Engine struct {
	mu     sync.Mutex
	rt     *kotvasync.Runtime
	in     *kotvasync.Instance
	eng    *kotvasync.Engine
	signer kotvasync.Signer
	author string // hex public key of this node
	ns     string
	kinds  kinds

	// nodeOf maps a substrate author key back to the FlowStock node that owns
	// it, so a resolved winner can be spelled as a FlowStock HLC string.
	nodeOf map[string]string
	// pubkeyForNode authenticates the binding in the other direction: an op
	// claiming node N must be signed by the key N enrolled when it paired.
	pubkeyForNode func(nodeID string) string

	ingested int
	minted   int
	legacy   int
	refused  int
}

// Options configures an Engine.
type Options struct {
	// Signer holds this node's Ed25519 key. Required. No key material ever
	// crosses into the engine — see Open.
	Signer kotvasync.Signer
	// NS is the substrate namespace (§7). FlowStock uses the workspace's org id,
	// so an op from another workspace is not merely rejected by the store's org
	// check but lands in a different namespace in the algebra too.
	NS string
	// PubkeyForNode returns the hex Ed25519 key a peer node enrolled, or "" if
	// that node is unknown. Optional; when nil, envelopes are verified but not
	// bound to a FlowStock node identity.
	PubkeyForNode func(nodeID string) string
	// CacheDir, if set, persists compiled code so a restart does not pay the
	// ~200-400ms compile again. Optional.
	CacheDir string
}

// Open compiles the engine and creates this node's replica.
//
// Compiling is the expensive step and happens exactly once per process; the
// engine is then held for the process's life, which is why a daemon syncing on a
// timer never pays it again.
func Open(ctx context.Context, opt Options) (*Engine, error) {
	if opt.Signer == nil {
		return nil, errors.New("substrate: a signer is required")
	}
	pub := opt.Signer.Public()
	if len(pub) == 0 {
		return nil, errors.New("substrate: the signer has no public key")
	}

	var opts []kotvasync.Option
	if opt.CacheDir != "" {
		opts = append(opts, kotvasync.WithCompilationCacheDir(opt.CacheDir))
	}
	rt, err := kotvasync.New(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("substrate: compiling the engine: %w", err)
	}
	in, err := rt.Instance(ctx)
	if err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("substrate: instantiating the engine: %w", err)
	}
	eng, err := in.NewEngine()
	if err != nil {
		in.Close(ctx)
		rt.Close(ctx)
		return nil, fmt.Errorf("substrate: creating the replica: %w", err)
	}
	// Never hard-code the §4.2 numbers: ask the engine which kind is which.
	k, err := in.OpKinds()
	if err != nil {
		eng.Close()
		in.Close(ctx)
		rt.Close(ctx)
		return nil, fmt.Errorf("substrate: reading op kinds: %w", err)
	}

	return &Engine{
		rt:            rt,
		in:            in,
		eng:           eng,
		signer:        opt.Signer,
		author:        hex.EncodeToString(pub),
		ns:            opt.NS,
		kinds:         kinds{setAdd: k.SetAdd, lwwSet: k.LWWSet},
		nodeOf:        map[string]string{},
		pubkeyForNode: opt.PubkeyForNode,
	}, nil
}

// OpenForStore wires an Engine to a store's own identity and peer registry. This
// is the whole signer story in one call: FlowStock's per-node Ed25519 key, which
// already signs op batches and snapshots, becomes the substrate author key.
//
// The key never reaches the engine. A kotvasync.Signer is asked for signatures
// over a preimage the engine hands out, and the binding's own test asserts the
// module exposes no entry point that could accept key material — so this is
// structural, not a convention to remember. FlowStock holds its key in process
// memory (settings-resident, decoded at Open), so crypto.Signer is the honest
// wrapper: swapping in an HSM or agent later is a change of custodian here and
// nowhere else.
func OpenForStore(ctx context.Context, st *store.Store, cacheDir string) (*Engine, error) {
	signer, ok := st.CryptoSigner()
	if !ok {
		return nil, errors.New("substrate: this node has no Ed25519 identity")
	}
	return Open(ctx, Options{
		Signer:        kotvasync.CryptoSigner{Key: signer},
		NS:            st.OrgID(),
		PubkeyForNode: st.PubkeyForNode,
		CacheDir:      cacheDir,
	})
}

// Close releases the engine.
func (e *Engine) Close(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.eng != nil {
		_ = e.eng.Close()
	}
	if e.in != nil {
		_ = e.in.Close(ctx)
	}
	if e.rt != nil {
		return e.rt.Close(ctx)
	}
	return nil
}

// Mint expresses a locally authored op as a signed SyncOp and admits it to this
// replica, returning the COSE_Sign1 envelope as hex for replication.
//
// Signing happens before ingest and the engine verifies before it will assemble
// the envelope, so a signature this node could not produce fails here rather
// than on a peer's ingest path hours later.
func (e *Engine) Mint(op store.Op) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	sop, err := syncOp(op, e.author, e.kinds, e.ns)
	if err != nil {
		return "", err
	}
	raw, err := e.in.EncodeOp(sop)
	if err != nil {
		return "", fmt.Errorf("substrate: encoding op: %w", err)
	}
	cose, err := e.in.SignOp(raw, e.signer)
	if err != nil {
		return "", fmt.Errorf("substrate: signing op: %w", err)
	}
	if _, err := e.eng.IngestSigned(cose, wallOf(op)); err != nil {
		return "", fmt.Errorf("substrate: ingesting own op: %w", err)
	}
	e.nodeOf[e.author] = op.NodeID
	e.minted++
	e.ingested++
	return hex.EncodeToString(cose), nil
}

// Ingest admits an op authored elsewhere, from the envelope its author minted.
//
// It fails closed. A malformed, unsigned or unverifiable envelope is refused
// with the §12 registry code intact, and the caller aborts the transaction: a
// row written from an op the engine would not accept is a divergence between
// SQLite and the algebra that is supposed to be deciding it.
func (e *Engine) Ingest(op store.Op) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	cose, err := hex.DecodeString(op.Cose)
	if err != nil {
		e.refused++
		return fmt.Errorf("substrate: envelope is not hex: %w", err)
	}
	// Bind the substrate author to the FlowStock node identity. The engine
	// verifies that the envelope was signed by the key it claims; only FlowStock
	// knows which key a given node enrolled when it paired, so only FlowStock
	// can catch a validly-signed op claiming to come from someone else.
	parts, err := e.in.DecodeSignedOp(cose)
	if err != nil {
		e.refused++
		return fmt.Errorf("substrate: undecodable envelope: %w", err)
	}
	if e.pubkeyForNode != nil && op.NodeID != "" {
		if known := e.pubkeyForNode(op.NodeID); known != "" && known != parts.Kid {
			e.refused++
			return fmt.Errorf("substrate: op claims node %s but is signed by %s", op.NodeID, parts.Kid)
		}
	}
	fresh, err := e.eng.IngestSigned(cose, wallOf(op))
	if err != nil {
		e.refused++
		return err
	}
	if parts.Kid != "" && op.NodeID != "" {
		e.nodeOf[parts.Kid] = op.NodeID
	}
	if fresh {
		e.ingested++
	}
	return nil
}

// Resolve returns the engine's verdict for a catalog row.
func (e *Engine) Resolve(tbl, rowID string) (json.RawMessage, string, bool, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	cell, err := e.eng.LWWCell(rowTarget(tbl, rowID), lwwField)
	if err != nil || cell == nil {
		return nil, "", false, false
	}
	payload, deleted, err := decodeRowValue(cell.Value)
	if err != nil {
		return nil, "", false, false
	}
	return payload, e.flowstockHLC(cell.HLC), deleted, true
}

// NoteLegacy counts an op that arrived with no envelope.
func (e *Engine) NoteLegacy() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.legacy++
}

// StateRoot is the content address of this replica's whole observable state
// (§6.1) — 33 bytes, hex. Two replicas that have converged agree on it byte for
// byte, which is a far stronger check than comparing rendered rows: it covers
// every register, every set element and every tombstone, including the ones no
// screen displays.
func (e *Engine) StateRoot() (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	root, err := e.eng.StateRoot()
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(root), nil
}

// LedgerSum sums one numeric field across an insert-only ledger, read out of the
// engine's OR-Set rather than out of SQLite.
//
// It exists so a test can hold the two against each other: if the substrate is
// deciding the merge, its total and the SQL SUM must agree, and a disagreement
// is a mapping bug. A wrong mapping is otherwise invisible — every replica
// agrees, and the number is simply wrong.
func (e *Engine) LedgerSum(tbl, field string) (float64, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	members, err := e.eng.SetMembers()
	if err != nil {
		return 0, err
	}
	total := 0.0
	for _, pair := range members {
		if len(pair) != 2 {
			continue
		}
		var target string
		if err := json.Unmarshal(pair[0], &target); err != nil || target != tbl {
			continue
		}
		payload, _, err := decodeRowValue(pair[1])
		if err != nil {
			return 0, err
		}
		var row map[string]any
		dec := json.NewDecoder(bytes.NewReader(payload))
		dec.UseNumber()
		if err := dec.Decode(&row); err != nil {
			return 0, fmt.Errorf("substrate: ledger element is not an object: %w", err)
		}
		num, ok := row[field].(json.Number)
		if !ok {
			continue // this element carries no such numeric field
		}
		v, err := num.Float64()
		if err != nil {
			return 0, fmt.Errorf("substrate: %s.%s is not a number: %w", tbl, field, err)
		}
		total += v
	}
	return total, nil
}

// Stats reports what the engine has seen. legacy_ops is the one to watch: a
// non-zero value means a peer is still merging with the built-in algebra, and a
// fleet running two algebras converges only by luck.
type Stats struct {
	Ingested  int `json:"ingested"`
	Minted    int `json:"minted"`
	LegacyOps int `json:"legacy_ops"`
	Refused   int `json:"refused"`
}

// Stats returns a snapshot of the counters.
func (e *Engine) Stats() Stats {
	e.mu.Lock()
	defer e.mu.Unlock()
	return Stats{Ingested: e.ingested, Minted: e.minted, LegacyOps: e.legacy, Refused: e.refused}
}

// flowstockHLC spells a substrate HLC the way FlowStock's oplog does. The author
// is a public key in the algebra and a node id in FlowStock, so the mapping is
// only possible for a node whose ops this replica has seen — which is every node
// whose op could have won.
//
// h.Wall and h.Counter come from the substrate engine's own domain (uint64 and
// uint32), not from this node's HLC clock — they never passed through bump()'s
// spill logic, so nothing stops a resolved cell from carrying a value wider
// than FlowStock's fixed-width string format allows. store.FormatHLC is the
// same width check ParseHLC applies on the way in, applied here on the way
// out: an out-of-width verdict is reported as "" (the same signal already used
// above for "no FlowStock node maps to this author") rather than rendered as a
// string whose lexical order would silently diverge from its numeric order —
// exactly the hazard store/hlc.go's own width bounds exist to rule out.
func (e *Engine) flowstockHLC(h kotvasync.HLC) string {
	node, ok := e.nodeOf[h.Author]
	if !ok {
		return ""
	}
	if h.Wall > math.MaxInt64 {
		return ""
	}
	s, ok := store.FormatHLC(int64(h.Wall), h.Counter, node)
	if !ok {
		return ""
	}
	return s
}

// wallOf is the receiver's "now" for the §3 skew check, taken from the op's own
// wall clock so replaying a stored oplog at startup is not refused for being old
// or (on a peer whose clock ran ahead) new. Live traffic is checked against the
// op's own claim, which the signature covers.
func wallOf(op store.Op) uint64 {
	ms, _, _, ok := store.ParseHLC(op.HLC)
	if !ok || ms < 0 {
		return 0
	}
	return uint64(ms)
}

// compile-time proof the engine is what the store expects.
var _ store.Merger = (*Engine)(nil)
