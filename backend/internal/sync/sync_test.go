package sync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"flowstock/backend/internal/store"
)

// node spins up a store plus an httptest server exposing its sync handler,
// mimicking a real branch reachable over HTTP.
type node struct {
	st     *store.Store
	eng    *Engine
	server *httptest.Server
}

func newNode(t *testing.T, name, secret string) *node {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), name+".db"))
	if err != nil {
		t.Fatalf("open %s: %v", name, err)
	}
	// Both test nodes belong to one workspace. Adopting before any local op is
	// authored is exactly how a fresh node pairs into an existing workspace.
	if _, err := st.AdoptOrg("shared-workspace"); err != nil {
		t.Fatalf("adopt org: %v", err)
	}
	_ = st.SetSetting("sync_secret", secret)
	_ = st.SetSetting("branch_id", "branch-"+name)
	_ = st.SetSetting("branch_name", "Branch "+name)
	eng := New(st, func() string { return st.GetSetting("sync_secret") })
	srv := httptest.NewServer(eng.Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &node{st: st, eng: eng, server: srv}
}

func put(t *testing.T, st *store.Store, tbl, id string, payload map[string]any) {
	t.Helper()
	if _, err := st.LocalPut(tbl, id, payload, false); err != nil {
		t.Fatalf("put: %v", err)
	}
}

func stock(t *testing.T, st *store.Store, variant string) float64 {
	t.Helper()
	levels, _ := st.StockLevels()
	var total float64
	for _, l := range levels {
		if l.VariantID == variant {
			total += l.Qty
		}
	}
	return total
}

// newRawNode is like newNode but does NOT adopt a shared workspace, so the
// node keeps whatever org id Open generated for it.
func newRawNode(t *testing.T, name, secret string) *node {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), name+".db"))
	if err != nil {
		t.Fatalf("open %s: %v", name, err)
	}
	_ = st.SetSetting("sync_secret", secret)
	eng := New(st, func() string { return st.GetSetting("sync_secret") })
	srv := httptest.NewServer(eng.Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &node{st: st, eng: eng, server: srv}
}

func TestPairingAdoptsWorkspaceAndBlocksForeignWorkspace(t *testing.T) {
	ctx := context.Background()

	// A is an established workspace with data.
	a := newRawNode(t, "A", "shared-secret")
	put(t, a.st, "products", "p1", map[string]any{"name": "Anvil"})
	put(t, a.st, "stock_movements", "m1", map[string]any{"variant_id": "v1", "branch_id": "brA", "qty_delta": 12.0, "kind": "receive"})

	// Joiner is brand new; it adopts A's workspace on first sync and pulls data.
	joiner := newRawNode(t, "J", "shared-secret")
	res := joiner.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if !res.OK {
		t.Fatalf("join sync failed: %s", res.Error)
	}
	if !res.Adopted {
		t.Fatal("joiner should have adopted A's workspace")
	}
	if joiner.st.OrgID() != a.st.OrgID() {
		t.Fatalf("workspace not adopted: %s vs %s", joiner.st.OrgID(), a.st.OrgID())
	}
	if got := stock(t, joiner.st, "v1"); got != 12.0 {
		t.Fatalf("joiner stock = %v, want 12", got)
	}

	// A foreign, already-established workspace with the same secret is refused
	// (shared secret alone is not enough to merge two real workspaces).
	foreign := newRawNode(t, "X", "shared-secret")
	put(t, foreign.st, "products", "px", map[string]any{"name": "Foreign"})
	res = foreign.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if res.OK {
		t.Fatal("foreign established workspace must be refused")
	}
	if foreign.st.OrgID() == a.st.OrgID() {
		t.Fatal("foreign workspace must not have re-homed")
	}
	// A stays clean.
	rows, _ := a.st.ListRows("products", false)
	for _, r := range rows {
		if r["name"] == "Foreign" {
			t.Fatal("foreign product leaked into A")
		}
	}
}

