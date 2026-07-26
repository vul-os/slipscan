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
│   ├─ sync/    leaderless peer replication + /api/sync/* (bearer-secret)             │
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
replicate). Domain columns are declared in a registry (`store/schema.go`);
the store generates upserts and JSON serialization from it, so adding a table
is a one-line change.

Two merge classes:

| Class | Tables | Merge rule |
|---|---|---|
| Catalog (mutable) | products, variants, customers, suppliers, orders, purchase orders, payments, branches, … | **Row-level last-writer-wins** on the HLC timestamp |
| Ledger (immutable) | `stock_movements` | **Insert-only, set-union** — rows are never updated or deleted |

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
`Authorization: Bearer <shared secret>`; with no secret configured they reject
every request (fail closed):

| Endpoint | Purpose |
|---|---|
| `GET /api/sync/vector` | this node's version vector |
| `POST /api/sync/ops` | apply a pushed batch of ops |
| `POST /api/sync/pull` | return ops newer than a supplied vector (batched) |

A sync round from node B against node A: fetch A's vector → push everything A
lacks → repeatedly pull everything B lacks. Rounds run on demand ("Sync now")
and in the background once a minute for every enabled peer. Any topology works
— full mesh, hub-and-spoke through head office, or chains — because ops carry
their origin node and relay transitively.

## Frontend data layer

`src/services/api.js` exposes one interface with two drivers:

- **HTTP driver** — talks to the Go backend over the app's own origin. This is
  the real app, whether self-hosted standalone or embedded in the Vulos OS.
- **Demo driver** — a seeded in-browser dataset with the same behaviours, used
  by `npm run dev` (Vite on port 5173) and the screenshotter, so the UI runs
  with zero backend. Reports and dashboards are computed client-side
  (`src/lib/reports.js`) from the primitive tables, so both drivers produce
  identical results.
