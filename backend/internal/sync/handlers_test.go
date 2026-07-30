package sync

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"flowstock/backend/internal/store"
)

// authed sends a request from an enrolled node with a correct envelope
// signature, which is the normal case for every guarded endpoint.
func authed(t *testing.T, to *node, from *store.Store, method, path string, body []byte) (int, string) {
	t.Helper()
	h := signedHeaders(from, method, path, body, nowTS(), store.NewID())
	h["Content-Type"] = "application/json"
	return req(t, method, to.server.URL+path, body, h)
}

// signedBatch marshals an ops batch the way postOps does — signed with the
// sending node's key, which handleOps now REQUIRES. A test fixture that skips
// the signature is testing the refusal, not the case it meant to test.
func signedBatch(from *store.Store, ops []store.Op) []byte {
	raw, _ := json.Marshal(ops)
	buf, _ := json.Marshal(opsMsg{
		NodeID: from.NodeID(), Ops: ops,
		PubKey: from.PublicKeyHex(), Sig: from.Sign(raw),
	})
	return buf
}

// pair returns a server node and a second node already enrolled on it.
func pair(t *testing.T) (*node, *node) {
	t.Helper()
	a := newNode(t, "A", "s3cret")
	b := newNode(t, "B", "s3cret")
	enroll(t, a, b.st, "s3cret")
	return a, b
}

// ── ping ─────────────────────────────────────────────────────────────────────

// The liveness ping is deliberately unauthenticated so an operator can check
// reachability before pairing. It must therefore reveal nothing.
func TestPingIsUnauthenticatedAndRevealsNothing(t *testing.T) {
	a := newNode(t, "A", "s3cret")
	code, body := req(t, "GET", a.server.URL+"/api/sync/ping", nil, nil)
	if code != 200 {
		t.Fatalf("ping should answer without credentials, got %d", code)
	}
	if body != "flowstock" {
		t.Fatalf("ping should identify the service and nothing else, got %q", body)
	}
	for _, secret := range []string{a.st.NodeID(), a.st.OrgID(), a.st.PublicKeyHex(), "s3cret"} {
		if secret != "" && strings.Contains(body, secret) {
			t.Fatalf("the unauthenticated ping must not leak %q", secret)
		}
	}
}

// ── endpoint auth coverage ───────────────────────────────────────────────────

// Every data endpoint is guarded. None of them may answer to an anonymous
// caller, whatever the shape of the request.
func TestAllDataEndpointsRequireAuth(t *testing.T) {
	a := newNode(t, "A", "s3cret")
	cases := []struct {
		method, path string
		body         []byte
	}{
		{"GET", "/api/sync/vector", nil},
		{"POST", "/api/sync/ops", []byte(`{"ops":[]}`)},
		{"POST", "/api/sync/pull", []byte(`{"vector":{}}`)},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			for name, headers := range map[string]map[string]string{
				"no credentials": nil,
				"wrong secret":   {"Authorization": "Bearer wrong"},
				"empty bearer":   {"Authorization": "Bearer "},
				"node id only":   {hdrNode: "some-node"},
			} {
				code, _ := req(t, c.method, a.server.URL+c.path, c.body, headers)
				if code != http.StatusUnauthorized {
					t.Fatalf("%s: expected 401, got %d", name, code)
				}
			}
		})
	}
}

// bearerOK requires the "Bearer " scheme, consistent with the app-side gate in
// internal/auth: a bare `Authorization: <secret>` (no scheme) must not
// authenticate, only the documented `Bearer <secret>` form.
func TestBearerSchemeIsEnforced(t *testing.T) {
	a := newNode(t, "A", "s3cret")

	if code, _ := req(t, "GET", a.server.URL+vectorPath, nil,
		map[string]string{"Authorization": "Bearer s3cret"}); code != 200 {
		t.Fatalf("expected the documented Bearer-scheme acceptance, got %d", code)
	}
	// A bare secret (no scheme) and every other malformed variant must not
	// authenticate, even though the underlying secret is correct.
	for _, wrong := range []string{"s3cret", "Bearer s3cre", "s3cre", "Bearer  s3cret", "bearer s3cret"} {
		if code, _ := req(t, "GET", a.server.URL+vectorPath, nil,
			map[string]string{"Authorization": wrong}); code != http.StatusUnauthorized {
			t.Fatalf("%q must not authenticate, got %d", wrong, code)
		}
	}
}