func TestTwoBranchesSyncOverHTTPAndSurviveOffline(t *testing.T) {
	ctx := context.Background()
	a := newNode(t, "A", "shared-secret")
	b := newNode(t, "B", "shared-secret")

	// Round 1: A builds catalog + stock; B sells while never having synced.
	put(t, a.st, "products", "p1", map[string]any{"name": "Hex Bolts M6"})
	put(t, a.st, "product_variants", "v1", map[string]any{"product_id": "p1", "sku": "FAS-1", "price": 189.0})
	put(t, a.st, "stock_movements", "mA1", map[string]any{"variant_id": "v1", "branch_id": "brA", "qty_delta": 100.0, "kind": "receive"})
	put(t, b.st, "stock_movements", "mB1", map[string]any{"variant_id": "v1", "branch_id": "brB", "qty_delta": -7.0, "kind": "sale"})

	res := b.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if !res.OK {
		t.Fatalf("sync failed: %s", res.Error)
	}
	if got := stock(t, a.st, "v1"); got != 93.0 {
		t.Fatalf("A stock = %v, want 93", got)
	}
	if got := stock(t, b.st, "v1"); got != 93.0 {
		t.Fatalf("B stock = %v, want 93", got)
	}

	// Round 2 ("offline week"): both keep writing without contact.
	put(t, a.st, "stock_movements", "mA2", map[string]any{"variant_id": "v1", "branch_id": "brA", "qty_delta": -20.0, "kind": "sale"})
	put(t, a.st, "customers", "c1", map[string]any{"name": "Mokoena Construction"})
	put(t, b.st, "stock_movements", "mB2", map[string]any{"variant_id": "v1", "branch_id": "brB", "qty_delta": -5.0, "kind": "sale"})
	time.Sleep(3 * time.Millisecond)
	put(t, b.st, "products", "p1", map[string]any{"name": "Hex Bolts M6 (renamed at B)"})

	if got := stock(t, a.st, "v1"); got != 73.0 {
		t.Fatalf("A offline view = %v, want 73", got)
	}
	if got := stock(t, b.st, "v1"); got != 88.0 {
		t.Fatalf("B offline view = %v, want 88", got)
	}

	// Reconnect: one round converges both.
	res = b.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if !res.OK {
		t.Fatalf("reconnect sync failed: %s", res.Error)
	}
	if got := stock(t, a.st, "v1"); got != 68.0 {
		t.Fatalf("A converged stock = %v, want 68", got)
	}
	if got := stock(t, b.st, "v1"); got != 68.0 {
		t.Fatalf("B converged stock = %v, want 68", got)
	}
	for _, n := range []*node{a, b} {
		row, _ := n.st.GetRow("products", "p1")
		if row["name"] != "Hex Bolts M6 (renamed at B)" {
			t.Fatalf("LWW rename did not win: %v", row["name"])
		}
	}

	// Idempotence.
	res = b.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if res.Pushed != 0 || res.Pulled != 0 {
		t.Fatalf("expected a quiet round, got pushed=%d pulled=%d", res.Pushed, res.Pulled)
	}

	// Auth: with mutual key auth, an enrolled peer authenticates by its Ed25519
	// key, so the shared secret is no longer the gate — a wrong (or empty) secret
	// still syncs, because B signs every request with its identity key that A
	// enrolled on the first round.
	_ = b.st.SetSetting("sync_secret", "wrong")
	res = b.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if !res.OK {
		t.Fatalf("enrolled peer should authenticate by key regardless of secret: %s", res.Error)
	}

	// An unsigned request (legacy bearer-only) is rejected once the listener has
	// no secret: no key, no secret → fail closed.
	_ = a.st.SetSetting("sync_secret", "")
	req, _ := http.NewRequest("GET", a.server.URL+"/api/sync/vector", nil)
	req.Header.Set("Authorization", "Bearer anything")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-secret listener should 401 an unsigned request, got %d", resp.StatusCode)
	}
}

