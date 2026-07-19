# Self-Hosting SlipScan

The desktop app is already self-hosted — your machine is the server. This page covers the next step: running the core **headless** on a box that is always on (NAS, home server, mini-PC), with your devices as clients. Same Rust core, same SQLite books, no new trust model.

What the server does **today**: serve the core service surface (books, transactions, documents, ledger, reports, packs, vault metadata) over HTTP to clients you point at it. What it does **not do yet**: `slipscan-server` contains no mailbox connectors and no scheduler — held-open IMAP IDLE / Pub/Sub connections and scheduled bank syncs are the design goal for this mode, not shipped behaviour. Until then, run `slipscan mail-sync` / `slipscan import` on the box from cron for the same effect.

## slipscan-server

`slipscan-server` (crate `crates/slipscan-server`) is a thin axum wrapper over the exact same core services the desktop app calls — one service layer, two transports (see [API.md](API.md)).

```sh
# build
cargo build --release -p slipscan-cli

# run — binds 127.0.0.1:7151, and only that, by default
slipscan serve

# LAN bind is an explicit opt-in, never a default: a non-loopback --listen
# is refused unless you also pass --lan
slipscan serve --listen 0.0.0.0:7151 --lan
```

```sh
curl http://127.0.0.1:7151/health
# {"status":"ok","version":"0.2.0"}
```

Non-negotiable #3 applies verbatim: localhost by default, no hosted SlipScan service of any kind, and the server only ever *listens* — today it makes no outbound calls at all (when connectors land in server mode, outbound calls will still go only to providers **you** configured).

**Headless secrets:** a server box may have no desktop keychain. On Linux servers, use Secret Service (`gnome-keyring` works fine headless with a login-unlocked keyring) — the same `SecretStore` abstraction the desktop uses. Note secret *material* is never set over HTTP — the server rejects secret-flagged settings writes; set secrets locally on the box via the CLI. Keychain access headless is gated only by the service session being unlocked; the trade-off is covered in [THREAT-MODEL.md](THREAT-MODEL.md#self-host-mode).

## Recommended layout

```
┌────────────────────── your home box / NAS ──────────────────────┐
│  slipscan-server (127.0.0.1:7151)                               │
│    ├── slipscan.sqlite (books) + documents/                     │
│    └── cron: slipscan mail-sync / slipscan import               │
│        (in-server connectors + scheduler: planned)              │
│  reverse proxy (caddy/nginx) — TLS + auth, LAN or VPN only      │
└─────────────────────────────────────────────────────────────────┘
          ▲                    ▲                    ▲
      desktop app          laptop              phone (later)
```

## Reverse-proxy pattern

Keep the server on loopback and put a proxy you control in front for TLS and auth:

```caddyfile
# Caddyfile — LAN/VPN-internal
slipscan.home.arpa {
    tls internal
    basic_auth {
        you $2a$14$...   # caddy hash-password
    }
    reverse_proxy 127.0.0.1:7151
}
```

The same shape works with nginx or Traefik. Rules of thumb:

- **Don't port-forward SlipScan to the internet.** Your finances do not belong on the public internet, TLS or not.
- Prefer a VPN/overlay (WireGuard, Tailscale-style) for out-of-home access — your devices join the network; nothing is exposed.
- If you ever must expose an HTTPS endpoint, scope the proxy route to exactly that path and keep auth on everything else. (There is currently no SlipScan route that needs one — Microsoft Graph push, which would, is not implemented; see [EMAIL.md](EMAIL.md#outlook--microsoft-365--connector-implemented-no-app-surface-yet).)

## Exposing via your own Vulos Relay (optional)

If you use the VulOS family, [Vulos Relay](https://vulos.org) is its reachability fabric — a way to give a machine behind NAT a stable, authenticated endpoint **you** operate. SlipScan can sit behind *your* relay like any other service: the relay terminates reachability, your box holds the data.

This is strictly optional and strictly yours: SlipScan does not ship with, default to, or depend on any relay — including Vulos Relay. It is one more "endpoint the user explicitly configured." SlipScan works fully without it; the products connect across a clean seam, they don't require each other.

## Devices as clients

Today the server's clients are anything that speaks HTTP — `curl`, scripts, your own tooling against the `/api/v1` surface ([API.md](API.md)). The desktop app **cannot yet connect to a remote server**: it always opens its local SQLite book, and there is no "Settings → Server → Connect" option. Desktop-as-client, multi-user households, and the Tauri mobile companion are Phase 5 ([ROADMAP.md](../ROADMAP.md)).

## Data folder on the server box

The server resolves the same movable data folder as every other surface — the pointer file in the box's app-config directory, platform default when unset ([CONFIGURATION.md](CONFIGURATION.md#data-locations)). `slipscan serve` without `--db` serves that folder; `GET /api/v1/data_status` reports it read-only (folder, sizes, pointer path — with an explicit `--db` the route answers 503, since the served database is not the managed folder's).

**Moving the folder is deliberately local-only** (`slipscan data move` on the box, or desktop Settings) — there is no HTTP route for it, on purpose: a move takes a local filesystem path as its target and deletes the old copy afterwards, so exposing it would let any bearer-token holder redirect and then destroy your data over the network; and mid-move nothing may hold the database open, which a remote client cannot coordinate. **Stop the server before moving** — the move takes SQLite's exclusive lock on the database and refuses while any process (the server included) still has it open — then restart it; it picks up the new location from the pointer.

Back up the server the same way as the desktop: sync the data folder (database + `documents/`) with your own cloud or copy it while the server is stopped. **SlipScan ships no backup service — the folder, its location, and its backup are yours.** Secrets stay in that box's keychain and are re-entered on restore — by design.

---

**Next:** [API.md](API.md) — the full service surface exposed by slipscan-server and Tauri IPC.