// A node with no secret configured and no enrolled peers must reject everything
// rather than falling open.
func TestNodeWithNoSecretFailsClosed(t *testing.T) {
	a := newNode(t, "A", "")
	_ = a.st.SetSetting("sync_secret", "")
	b := newNode(t, "B", "")

	for name, headers := range map[string]map[string]string{
		"anonymous":      nil,
		"empty bearer":   {"Authorization": "Bearer "},
		"signed but new": signedHeaders(b.st, "GET", vectorPath, nil, nowTS(), store.NewID()),
	} {
		code, _ := req(t, "GET", a.server.URL+vectorPath, nil, headers)
		if code != http.StatusUnauthorized {
			t.Fatalf("%s: a node with no secret must fail closed, got %d", name, code)
		}
	}
}

// ── envelope binding ─────────────────────────────────────────────────────────

// The signature covers method, path, body, timestamp and nonce. Changing any of
// them after signing must invalidate it, so a captured signature cannot be
// steered at a different request.
func TestSignatureIsBoundToTheWholeEnvelope(t *testing.T) {
	a, b := pair(t)
	body := []byte(`{"vector":{}}`)
	const path = "/api/sync/pull"

	// Baseline: the untampered request is accepted.
	if code, msg := authed(t, a, b.st, "POST", path, body); code != 200 {
		t.Fatalf("baseline signed request should succeed, got %d: %s", code, msg)
	}

	tamper := map[string]struct {
		method, path string
		body         []byte
		mutate       func(map[string]string)
	}{
		"different body": {"POST", path, []byte(`{"vector":{"n":"9"}}`), nil},
		"different path": {"POST", "/api/sync/ops", body, nil},
		"altered nonce":  {"POST", path, body, func(h map[string]string) { h[hdrNonce] = store.NewID() }},
		"altered timestamp": {"POST", path, body, func(h map[string]string) {
			h[hdrTimestamp] = strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)
		}},
		"stripped signature": {"POST", path, body, func(h map[string]string) { delete(h, hdrSig) }},
		"garbage signature":  {"POST", path, body, func(h map[string]string) { h[hdrSig] = "zzzz" }},
		"truncated signature": {"POST", path, body, func(h map[string]string) {
			h[hdrSig] = h[hdrSig][:len(h[hdrSig])-2]
		}},
	}
	for name, c := range tamper {
		t.Run(name, func(t *testing.T) {
			// Sign the ORIGINAL request, then present the tampered one.
			h := signedHeaders(b.st, "POST", path, body, nowTS(), store.NewID())
			h["Content-Type"] = "application/json"
			if c.mutate != nil {
				c.mutate(h)
			}
			code, _ := req(t, c.method, a.server.URL+c.path, c.body, h)
			if code != http.StatusUnauthorized {
				t.Fatalf("expected 401 for a signature that does not cover the request, got %d", code)
			}
		})
	}
}