// A mesh must not run two merge algebras at once. The two engines are each
// convergent but break HLC ties differently (node id vs author public key), so
// a mixed round is accepted by both sides and then quietly disagrees about which
// concurrent write won. SyncPeer therefore refuses the round outright.
func TestMergeEngineMismatchRefusesSync(t *testing.T) {
	ctx := context.Background()

	a := newNode(t, "A", "shared-secret")
	b := newNode(t, "B", "shared-secret")

	// Matching engines (both default to built-in) sync normally.
	put(t, a.st, "products", "p1", map[string]any{"name": "Anvil"})
	if res := b.eng.SyncPeer(ctx, "peerA", a.server.URL); !res.OK {
		t.Fatalf("matching engines should sync: %s", res.Error)
	}

	// Flip A onto the substrate and the round is refused from either direction.
	a.eng.MergeEngine = MergeSubstrate
	put(t, a.st, "products", "p2", map[string]any{"name": "Vise"})

	res := b.eng.SyncPeer(ctx, "peerA", a.server.URL)
	if res.OK {
		t.Fatal("built-in node must refuse a substrate peer")
	}
	if !strings.Contains(res.Error, MergeSubstrate) || !strings.Contains(res.Error, MergeBuiltin) {
		t.Fatalf("error should name both engines, got %q", res.Error)
	}
	// Nothing crossed the wire.
	rows, _ := b.st.ListRows("products", false)
	for _, r := range rows {
		if r["name"] == "Vise" {
			t.Fatal("ops leaked across a merge-engine mismatch")
		}
	}

	res = a.eng.SyncPeer(ctx, "peerB", b.server.URL)
	if res.OK {
		t.Fatal("substrate node must refuse a built-in peer")
	}

	// Agreeing again restores sync, which is what finishing a rollout looks like.
	b.eng.MergeEngine = MergeSubstrate
	if res := b.eng.SyncPeer(ctx, "peerA", a.server.URL); !res.OK {
		t.Fatalf("re-agreed engines should sync: %s", res.Error)
	}
}

// A node built before the handshake carried merge_engine omits the field. That
// is always the built-in engine, so it must be readable as such rather than as
// an unknown that blocks every peer.
func TestLegacyPeerWithoutEngineFieldIsBuiltin(t *testing.T) {
	ctx := context.Background()
	local := newNode(t, "L", "shared-secret")

	// Stand in for an older build: a vector response with no merge_engine. It
	// still signs its op batches — that is not the property under test here, and
	// an unsigned batch is refused outright (see TestPullResponseMustBeSigned).
	old := newNode(t, "Old", "shared-secret")
	legacy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/pull") {
			msg := opsMsg{NodeID: "legacy-node"}
			old.eng.signBatch(&msg)
			writeJSON(w, msg)
			return
		}
		writeJSON(w, map[string]any{
			"node_id": "legacy-node",
			"org_id":  local.st.OrgID(),
			"pubkey":  old.st.PublicKeyHex(),
			"vector":  map[string]string{},
		})
	}))
	t.Cleanup(legacy.Close)

	// The local node is on the built-in engine, so the legacy peer is compatible
	// and the round gets past the guard.
	if res := local.eng.SyncPeer(ctx, "legacy", legacy.URL); !res.OK {
		t.Fatalf("legacy peer should read as built-in: %s", res.Error)
	}

	// On the substrate it is a mismatch, and the message says so in terms of the
	// engine rather than of a missing field.
	local.eng.MergeEngine = MergeSubstrate
	res := local.eng.SyncPeer(ctx, "legacy", legacy.URL)
	if res.OK {
		t.Fatal("substrate node must refuse a legacy built-in peer")
	}
	if !strings.Contains(res.Error, MergeBuiltin) {
		t.Fatalf("error should name the built-in engine, got %q", res.Error)
	}
}
