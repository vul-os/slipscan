# Substrate adoption — what FlowStock demonstrates, and what it does not

FlowStock takes its decentralisation from the KOTVA substrate: the specification
plus the published shared libraries. It is **not** part of the reference
implementation pair (envoir + ephor), so it gets no coupling to those and must
stand up its own node on a cloud instance if an operator wants one.

The substrate states the obligation in
`kotva/substrate/SOVEREIGNTY.md` (owner ruling, **2026-07-30**) as five
properties, R-SOV-1..5, with a thirteen-row checklist. This page is FlowStock's
answer, and its rule is: **every row points at something you can run.** A row
whose evidence is a sentence is marked as such, because a checklist nobody has
executed is an obligation, not a result.

Verified against the tree at the time of writing. Re-run the commands rather than
trusting the table.

---

## The five properties

| #       | Property                                                   | FlowStock                                                                                      |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R-SOV-1 | No dependency on a reachability broker in any default path | **Met.** No reference at all — not in the build, the configuration or the startup path. Gated. |
| R-SOV-2 | Peer-to-peer over an operator-supplied address             | **Met.** Manual peer enrolment, no directory, no default endpoint, no LAN assumption.          |
| R-SOV-3 | Authentication safe on the open internet                   | **Met on the `-tags dmtap` build. NOT met on the built-in engine** (§R-SOV-3 below).           |
| R-SOV-4 | A real cloud-node deployment path                          | **Met.** [CLOUD-NODE.md](CLOUD-NODE.md), container artifact, tested restore.                   |
| R-SOV-5 | The merge engine is the shared one                         | **Met on the `-tags dmtap` build. NOT met in the release archives** (§R-SOV-5 below).          |

Two of the five are build-dependent, and pretending otherwise would be the exact
kind of status inflation this page exists to prevent. The consequence is stated
once, plainly: **a node on a public address must run the `-tags dmtap` build**,
which is what the container image builds and what
[CLOUD-NODE.md](CLOUD-NODE.md) §1 requires. A LAN or VPN install may stay on the
built-in engine; it is convergent and fully tested, it just does not sign each op
individually and does not run the shared algebra.

---

## R-SOV-1 — no reachability broker

FlowStock references no broker anywhere. That is the compliant answer and the
strictest posture the substrate's gate has: no seam is declared, because there is
nothing to gate.

```sh
make sovereignty-gate
```

lifts `tools/gates/no-broker-dep.sh` **verbatim** from the substrate (do not edit
that copy — re-copy it; FlowStock's configuration lives in
`scripts/sovereignty-gate.sh`) and runs all three checks plus the gate's own
self-control, because a copied gate that has gone inert reports a pass nobody
earned. CI runs it on every push and separately diffs the copy against the
substrate's live one, so a silent fork fails the build.

- **C-DEP** reads `go list -deps ./...` — the import closure under **default**
  build tags, 233 entries at the time of writing.
- **C-START** scans every non-exempt file. Exempt: `docs/`, `site/` (prose, and
  `site/docs/` is a byte-identical mirror of `docs/`), and `tools/gates/`, whose
  only mention of a broker is the pattern it searches for.
- **C-SEAM** reports "no seam declared".

Proof of teeth against this tree, not just against the gate's own fixtures:
planting `const defaultBrokerEndpoint = "https://rendezvous.ephor.example"` in
`backend/internal/config/config.go` makes the gate exit 1 naming the file and
line; removing it returns exit 0.

