# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **An enrolled sync peer could push ops attributed to any node it liked.**
  `handleOps` verified the op-batch signature only `if msg.Sig != "" ||
msg.PubKey != ""`, so omitting two JSON fields skipped op-level verification
  altogether: an authenticated peer could POST a batch of ops carrying another
  node's `node_id` and they were applied and written. And `handlePull` returned
  no batch signature at all, so the pull direction had **no** op-level tamper
  evidence — on the plain-HTTP hop the docs describe, whatever sat in the middle
  could rewrite everything a node pulled. The batch signature is now
  **mandatory in both directions** and bound to the key the sender authenticated
  with, so a caller cannot present one key at the transport and sign the payload
  with another. Six negative controls with an asserted count:
  `backend/internal/sync/op_authenticity_test.go`.
- **A substrate node merged remote ops that carried no signed envelope.** With
  the shared engine installed as merge authority, an op with `cose == ""` was
  counted as "legacy" and then merged by the built-in algebra — accepted on the
  strength of the connection it arrived over, which is precisely what per-op
  authenticity is supposed to remove (kotva `substrate/SOVEREIGNTY.md`
  R-SOV-3.2). It is now **refused**, and still counted so a mixed fleet is
  visible. `substrate_accept_unsigned_ops` (default `false`, announced in the
  startup log) is the migration hatch for a fleet still rolling off the built-in
  engine; it must not be on for a node bound to a public address. Five per-op
  controls with an asserted count:
  `backend/internal/substrate/op_authenticity_test.go`.

### Added

- **`docs/CLOUD-NODE.md`** — running a branch node on a cloud instance, which is
  a different threat model from the LAN/VPN topologies the other pages assume.
  Which build (and why the substrate one is not optional there), bind address,
  the reverse proxy that terminates TLS declared as the trust boundary it is,
  firewall, the container and systemd artifacts, backup/restore, upgrade, and a
  closing section on what the setup still does not protect against.
- **`docs/SOVEREIGNTY.md`** — FlowStock's answer to the substrate's five
  adoption properties and thirteen-row checklist, with a runnable command behind
  each row and **not-met** recorded where it is not met: per-op authenticity and
  the shared merge engine hold on the `-tags dmtap` build and not in the release
  archives, and mutual auth is not channel-bound because FlowStock terminates no
  TLS.
- **The R-SOV-1 gate, lifted verbatim** into `tools/gates/no-broker-dep.sh` with
  FlowStock's configuration in `scripts/sovereignty-gate.sh` (`make
sovereignty-gate`). It runs the gate and the gate's own self-control in one
  step, because a copied gate that has gone inert reports a pass nobody earned,
  and CI additionally diffs the copy against the substrate's live one so a silent
  fork fails the build. FlowStock references no reachability broker at all — no
  seam is declared, which is the strictest posture the gate has. Proven against
  this tree, not just the gate's fixtures: a planted default broker endpoint in
  `backend/internal/config/config.go` makes it exit 1.
- **A tested backup and restore.**
  `store.TestBackupAndRestorePreservesIdentityAndEnrolments` takes the backup
  `docs/CLOUD-NODE.md` describes, destroys the data directory, restores it, and
  asserts the node returns with the same node id, key, workspace, peer
  enrolments, history and a clock that did not regress — so "restore does not
  force re-pairing" is a check rather than a claim.

### Changed

- **The container image now builds `-tags dmtap`.** It is the cloud-node
  artifact, and only that build signs every op individually. `--build-arg
BUILD_TAGS=embed_frontend` restores the release-archive build for a LAN
  deployment. The consequence is stated in the Dockerfile and in
  `docs/CLOUD-NODE.md`: the merge engine is a workspace-wide choice, so the
  container refuses to sync with a branch running a release archive.
- **Corrected two documentation claims that were wrong, not merely vague.**
  `docs/GETTING-STARTED.md` told operators to `docker run
