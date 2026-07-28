// Package sync implements FlowStock's leaderless branch-to-branch replication.
//
// There is no central server. Every node can both serve sync requests (over
// the same HTTP mux as the app) and dial peers. A sync round is stateless and
// symmetric — push what the peer lacks, then pull what we lack — so any
// topology works (pair, hub-and-spoke, full mesh) and a branch that was
// offline simply catches up on its next reachable round.
//
// Every sync request is authenticated by a mutual Ed25519 signature over a
// canonical request envelope, verified against the key recorded for the caller
// node; the shared secret survives only as the pairing bootstrap and an opt-in
// compatibility fallback (see transport_auth.go). With no secret and no
// enrolled key, requests are rejected (fail closed).
package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"flowstock/backend/internal/store"
)

// Batch bounds how many ops travel per request.
const Batch = 2000

// Merge-engine identifiers exchanged in the /api/sync/vector handshake.
//
// The two engines are each convergent but do not share a total order —
// FlowStock's built-in CRDT breaks an HLC tie on node id, the DMTAP substrate
// on the author's public key — so a mesh running both can pick different
// winners for the same pair of concurrent writes. That divergence is silent:
// every node reports a healthy sync and simply disagrees about a row.
//
// So the engine is part of the handshake and a mismatch refuses the round.
// A node running a build from before this field existed omits it, which is
// exactly the built-in engine, so the empty string normalizes to MergeBuiltin.
const (
	MergeBuiltin   = "builtin"
	MergeSubstrate = "substrate"
)

// normalizeEngine maps the wire value onto a known engine. An absent field is
// an older build, which is always the built-in engine.
func normalizeEngine(v string) string {
	if v == "" {
		return MergeBuiltin
	}
	return v
}

// Engine wires the store to the network. SecretFn is read on every request so
// rotating the secret in settings takes effect immediately.
type Engine struct {
	Store    *store.Store
	SecretFn func() string
	// FolderFn, if set, returns the shared-folder path for file-based transport
	// (empty = disabled). Read on every round so toggling it takes effect live.
	FolderFn func() string
	// AllowSecretFallback lets an already-enrolled peer authenticate with the
	// shared secret alone (compatibility). Default false = key auth required once
	// a peer has enrolled a key (fail closed).
	AllowSecretFallback bool
	// MergeEngine names the algebra this node merges by (MergeBuiltin or
	// MergeSubstrate). It is advertised in the handshake and must match the
	// peer's, because two engines that disagree about tie-breaks converge only
	// by luck. Empty is treated as MergeBuiltin.
	MergeEngine string
	NodeID      string
	client      *http.Client
	nonces      *nonceCache
	mu          sync.Mutex // serializes outbound rounds
}

func New(s *store.Store, secretFn func() string) *Engine {
	return &Engine{
		Store:       s,
		SecretFn:    secretFn,
		NodeID:      s.NodeID(),
		MergeEngine: MergeBuiltin,
		client:      &http.Client{Timeout: 20 * time.Second},
		nonces:      newNonceCache(),
	}
}

type opsMsg struct {
	NodeID string     `json:"node_id"`
	Ops    []store.Op `json:"ops"`
	// PubKey + Sig sign the batch (Ed25519 over the marshaled ops). The request
	// envelope signature (transport_auth.go) already binds the whole body to the
	// caller's key; this batch signature is kept as defence-in-depth so a relayed
	// batch stays attributable and tamper-evident on its own.
	PubKey string `json:"pubkey,omitempty"`
	Sig    string `json:"sig,omitempty"`
}

type pullReq struct {
	Vector map[string]string `json:"vector"`
}

// Handler returns the /api/sync/* routes. Every route except the unauthenticated
// liveness ping is wrapped in guard, which enforces mutual key authentication.
func (e *Engine) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/sync/ping", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "flowstock")
	})
	mux.HandleFunc("GET /api/sync/vector", e.guard(e.handleVector))
	mux.HandleFunc("POST /api/sync/ops", e.guard(e.handleOps))
	mux.HandleFunc("POST /api/sync/pull", e.guard(e.handlePull))

	return mux
}

func (e *Engine) handleVector(w http.ResponseWriter, r *http.Request) {
	vec, err := e.Store.Vector()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"node_id":      e.NodeID,
		"org_id":       e.Store.OrgID(),
		"pubkey":       e.Store.PublicKeyHex(),
		"merge_engine": normalizeEngine(e.MergeEngine),
		"vector":       vec,
	})
}

