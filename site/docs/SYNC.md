# Multi-branch sync

FlowStock's sync is built around one requirement: **a branch must keep working
with no connectivity at all**, and still end up consistent with every other
branch later. There is no central server and no "primary" branch — replication
is leaderless and peer-to-peer.

## Mental model

- Every install is a **node** with its own SQLite database.
- Every change is journalled as an **op** with a hybrid-logical-clock
  timestamp that is unique and causally ordered.
- Syncing = exchanging ops. Ops are idempotent; applying the same op twice is a
  no-op. Any node can relay any other node's ops.

## Workspaces (org id)

Every database belongs to a **workspace**, identified by an `org_id` generated
on first run. That id travels in the envelope of every synced row and every op,
so the data is **self-describing**: `ApplyOps` drops any op whose `org_id` does
not match this node's, and `SyncPeer` refuses a peer that reports a different
workspace. Isolation therefore no longer rests only on the shared secret — even
if two unrelated businesses picked the same secret, their data can never merge.

**Pairing** a brand-new device into an existing workspace: the fresh node (one
that has authored no ops yet) **adopts** the peer's `org_id` during the first
sync handshake, then pulls the catalog, stock and branches. An established node
never re-homes, so two real workspaces can never silently absorb one another.

## What merges how

- **Stock movements** are immutable facts ("JHB sold 3 of SKU X at 14:02").
  They merge by union. Stock on hand is the sum of movements, so two branches
  selling the same product offline never conflict — the totals simply add up.
- **Goods receipts** work the same way: receiving against a purchase order
  writes an immutable row to the `po_receipts` ledger, and a line's received
  quantity is `SUM(qty)` over those rows — never a stored counter. Two branches
  that each receive part of the same PO offline **add up** instead of one
  clobbering the other (which a last-writer-wins counter would have done).
- **Catalog rows** (products, prices, customers, orders, …) merge row-level
  **last-writer-wins**: the edit with the newest timestamp wins on every node.
  Deletions are soft (a `deleted` flag) so they replicate too.
- **Order/PO stock effects** are snapshotted as movements at the branch that
  confirmed/received them, so merging documents never double-counts stock. Line
  items lock once an order leaves draft.

## Topologies

Anything works, because ops relay transitively:

- **Pair** — two shops; one is reachable, the other dials it.
- **Hub and spoke** — head office is reachable; every branch adds only head
  office as a peer. Branches still receive each other's changes via the hub.
- **Mesh** — everyone lists everyone; most resilient.

A sync round with one peer both pushes and pulls, so only one side of any pair
needs to be reachable.

## Transport & security

The sync endpoints (`/api/sync/*`) live on the app's HTTP port. Authentication
is **mutual Ed25519 key auth** with the shared secret retained only for pairing.

### How a request is authenticated

Every sync request is **signed** with the caller's per-node identity key over a
canonical envelope — `method`, `path`, `sha256(body)`, a Unix `timestamp` and a
random `nonce`. The responder:

1. checks the timestamp is **fresh** (within ±5 minutes) — rejects stale or
   future-dated requests;
2. looks up the **public key it recorded** for the caller's node id and verifies
   the signature against _that_ key (never the one the caller presents) — so a
   caller cannot impersonate an enrolled node by presenting its own key;
3. rejects a **replayed** `(node, nonce)` it has seen inside the freshness
   window.

### The shared secret: pairing bootstrap, not the gate

The shared secret now has exactly two jobs:

- **Pairing bootstrap.** A node that has not yet enrolled a key proves it knows
  the secret; that authorizes the responder to record (trust-on-first-use) the
  key it presents. From then on the node authenticates **by key** and the secret
  is no longer consulted for it. This is how a new branch _earns_ enrollment.
- **Compatibility fallback** (opt-in). With `sync_secret_fallback` enabled
  (default **off**), an already-enrolled peer may still authenticate with the
  secret alone. With the default off, an enrolled peer that presents no valid
  signature is **rejected — the mesh fails closed.**

With no secret set _and_ no enrolled key, every request is rejected (401).

### Threat model

| Threat                                                | What stops it                                                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger on the network reaching the sync API       | They have neither the shared secret (to bootstrap) nor an enrolled key → rejected.                                                                                                  |
| A former branch whose key you removed                 | Its key no longer verifies. It can only re-enroll if it still knows the shared secret — so full revocation = **remove the peer row _and_ rotate the secret**.                       |
| Someone who learns the shared secret                  | They can bootstrap-enroll a _new_ key, but cannot forge requests as an _existing_ enrolled node (those verify against the recorded key). Rotate the secret to stop new enrollments. |
| A captured request replayed later                     | Fails the freshness window and/or the replay-nonce cache.                                                                                                                           |
| A tampered request body / retargeted path             | The body hash and path are inside the signed envelope → signature fails.                                                                                                            |
| Two unrelated businesses sharing a secret by accident | `org_id` isolation rejects foreign ops regardless of transport auth (see Workspaces above).                                                                                         |

