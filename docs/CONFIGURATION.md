# Configuration

FlowStock runs with zero configuration. A config file is optional; settings
resolve in the order **config file → environment variable → default**.

## Config file

`flowstock.config.json`, searched in: the working directory (and parents),
`~/.config/flowstock/`, `~/.flowstock/`, then next to the executable. Example:

```json
{
  "port": "8787",
  "host": "0.0.0.0",
  "data_dir": "/var/lib/flowstock",
  "password": "",
  "frame_ancestors": ""
}
```

| Key                             | Env                                       | Default         | Notes                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`                          | `FLOWSTOCK_PORT`                          | `8787`          | HTTP listen port (also serves the sync mesh)                                                                                                                                                                                                                                                                                                 |
| `host`                          | `FLOWSTOCK_HOST`                          | `127.0.0.1`     | bind interface — set `0.0.0.0` so other branches can reach this one                                                                                                                                                                                                                                                                          |
| `data_dir`                      | `FLOWSTOCK_DATA_DIR`                      | `~/.flowstock`  | holds `flowstock.db` (and `snapshot.json` after a Compact)                                                                                                                                                                                                                                                                                   |
| `password`                      | `FLOWSTOCK_PASSWORD`                      | _(empty)_       | if set, gates the app + data API behind an owner password                                                                                                                                                                                                                                                                                    |
| `frame_ancestors`               | `FLOWSTOCK_FRAME_ANCESTORS`               | _(empty)_       | origins allowed to iframe FlowStock, e.g. `https://vulos.org` (for the Vulos OS shell)                                                                                                                                                                                                                                                       |
| `sync_secret_fallback`          | `FLOWSTOCK_SYNC_SECRET_FALLBACK`          | `false`         | when `true`, lets an already-enrolled sync peer authenticate with the shared secret alone instead of a request signature — a compatibility escape hatch for mixed-version fleets. Default `false` = mutual key auth is required once a peer has enrolled a key (the mesh fails closed)                                                       |
| `substrate_sync`                | `FLOWSTOCK_SUBSTRATE_SYNC`                | build-dependent | whether the shared DMTAP sync engine decides how concurrent writes merge. Defaults to `false` in a plain build (which carries no engine) and `true` in a `-tags dmtap` build. **Set it the same way on every node in a workspace** — see below                                                                                               |
| `substrate_accept_unsigned_ops` | `FLOWSTOCK_SUBSTRATE_ACCEPT_UNSIGNED_OPS` | `false`         | migration escape hatch. With the substrate engine on, a remote op that carries no signed envelope is **refused** — it could only be trusted for the connection it arrived over. Set `true` only while rolling a fleet off the built-in engine, and never on a node bound to a public address. The startup log states which posture is active |

The `--port` flag overrides the port; `--version` prints the version.

### `substrate_sync` — the shared merge engine

