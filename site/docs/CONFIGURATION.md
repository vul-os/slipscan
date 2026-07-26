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

| Key | Env | Default | Notes |
|---|---|---|---|
| `port` | `FLOWSTOCK_PORT` | `8787` | HTTP listen port (also serves the sync mesh) |
| `host` | `FLOWSTOCK_HOST` | `127.0.0.1` | bind interface — set `0.0.0.0` so other branches can reach this one |
| `data_dir` | `FLOWSTOCK_DATA_DIR` | `~/.flowstock` | holds `flowstock.db` |
| `password` | `FLOWSTOCK_PASSWORD` | *(empty)* | if set, gates the app + data API behind an owner password |
| `frame_ancestors` | `FLOWSTOCK_FRAME_ANCESTORS` | *(empty)* | origins allowed to iframe FlowStock, e.g. `https://vulos.org` (for the Vulos OS shell) |

The `--port` flag overrides the port; `--version` prints the version.

## In-app settings (Settings page)

These live in the database and, except business identity, **sync between
branches**:

- **Business** — business name, this branch's name, currency code/symbol, tax
  rate (VAT %, applied to purchase orders).
- **Branches** — the shared branch registry; each install picks which branch it
  *is* at first run. Stock levels and transfers are per branch.
- **Sync** — the shared secret (required to accept sync — no secret means the
  mesh rejects everything), the reachable address to advertise to peers, and
  the peer list (name + URL, enable/disable, test, sync-now, per-peer status).

## Security notes

- The sync mesh authenticates with a bearer secret and **fails closed**: with
  no secret set, `/api/sync/*` returns 401. All branches share one secret.
- Sync is plain HTTP over whatever network you run it on. Use a trusted LAN, a
  VPN/overlay (Tailscale, WireGuard, Netbird), or an HTTPS tunnel
  (Ephor). Peer URLs may be `http://` or `https://`.
- Set `password` for a shared or internet-exposed machine; leave it empty for a
  trusted single-user device or when the Vulos OS shell provides the gate.

## Running two nodes on one machine (testing)

```bash
FLOWSTOCK_DATA_DIR=/tmp/fs-a FLOWSTOCK_PORT=8787 ./flowstock
FLOWSTOCK_DATA_DIR=/tmp/fs-b FLOWSTOCK_PORT=8788 ./flowstock
# then add http://127.0.0.1:8787 as a peer on node B (same secret on both)
```