func (e *Engine) handleOps(w http.ResponseWriter, r *http.Request) {
	var msg opsMsg
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// If the batch carries its own signature, it must verify against its public
	// key — tamper-evidence independent of the transport envelope.
	if msg.Sig != "" || msg.PubKey != "" {
		body, _ := json.Marshal(msg.Ops)
		if !store.VerifySig(msg.PubKey, body, msg.Sig) {
			http.Error(w, "op batch signature invalid", http.StatusBadRequest)
			return
		}
	}
	applied, err := e.Store.ApplyOps(msg.Ops)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"applied": applied})
}

func (e *Engine) handlePull(w http.ResponseWriter, r *http.Request) {
	var req pullReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ops, err := e.Store.OpsAfter(req.Vector, Batch)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, opsMsg{NodeID: e.NodeID, Ops: ops})
}

// Result reports the outcome of syncing one peer.
type Result struct {
	PeerID  string `json:"peer_id"`
	OK      bool   `json:"ok"`
	Pushed  int    `json:"pushed"`
	Pulled  int    `json:"pulled"`
	Adopted bool   `json:"adopted"`
	Error   string `json:"error"`
}

// SyncPeer runs one full round against a peer base URL.
func (e *Engine) SyncPeer(ctx context.Context, peerID, baseURL string) Result {
	e.mu.Lock()
	defer e.mu.Unlock()

	res := Result{PeerID: peerID}
	secret := e.SecretFn()
	if secret == "" {
		res.Error = "sync secret not set"
		return res
	}
	base := strings.TrimRight(baseURL, "/")
	auth := "Bearer " + secret

	// 1. Learn the peer's vector (and workspace id), then push everything it
	// lacks. The window vector advances past each pushed batch so batches never
	// overlap.
	peer, err := e.fetchVector(ctx, base, auth)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	peerVec, peerNode, peerOrg, peerPub := peer.Vector, peer.NodeID, peer.OrgID, peer.PubKey
	if peerPub != "" {
		// Learn/confirm the peer's identity so inbound requests from that same
		// node can later be authenticated by key.
		e.Store.SavePeerIdentity(peerID, peerNode, peerPub)
	}
	// Pairing: a brand-new node adopts the workspace it is joining. An
	// established node keeps its own workspace, and mismatched ops are rejected
	// on apply, so two real workspaces never silently merge over a shared secret.
	if adopted, aerr := e.Store.AdoptOrg(peerOrg); aerr != nil {
		res.Error = aerr.Error()
		return res
	} else if adopted {
		res.Adopted = true
	}
	if myOrg := e.Store.OrgID(); peerOrg != "" && myOrg != "" && peerOrg != myOrg {
		res.Error = fmt.Sprintf("peer is a different workspace (%s ≠ %s); refusing to sync", peerOrg, myOrg)
		return res
	}
	// Both sides must merge by the same algebra. Exchanging ops across a
	// mismatch does not fail loudly on its own — both nodes would accept every
	// op and quietly disagree about which concurrent write won — so the round is
	// refused here instead. During a rolling upgrade this is the expected state
	// until every node is switched; it clears itself with no operator action
	// beyond finishing the rollout.
	if mine := normalizeEngine(e.MergeEngine); peer.MergeEngine != mine {
		res.Error = fmt.Sprintf(
			"peer merges by %q but this node merges by %q; refusing to sync until the whole workspace agrees",
			peer.MergeEngine, mine)
		return res
	}
	// Record what this peer has acknowledged (a conservative lower bound: its
	// vector before we push). It gates safe oplog pruning — an op is dropped
	// only once every registered peer has it.
	e.Store.SavePeerVector(peerID, peerVec)
	window := peerVec
	for {
		ops, err := e.Store.OpsAfter(window, Batch)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		if len(ops) == 0 {
			break
		}
		for _, op := range ops {
			if op.HLC > window[op.NodeID] {
				window[op.NodeID] = op.HLC
			}
		}
		if err := e.postOps(ctx, base, auth, ops); err != nil {
			res.Error = err.Error()
			return res
		}
		res.Pushed += len(ops)
		if len(ops) < Batch {
			break
		}
	}

	// 2. Pull everything we lack.
	for {
		myVec, err := e.Store.Vector()
		if err != nil {
			res.Error = err.Error()
			return res
		}
		ops, err := e.pull(ctx, base, auth, myVec)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		if len(ops) == 0 {
			break
		}
		n, err := e.Store.ApplyOps(ops)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		res.Pulled += n
		if len(ops) < Batch {
			break
		}
	}

	res.OK = true
	return res
}