FlowStock can merge with the suite-wide
[DMTAP sync engine](SYNC.md#the-shared-substrate-engine) instead of its own CRDT.
Storage, transport and identity are unchanged; only the algebra that decides a
conflict changes.

**It is not in the default build.** The engine is compiled in only with
`-tags dmtap`; a plain `go build` (which is what `npm run build:all` and the
release workflow run) carries no DMTAP binding at all, defaults this setting to
`false`, and **exits at startup** with `substrate: this binary was built without
dmtap support` if you force it on anyway. Which build you want, and what the
engine costs, is [Choosing an engine](SYNC.md#choosing-an-engine).

**Two places where it is not optional.** The container image (`Dockerfile`) builds
`-tags dmtap` because it is the cloud-node artifact, and a node on a public
address must run that build — only it gives every op its own author signature.
[CLOUD-NODE.md §1](CLOUD-NODE.md#1-what-you-must-decide-first-which-build) has the
comparison and the consequence: the container will not sync with a branch running
a release archive.

**It is a deployment-wide switch, not a per-node preference.** Both engines
converge, but they do not share a total order: FlowStock breaks a tie between
two writes stamped in the same millisecond on the node id, the substrate on the
author's public key. A mesh running both can therefore pick different winners
for the same pair of concurrent writes.

That divergence would be silent — both nodes accept every op and simply disagree
about a row — so it is caught in the handshake instead. Each node advertises its
engine in `GET /api/sync/vector`, and a round between two nodes that disagree is
**refused** with an error naming both engines. A node old enough not to send the
field is read as the built-in engine.

**Switching a live mesh.** A node that has switched engines stops syncing with
one that has not, and they resume by themselves once every node has switched —
no operator step beyond rolling the change out. Sync pauses only between a
mismatched pair, never across the whole mesh, so a node-by-node rollout is safe;
it just leaves the not-yet-switched nodes talking only to each other until it
finishes.

`GET /api/substrate` reports `legacy_ops`: ops in this node's own history that
predate the switch and so carry no signed envelope. It also returns
`state_root` — a content address over this branch's entire replicated state. Two
branches that have converged return the identical 66-character root, which is a
far stronger check than comparing what the two screens show.

The engine costs **2.6 MiB** of binary size in a release build (3.57 MiB for a
plain unstripped `go build`) and ~150 ms at first start (~7 ms afterwards, from
a compiled-code cache under the data dir). See
[Choosing an engine](SYNC.md#choosing-an-engine) for when that is worth paying.

## In-app settings (Settings page)

These live in the database and, except business identity, **sync between
branches**:

- **Business** — business name, this branch's name, currency code/symbol, tax
  rate (VAT %, applied to purchase orders).
- **Branches** — the shared branch registry; each install picks which branch it
  _is_ at first run. Stock levels and transfers are per branch.
- **Sync** — the shared secret (required to accept sync — no secret means the
  mesh rejects everything), the reachable address to advertise to peers, the
  peer list (name + URL, enable/disable, test, sync-now, per-peer status), an
  optional **Sync folder** path, and a **Compact** action.
  - **Sync folder** — a shared folder (Dropbox, Google Drive, Syncthing, a NAS
    mount, or a USB stick) used as an alternative transport. Each device writes
    only its own `ops-<node_id>.jsonl` file, so file-sync never conflicts; no
    ports or secret are needed for this path. Point every branch at the same
    folder. See [SYNC.md](SYNC.md) for the USB/sneakernet workflow.
  - **Compact** — writes a checksummed, signed `snapshot.json` to the data
    directory and prunes oplog entries every peer has acknowledged.

Each install also has, in its database, a **workspace id** (`org_id`, generated
on first run and shared by pairing) and a **node identity** (an Ed25519 keypair,
generated on first run). Neither is edited by hand. See [SYNC.md](SYNC.md).

## Security notes

- The sync mesh uses **mutual Ed25519 key authentication** and **fails closed**:
  each request is signed by the caller's node key and verified against the key
  recorded for that node, with ±5-minute freshness and replay protection. The
  shared secret only **bootstraps pairing** (it authorizes enrolling a new
  node's key) and, if `sync_secret_fallback` is on, is an opt-in compatibility
  path. With no secret and no enrolled key, `/api/sync/*` returns 401. Full
  detail and threat model: [SYNC.md](SYNC.md).
- **Revocation:** remove a peer row to drop its key; rotate the shared secret to
  stop a removed node from re-bootstrapping a new key.
- Beyond auth, ops carry an `org_id`, so a foreign workspace's ops are dropped
  even if the transport authenticated.
- Every op batch is **signed by the node that sends it** — in both directions,
  and the signature is **required**, not optional. It is checked against the key
  that node authenticated with, so a caller cannot present one key at the
  transport and sign the payload with another. What that gets you is
  tamper-evidence for the hop: these bytes reached you as the sender sent them.
  It is **not** an author signature, so under the built-in engine a relayed op is
  not attributable to whoever wrote it. Per-**op** author signatures
  (`COSE_Sign1`, verified on their own) exist only in the `-tags dmtap` build —
  see [SYNC.md](SYNC.md#the-shared-substrate-engine) and, for why that matters on
  a public address, [CLOUD-NODE.md](CLOUD-NODE.md).
- Sync signatures authenticate peers but do not encrypt the payload. Sync is
  plain HTTP over whatever network you run it on. Use a trusted LAN or a
  VPN/overlay (Tailscale, WireGuard, Netbird). For a node on a public address you
  must terminate TLS in front of it — [CLOUD-NODE.md](CLOUD-NODE.md) is the whole
  procedure and its threat model. Peer URLs may be `http://` or `https://`.
- The **Sync folder** carries the same business data as the mesh. Treat it as
  trusted storage: a shared/private Dropbox or Syncthing folder, a NAS share
  you control, or a USB stick you keep custody of.
- Set `password` for a shared or internet-exposed machine; leave it empty for a
  trusted single-user device or when the Vulos OS shell provides the gate.

## Running two nodes on one machine (testing)

```bash
FLOWSTOCK_DATA_DIR=/tmp/fs-a FLOWSTOCK_PORT=8787 ./flowstock
FLOWSTOCK_DATA_DIR=/tmp/fs-b FLOWSTOCK_PORT=8788 ./flowstock
# then add http://127.0.0.1:8787 as a peer on node B (same secret on both)
```
