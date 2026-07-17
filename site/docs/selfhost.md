# Self-Hosting SlipScan

The desktop app is already self-hosted — your machine is the server. This page covers the next step: running the core **headless** on a box that is always on (NAS, home server, mini-PC), with your devices as clients. Same Rust core, same SQLite books, no new trust model.

Why bother: an always-on box keeps mailbox connections held open, runs scheduled bank syncs, and serves every device in the house from one set of books.

## slipscan-server

`slipscan-server` (crate `crates/slipscan-server`) is a thin axum wrapper over the exact same core services the desktop app calls — one service layer, two transports (see [API.md](API.md)).

```sh
# build
cargo build --release -p slipscan-cli

# run — binds 127.0.0.1:7151, and only that, by default
slipscan serve

# LAN bind is an explicit opt-in, never a default
slipscan serve --listen 0.0.0.0:7151
```

```sh
curl http://127.0.0.1:7151/health
# {"status":"ok","version":"0.1.0"}
```

Non-negotiable #3 applies verbatim: localhost by default, no hosted SlipScan service of any kind, and the server only ever *listens* — it makes no outbound calls except the providers **you** configured (mailboxes, bank adapters, your LLM endpoint).

**Headless secrets:** a server box may have no desktop keychain. On Linux servers, use Secret Service (`gnome-keyring` works fine headless with a login-unlocked keyring) — the same `SecretStore` abstraction the desktop uses. User-presence prompts (Touch ID-class) don't exist headless; that trade-off is yours to make and is covered in [THREAT-MODEL.md](THREAT-MODEL.md#self-host-mode).

## Recommended layout

```
┌────────────────────── your home box / NAS ──────────────────────┐
│  slipscan-server (127.0.0.1:7151)                               │
│    ├── books/*.sqlite  + documents/                             │
│    ├── mailbox connectors (IDLE / Pub/Sub pull — outbound only) │
│    └── scheduled bank-adapter syncs                             │
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
- If you must expose an HTTPS endpoint (e.g. to enable Microsoft Graph push notifications — see [EMAIL.md](EMAIL.md#outlook--microsoft-365)), scope the proxy route to exactly that path and keep auth on everything else.

## Exposing via your own Vulos Relay (optional)

If you use the VulOS family, [Vulos Relay](https://vulos.org) is its reachability fabric — a way to give a machine behind NAT a stable, authenticated endpoint **you** operate. SlipScan can sit behind *your* relay like any other service: the relay terminates reachability, your box holds the data.

This is strictly optional and strictly yours: SlipScan does not ship with, default to, or depend on any relay — including Vulos Relay. It is one more "endpoint the user explicitly configured." SlipScan works fully without it; the products connect across a clean seam, they don't require each other.

## Devices as clients

Point the desktop app at your server (**Settings → Server → Connect**) instead of a local book, and it becomes a client of the same `/api/v1` surface — the IPC/HTTP parity in [API.md](API.md) is what makes this a configuration change rather than a different app. Multi-user households and the Tauri mobile companion are Phase 5 ([ROADMAP.md](../ROADMAP.md)); today the practical setup is one household, devices sharing the server's books over LAN/VPN.

Back up the server the same way as the desktop: copy the books directory ([CONFIGURATION.md](CONFIGURATION.md#data-locations)). Secrets stay in that box's keychain and are re-entered on restore — by design.

---

**Next:** [API.md](API.md) — the full service surface exposed by slipscan-server and Tauri IPC.
