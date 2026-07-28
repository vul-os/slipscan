# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The shared DMTAP sync engine, as an opt-in build** (`-tags dmtap` plus
  `substrate_sync`): the suite-wide engine decides how concurrent writes merge,
  instead of FlowStock's own CRDT. Storage, transport and identity are
  unchanged; the per-node Ed25519 key additionally signs every op, so replicated
  changes are individually verified rather than trusted for arriving over an
  authenticated connection. `GET /api/substrate` reports a `state_root` — a
  content address over the whole replicated state — so two branches can be
  checked for agreement over everything, not just what is on screen. The default
  build carries no engine at all and merges with FlowStock's own CRDT, which is
  what a release ships; the engine costs 2.6 MiB of binary, and when that is
  worth paying is [Choosing an engine](docs/SYNC.md#choosing-an-engine).
- **The merge engine is part of the sync handshake.** Both engines converge but
  break an exact timestamp tie differently (node id vs author public key), so a
  mesh running both can pick different winners for the same pair of concurrent
  writes — silently, with every node reporting a healthy sync.
  `GET /api/sync/vector` now advertises `merge_engine`, and a round between two
  nodes that disagree is refused with an error naming both. A peer too old to
  send the field reads as the built-in engine.

### Upgrading

- **Switching engines pauses sync between mismatched pairs**, by design: a node
  on the DMTAP engine refuses rounds with a node still on the built-in one, and
  they resume on their own once the whole fleet has switched. Upgrading alone
  changes nothing — the default build keeps merging with the built-in engine.

- **Self-describing workspaces**: every synced row and op carries an `org_id`
  (generated on first run). Cross-workspace ops are rejected on apply and a
  peer that reports a different workspace is refused, so isolation no longer
  rests on the shared secret alone. A fresh device _pairs in_ by adopting the
  workspace it joins; an established device never re-homes.
- **Append-only goods-receipt ledger** (`po_receipts`): a line's received
  quantity is `SUM(qty)` over immutable receipt rows, so concurrent partial
  receipts on different branches converge by union instead of a last-writer-wins
  counter under-counting.
- **Folder sync transport** ("files as transport, never as truth"): replicate
  through a shared folder (Dropbox, Google Drive, Syncthing, NAS, USB). Each
  node writes only its own append-only `ops-<node_id>.jsonl`, so file-sync never
  conflicts; imports are incremental and idempotent. Includes a Settings path,
  `POST /api/sync/folder`, and a documented USB/sneakernet workflow.
- **Oplog compaction**: `POST /api/sync/compact` writes a checksummed, signed
  `snapshot.json` and prunes ops every enabled peer has acknowledged
  (conservative — keeps the newest op per node; the version vector never
  regresses). Snapshots rebuild a late joiner from state.
- **Per-node Ed25519 identity**: generated on first run; op batches and
  snapshots are signed and tamper-checked, and peer public keys are recorded on
  pairing.
- **Mutual Ed25519 transport auth for the sync mesh**: every sync request is
  signed with the node's identity key over a canonical envelope (method, path,
  body hash, timestamp, nonce). The responder verifies the signature against the
  key it recorded for that node, enforces a ±5-minute freshness window and
  rejects replayed nonces. The shared secret is retained only as (a) the pairing
  bootstrap that authorizes trust-on-first-use enrollment of a node's key, and
  (b) an opt-in compatibility fallback (`sync_secret_fallback`, default off).
  Once a peer has enrolled a key, key auth is required and the mesh **fails
  closed**. Removing a peer row revokes its key; an inbound-only peer that paired
  with you appears in the peer list (badged _inbound_) so you can revoke it.

### Changed

- Synced-table envelope gains `org_id`; `peers` gains `vector`, `pubkey` and
  `node_id` (idempotent additive migrations for existing databases).
- Sync transport auth upgraded from a single shared Bearer secret to mutual key
  authentication (the secret now bootstraps pairing rather than gating every
  request). The Settings → Sync screen drops the misleading editable sync
  port/bind fields — sync shares the app's own HTTP port.
- `received_quantity` is derived (never stored) and folded out of the schema.

### Fixed