// The freshness window is symmetric: a request timestamped too far in the FUTURE
// is as suspect as a stale one, so an attacker cannot mint long-lived envelopes.
func TestFutureSkewedTimestampRejected(t *testing.T) {
	a, b := pair(t)
	for name, offset := range map[string]time.Duration{
		"10 minutes ahead": 10 * time.Minute,
		"an hour ahead":    time.Hour,
		"a year ahead":     365 * 24 * time.Hour,
	} {
		t.Run(name, func(t *testing.T) {
			ts := strconv.FormatInt(time.Now().Add(offset).Unix(), 10)
			h := signedHeaders(b.st, "GET", vectorPath, nil, ts, store.NewID())
			if code, msg := req(t, "GET", a.server.URL+vectorPath, nil, h); code != http.StatusUnauthorized {
				t.Fatalf("a future-skewed request must be rejected, got %d: %s", code, msg)
			}
		})
	}
	// Just inside the window still works, so honest clock drift is tolerated.
	ts := strconv.FormatInt(time.Now().Add(2*time.Minute).Unix(), 10)
	h := signedHeaders(b.st, "GET", vectorPath, nil, ts, store.NewID())
	if code, msg := req(t, "GET", a.server.URL+vectorPath, nil, h); code != 200 {
		t.Fatalf("a request inside the skew window should succeed, got %d: %s", code, msg)
	}
}

func TestUnparseableTimestampRejected(t *testing.T) {
	a, b := pair(t)
	for _, ts := range []string{"not-a-number", "", "1e9", "99999999999999999999", "-1", "12.5"} {
		h := signedHeaders(b.st, "GET", vectorPath, nil, ts, store.NewID())
		if ts == "" {
			// An empty timestamp makes the request look unsigned; an enrolled peer
			// then fails closed for want of a signature. Either way: rejected.
			h[hdrTimestamp] = ""
		}
		if code, msg := req(t, "GET", a.server.URL+vectorPath, nil, h); code != http.StatusUnauthorized {
			t.Fatalf("timestamp %q must be rejected, got %d: %s", ts, code, msg)
		}
	}
}

// ── TOFU enrollment ──────────────────────────────────────────────────────────

// Trust-on-first-use means exactly once. Once a node id has a recorded key, a
// SECOND, different key for that same id must never silently replace it — even
// when the caller knows the shared secret. Otherwise the shared secret would
// still be sufficient to impersonate any enrolled branch, and key auth would buy
// nothing.
func TestSecondKeyForAnEnrolledNodeIsNotSilentlyReEnrolled(t *testing.T) {
	a, b := pair(t)
	original := a.st.PubkeyForNode(b.st.NodeID())
	if original != b.st.PublicKeyHex() {
		t.Fatal("precondition: B should be enrolled with its own key")
	}

	// An attacker who has the shared secret presents a fresh key for B's node id.
	attacker := newNode(t, "X", "s3cret")
	ts, nonce := nowTS(), store.NewID()
	h := map[string]string{
		hdrNode:         b.st.NodeID(),
		hdrPubkey:       attacker.st.PublicKeyHex(),
		hdrTimestamp:    ts,
		hdrNonce:        nonce,
		hdrSig:          sign(attacker.st, "GET", vectorPath, nil, ts, nonce),
		"Authorization": "Bearer s3cret",
	}
	if code, _ := req(t, "GET", a.server.URL+vectorPath, nil, h); code != http.StatusUnauthorized {
		t.Fatalf("a second key for an enrolled node must be rejected, got %d", code)
	}
	if got := a.st.PubkeyForNode(b.st.NodeID()); got != original {
		t.Fatalf("the enrolled key must be unchanged, got %q want %q", got, original)
	}
	// And the real B still authenticates, so the attempt did not lock it out.
	if code, msg := authed(t, a, b.st, "GET", vectorPath, nil); code != 200 {
		t.Fatalf("the genuine node must still authenticate, got %d: %s", code, msg)
	}
}

