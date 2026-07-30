//go:build dmtap

package substrate_test

// R-SOV-3.2 controls for the build that can actually satisfy it: with the shared
// engine as merge authority, every replicated change carries its own COSE_Sign1
// envelope and is verified on its own — never accepted because it arrived over an
// authenticated connection (kotva substrate/SOVEREIGNTY.md §3.3.2, row SOV-7).
//
// The transport-level controls (an unsigned batch, a batch signed by the wrong
// key, a hostile pull response) live in backend/internal/sync; these are the
// per-op ones, which is the property that makes an internet-exposed node
// defensible rather than merely authenticated.
//
// One deliberate difference from the demonstration sketched in SOVEREIGNTY §3.3:
// a bad op fails the WHOLE batch here rather than being dropped while its
// siblings apply. ApplyOps admits a batch before it writes any of it, so a
// per-op skip would commit a partially-merged push with nothing recording which
// half was dropped. A refusal an operator can see is worth more than a
// best-effort merge, so the batch aborts and the peer's round reports the error.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"flowstock/backend/internal/store"
)

// wantPerOpControls is the number of controls below. It exists so a file that
// stops exercising them fails instead of passing on nothing.
const wantPerOpControls = 5

func forged(t *testing.T, orgID, claimNode, rowID, name, cose string) store.Op {
	t.Helper()
	hlc, ok := store.FormatHLC(time.Now().UnixMilli(), 1, claimNode)
	if !ok {
		t.Fatal("FormatHLC refused a present-day timestamp")
	}
	payload, _ := json.Marshal(map[string]any{"name": name})
	return store.Op{
		HLC: hlc, NodeID: claimNode, OrgID: orgID,
		Tbl: "products", RowID: rowID, Payload: payload, Cose: cose,
	}
}