**R-SOV-1b (dated status).** Ephor is recorded as **not ready as of 2026-07-30**
in [SYNC.md](SYNC.md#independence-first), [OVERVIEW.md](OVERVIEW.md#part-of-vulos)
and [CLOUD-NODE.md](CLOUD-NODE.md), each with the date attached so the claim is
re-checked rather than inherited. It is named only under "optional / the gap we do
not solve", never in the minimum-setup path — the getting-started page now sends
you to your own cloud node instead.

**The honest gap this leaves.** A branch that can open no port, and cannot reach
any branch that can, is unreachable over the network. The folder transport
(Dropbox / Syncthing / a USB stick) covers it without any network at all. That is
a loss of reach, not of function, which is what R-SOV-1 requires the degradation
to be.

---

## R-SOV-2 — peer-to-peer over an operator-supplied address

An operator types the other node's URL into **Settings → Sync → Peers**. There is
no central directory, no bootstrap list, and no mDNS — enrolment is manual, full
stop.

- **No default endpoint.** `flowstock.config.example.json` contains no peer,
  broker or bootstrap address, and the shipped defaults are `127.0.0.1:8787` plus
  a data dir. An unset peer list is an empty peer list; nothing is dialled.
- **Address is a route, key is the identity.** The first successful round records
  (trust-on-first-use) the peer's Ed25519 key against its `node_id`; after that
  the key is what authenticates it, and re-enrolling the same node at a new URL
  does not change who it is. A matching address with a mismatching key fails
  closed — `sync.verifyRequest` verifies against the **recorded** key, never the
  one the caller presents.
- **Workspace isolation on top.** Two established workspaces cannot merge even if
  they share a secret; ops carry an `org_id` and a mismatched handshake is
  refused.

Evidence:

- `backend/internal/sync/sync_test.go` — `TestPairingAdoptsWorkspaceAndBlocksForeignWorkspace`,
  `TestTwoBranchesSyncOverHTTPAndSurviveOffline`.
- `backend/internal/sync/transport_auth_test.go` — the enrolled-key path and its
  refusals.
- `e2e/sync-two-node.spec.js` — two real processes, two data dirs, paired from a
  URL through the browser.
- A non-loopback demonstration, run by hand against the real binaries: two nodes
  bound to a LAN address (loopback refused, confirmed), node B enrolled into A
  from the typed URL alone, a change created on each side and pulled by the other,
  and byte-identical `state_root` on both — `1eb4a64e…72e7ce`, with `legacy_ops: 0`.

---

## R-SOV-3 — authentication safe on the open internet

### 3.1 Mutual key-authenticated sync — met

Every sync request is signed with the caller's per-node Ed25519 key over a
canonical envelope (method, path, `sha256(body)`, timestamp, nonce) and verified
against the key recorded for that `node_id`. The shared secret survives only as
the pairing bootstrap and an opt-in compatibility fallback that is **off by
default**.

The substrate scopes the shared-secret transport arm to _a trusted network_, and a
node bound to a public address is not on one. FlowStock's default is the
Identity-authenticated arm: with `sync_secret_fallback` off, an enrolled peer that
sends no valid signature is rejected.

**Channel binding is not achieved, and that is a real limitation.** FlowStock
terminates no TLS, so there is no exporter to bind a key proof to; the signature
covers the request envelope, not the channel. What that costs is stated in
[CLOUD-NODE.md](CLOUD-NODE.md) §3 and §9: the terminating reverse proxy in front
of a public node is a trust boundary, and it should be one you run.

### 3.2 Individually signed ops — met on `-tags dmtap` only

This is the property that makes an internet-exposed node defensible, so here is
exactly what holds where.

**On the `-tags dmtap` build:** every op carries its own `COSE_Sign1` envelope,
minted by its author and verified on its own. An op with **no** envelope is
refused. A validly signed op that claims to come from a node other than the one
whose key signed it is refused — only FlowStock knows which key a node enrolled at
pairing, so only FlowStock can catch that. Both refusals abort the batch and are
counted in `GET /api/substrate`.

**On the built-in engine:** ops carry no author signature. Nothing in an op says
who wrote it beyond a `node_id` field anyone can set. This is a genuine
limitation, not a wording problem, and it is why the container image and the
cloud-node guide require the other build.

Two things were fixed here rather than documented around:

1. An envelopeless op used to be counted as "legacy" and then **merged** by the
   built-in algebra even with the substrate installed — accepted on the strength
   of the connection alone. It is now refused by default, with
   `substrate_accept_unsigned_ops` as an explicit, logged, off-by-default
   migration hatch.
2. The batch signature was verified **only if present** (`if msg.Sig != "" ||
msg.PubKey != ""`), so omitting two JSON fields skipped op-level verification
   entirely — an enrolled peer could push a row attributed to any `node_id` it
   liked and it would be written. And `handlePull` sent no batch signature at all,
   so the pull direction had no op-level tamper evidence whatsoever. The signature
   is now **mandatory in both directions**, and bound to the key the sender
   authenticated with.

### 3.3 Replay defence — met

Request replay: a `(node, nonce)` cache plus a ±5-minute symmetric freshness
window. Op replay: ops are idempotent by op id, so re-applying a batch applies
none of it and does not move the state root.

Ordered-domain decode: `store.ParseHLC` rejects any timestamp outside its
fixed-width domain, at **both** entry points into `ApplyOps` — the width hazard
that lets one hostile remote timestamp invert lexical ordering for every op minted
afterwards. `substrate.flowstockHLC` applies the same bound on the way out.

### 3.4 Fail closed on mismatch — met

No secret and no enrolled key → 401. Enrolled peer with no signature → 401. Wrong
workspace → refused. Merge-engine mismatch → the round is refused naming both
engines. Substrate ingest refusal → the batch aborts and the transaction rolls
back.

### Negative controls, with asserted counts

```sh
go test ./backend/internal/sync/ -run TestOpAuthenticityNegativeControls -v
go test -tags dmtap ./backend/internal/substrate/ -run TestPerOpAuthenticityControls -v
```

Six transport-level controls and five per-op controls, each asserting the
**specific** refusal string rather than "an error", each including a positive
control so the refusals are not satisfiable by a handler that rejects everything,
and each asserting how many controls ran — a suite that runs zero negative tests
is otherwise indistinguishable from one that runs eleven.

`TestUnsignedOpsAcceptedOnlyWithTheExplicitOptOut` pins the default: refuse,
accept only with the flag, refuse again when it is turned back off.

**Deliberate deviation.** The substrate's sketch has a tampered op rejected "while
its sibling ops still apply". FlowStock aborts the whole batch instead:
`ApplyOps` admits a batch before writing any of it, so a per-op skip would commit
a partially-merged push with nothing recording which half was dropped. A refusal
an operator can see is worth more than a best-effort merge.

---

## R-SOV-4 — a real cloud-node deployment path

[CLOUD-NODE.md](CLOUD-NODE.md) is the operator guide, written for someone who has
only a VPS and the documentation.

| Requirement                | Where                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configurable bind address  | `host` / `FLOWSTOCK_HOST`, default loopback (safe), any interface available. Demonstrated on a LAN address with loopback refused.                                  |
| Honest TLS story           | FlowStock terminates **no** TLS and says so. A terminating reverse proxy is required for a public node, declared as a trust boundary, with a working Caddy config. |
| Deploy artifact            | `Dockerfile` (builds `-tags dmtap`, publishes to loopback in the documented `docker run`), or a verified release archive plus the systemd unit in §5.              |
| Data durability and backup | State is a SQLite database outside the process; stop/copy-the-glob/start, with the WAL trap called out, and a restore procedure.                                   |
| Operator documentation     | Install, bind, TLS, firewall, enrolment, backup, upgrade, and a closing section on what the setup still does not protect you from.                                 |

The restore is tested, not asserted:
`go test ./backend/internal/store/ -run TestBackupAndRestorePreservesIdentityAndEnrolments`
takes the documented backup, **destroys the data directory**, restores it, and
asserts the node comes back with the same node id, the same public key, the same
workspace, its peers still enrolled in both lookup directions, its history intact
and its clock not regressed. No re-pairing.

**Corrected while walking the path.** The docs told operators to
`docker run ghcr.io/vul-os/flowstock:latest`. No such image exists — the release
workflow builds archives and explicitly does not build or push an image. That was
a deployment instruction that could never work.

---

## R-SOV-5 — the merge engine is the shared one

**On the `-tags dmtap` build:** the merge authority is `kotva-sync` through the
published Go binding, `github.com/vul-os/kotva/bindings/go`, pinned in `go.mod`
and hashed in `go.sum`. FlowStock keeps storage, transport and identity; the
substrate's algebra decides which write wins.

**In the release archives:** the built-in CRDT decides. That is a private
re-implementation of the same rules, and R-SOV-5 is **not met** by that binary.
It is convergent and tested, and two FlowStock nodes running it agree — but they
agree because two copies of one implementation agree, which is the thing R-SOV-5
is written against. The cloud-node path therefore requires the substrate build,
and this row stays marked not-met for the default build until the default itself
changes. **That is an owner decision, not a documentation one**: flipping it
changes the shipped artifact, adds 2.6 MiB, and strands every existing built-in
mesh until the whole fleet rolls over.

Evidence for the build that does run it:

```sh
go test ./backend/internal/substrate/ -run TestEngineIsAPinnedModuleNotAVendoredCopy -v
FLOWSTOCK_REQUIRE_SPEC_VECTOR_CHECK=1 FLOWSTOCK_KOTVA_DIR=../kotva \
  go test -tags dmtap ./backend/internal/substrate/ \
  -run 'TestEngineDrivesTheFrozenConformanceVectors|TestFrozenVectorsMatchTheSpecFile' -v
```

- **The pin gate** asserts four properties together: `go.mod` requires the module
  at the version written down a second time in the test (so the test cannot read
  the answer off the thing it is checking), nothing redirects it with a
  `replace`, `go.sum` carries both hashes for that exact version, and the old
  vendored tree is gone. It runs in **both** tag configurations, because a plain
  build is where a re-vendored copy would most easily slip back in unnoticed.
- **The vectors**: 14 of the suite's 24 frozen SYNC vectors are driven through
  the linked engine with the count asserted (`wantDrivenVectors = 14`). The other
  ten exercise algebra FlowStock's mapping never reaches — RGA ordering,
  movable-tree cycles, fast-join, reconciliation, sparse namespace scoping — and
  the reason is written down next to the constant rather than left to inference.
- **The literals** in the test are re-derived from
  `conformance/vectors/sync_vectors.json` in the substrate repo: 76 values across
  14 vectors, count asserted. Locally it can skip with a printed NOT VERIFIED
  sentence naming what went unchecked; in CI `FLOWSTOCK_REQUIRE_SPEC_VECTOR_CHECK=1`
  turns every skip path into a failure, and the substrate is checked out at the
  engine's own tag so the vectors are the ones that version was proved against.
- **Convergence is checked on the state root**, not on rendered rows: two branches
  return byte-identical 66-character roots covering every register, set element
  and tombstone. `GET /api/substrate`.

---

## Checklist

| #      | Row                                                                                      | Status                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| SOV-1  | No hard broker dependency in the default build or startup path                           | **met** — `make sovereignty-gate`                                                                                          |
| SOV-2  | Any broker behind a declared, default-off seam                                           | **met, vacuously** — there is no broker integration to gate                                                                |
| SOV-3  | The R-SOV-1 gate runs in CI on every push, self-control included                         | **met** — `.github/workflows/ci.yml`, plus a drift diff against the substrate's copy                                       |
| SOV-4  | Enrols a peer from an operator-supplied address + key; no directory, no default endpoint | **met**                                                                                                                    |
| SOV-5  | mDNS optional, never the only path                                                       | **met, vacuously** — there is no mDNS; enrolment is manual only                                                            |
| SOV-6  | Mutually key-authenticates sync, channel-bound, never §13 on a node leg                  | **partial** — mutual key auth over a canonical envelope; **not channel-bound**, because FlowStock terminates no TLS (§3.1) |
| SOV-7  | Verifies every op's own signature rather than trusting the connection                    | **met on `-tags dmtap`; not met on the built-in engine** (§3.2)                                                            |
| SOV-8  | Rejects replayed and rolled-back ops; ordered counters persisted before emission         | **met**                                                                                                                    |
| SOV-9  | Fails closed on any auth mismatch, no shared-secret-only fallback                        | **met** — the fallback exists, is off by default, and is documented as a compatibility hatch                               |
| SOV-10 | Non-loopback bind from configuration, declared TLS story                                 | **met** — demonstrated on a LAN address; TLS is declared as _not ours_, with the proxy documented                          |
| SOV-11 | Deploy artifact, documented backup/restore preserving identity, operator guide           | **met** — and the restore is a test, not a paragraph                                                                       |
| SOV-12 | Depends on the shared merge engine; executes the frozen vectors with an asserted count   | **met on `-tags dmtap`; not met in the release archives** (§R-SOV-5)                                                       |
| SOV-13 | Dates any claim about a coordinator's readiness                                          | **met** — "not ready as of 2026-07-30", in three places                                                                    |

## Residual, stated plainly

- **Two rows are build-dependent** (SOV-7, SOV-12) and one is partial (SOV-6).
  Making the substrate build the default would close the first two; it is an owner
  decision with a fleet-wide migration attached.
- **No channel binding.** Without TLS termination there is nothing to bind to. The
  proxy in front of a public node reads everything.
- **A tampered batch fails whole**, not per-op. Deliberate; see §3.3's deviation
  note.
- **14 of 24 vectors** are driven, with the ten skipped named and justified. A
  wider mapping would drive more.
- **This page is a snapshot.** Re-run the commands; a checklist row nobody has
  executed against the current tree is an obligation, not a result.