// Re-presenting the SAME key is idempotent — a peer that re-pairs is not
// duplicated and does not churn the recorded identity.
func TestReEnrollingTheSameKeyIsANoOp(t *testing.T) {
	a, b := pair(t)
	before, _ := a.st.ListPeers()

	for i := 0; i < 3; i++ {
		h := signedHeaders(b.st, "GET", vectorPath, nil, nowTS(), store.NewID())
		h["Authorization"] = "Bearer s3cret"
		if code, msg := req(t, "GET", a.server.URL+vectorPath, nil, h); code != 200 {
			t.Fatalf("re-pairing with the same key should succeed, got %d: %s", code, msg)
		}
	}
	after, _ := a.st.ListPeers()
	if len(after) != len(before) {
		t.Fatalf("re-pairing must not add peer rows: had %d, now %d", len(before), len(after))
	}
	if a.st.PubkeyForNode(b.st.NodeID()) != b.st.PublicKeyHex() {
		t.Fatal("the recorded key must be unchanged")
	}
}

// Enrollment must not be usable as a way to plant a key without proving
// possession of the matching private key.
func TestEnrollmentRequiresProofOfTheKeyBeingEnrolled(t *testing.T) {
	a := newNode(t, "A", "s3cret")
	b := newNode(t, "B", "s3cret")
	victim := newNode(t, "V", "s3cret")

	// B knows the secret and presents the VICTIM's public key, but can only sign
	// with its own — so it cannot enroll a key it does not hold.
	ts, nonce := nowTS(), store.NewID()
	h := map[string]string{
		hdrNode:         b.st.NodeID(),
		hdrPubkey:       victim.st.PublicKeyHex(),
		hdrTimestamp:    ts,
		hdrNonce:        nonce,
		hdrSig:          sign(b.st, "GET", vectorPath, nil, ts, nonce),
		"Authorization": "Bearer s3cret",
	}
	if code, _ := req(t, "GET", a.server.URL+vectorPath, nil, h); code != http.StatusUnauthorized {
		t.Fatalf("enrolling a key without holding it must be rejected, got %d", code)
	}
	if a.st.PubkeyForNode(b.st.NodeID()) != "" {
		t.Fatal("no key should have been enrolled by the failed attempt")
	}
}

// ── endpoint behaviour ───────────────────────────────────────────────────────

