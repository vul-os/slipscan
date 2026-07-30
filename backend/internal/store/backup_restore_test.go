package store

// R-SOV-4.4 control: the documented backup and restore must bring a node back as
// the SAME node (kotva substrate/SOVEREIGNTY.md §3.4, row SOV-11 — "a restore MUST
// NOT change the node's identity or force re-enrolment of its peers").
//
// This is the property that makes docs/CLOUD-NODE.md's backup section a procedure
// rather than a hope. It is easy to get accidentally right and easy to break
// silently: the identity, the workspace id, the oplog and the peers' enrolled keys
// all live in flowstock.db, so a "backup" that copied only some of it, or a future
// change that moved the keypair to a file outside the data dir, would produce a
// node that comes up healthy, syncs, and is a stranger to every peer it had.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// backupFiles is exactly what docs/CLOUD-NODE.md tells an operator to copy. The
// glob is the point: SQLite in WAL mode keeps committed pages in -wal until a
// checkpoint, so copying flowstock.db alone can lose the newest writes.
func backupFiles(t *testing.T, dataDir, dbName string) []string {
	t.Helper()
	got, err := filepath.Glob(filepath.Join(dataDir, dbName+"*"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(got) == 0 {
		t.Fatalf("the documented backup glob %s* matched nothing", dbName)
	}
	return got
}

func TestBackupAndRestorePreservesIdentityAndEnrolments(t *testing.T) {
	src := t.TempDir()
	dbPath := filepath.Join(src, "flowstock.db")

	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	// A node with history, an adopted workspace, and a peer whose key it enrolled
	// — the three things a restore must not lose.
	if _, err := st.AdoptOrg("shared-workspace"); err != nil {
		t.Fatalf("adopt org: %v", err)
	}
	if _, err := st.LocalPut("products", "p1", map[string]any{"name": "Anvil"}, false); err != nil {
		t.Fatalf("put: %v", err)
	}
	const peerNode = "peer-node-id"
	const peerKey = "aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
	if err := st.SavePeer(Peer{ID: "peer1", Name: "Soweto", URL: "http://198.51.100.7:8787", Enabled: true}); err != nil {
		t.Fatalf("save peer: %v", err)
	}
	st.SavePeerIdentity("peer1", peerNode, peerKey)

	before := struct {
		node, pub, org, hlc string
		vector              map[string]string
	}{st.NodeID(), st.PublicKeyHex(), st.OrgID(), "", nil}
	if before.node == "" || before.pub == "" || before.org == "" {
		t.Fatalf("the node under test has no identity to preserve: %+v", before)
	}
	ops, err := st.OwnOpsAfter("")
	if err != nil || len(ops) == 0 {
		t.Fatalf("expected authored ops: %v", err)
	}
	before.hlc = ops[len(ops)-1].HLC
	if before.vector, err = st.Vector(); err != nil {
		t.Fatalf("vector: %v", err)
	}

	// Take the backup the docs describe, from a node that has been shut down (the
	// documented order — stop, copy, start).
	files := backupFiles(t, src, "flowstock.db")
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	backup := t.TempDir()
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			// A -shm file can legitimately vanish on close; a missing .db cannot.
			if strings.HasSuffix(f, ".db") {
				t.Fatalf("read %s: %v", f, err)
			}
			continue
		}
		if err := os.WriteFile(filepath.Join(backup, filepath.Base(f)), data, 0o600); err != nil {
			t.Fatalf("write backup of %s: %v", f, err)
		}
	}

	// Destroy the original data directory, exactly as losing the instance would.
	if err := os.RemoveAll(src); err != nil {
		t.Fatalf("destroy data dir: %v", err)
	}

	// Restore into a fresh data directory — a new host, in the real procedure.
	restoredDir := t.TempDir()
	entries, err := os.ReadDir(backup)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(backup, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(restoredDir, e.Name()), data, 0o600); err != nil {
			t.Fatalf("restore %s: %v", e.Name(), err)
		}
	}

	rst, err := Open(filepath.Join(restoredDir, "flowstock.db"))
	if err != nil {
		t.Fatalf("open restored: %v", err)
	}
	defer rst.Close()

	if got := rst.NodeID(); got != before.node {
		t.Fatalf("restore changed the node id: %s -> %s (every peer's enrolment is keyed to it)", before.node, got)
	}
	if got := rst.PublicKeyHex(); got != before.pub {
		t.Fatalf("restore changed the node's public key: %s -> %s (peers would refuse it)", before.pub, got)
	}
	if got := rst.OrgID(); got != before.org {
		t.Fatalf("restore changed the workspace id: %s -> %s", before.org, got)
	}
	// The peers it had are still enrolled, in both directions of the lookup, so no
	// re-pairing is needed.
	if got := rst.PubkeyForNode(peerNode); got != peerKey {
		t.Fatalf("restore lost the peer's enrolled key: %q", got)
	}
	if got := rst.PeerPubkey("peer1"); got != peerKey {
		t.Fatalf("restore lost the peer row's key: %q", got)
	}
	peers, err := rst.ListPeers()
	if err != nil || len(peers) != 1 || peers[0].URL != "http://198.51.100.7:8787" {
		t.Fatalf("restore lost the peer's dial address: %+v (err %v)", peers, err)
	}
	// History survived, and the clock did not regress — a restored node that
	// re-minted timestamps below its own history would lose every later edit to
	// last-writer-wins.
	if got, err := rst.Vector(); err != nil || got[before.node] != before.vector[before.node] {
		t.Fatalf("restore lost history: vector %v vs %v (err %v)", got, before.vector, err)
	}
	next, err := rst.LocalPut("products", "p2", map[string]any{"name": "Vise"}, false)
	if err != nil {
		t.Fatalf("put after restore: %v", err)
	}
	if next.HLC <= before.hlc {
		t.Fatalf("the restored clock regressed: minted %s after %s", next.HLC, before.hlc)
	}
	if row, err := rst.GetRow("products", "p1"); err != nil || row["name"] != "Anvil" {
		t.Fatalf("restore lost a row: %v (err %v)", row, err)
	}
}
