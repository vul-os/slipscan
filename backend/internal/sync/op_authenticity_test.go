package sync

// R-SOV-3 negative controls: authentication that is safe on the open internet
// (kotva substrate/SOVEREIGNTY.md §3.3, checklist rows SOV-6..SOV-9).
//
// Every control here asserts a SPECIFIC refusal, not merely "an error", and the
// number of controls that ran is asserted at the end. A suite that runs zero
// negative tests reports the same green as one that runs all of them, which is
// the failure mode this count exists to make impossible.
//
// What these controls do NOT prove, and no test in this package can: that a
// relayed op is attributable to its AUTHOR. Under the built-in merge engine an
// op carries no author signature at all — only the sending node signs the batch
// — so a peer that relays C's ops vouches for them with its own key. Per-op
// authorship is a property of the `-tags dmtap` build, where each op carries its
// own COSE_Sign1 envelope; the controls for that live in
// backend/internal/substrate/op_authenticity_test.go. docs/SYNC.md says which
// build has which property, and the cloud-node guide requires the one that has
// per-op authenticity.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"flowstock/backend/internal/store"
)

// wantOpAuthControls is the number of subtests below. An equality of
// "ran == listed" holds at 0 == 0, so this constant is what says what "nothing
// ran" would look like.
const wantOpAuthControls = 6

// forgedOp builds an op that claims to come from `claimNode` — a node that never
// authored it and whose key the forger does not hold.
func forgedOp(t *testing.T, orgID, claimNode, rowID, name string) store.Op {
	t.Helper()
	hlc, ok := store.FormatHLC(time.Now().UnixMilli(), 1, claimNode)
	if !ok {
		t.Fatal("FormatHLC refused a present-day timestamp")
	}
	payload, _ := json.Marshal(map[string]any{"name": name})
	return store.Op{
		HLC: hlc, NodeID: claimNode, OrgID: orgID,
		Tbl: "products", RowID: rowID, Payload: payload,
	}
}

func rowAbsent(t *testing.T, st *store.Store, rowID string) {
	t.Helper()
	row, _ := st.GetRow("products", rowID)
	if len(row) != 0 {
		t.Fatalf("a refused op still landed as a row: %v", row)
	}
}

