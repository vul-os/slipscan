//go:build dmtap

package substrate_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"flowstock/backend/internal/store"
	"flowstock/backend/internal/substrate"
)

// cacheDir persists compiled WebAssembly across every Open in this test binary.
// Without it each node pays the ~300ms compile; with it, only the first does.
var cacheDir string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "flowstock-wasm-cache")
	if err != nil {
		panic(err)
	}
	cacheDir = dir
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// node is one FlowStock replica with the substrate engine installed as its merge
// authority: real store, real SQLite, real identity — only the algebra is swapped.
type node struct {
	t   *testing.T
	st  *store.Store
	eng *substrate.Engine
}

func newNode(t *testing.T, name string) *node {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), name+".db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	eng, err := substrate.OpenForStore(context.Background(), st, cacheDir)
	if err != nil {
		st.Close()
		t.Fatalf("open engine: %v", err)
	}
	st.SetMerger(eng)
	t.Cleanup(func() {
		eng.Close(context.Background())
		st.Close()
	})
	return &node{t: t, st: st, eng: eng}
}

// pair puts two nodes in one workspace and enrols each other's keys, exactly as
// pairing does in the product.
func pair(t *testing.T, a, b *node) {
	t.Helper()
	if _, err := b.st.AdoptOrg(a.st.OrgID()); err != nil {
		t.Fatalf("adopt org: %v", err)
	}
	// The engine's namespace is the org id, fixed at Open; re-open b's engine so
	// both replicas share a namespace, as they would after a real join.
	b.eng.Close(context.Background())
	eng, err := substrate.OpenForStore(context.Background(), b.st, cacheDir)
	if err != nil {
		t.Fatalf("reopen engine: %v", err)
	}
	b.eng = eng
	b.st.SetMerger(eng)
	a.st.RecordPeerIdentity(b.st.NodeID(), b.st.PublicKeyHex())
	b.st.RecordPeerIdentity(a.st.NodeID(), a.st.PublicKeyHex())
}

// sync moves every op from → to, the way the HTTP pull and the folder-sync
// exporter both do: nothing but store.Op values cross.
func (n *node) sync(from *node) {
	n.t.Helper()
	vec, err := n.st.Vector()
	if err != nil {
		n.t.Fatalf("vector: %v", err)
	}
	ops, err := from.st.OpsAfter(vec, 10_000)
	if err != nil {
		n.t.Fatalf("ops after: %v", err)
	}
	if _, err := n.st.ApplyOps(ops); err != nil {
		n.t.Fatalf("apply ops: %v", err)
	}
}

func (n *node) root() string {
	n.t.Helper()
	r, err := n.eng.StateRoot()
	if err != nil {
		n.t.Fatalf("state root: %v", err)
	}
	return r
}

func (n *node) put(tbl, id string, data map[string]any) {
	n.t.Helper()
	if _, err := n.st.LocalPut(tbl, id, data, false); err != nil {
		n.t.Fatalf("put %s/%s: %v", tbl, id, err)
	}
}

func (n *node) row(tbl, id string) map[string]any {
	n.t.Helper()
	r, err := n.st.GetRow(tbl, id)
	if err != nil {
		n.t.Fatalf("get row: %v", err)
	}
	return r
}

func (n *node) stock(variant, branch string) float64 {
	n.t.Helper()
	levels, err := n.st.StockLevels()
	if err != nil {
		n.t.Fatalf("stock levels: %v", err)
	}
	for _, l := range levels {
		if l.VariantID == variant && l.BranchID == branch {
			return l.Qty
		}
	}
	return 0
}

// TestConcurrentStockMovementsBothSurvive is the case the product's value rests
// on: two branches trade the same SKU while disconnected, and neither movement
// may be dropped. It is also the case a naive last-writer-wins store gets wrong,
// which is why stock_movements maps to an OR-Set (§4.3) and not to a register.
func TestConcurrentStockMovementsBothSurvive(t *testing.T) {
	a, b := newNode(t, "a"), newNode(t, "b")
	pair(t, a, b)

	a.put("branches", "br1", map[string]any{"name": "Main", "is_active": 1})
	a.put("product_variants", "v1", map[string]any{"product_id": "p1", "sku": "SKU-1", "price": 19.99})
	b.sync(a)

	// Offline: both branches move stock on the same variant at the same branch.
	a.put("stock_movements", "m-a", map[string]any{
		"variant_id": "v1", "branch_id": "br1", "qty_delta": 7.0, "kind": "purchase"})
	b.put("stock_movements", "m-b", map[string]any{
		"variant_id": "v1", "branch_id": "br1", "qty_delta": -3.0, "kind": "sale"})

	a.sync(b)
	b.sync(a)

	if got := a.stock("v1", "br1"); got != 4 {
		t.Fatalf("node a on-hand = %v, want 4 (7 in, 3 out — neither movement may be lost)", got)
	}
	if got := b.stock("v1", "br1"); got != 4 {
		t.Fatalf("node b on-hand = %v, want 4", got)
	}
	if a.root() != b.root() {
		t.Fatalf("state roots diverged:\n a %s\n b %s", a.root(), b.root())
	}

	// The engine's own view of the ledger must agree with the SQL SUM. If it did
	// not, the substrate would be deciding one thing and the product showing
	// another — the failure mode that makes a wrong mapping invisible.
	total, err := a.eng.LedgerSum("stock_movements", "qty_delta")
	if err != nil {
		t.Fatalf("ledger sum: %v", err)
	}
	if total != 4 {
		t.Fatalf("engine ledger sum = %v but SQL says %v — the ledger mapping disagrees with the projection",
			total, a.stock("v1", "br1"))
	}
}

