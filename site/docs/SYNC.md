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

## What merges how

- **Stock movements** are immutable facts ("JHB sold 3 of SKU X at 14:02").
  They merge by union. Stock on hand is the sum of movements, so two branches
  selling the same product offline never conflict — the totals simply add up.
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

- The sync endpoints (`/api/sync/*`) live on the app's HTTP port and
  authenticate every request with `Authorization: Bearer <shared secret>`.
  **No secret → every sync request is rejected (401).** All branches of a
  business share one secret.
- To be reachable by other branches, run with `host: 0.0.0.0`. Peers connect to
  `http://<host>:<port>` (the app's own address).
- Sync traffic is business data — run it on a **trusted network**: a LAN, a
  VPN/overlay (Tailscale, WireGuard, Netbird), or an HTTPS tunnel such as a
  [Ephor](https://github.com/vul-os/ephor) exposing the port as
  `https://…`. Peer URLs may be `http://` or `https://`.
- The secret is compared in constant time; failed auth returns 401 with no
  detail.

## Conflict examples

| Scenario | Outcome |
|---|---|
| JHB and CPT both sell SKU X while offline | Both sale movements survive; total stock reflects both |
| Both edit the same product's price offline | Newest edit wins everywhere (LWW) |
| JHB cancels an order CPT already synced | Cancellation + stock reversal replicate |
| A branch is offline for a month | First reconnect replays everything both ways in batches |

## Operational notes

- Background sync runs once a minute per enabled peer; "Sync now" (top bar or
  Settings) runs immediately and reports pushed/pulled counts per peer.
- Peer status (last attempt, result) is shown in Settings → Sync.
- The oplog is the sync source of truth and grows with history — keep it (ops
  are compact JSON rows; disk cost is small).
- Clocks: the HLC tolerates skewed wall clocks (observed timestamps push the
  clock forward), but keep branch clocks roughly sane (NTP) so
  last-writer-wins matches human expectations.