// peerInfo is what the /api/sync/vector handshake tells us about a peer.
type peerInfo struct {
	Vector      map[string]string `json:"vector"`
	NodeID      string            `json:"node_id"`
	OrgID       string            `json:"org_id"`
	PubKey      string            `json:"pubkey"`
	MergeEngine string            `json:"merge_engine"`
}

func (e *Engine) fetchVector(ctx context.Context, base, auth string) (peerInfo, error) {
	var body peerInfo
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/sync/vector", nil)
	req.Header.Set("Authorization", auth)
	e.signRequest(req, nil)
	resp, err := e.client.Do(req)
	if err != nil {
		return body, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return body, fmt.Errorf("vector: HTTP %d (%s)", resp.StatusCode, statusText(resp))
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return body, err
	}
	if body.Vector == nil {
		body.Vector = map[string]string{}
	}
	body.MergeEngine = normalizeEngine(body.MergeEngine)
	return body, nil
}

func (e *Engine) postOps(ctx context.Context, base, auth string, ops []store.Op) error {
	body, _ := json.Marshal(ops)
	buf, _ := json.Marshal(opsMsg{
		NodeID: e.NodeID,
		Ops:    ops,
		PubKey: e.Store.PublicKeyHex(),
		Sig:    e.Store.Sign(body),
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/api/sync/ops", bytes.NewReader(buf))
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Type", "application/json")
	e.signRequest(req, buf)
	resp, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("push: HTTP %d (%s)", resp.StatusCode, statusText(resp))
	}
	return nil
}

func (e *Engine) pull(ctx context.Context, base, auth string, vec map[string]string) ([]store.Op, error) {
	buf, _ := json.Marshal(pullReq{Vector: vec})
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/api/sync/pull", bytes.NewReader(buf))
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Type", "application/json")
	e.signRequest(req, buf)
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("pull: HTTP %d (%s)", resp.StatusCode, statusText(resp))
	}
	var msg opsMsg
	if err := json.NewDecoder(resp.Body).Decode(&msg); err != nil {
		return nil, err
	}
	return msg.Ops, nil
}

// statusText returns a short trimmed body for surfacing an auth error to the UI.
func statusText(resp *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return strings.TrimSpace(string(b))
}

// TestPeer checks reachability + auth against a peer URL.
func (e *Engine) TestPeer(ctx context.Context, baseURL string) bool {
	base := strings.TrimRight(baseURL, "/")
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/sync/vector", nil)
	req.Header.Set("Authorization", "Bearer "+e.SecretFn())
	e.signRequest(req, nil)
	resp, err := e.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// SyncAll syncs every enabled peer (or one, if only != "") and records the
// outcome on the peers table.
func (e *Engine) SyncAll(ctx context.Context, only string) []Result {
	peers, err := e.Store.ListPeers()
	if err != nil {
		return nil
	}
	var results []Result
	for _, p := range peers {
		if !p.Enabled || (only != "" && p.ID != only) {
			continue
		}
		if strings.TrimSpace(p.URL) == "" {
			continue // inbound-only enrollment row: we authenticate it, never dial it
		}
		res := e.SyncPeer(ctx, p.ID, p.URL)
		status := "ok: pushed " + itoa(res.Pushed) + ", pulled " + itoa(res.Pulled)
		if !res.OK {
			status = "error: " + res.Error
		}
		e.Store.UpdatePeerStatus(p.ID, time.Now().UTC().Format(time.RFC3339), status)
		results = append(results, res)
	}
	// Flush to / drain from the shared folder too, if one is configured. This
	// runs even with no peers, so a folder-only (offline / sneakernet) topology
	// works with no network sync at all.
	if e.FolderFn != nil {
		if dir := e.FolderFn(); dir != "" {
			e.FolderSync(dir)
		}
	}
	return results
}

// RunBackground syncs all enabled peers every interval until ctx is cancelled.
func (e *Engine) RunBackground(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.SyncAll(ctx, "")
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