func TestOpAuthenticityNegativeControls(t *testing.T) {
	ran := map[string]bool{}
	control := func(name string, fn func(t *testing.T)) {
		ran[name] = true
		t.Run(name, fn)
	}

	// (a) An op batch with no signature at all is refused. This is the one that
	// was open: handleOps verified `if msg.Sig != "" || msg.PubKey != ""`, so
	// omitting both fields skipped op-level verification entirely, and an enrolled
	// peer could push a row attributed to any node id it liked.
	control("an unsigned op batch is refused, and nothing lands", func(t *testing.T) {
		a, b := pair(t)
		op := forgedOp(t, a.st.OrgID(), "victim-node", "forged-1", "FORGED")
		buf, _ := json.Marshal(opsMsg{NodeID: "victim-node", Ops: []store.Op{op}})
		code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf)
		if code != http.StatusBadRequest {
			t.Fatalf("expected 400 for an unsigned batch, got %d: %s", code, body)
		}
		if body != "op batch is unsigned: pubkey and sig are required" {
			t.Fatalf("expected the unsigned-batch refusal, got %q", body)
		}
		rowAbsent(t, a.st, "forged-1")
	})

	// (b) A batch signed with a key OTHER than the one the caller authenticated
	// with is refused, so possession of the shared secret plus any keypair is not
	// enough to speak for an enrolled node.
	control("a batch signed by a key other than the caller's enrolled key is refused", func(t *testing.T) {
		a, b := pair(t)
		imposter := newNode(t, "X", "s3cret")
		op := forgedOp(t, a.st.OrgID(), b.st.NodeID(), "forged-2", "FORGED")
		ops := []store.Op{op}
		raw, _ := json.Marshal(ops)
		buf, _ := json.Marshal(opsMsg{
			NodeID: b.st.NodeID(), Ops: ops,
			PubKey: imposter.st.PublicKeyHex(), Sig: imposter.st.Sign(raw),
		})
		code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf)
		if code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", code, body)
		}
		if body != "op batch is signed by a key other than the sender's enrolled key" {
			t.Fatalf("expected the key-binding refusal, got %q", body)
		}
		rowAbsent(t, a.st, "forged-2")
	})

	// (c) A signed batch tampered with after signing is refused, and the honest
	// op that shared the batch does not land either — the refusal is the whole
	// batch, deliberately, because a partially-applied push is a silent hole.
	control("a tampered signed batch is refused whole", func(t *testing.T) {
		a, b := pair(t)
		put(t, b.st, "products", "honest", map[string]any{"name": "Honest"})
		ops, _ := b.st.OpsAfter(map[string]string{}, Batch)
		if len(ops) == 0 {
			t.Fatal("expected an op to send")
		}
		raw, _ := json.Marshal(ops)
		sig := b.st.Sign(raw)
		ops = append(ops, forgedOp(t, a.st.OrgID(), b.st.NodeID(), "smuggled", "SMUGGLED"))
		buf, _ := json.Marshal(opsMsg{
			NodeID: b.st.NodeID(), Ops: ops,
			PubKey: b.st.PublicKeyHex(), Sig: sig,
		})
		code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf)
		if code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", code, body)
		}
		if body != "op batch signature invalid" {
			t.Fatalf("expected the batch-signature refusal, got %q", body)
		}
		rowAbsent(t, a.st, "smuggled")
		rowAbsent(t, a.st, "honest")
	})

	// (d) A pull RESPONSE must be signed too, and by the key the peer presented
	// in the handshake. Before this, handlePull sent no batch signature at all,
	// so on the plain-HTTP hop the product documents, whatever sat in the middle
	// could rewrite everything a node pulled.
	control("an unsigned pull response is refused", func(t *testing.T) {
		local := newNode(t, "L", "shared-secret")
		peer := newNode(t, "P", "shared-secret")
		hostile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if pathIsPull(r) {
				op := forgedOp(t, local.st.OrgID(), "victim-node", "pulled-unsigned", "FORGED")
				writeJSON(w, opsMsg{NodeID: "victim-node", Ops: []store.Op{op}})
				return
			}
			writeJSON(w, map[string]any{
				"node_id": peer.st.NodeID(), "org_id": local.st.OrgID(),
				"pubkey": peer.st.PublicKeyHex(), "merge_engine": MergeBuiltin,
				"vector": map[string]string{},
			})
		}))
		t.Cleanup(hostile.Close)

		res := local.eng.SyncPeer(t.Context(), "hostile", hostile.URL)
		if res.OK {
			t.Fatal("a pull answered with an unsigned batch must fail the round")
		}
		if res.Error != "pull: op batch is unsigned: pubkey and sig are required" {
			t.Fatalf("expected the unsigned-pull refusal, got %q", res.Error)
		}
		rowAbsent(t, local.st, "pulled-unsigned")
	})

	// (e) …and a pull response signed by some other key than the one the peer
	// advertised is refused, which is what binds the batch to the identity the
	// handshake pinned.
	control("a pull response signed by the wrong key is refused", func(t *testing.T) {
		local := newNode(t, "L", "shared-secret")
		peer := newNode(t, "P", "shared-secret")
		imposter := newNode(t, "X", "shared-secret")
		hostile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if pathIsPull(r) {
				op := forgedOp(t, local.st.OrgID(), "victim-node", "pulled-miskeyed", "FORGED")
				ops := []store.Op{op}
				raw, _ := json.Marshal(ops)
				writeJSON(w, opsMsg{
					NodeID: "victim-node", Ops: ops,
					PubKey: imposter.st.PublicKeyHex(), Sig: imposter.st.Sign(raw),
				})
				return
			}
			writeJSON(w, map[string]any{
				"node_id": peer.st.NodeID(), "org_id": local.st.OrgID(),
				"pubkey": peer.st.PublicKeyHex(), "merge_engine": MergeBuiltin,
				"vector": map[string]string{},
			})
		}))
		t.Cleanup(hostile.Close)

		res := local.eng.SyncPeer(t.Context(), "hostile", hostile.URL)
		if res.OK {
			t.Fatal("a pull signed by an unexpected key must fail the round")
		}
		if res.Error != "pull: op batch is signed by a key other than the sender's enrolled key" {
			t.Fatalf("expected the pull key-binding refusal, got %q", res.Error)
		}
		rowAbsent(t, local.st, "pulled-miskeyed")
	})

	// (f) A correctly signed batch from the enrolled caller is still accepted.
	// Without this the five refusals above are satisfiable by a handler that
	// rejects everything.
	control("the honest signed batch is still accepted", func(t *testing.T) {
		a, b := pair(t)
		put(t, b.st, "products", "legit", map[string]any{"name": "Legit"})
		ops, _ := b.st.OpsAfter(map[string]string{}, Batch)
		code, body := authed(t, a, b.st, "POST", "/api/sync/ops", signedBatch(b.st, ops))
		if code != 200 {
			t.Fatalf("a correctly signed batch must be accepted, got %d: %s", code, body)
		}
		if row, _ := a.st.GetRow("products", "legit"); len(row) == 0 {
			t.Fatal("the honest op did not land")
		}
	})

	if len(ran) != wantOpAuthControls {
		t.Fatalf("ran %d R-SOV-3 negative controls, expected %d — a control that stops "+
			"running must be removed deliberately, not by an early return", len(ran), wantOpAuthControls)
	}
	t.Logf("ran %d/%d R-SOV-3 negative controls", len(ran), wantOpAuthControls)
}

func pathIsPull(r *http.Request) bool { return r.URL.Path == "/api/sync/pull" }