**What the shared secret still protects:** the _bootstrap_ step — only someone
with the secret can get a key enrolled. **What key auth adds on top:** per-node
identity, non-repudiation, replay protection, and revocation that does not
require re-keying everyone (remove one peer row).

### Revocation

Deleting a peer row removes its recorded key, so that node can no longer
authenticate by key. A node that paired _inbound_ (dialed you) appears in
**Settings → Sync → Peers** badged **inbound** with no dial URL; removing it
revokes it. Because a node that still knows the shared secret could re-bootstrap
a fresh key, rotate the secret alongside removal to revoke completely.

### Network

- To be reachable by other branches, run with `host: 0.0.0.0`. Peers connect to
  `http://<host>:<port>` — the app's own address (sync shares the app port;
  there is no separate sync port).
- Sync traffic is business data. The signatures authenticate peers but do **not**
  encrypt the payload, so still run it on a **trusted network**: a LAN, a
  VPN/overlay (Tailscale, WireGuard, Netbird), or an HTTPS tunnel such as a
  [Ephor](https://github.com/vul-os/ephor) exposing the port as
  `https://…`. Peer URLs may be `http://` or `https://`.
- The shared secret is compared in constant time; failed auth returns 401.

### Independence first

FlowStock never _needs_ the internet or any Vulos service to sync. A LAN, a
VPN/overlay you run yourself, or the folder transport below are all first-class.
An **Ephor** tunnel is only ever an _optional convenience_ for reaching a
branch across the internet without opening a port — nothing about sync depends
on it.

## Folder sync (files as transport)

Networking is not the only way to replicate. FlowStock can also sync through a
**shared folder** — Dropbox, Google Drive, Syncthing, a NAS mount, or a USB
stick. Set it under **Settings → Sync → Sync folder** (or the `sync_folder`
setting) and point every branch at the same folder.

How it works, and why it never conflicts:

- Each node writes **only its own** ops to `ops-<node_id>.jsonl` in the folder
  (append-only). Because every node owns a single file, the file-sync tool never
  has two writers on one file — there is nothing to merge or conflict.
- Each node periodically **imports every other** `ops-*.jsonl` through the same
  idempotent `ApplyOps` used by network sync. Imports are incremental (a byte
  offset per file) and only consume whole lines, so a file still being written
  is read safely up to its last complete line.
- The files are **transport, never truth** — the database remains authoritative.
  The files are a durable, replayable log; a brand-new node pointed at the
  folder replays the full history from the files alone.

This needs no ports, no secret, and no simultaneous connectivity — the two
branches never have to be online at the same time.

### USB / sneakernet workflow

For sites with no shared network at all, carry the folder on a USB stick:

1. On branch **A**, set the Sync folder to the USB stick (e.g.
   `/Volumes/USB/flowstock`) and click **Sync folder now**. A writes
   `ops-<A>.jsonl` and imports any files already on the stick.
2. Eject and carry the stick to branch **B**. Set B's Sync folder to the stick
   and **Sync folder now**. B imports A's file (catching up on A's changes) and
   writes its own `ops-<B>.jsonl`.
3. Carry the stick back to A and sync again; A now imports B's file. Both
   branches have converged, with no network involved.

Because the per-node files are append-only and idempotent, it does not matter
how often the stick is carried, in what order, or if a trip is skipped — every
node eventually converges once the files reach it. For a late joiner, pair a
**snapshot** (below) with the op files so it starts from state rather than
replaying all history.

## Compaction & snapshots

The oplog is the sync source of truth and grows with history. **Compaction**
(Settings → Sync → **Compact**, or `POST /api/sync/compact`) keeps it bounded:

- It writes a **snapshot** — the full materialized state plus the version
  vector — to `snapshot.json` in the data directory. The snapshot is SHA-256
  **checksummed** (corruption/tamper is detectable on read) and **signed** with
  the node's identity key. A fresh node can rebuild from a snapshot alone.
- It then **prunes** oplog entries that **every enabled peer has already
  acknowledged** (peer version vectors are recorded on each sync round), always
  keeping the newest op per origin node so the version vector never regresses.

Pruning is deliberately conservative: with no peers, or any peer whose
acknowledgement is unknown, nothing is pruned. **Tradeoff:** after pruning, a
brand-new peer can no longer catch up from the oplog for the pruned range — it
imports a snapshot and then syncs the newer ops. Already-registered peers are
unaffected because, by definition, they acknowledged everything pruned. (The
folder-sync `ops-*.jsonl` files are unaffected by oplog pruning — they retain
the lines already written, so folder late-joiners still replay in full.)

## Per-node identity

Each node generates an **Ed25519 keypair** on first run. That one identity does
double duty:

- it signs the **op batches** a node pushes and the **snapshots** it writes, so
  replicated data is attributable and **tamper-evident**; and
- it signs every **sync request** (see _Transport & security_ above), which is
  how the mutual key authentication works.

Public keys are exchanged in the sync handshake and recorded against each peer
(`peers.pubkey`, keyed to the remote `node_id`) on pairing — the same recorded
key that inbound requests are then verified against.

