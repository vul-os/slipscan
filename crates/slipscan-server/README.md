# slipscan-server

Headless self-host mode for SlipScan: a thin [axum] wrapper exposing the
same core operations as the desktop app's IPC layer, under
`POST /api/v1/<operation_name>` with JSON bodies (`book_list`,
`transaction_categorize`, `report_spending`, `pack_install`, …).
`GET /health` is a public liveness probe.

Run it via the CLI:

```sh
slipscan --db ~/slipscan/personal.sqlite serve            # 127.0.0.1:7151
slipscan serve --auth                                     # require a bearer token
slipscan serve --bind 0.0.0.0:7151 --auth                 # explicit LAN opt-in
```

## Privacy posture

* **Binds `127.0.0.1` by default.** Serving on any other interface is an
  explicit `--bind` opt-in (mantra #3). The server never makes outbound
  network calls of any kind — it only listens.
* **No telemetry, no analytics.**
* **Optional bearer-token auth** (`--auth`): on first run a random token is
  generated, printed exactly once, and only its SHA-256 hex is stored in the
  `settings` table (`server.auth_token_sha256`). The token itself is never
  written anywhere. Every `/api/v1` request must then send
  `Authorization: Bearer <token>`. To rotate a lost token, delete the
  `server.auth_token_sha256` setting and run `serve --auth` again.

## TLS: bring a reverse proxy

slipscan-server deliberately does **no TLS termination** — keeping the
in-process surface small and auditable. For anything beyond localhost, put a
reverse proxy you already trust in front and let it terminate TLS:

```
[ client ] --HTTPS--> [ caddy / nginx / traefik ] --HTTP (localhost)--> slipscan-server
```

Example with [Caddy](https://caddyserver.com) (automatic self-managed certs):

```caddyfile
slipscan.home.example {
    reverse_proxy 127.0.0.1:7151
}
```

Example with nginx:

```nginx
server {
    listen 443 ssl;
    server_name slipscan.home.example;
    ssl_certificate     /etc/ssl/slipscan.crt;
    ssl_certificate_key /etc/ssl/slipscan.key;
    location / {
        proxy_pass http://127.0.0.1:7151;
    }
}
```

With a proxy on the same host, keep the default loopback bind — the proxy
connects over localhost and nothing is exposed directly. Combine with
`--auth` so the proxy's clients still need the bearer token.

## Error shape

Errors are JSON: `{"error": {"code": "...", "message": "..."}}` with
conventional status codes — `404` not found, `409` duplicate, `422`
validation / unbalanced journal / bad pack signature, `401` missing or wrong
bearer token.

## Testing

Integration tests drive the router in-memory with `tower::ServiceExt`
(no sockets, no disk): `cargo test -p slipscan-server`.

[axum]: https://github.com/tokio-rs/axum
