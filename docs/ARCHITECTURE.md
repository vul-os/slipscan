# Architecture

FlowStock is a single self-contained Go binary that serves a React web UI and
owns a local SQLite database. There is **no central server**: every install is
one **branch node**, and branches replicate to each other directly. Run the
binary on a laptop, a shop-counter PC, a server, a NAS or a Raspberry Pi, then
open it in a browser — locally or, embedded in the Vulos OS shell, via an
iframe.

```
┌──────────────────────────── flowstock (one branch node) ───────────────────────────┐
│                                                                                     │
│  Browser ── React UI (shadcn/ui, recharts)                                          │
│      │  fetch  /api/*        SSE /api/events (live refresh)                          │
│  Go HTTP server (net/http)                                                           │
│   ├─ api/     application API: CRUD, stock ops, order/PO workflows, sync settings    │
│   ├─ auth/    optional single-password owner session                                │
│   ├─ sync/    leaderless peer replication + /api/sync/* (mutual key auth)           │
│   ├─ store/   HLC clock · oplog · LWW/union merge · version vector                   │
│   └─ SQLite (WAL)  ~/.flowstock/flowstock.db                                         │
│                                                                                     │
└───────────────▲───────────────────────────────────────────────────▲────────────────┘
                │  HTTP /api/sync/* (LAN · VPN · Ephor tunnel)  │
                ▼                                                     ▼
          other branch                                          other branch
```

The binary embeds the built frontend (`go:embed`), so a release is one file
with no runtime dependencies. In development the same binary reverse-proxies to
the Vite dev server instead (`npm run dev`).

## Data model

Every synced table shares one envelope: `id TEXT PRIMARY KEY`, `hlc TEXT`
(last-writer timestamp), `deleted INTEGER` (soft delete, so deletions
replicate), and `org_id TEXT` (the workspace that owns the row). Domain columns
are declared in a registry (`store/schema.go`); the store generates upserts and
JSON serialization from it, so adding a table is a one-line change.

`org_id` makes the data self-describing about which **workspace** owns it: it is
generated on a brand-new database, stamped on every op, and enforced on apply
(`ApplyOps` drops cross-org ops; `SyncPeer` refuses a foreign workspace). A
fresh node adopts a peer's `org_id` when it pairs in. Isolation therefore does
not rest on the shared sync secret alone.

Two merge classes:

| Class              | Tables                                                                                   | Merge rule                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Catalog (mutable)  | products, variants, customers, suppliers, orders, purchase orders, payments, branches, … | **Row-level last-writer-wins** on the HLC timestamp            |
| Ledger (immutable) | `stock_movements`, `po_receipts`                                                         | **Insert-only, set-union** — rows are never updated or deleted |

`po_receipts` records individual goods-receipt events; a purchase-order line's
received quantity is `SUM(qty)` over its rows, derived at the read layer and
never stored. This makes concurrent partial receipts on different branches
converge by union, where a stored last-writer-wins counter would under-count.

## Stock is a ledger, not a number

`product_variants` has no quantity column. Stock on hand =
`SUM(qty_delta)` over `stock_movements`, grouped by variant and branch.
Movements are written only by domain endpoints:

- confirming an order → `sale` movements (negative) at the order's branch
- cancelling a confirmed order → `reversal` movements (positive)
- receiving a purchase order → `receive` movements, partial receipts tracked
  per line item
- manual adjustment / stock count → `adjustment` / `count`
- transfers → paired `transfer_out` / `transfer_in` with a shared reference

Because the ledger is append-only, two branches that both traded while offline
merge by simply unioning their movements — totals converge without conflict
resolution.

## Clocks and the oplog

Every mutation is journalled to an **oplog** in the same transaction as the
row write. Each op carries a **hybrid logical clock** timestamp
(`{unix_ms}-{counter}-{node_id}`) that sorts lexically in causal order and is
globally unique. A node's **version vector** (newest HLC seen per origin node)
is derived from the oplog itself, so sync needs no per-peer state and every
round is idempotent.

Applying a remote op:

1. `INSERT OR IGNORE` into the oplog (dedupe by HLC primary key)
2. if fresh: upsert the row, guarded by `WHERE excluded.hlc > row.hlc`
   (LWW) — or plain `INSERT OR IGNORE` for the ledger table
3. fold the timestamp into the local clock so later local writes sort after it

## Sync protocol

Three endpoints, served on the same HTTP listener as the app, all requiring
**mutual Ed25519 key authentication** — each request is signed with the caller's
node key and verified against the key enrolled for that node (the shared secret
only bootstraps pairing; see [SYNC.md](SYNC.md)). With no enrolled key and no
secret they reject every request (fail closed):

| Endpoint               | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `GET /api/sync/vector` | this node's version vector                        |
| `POST /api/sync/ops`   | apply a pushed batch of ops                       |
| `POST /api/sync/pull`  | return ops newer than a supplied vector (batched) |

A sync round from node B against node A: fetch A's vector (which also carries
A's `org_id` and public key) → push everything A lacks → repeatedly pull
everything B lacks. Rounds run on demand ("Sync now") and in the background once
a minute for every enabled peer. Any topology works — full mesh, hub-and-spoke
through head office, or chains — because ops carry their origin node and relay
transitively.

Op batches are **signed** with the sender's Ed25519 key and verified on receipt
(tamper-evidence), and the **transport itself** is mutually key-authenticated:
every request is signed over a canonical envelope (method, path, body hash,
timestamp, nonce), verified against the peer's enrolled key with ±5-min
freshness and replay protection. See [SYNC.md](SYNC.md) for the full identity,
threat model and revocation story.

## Folder transport, snapshots & compaction

Beyond HTTP, a node can replicate through a **shared folder** (Dropbox,
Syncthing, NAS, USB): each node appends its own ops to `ops-<node_id>.jsonl` and
imports every other node's file through the same idempotent `ApplyOps` — files
as transport, never as truth, with one writer per file so file-sync never
conflicts.

**Compaction** bounds oplog growth: it writes a checksummed, signed
`snapshot.json` (full materialized state + version vector) and prunes ops that
every enabled peer has acknowledged, keeping the newest op per origin node so
the version vector (merged with a persisted _snapshot floor_) never regresses. A
brand-new node can rebuild from a snapshot and then sync only newer ops. Details
and the pruning tradeoff are in [SYNC.md](SYNC.md).

## Frontend data layer

`src/services/api.js` exposes one interface with two drivers:

- **HTTP driver** — talks to the Go backend over the app's own origin. This is
  the real app, whether self-hosted standalone or embedded in the Vulos OS.
- **Demo driver** — a seeded in-browser dataset with the same behaviours, used
  by `npm run dev` (Vite on port 5173) and the screenshotter, so the UI runs
  with zero backend. Reports and dashboards are computed client-side
  (`src/lib/reports.js`) from the primitive tables, so both drivers produce
  identical results.