## The shared substrate engine

FlowStock's merge rules — last-writer-wins for catalog rows, union for the
ledgers — were written for FlowStock. The Vulos suite now has one specified
implementation of those rules that several products share, and FlowStock can use
it instead of its own.

**It is an optional build, not the default one.** The engine is compiled in only
with `-tags dmtap`; the binary a release ships carries the built-in CRDT and
nothing else. Everything below describes the `-tags dmtap` build. The
built-in CRDT is not a legacy path being tolerated — it is what almost every
install runs, and it is fully tested either way.

Because the two engines break ties differently, a node **advertises which engine
it merges by** in the sync handshake, and refuses a round with a peer that
disagrees. Two algebras in one mesh converge only by luck, and the failure would
otherwise be invisible.

Nothing about the deployment changes. Storage is still SQLite, transport is
still the mutual-Ed25519 HTTP pull and the folder-sync path, and the per-node
key is still the per-node key — it simply becomes the signing key for each op as
well, so every replicated change is individually signed and verified rather than
trusted because it arrived over an authenticated connection.

What the mapping says, in FlowStock's terms:

| FlowStock                            | Substrate                     | Why                                                                                                                        |
| ------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a catalog row (product, customer, …) | one last-writer-wins register | matches what FlowStock already does: the newest write replaces the row                                                     |
| deleting a catalog row               | an ordinary write, flagged    | FlowStock re-creates a deleted row with the same write that created it, so the deletion must not be permanent in the merge |
| `stock_movements`, `po_receipts`     | an add-only set               | immutable facts, summed at read time — concurrent movements union rather than clobber                                      |

The second row is the one worth understanding. The substrate offers a stronger
kind of delete that no later edit can undo, meant for redactions and expiries.
Using it here would look correct in every test that only ever deletes — and
would then swallow the next write to that row on every branch at once, with no
error anywhere. FlowStock does not use it, and an end-to-end test deletes a
product and re-creates it to keep that true.

### Checking that two branches really agree

With the engine on, `GET /api/substrate` returns a `state_root`: a content
address over the whole replicated state, including tombstones and other things
no screen shows. Two branches that have converged return byte-identical roots.
Comparing screens tells you the visible part matches; comparing roots tells you
everything matches.

### Choosing an engine

Building with `-tags dmtap` grows the shipped binary by **2.6 MiB**: on
linux/amd64, built the way the release workflow builds it
(`-tags embed_frontend -trimpath -ldflags "-s -w"`), 12,005,560 → 14,766,264
bytes. A plain `go build` with no frontend embedded pays a little more, 3.57
MiB, because nothing is stripped. Almost none of that is the
engine — the WebAssembly module is 426 KB. The rest is
[wazero](https://wazero.io), the compiler that has to be embedded alongside
anything that runs WebAssembly. There is also a one-off ~120 ms compile at first
start, which drops to ~6 ms once the compiled-code cache under the data dir is
warm.

The criterion for paying it is narrow:

> **Pay it when you need byte-identical merge semantics with a peer running the
> same engine.** Two replicas of the _same specified implementation_ resolve
> every tie the same way and agree on a `state_root` — 33 bytes that cover every
> register, set element and tombstone. That is the guarantee, and it is worth
> 2.6 MiB when something depends on it: a FlowStock branch replicating with a
> different Vulos product over the same algebra, or a deployment that has to
> _prove_ two branches agree rather than eyeball two screens.

> **Do not pay it when you merely need a CRDT.** For "branches trade offline and
> converge", the built-in engine is already correct and already convergent — it
> is what the two-node offline-divergence tests in `backend/internal/sync/` run
> against, and it costs nothing extra. Buying the shared engine here purchases
> agreement with a peer you do not have.

Two engines in one mesh converge only by luck, so this is a fleet-wide decision:
see [Configuration](CONFIGURATION.md#substrate_sync--the-shared-merge-engine)
for the handshake that enforces it.

## Conflict examples

| Scenario                                   | Outcome                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| JHB and CPT both sell SKU X while offline  | Both sale movements survive; total stock reflects both  |
| Both edit the same product's price offline | Newest edit wins everywhere (LWW)                       |
| JHB cancels an order CPT already synced    | Cancellation + stock reversal replicate                 |
| A branch is offline for a month            | First reconnect replays everything both ways in batches |

## Operational notes

- Background sync runs once a minute per enabled peer; "Sync now" (top bar or
  Settings) runs immediately and reports pushed/pulled counts per peer.
- Peer status (last attempt, result) is shown in Settings → Sync.
- The oplog is the sync source of truth and grows with history. Ops are compact
  JSON rows so the cost is small, but you can bound it with **Compact** (see
  Compaction & snapshots above), which snapshots state and prunes ops every peer
  has acknowledged.
- Clocks: the HLC tolerates skewed wall clocks (observed timestamps push the
  clock forward), but keep branch clocks roughly sane (NTP) so
  last-writer-wins matches human expectations.