- **`install.sh` now verifies the download against the release's
  `SHA256SUMS.txt`, and fails closed.** It previously downloaded a binary and
  ran `chmod +x` on it without checking anything — the release published a
  checksum file that nothing consumed, which documents what the bytes should
  have been while installing whatever arrived. A missing sums file, a sums file
  with no line for this archive, a digest mismatch, or a machine with no SHA-256
  tool are now all fatal, and nothing is written to `./flowstock` on any of
  them. It also downloaded the wrong asset name entirely
  (`flowstock-<os>-<arch>`, which the release workflow never produced).
- **The release workflow could never publish.** Its build step copied a
  `LICENSE` file into every archive; the repo is dual-licensed and carries
  `LICENSE-MIT` and `LICENSE-APACHE`, so `cp` failed and took the job with it.
- Joining a workspace now records the joined peer's identity and acknowledged
  vector on the real peer row (previously written to a throwaway id and lost).
- **`POST /api/sync/settings` no longer clears the shared secret when the
  field is omitted.** Previously `secret` was the only field written through
  unconditionally — `port`, `bind_addr` and `folder` already treated omission
  as "leave unchanged" — so any partial update from a script or non-bundled
  client silently destroyed the pairing secret and broke sync for every
  enrolled peer. `secret` now follows the same pointer contract as `folder`:
  omitted = unchanged, an explicit `""` = clear it deliberately. This is an
  **API contract change**: a caller that relied on omission clearing the
  secret must now send `"secret": ""` explicitly. The bundled UI always sent
  the field back anyway, so it is unaffected.
- **Sync transport auth now requires the `Bearer ` scheme.** `bearerOK`
  previously trimmed an optional `Bearer ` prefix, so a bare
  `Authorization: <secret>` (no scheme) authenticated just as well as the
  documented `Bearer <secret>` — laxer than `internal/auth`'s app-level gate,
  which has always enforced the scheme. Not an escalation (the full secret was
  still required either way), but tightened for consistency. Nothing in the
  bundled client, the sync engine, or the E2E harness sent a bare header, so
  this is a transport-only tightening with no call-site changes.

## [1.0.0] - 2026-07-19

Complete rebuild as a self-hosted, offline-first, decentralized inventory app.

### Added

- **Single Go binary** that serves a React web UI and owns a local SQLite
  database — no cloud services, no accounts, no external dependencies. The
  built frontend is embedded (`go:embed`), so a release is one file.
- **Leaderless multi-branch sync**: every install is a branch node. Branches
  exchange changes peer-to-peer over an authenticated HTTP endpoint (LAN, VPN
  or tunnel) whenever they can reach each other — no central server. Catalog
  rows merge last-writer-wins on a hybrid logical clock; stock movements are an
  append-only ledger that merges by union, so branches that were offline
  converge to identical stock totals.
- **Real stock ledger**: stock levels are derived from immutable movements
  (receive / sale / adjustment / count / transfer / reversal), per branch.
  Confirming an order deducts stock; receiving a purchase order adds it;
  cancelling a confirmed order writes a reversal.
- **Goods receiving** on purchase orders (partial receipts, automatic status:
  sent → partially received → received).
- **Stock page**: on-hand matrix per branch, adjustments, stock counts and
  between-branch transfers, plus a filterable movement ledger.
- **Real dashboard** (sales, receivable/payable, inventory value, low stock,
  recent movements) computed from live data.
- **Working reports** with CSV export: inventory valuation, stock movements,
  low stock, sales, accounts (creditors & debtors).
- **Payments** against customers and suppliers; creditors & debtors balances
  computed from orders, purchase orders and payments.
- **Live UI updates** over server-sent events whenever data changes locally or
  arrives via sync.
- **Optional owner password** gate; **`frame_ancestors`** support so the Vulos
  OS shell can embed FlowStock.
- **Demo mode**: running the UI outside the backend (`npm run dev`) boots an
  in-browser seeded dataset so anyone can try FlowStock with zero setup — also
  used by the screenshotter.
- First-run setup, per-branch settings, sync settings with a shared secret
  (fail-closed), peer management, and manual/background sync.

### Notes

- Backend: Go 1.25 + pure-Go SQLite (`modernc.org/sqlite`); frontend: React 18
  - Vite + shadcn/ui + recharts.
- Replaces the previous Supabase/Firebase cloud prototype entirely; removes all
  accounts, organizations and network dependencies.