func TestPerOpAuthenticityControls(t *testing.T) {
	ran := map[string]bool{}
	control := func(name string, fn func(t *testing.T)) {
		ran[name] = true
		t.Run(name, fn)
	}

	// (a) The gap this file was written for: an op with NO envelope used to be
	// counted as "legacy" and then merged by the built-in algebra — accepted on
	// the strength of the connection alone, which is exactly what R-SOV-3.2
	// forbids. It must now be refused.
	control("an op with no envelope is refused", func(t *testing.T) {
		a := newNode(t, "a")
		op := forged(t, a.st.OrgID(), "forger-node", "no-envelope", "ENVELOPELESS", "")
		n, err := a.st.ApplyOps([]store.Op{op})
		if err == nil {
			t.Fatalf("an envelopeless op must be refused, applied=%d", n)
		}
		if !strings.Contains(err.Error(), "carries no signed envelope") {
			t.Fatalf("expected the no-envelope refusal, got %v", err)
		}
		if row := a.row("products", "no-envelope"); len(row) != 0 {
			t.Fatalf("a refused op still landed: %v", row)
		}
		if st := a.eng.Stats(); st.LegacyOps != 1 {
			t.Fatalf("the refusal must still be counted for the operator, legacy_ops=%d", st.LegacyOps)
		}
	})

	// (b) An envelope that is not even hex, and one that is hex but not a
	// COSE_Sign1, are both refused by the engine rather than merged.
	control("a malformed envelope is refused", func(t *testing.T) {
		a := newNode(t, "a")
		for name, cose := range map[string]string{
			"not hex":          "zzzz",
			"hex but not cose": "deadbeef",
		} {
			op := forged(t, a.st.OrgID(), "forger-node", "malformed-"+name, "MALFORMED", cose)
			if _, err := a.st.ApplyOps([]store.Op{op}); err == nil {
				t.Fatalf("%s: a malformed envelope must be refused", name)
			}
			if row := a.row("products", "malformed-"+name); len(row) != 0 {
				t.Fatalf("%s: a refused op still landed: %v", name, row)
			}
		}
	})

	// (c) A VALID envelope, correctly signed by its author, is refused when the op
	// claims to come from a different FlowStock node. Only FlowStock knows which
	// key a node enrolled at pairing, so only FlowStock can catch this.
	control("a validly signed op claiming another node is refused", func(t *testing.T) {
		a, b := newNode(t, "a"), newNode(t, "b")
		pair(t, a, b)
		c := newNode(t, "c")

		b.put("products", "authored-by-b", map[string]any{"name": "Real"})
		ops, err := b.st.OpsAfter(map[string]string{}, 100)
		if err != nil || len(ops) == 0 {
			t.Fatalf("expected an op from b: %v", err)
		}
		var envelope store.Op
		for _, op := range ops {
			if op.RowID == "authored-by-b" {
				envelope = op
			}
		}
		if envelope.Cose == "" {
			t.Fatal("b's own op should carry an envelope")
		}
		// Same envelope, relabelled as c's work.
		stolen := envelope
		stolen.NodeID = c.st.NodeID()
		a.st.RecordPeerIdentity(c.st.NodeID(), c.st.PublicKeyHex())

		if _, err := a.st.ApplyOps([]store.Op{stolen}); err == nil {
			t.Fatal("an op signed by b but claiming c must be refused")
		} else if !strings.Contains(err.Error(), "but is signed by") {
			t.Fatalf("expected the author-binding refusal, got %v", err)
		}
		if row := a.row("products", "authored-by-b"); len(row) != 0 {
			t.Fatalf("a misattributed op still landed: %v", row)
		}
	})

	// (d) Replay: the same signed op applied twice changes nothing the second
	// time. Ops are idempotent by op id, so a captured envelope is not a lever.
	control("a replayed op is a no-op", func(t *testing.T) {
		a, b := newNode(t, "a"), newNode(t, "b")
		pair(t, a, b)
		b.put("products", "replayed", map[string]any{"name": "Once"})
		ops, _ := b.st.OpsAfter(map[string]string{}, 100)

		first, err := a.st.ApplyOps(ops)
		if err != nil || first == 0 {
			t.Fatalf("the first application should apply ops: applied=%d err=%v", first, err)
		}
		rootAfterFirst := a.root()
		second, err := a.st.ApplyOps(ops)
		if err != nil {
			t.Fatalf("replaying a valid batch must not error: %v", err)
		}
		if second != 0 {
			t.Fatalf("a replayed batch applied %d ops; it must apply none", second)
		}
		if a.root() != rootAfterFirst {
			t.Fatal("a replayed batch changed the state root")
		}
	})

	// (e) The honest path still works, so the four refusals above are not
	// satisfiable by an ingest that refuses everything.
	control("a correctly signed op from an enrolled node applies", func(t *testing.T) {
		a, b := newNode(t, "a"), newNode(t, "b")
		pair(t, a, b)
		b.put("products", "honest", map[string]any{"name": "Honest"})
		a.sync(b)
		if row := a.row("products", "honest"); row["name"] != "Honest" {
			t.Fatalf("the honest op did not land: %v", row)
		}
		if st := a.eng.Stats(); st.Refused != 0 || st.LegacyOps != 0 {
			t.Fatalf("the honest path must refuse nothing: %+v", st)
		}
	})

	if len(ran) != wantPerOpControls {
		t.Fatalf("ran %d per-op authenticity controls, expected %d", len(ran), wantPerOpControls)
	}
	t.Logf("ran %d/%d per-op authenticity controls", len(ran), wantPerOpControls)
}

// The migration escape hatch exists, is off by default, and is the ONLY way an
// envelopeless op merges. A default that could be flipped by configuration alone
// with nothing asserting the default is how a fail-closed guard quietly opens.
func TestUnsignedOpsAcceptedOnlyWithTheExplicitOptOut(t *testing.T) {
	a := newNode(t, "a")
	op := forged(t, a.st.OrgID(), "forger-node", "migration", "MIGRATING", "")

	if _, err := a.st.ApplyOps([]store.Op{op}); err == nil {
		t.Fatal("the DEFAULT must refuse an envelopeless op")
	}
	a.st.SetAcceptUnsignedRemoteOps(true)
	if n, err := a.st.ApplyOps([]store.Op{op}); err != nil || n != 1 {
		t.Fatalf("with the opt-out on, the op should merge: applied=%d err=%v", n, err)
	}
	if row := a.row("products", "migration"); row["name"] != "MIGRATING" {
		t.Fatalf("the opt-out did not merge the op: %v", row)
	}
	if st := a.eng.Stats(); st.LegacyOps != 2 {
		t.Fatalf("both the refusal and the acceptance must be counted, legacy_ops=%d", st.LegacyOps)
	}
	a.st.SetAcceptUnsignedRemoteOps(false)
	op2 := forged(t, a.st.OrgID(), "forger-node", "migration-2", "MIGRATING", "")
	if _, err := a.st.ApplyOps([]store.Op{op2}); err == nil {
		t.Fatal("turning the opt-out back off must restore the refusal")
	}
}
