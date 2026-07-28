# FlowStock

**Offline-first inventory for multi-branch businesses.** FlowStock is a single
self-hosted binary that serves a web UI and stores everything in a local
SQLite database — products, stock, orders, purchasing and accounts. Each branch
runs its own copy, works fully offline, and syncs peer-to-peer with the other
branches whenever they can reach each other. There is no cloud, no account, and
no central server.

## Why FlowStock

- **Runs anywhere** — one ~12 MB binary (11.45 MiB measured for the linux/amd64
  release build) on a laptop, a shop counter, a server, a NAS, or a Raspberry
  Pi. Open it in a browser.
- **Real stock control** — stock on hand is derived from an append-only ledger
  of movements (receive, sale, adjustment, count, transfer, reversal), tracked
  per branch. Never a mutable counter that drifts.
- **Leaderless sync** — branches converge without a central authority. Catalog
  edits merge last-writer-wins; stock movements merge by union, so branches
  that traded while offline always reach the same totals.
- **Private by default** — your data lives on hardware you own. Sync is
  authenticated by **mutual Ed25519 signatures** between paired nodes and fails
  closed: an unenrolled caller with no shared secret is rejected. Every database
  also carries a workspace `org_id` that foreign ops are dropped against, so two
  businesses can never merge by accident. Details and threat model:
  [How sync works](SYNC.md#transport--security).

## Verify what you downloaded

Every release attaches `SHA256SUMS.txt` covering each archive. Check your
download against it before running the binary:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

`install.sh` in the repo does exactly this and refuses to install on a
mismatch, a missing sums file, or a machine with no SHA-256 tool to check with.

## Part of VulOS

FlowStock is part of **[VulOS](https://vulos.org)** — the open, self-hostable
web OS and app suite. VulOS software is free and open source; the only paid
services are **Ephor** (reachability) and **backup storage**. FlowStock
runs standalone, and is also hosted as an app inside the Vulos OS shell. It
pairs naturally with a Ephor tunnel when branches need to sync across the
internet without opening ports. Nothing about sync depends on it.

## Next steps

- [Getting started](GETTING-STARTED.md) — install, first run, connecting branches
- [How sync works](SYNC.md) — topologies, security, merge semantics
- [Architecture](ARCHITECTURE.md) — the Go binary, data model, oplog and clocks
- [Configuration](CONFIGURATION.md) — every setting and environment variable