// TestCatalogRowsConvergeOnOneWinner pins §4.4: concurrent edits to one row
// resolve to a single winner, identically on both replicas.
func TestCatalogRowsConvergeOnOneWinner(t *testing.T) {
	a, b := newNode(t, "a"), newNode(t, "b")
	pair(t, a, b)

	a.put("products", "p1", map[string]any{"name": "Widget"})
	b.sync(a)

	a.put("products", "p1", map[string]any{"name": "Widget (A)"})
	b.put("products", "p1", map[string]any{"name": "Widget (B)"})

	a.sync(b)
	b.sync(a)

	an, bn := a.row("products", "p1")["name"], b.row("products", "p1")["name"]
	if an != bn {
		t.Fatalf("rows diverged: a=%v b=%v", an, bn)
	}
	if an != "Widget (A)" && an != "Widget (B)" {
		t.Fatalf("winner is neither write: %v", an)
	}
	if a.root() != b.root() {
		t.Fatalf("state roots diverged:\n a %s\n b %s", a.root(), b.root())
	}
}

// TestDeleteIsRevivableByAnOrdinaryWrite is the §4.10 selection test, executed.
//
// FlowStock deletes a row with the same ordinary write that created it, and
// re-creating it is that same write again. Had the mapping used a §4.5 death
// certificate, this test would fail — the re-created product would stay
// invisible on every replica, with no error anywhere, which is exactly the
// silent converged data loss §4.10 exists to prevent.
func TestDeleteIsRevivableByAnOrdinaryWrite(t *testing.T) {
	a, b := newNode(t, "a"), newNode(t, "b")
	pair(t, a, b)

	a.put("products", "p1", map[string]any{"name": "Widget"})
	if _, err := a.st.LocalPut("products", "p1", map[string]any{"name": "Widget"}, true); err != nil {
		t.Fatalf("delete: %v", err)
	}
	b.sync(a)
	if rows, _ := b.st.ListRows("products", false); len(rows) != 0 {
		t.Fatalf("deleted product still listed on b: %v", rows)
	}

	// Re-create it — the ordinary write, not a privileged revival.
	a.put("products", "p1", map[string]any{"name": "Widget again"})
	b.sync(a)

	rows, err := b.st.ListRows("products", false)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0]["name"] != "Widget again" {
		t.Fatalf("an ordinary write did not revive the row: %v — the delete was mapped to something that dominates", rows)
	}
	if a.root() != b.root() {
		t.Fatalf("state roots diverged after revival")
	}
}

// TestStateRootIsIndependentOfArrivalOrder pins the join property directly: the
// same op set, delivered in different orders, is the same state.
func TestStateRootIsIndependentOfArrivalOrder(t *testing.T) {
	a, b, c := newNode(t, "a"), newNode(t, "b"), newNode(t, "c")
	pair(t, a, b)
	pair(t, a, c)

	a.put("products", "p1", map[string]any{"name": "One"})
	a.put("stock_movements", "m1", map[string]any{"variant_id": "v1", "branch_id": "br1", "qty_delta": 5.0})
	b.sync(a)
	b.put("products", "p1", map[string]any{"name": "Two"})
	b.put("stock_movements", "m2", map[string]any{"variant_id": "v1", "branch_id": "br1", "qty_delta": 2.0})

	// c hears from b first, then a; a hears from b only.
	c.sync(b)
	c.sync(a)
	a.sync(b)

	if a.root() != c.root() {
		t.Fatalf("arrival order changed the state:\n a %s\n c %s", a.root(), c.root())
	}
	if a.stock("v1", "br1") != c.stock("v1", "br1") {
		t.Fatalf("stock disagrees: %v vs %v", a.stock("v1", "br1"), c.stock("v1", "br1"))
	}
}