func TestVectorReportsThisNodesIdentity(t *testing.T) {
	a, b := pair(t)
	code, body := authed(t, a, b.st, "GET", vectorPath, nil)
	if code != 200 {
		t.Fatalf("vector failed with %d: %s", code, body)
	}
	var out struct {
		NodeID string            `json:"node_id"`
		OrgID  string            `json:"org_id"`
		PubKey string            `json:"pubkey"`
		Vector map[string]string `json:"vector"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("vector response is not JSON: %v", err)
	}
	if out.NodeID != a.st.NodeID() || out.OrgID != a.st.OrgID() || out.PubKey != a.st.PublicKeyHex() {
		t.Fatalf("vector must report this node's identity, got %+v", out)
	}
	// The shared secret is never part of the response.
	if strings.Contains(body, "s3cret") {
		t.Fatal("the vector response must not leak the shared secret")
	}
}

func TestMalformedBodiesOnGuardedEndpoints(t *testing.T) {
	a, b := pair(t)
	for name, c := range map[string]struct {
		path string
		body []byte
	}{
		"ops not json":      {"/api/sync/ops", []byte(`not json`)},
		"ops truncated":     {"/api/sync/ops", []byte(`{"ops":[`)},
		"ops wrong shape":   {"/api/sync/ops", []byte(`{"ops":"lots"}`)},
		"ops empty body":    {"/api/sync/ops", []byte(``)},
		"pull not json":     {"/api/sync/pull", []byte(`not json`)},
		"pull wrong shape":  {"/api/sync/pull", []byte(`{"vector":[]}`)},
		"pull empty body":   {"/api/sync/pull", []byte(``)},
		"pull vector types": {"/api/sync/pull", []byte(`{"vector":{"n":1}}`)},
	} {
		t.Run(name, func(t *testing.T) {
			code, _ := authed(t, a, b.st, "POST", c.path, c.body)
			if code != http.StatusBadRequest {
				t.Fatalf("a malformed body should be a 400, got %d", code)
			}
		})
	}
}

// An op batch that carries its own signature must verify against its own key —
// tamper-evidence that survives independently of the transport envelope.
func TestOpBatchSignatureIsVerified(t *testing.T) {
	a, b := pair(t)
	put(t, b.st, "products", "p1", map[string]any{"name": "Anvil"})
	ops, err := b.st.OpsAfter(map[string]string{}, Batch)
	if err != nil || len(ops) == 0 {
		t.Fatalf("expected ops to send: %v", err)
	}
	raw, _ := json.Marshal(ops)

	t.Run("valid batch signature is accepted", func(t *testing.T) {
		buf, _ := json.Marshal(opsMsg{NodeID: b.st.NodeID(), Ops: ops, PubKey: b.st.PublicKeyHex(), Sig: b.st.Sign(raw)})
		if code, msg := authed(t, a, b.st, "POST", "/api/sync/ops", buf); code != 200 {
			t.Fatalf("a correctly signed batch should be accepted, got %d: %s", code, msg)
		}
	})

	t.Run("mismatched batch signature is rejected", func(t *testing.T) {
		imposter := newNode(t, "X", "s3cret")
		for name, msg := range map[string]opsMsg{
			"signed by another key": {NodeID: b.st.NodeID(), Ops: ops, PubKey: b.st.PublicKeyHex(), Sig: imposter.st.Sign(raw)},
			"key without signature": {NodeID: b.st.NodeID(), Ops: ops, PubKey: b.st.PublicKeyHex()},
			"signature without key": {NodeID: b.st.NodeID(), Ops: ops, Sig: b.st.Sign(raw)},
			"garbage signature":     {NodeID: b.st.NodeID(), Ops: ops, PubKey: b.st.PublicKeyHex(), Sig: "zzzz"},
		} {
			buf, _ := json.Marshal(msg)
			if code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf); code != http.StatusBadRequest {
				t.Fatalf("%s: expected 400, got %d: %s", name, code, body)
			}
		}
	})
}

// Ops carrying a FOREIGN workspace id must never be merged, even though the
// caller is a fully authenticated peer. Transport auth and workspace isolation
// are separate guarantees.
func TestOpsFromAForeignWorkspaceAreNotApplied(t *testing.T) {
	a, b := pair(t)

	// A legitimate op from our own workspace, for contrast.
	put(t, b.st, "products", "ours", map[string]any{"name": "Ours"})
	mine, _ := b.st.OpsAfter(map[string]string{}, Batch)
	if len(mine) == 0 {
		t.Fatal("expected an op to send")
	}

	foreign := mine[0]
	foreign.OrgID = "some-other-workspace"
	foreign.RowID = "theirs"
	foreign.Payload = []byte(`{"name":"Theirs"}`)

	buf := signedBatch(b.st, []store.Op{foreign})
	code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf)
	if code != 200 {
		t.Fatalf("the request itself is well formed and authenticated: got %d: %s", code, body)
	}
	var out struct {
		Applied int `json:"applied"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	if out.Applied != 0 {
		t.Fatalf("a foreign workspace's ops must not be applied, applied=%d", out.Applied)
	}
	rows, _ := a.st.ListRows("products", true)
	for _, r := range rows {
		if r["id"] == "theirs" {
			t.Fatal("a foreign workspace's row must never land in our tables")
		}
	}

	// The same op with our own workspace id IS applied, proving the rejection was
	// the org check and not something incidental.
	buf = signedBatch(b.st, mine)
	if code, body = authed(t, a, b.st, "POST", "/api/sync/ops", buf); code != 200 {
		t.Fatalf("our own ops should be accepted, got %d: %s", code, body)
	}
	_ = json.Unmarshal([]byte(body), &out)
	if out.Applied == 0 {
		t.Fatal("ops from our own workspace should have been applied")
	}
}

// Ops naming a table this build does not know are skipped rather than faulting
// the node — a newer peer must not be able to crash an older one.
func TestOpsForUnknownTablesAreSkipped(t *testing.T) {
	a, b := pair(t)
	put(t, b.st, "products", "p1", map[string]any{"name": "Anvil"})
	ops, _ := b.st.OpsAfter(map[string]string{}, Batch)
	ops[0].Tbl = "tables_from_the_future"

	buf := signedBatch(b.st, ops)
	code, body := authed(t, a, b.st, "POST", "/api/sync/ops", buf)
	if code != 200 {
		t.Fatalf("an unknown table should be skipped, not fault the node: got %d: %s", code, body)
	}
	var out struct {
		Applied int `json:"applied"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	if out.Applied != 0 {
		t.Fatalf("an unknown table's op must not be applied, applied=%d", out.Applied)
	}
}

func TestPullReturnsOpsTheCallerLacks(t *testing.T) {
	a, b := pair(t)
	put(t, a.st, "products", "p1", map[string]any{"name": "Anvil"})

	// An empty vector means "I have nothing" — everything comes back.
	code, body := authed(t, a, b.st, "POST", "/api/sync/pull", []byte(`{"vector":{}}`))
	if code != 200 {
		t.Fatalf("pull failed with %d: %s", code, body)
	}
	var out opsMsg
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Ops) == 0 {
		t.Fatal("pull with an empty vector should return the node's ops")
	}
	if out.NodeID != a.st.NodeID() {
		t.Fatalf("pull should identify the responding node, got %q", out.NodeID)
	}

	// Pulling again with an up-to-date vector returns nothing.
	vec, _ := a.st.Vector()
	buf, _ := json.Marshal(pullReq{Vector: vec})
	code, body = authed(t, a, b.st, "POST", "/api/sync/pull", buf)
	if code != 200 {
		t.Fatalf("pull failed with %d: %s", code, body)
	}
	_ = json.Unmarshal([]byte(body), &out)
	if len(out.Ops) != 0 {
		t.Fatalf("a caller that is up to date should get nothing, got %d ops", len(out.Ops))
	}
}

// ── replay cache ─────────────────────────────────────────────────────────────

// The nonce cache is scoped per node, so two branches picking the same nonce do
// not lock each other out.
func TestNonceCacheIsScopedPerNode(t *testing.T) {
	a := newNode(t, "A", "s3cret")
	b := newNode(t, "B", "s3cret")
	c := newNode(t, "C", "s3cret")
	enroll(t, a, b.st, "s3cret")
	enroll(t, a, c.st, "s3cret")

	shared := store.NewID()
	ts := nowTS()
	for name, from := range map[string]*node{"B": b, "C": c} {
		h := signedHeaders(from.st, "GET", vectorPath, nil, ts, shared)
		if code, msg := req(t, "GET", a.server.URL+vectorPath, nil, h); code != 200 {
			t.Fatalf("%s should not be blocked by another node's nonce, got %d: %s", name, code, msg)
		}
	}
	// But each node's own replay is still caught.
	h := signedHeaders(b.st, "GET", vectorPath, nil, ts, shared)
	if code, _ := req(t, "GET", a.server.URL+vectorPath, nil, h); code != http.StatusUnauthorized {
		t.Fatalf("B replaying its own nonce must be rejected, got %d", code)
	}
}

func TestNonceCacheExpiresEntries(t *testing.T) {
	c := newNonceCache()
	if !c.checkAndAdd("n1", 50*time.Millisecond) {
		t.Fatal("a fresh nonce should be accepted")
	}
	if c.checkAndAdd("n1", 50*time.Millisecond) {
		t.Fatal("an immediate replay should be rejected")
	}
	time.Sleep(80 * time.Millisecond)
	// Past its TTL the entry is forgotten — which is safe, because a request that
	// old is already outside the freshness window.
	if !c.checkAndAdd("n1", 50*time.Millisecond) {
		t.Fatal("an expired nonce entry should have been pruned")
	}
}