ghcr.io/vul-os/flowstock:latest`; no such image exists, and the release
  workflow explicitly does not build or push one. And `docs/CONFIGURATION.md`
  said ops "are **signed** with the node's Ed25519 key and verified on receipt
  (tamper-evident)" without distinguishing a per-hop batch signature from a
  per-op author signature — the built-in engine has only the former, and a reader
  plans a threat model around the difference.
- **Ephor is named only as a dated, optional, not-integrated convenience.** It
  was in the getting-started path ("expose a branch through an Ephor tunnel"),
  which reads as a supported step. It is **not ready as of 2026-07-30**;
  `docs/SYNC.md`, `docs/OVERVIEW.md` and `docs/CLOUD-NODE.md` now say so with the
  date attached, name the gap it would close (a branch that can open no port),
  and point at the folder transport that covers that gap today. No code, build or
  configuration references it, which the gate enforces.
- **`store/identity.go`'s package comment stopped understating the code.** It
  still said the transport "authenticates with the shared Bearer secret exactly
  as before" and called mutual key auth "a documented next step" — a claim stale
  in the too-pessimistic direction, which nobody audits.

- **The DMTAP sync engine is now a fetched, pinned module instead of a vendored
  copy.** `third_party/dmtapsync/` (~2,070 LOC plus a 427 KB `.wasm`) is gone;
  `go.mod` requires `github.com/vul-os/kotva/bindings/go v0.2.0` and the
  `replace` directive that redirected the old
  `github.com/vul-os/envoir/bindings/go` import to that directory is gone with
  it. The Go package renamed with the repo — `kotvasync`, was `dmtapsync` — so
  the four files that import it were updated; nothing else in FlowStock moved.
  Vendoring existed for two reasons, both now resolved upstream: the binding was
  not a fetchable module, and its embedded `.wasm` was gitignored, so a proxy
  fetch arrived unable to compile. The artifact is committed and tied to its
  Rust sources by `wasm_provenance.json`, and the module is tagged.
- **The vendored-copy drift guards are replaced, not deleted.**
  `vendor_drift_test.go` hashed a directory that no longer exists, and `go.sum`
  now answers "are these the module's bytes?" on every build rather than only
  when a test runs. What `go.sum` does not answer — whether the engine inside
  still computes the algebra FlowStock merges on — is now covered by
  `backend/internal/substrate/engine_conformance_test.go`, which drives 14 of
  the 24 frozen `SYNC.md` §10 conformance vectors through the linked engine and
  never skips, and by `engine_pin_test.go`, which asserts in both build
  configurations that the engine is required at a pinned version, is not
  redirected by a `replace`, has both `go.sum` hashes, and that no vendored copy
  has come back. This mattered: the engine in v0.2.0 is a fresh build (427,731
  bytes against the vendored copy's 426,890), so the pinned bytes were bytes
  nothing in this repo had ever executed.
- **Re-measured the engine's cost against the published module.** The binary
  delta for `-tags dmtap` is +3,748,000 bytes on a plain `go build`
  (15,301,826 → 19,049,826), which is 3.57 MiB where the note in
  `backend/internal/substrate/mapping.go` said 3.58 — a rounding boundary
  crossed by 1,216 bytes, not a regression. The release-build delta is
  unchanged at 2.6 MiB (linux/amd64, stripped: 12,001,464 → 14,762,168). Cold
  `Open` moved from ~118 ms to ~150 ms and warm from ~5.7 ms to ~7 ms, tracking
  the 841-byte-larger artifact.
- **The stale-claim scan in `scripts/docs-mirror.mjs` now covers `docs/*.md`,
  not only the hand-authored site shells.** Both banned claims originated in
  `docs/` and the shells only repeated them, so guarding the copies and not the
  source left the regression path open. One stale claim survived the earlier
  correction pass and is fixed here: `backend/cmd/flowstock/main.go` still
  described the sync mesh as carrying "its own bearer-secret auth" after the
  transport moved to mutual Ed25519.

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

- **The published docs contradicted the code on authentication, in the weaker
  direction.** `site/` is the product site this repo ships, and its docs pages
  had gone stale: they described sync as authenticated by a bearer secret long
  after the code required **mutual Ed25519** signatures, and omitted the
  `org_id` workspace isolation, `substrate_sync`, `sync_secret_fallback` and the
  `SHA256SUMS.txt` verification instructions entirely. A reader plans a threat
  model around a published security claim, so this was the worst kind of doc
  bug. `site/docs/*.md` are now byte-identical copies of `docs/*.md` — enforced
  by `npm run docs:check` (`scripts/docs-mirror.mjs`) in CI, which also scans
  the hand-authored `site/*.html` shells for the specific claims that shipped
  and were wrong. The landing page's sync diagram said `(Bearer)` and its
  binary-size claim said `~15 MB` against a measured 11.45 MiB; both corrected.
- **The vendored-engine provenance check silently skipped in CI.**
  `TestVendoredMatchesPinnedUpstream` compares `third_party/dmtapsync/` against
  the upstream commit `VENDOR.md` pins, which needs an `envoir` checkout that CI
  never made — so the one guard that catches drift laundered through a
  regenerated `SHA256SUMS.txt` reported success for work it did not do. CI (and
  the release workflow) now check `vul-os/envoir` out at the pinned commit and
  set `FLOWSTOCK_REQUIRE_UPSTREAM_VENDOR_CHECK=1`, which turns every remaining
  "could not compare" path into a failure. Where it can still skip (a laptop
  with no checkout) it names what was not verified and how many files went
  uncompared, and it asserts it compared all ten when it runs.
- **CI now runs the race detector** (`go test -race`, in both tag
  configurations). It was clean locally, but nothing in CI stood behind that.
- `Makefile`'s `.PHONY` list omitted `test-e2e`.
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