// TestTamperedEnvelopeIsRefused: the merge path fails closed rather than merging
// state whose signature does not verify.
func TestTamperedEnvelopeIsRefused(t *testing.T) {
	a, b := newNode(t, "a"), newNode(t, "b")
	pair(t, a, b)

	a.put("products", "p1", map[string]any{"name": "Widget"})
	ops, err := a.st.OwnOpsAfter("")
	if err != nil {
		t.Fatalf("own ops: %v", err)
	}
	if len(ops) == 0 || ops[0].Cose == "" {
		t.Fatal("a minted no signed envelope")
	}

	raw, err := hex.DecodeString(ops[0].Cose)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw[len(raw)-1] ^= 0xff // flip a signature byte
	ops[0].Cose = hex.EncodeToString(raw)

	if _, err := b.st.ApplyOps(ops); err == nil {
		t.Fatal("a tampered envelope was merged; the engine must fail closed")
	}
	if rows, _ := b.st.ListRows("products", false); len(rows) != 0 {
		t.Fatalf("the refused op still wrote a row: %v", rows)
	}
}

// TestOpClaimingAnotherNodeIsRefused: the envelope verifies under its own key,
// but claims to come from a node that enrolled a different one. Only FlowStock
// knows which key a node enrolled, so only FlowStock can catch this.
func TestOpClaimingAnotherNodeIsRefused(t *testing.T) {
	a, b, imposter := newNode(t, "a"), newNode(t, "b"), newNode(t, "imp")
	pair(t, a, b)
	pair(t, a, imposter)

	imposter.put("products", "p1", map[string]any{"name": "Forged"})
	ops, err := imposter.st.OwnOpsAfter("")
	if err != nil {
		t.Fatalf("own ops: %v", err)
	}
	// b knows a's key; the imposter's op claims to be a's.
	ops[0].NodeID = a.st.NodeID()

	if _, err := b.st.ApplyOps(ops); err == nil {
		t.Fatal("an op claiming another node's identity was merged")
	}
}

// TestMintedEnvelopeRoundTripsThroughTheOplog: the envelope survives storage and
// the wire representation the transport actually uses (JSON store.Op).
func TestMintedEnvelopeRoundTripsThroughTheOplog(t *testing.T) {
	a := newNode(t, "a")
	a.put("products", "p1", map[string]any{"name": "Widget", "price": 19.99})

	ops, err := a.st.OwnOpsAfter("")
	if err != nil {
		t.Fatalf("own ops: %v", err)
	}
	if len(ops) != 1 {
		t.Fatalf("want 1 op, got %d", len(ops))
	}
	wire, err := json.Marshal(ops[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back store.Op
	if err := json.Unmarshal(wire, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Cose != ops[0].Cose || back.Cose == "" {
		t.Fatal("the envelope did not survive the wire encoding")
	}
}

// TestLegacyPeerIsRefusedAndCounted: an op from a peer that has not enabled the
// substrate carries no envelope, so it cannot be verified on its own — the only
// thing vouching for it is the connection it arrived over.
//
// This test used to assert the opposite: that such an op "still merges (by the
// built-in algebra) but is counted". Counting it was right; merging it was the
// R-SOV-3.2 hole (kotva substrate/SOVEREIGNTY.md §3.3.2) — an authenticated peer
// could push a row attributed to any node id at all and a substrate node would
// write it. It is now refused, and still counted, so an operator sees a mixed
// fleet as a stream of refusals rather than as silence.
func TestLegacyPeerIsRefusedAndCounted(t *testing.T) {
	a, b := newNode(t, "a"), newNode(t, "b")
	pair(t, a, b)

	a.put("products", "p1", map[string]any{"name": "Widget"})
	ops, _ := a.st.OwnOpsAfter("")
	ops[0].Cose = "" // as if a were running with the flag off

	if _, err := b.st.ApplyOps(ops); err == nil {
		t.Fatal("an op with no envelope must be refused, not merged on the strength of the transport")
	}
	if got := b.eng.Stats().LegacyOps; got != 1 {
		t.Fatalf("legacy_ops = %d, want 1 — a refusal an operator cannot see is a silent one", got)
	}
	if rows, _ := b.st.ListRows("products", false); len(rows) != 0 {
		t.Fatalf("a refused op still landed: %v", rows)
	}
}

// TestBuiltInEngineIsUntouched: with no merger installed, the store behaves
// exactly as it did — no envelopes, and the hand-rolled path decides.
func TestBuiltInEngineIsUntouched(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "plain.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()

	if _, err := st.LocalPut("products", "p1", map[string]any{"name": "Widget"}, false); err != nil {
		t.Fatalf("put: %v", err)
	}
	ops, err := st.OwnOpsAfter("")
	if err != nil {
		t.Fatalf("own ops: %v", err)
	}
	if len(ops) != 1 || ops[0].Cose != "" {
		t.Fatalf("the default path must mint no envelope, got %q", ops[0].Cose)
	}
}
