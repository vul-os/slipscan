# Running a branch node on a cloud instance

Everything else in these docs assumes a **trusted network** — a shop counter PC,
a LAN, a VPN you run yourself. This page is the other case: a FlowStock node on a
VPS, reachable from the open internet, so branches behind NAT can sync to it
without any third party in the middle.

**It is a different threat model, and the difference is not a footnote.** On a
LAN the network is a boundary; on a public address there is no boundary, and
every property below has to hold on its own. Read the whole page before opening
the port.

> **Status, 2026-07-30.** Nothing here uses or needs a reachability broker. A
> broker (NAT traversal) would be a convenience for the _other_ direction — a
> branch that cannot open a port — and is not part of this path. The suite's own
> broker, Ephor, is **not ready** as of this date; see
> [SYNC.md](SYNC.md#independence-first).

---

## 1. What you must decide first: which build

A cloud node **must** run the shared DMTAP sync engine (`-tags dmtap`), not
FlowStock's built-in CRDT.

|                                            | built-in engine (release archives) | substrate engine (`-tags dmtap`, the container image) |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| Sync request authenticated by node key     | yes                                | yes                                                   |
| Op **batch** signed by the sending node    | yes                                | yes                                                   |
| Each **op** signed by its **author**       | **no**                             | yes (`COSE_Sign1`)                                    |
| A relayed op is attributable to its author | **no**                             | yes                                                   |
| Merge algebra                              | FlowStock's own                    | the shared, vector-verified one                       |

The row that decides it is the third. Under the built-in engine an op carries no
author signature, so a peer relaying a third branch's changes vouches for them
with its own key and nothing distinguishes a relayed op from one that peer
invented. On a LAN that is a tolerable simplification. On a public address it is
not: the whole point of exposing a node is that strangers can reach it, and an
enrolled peer that turns hostile — or is compromised — must not be able to author
history in another branch's name.

The substrate build refuses an op with no envelope, and refuses a validly signed
op that claims to come from a node other than the one that signed it. See
`backend/internal/substrate/op_authenticity_test.go`.

**The engine is a workspace-wide choice.** A substrate node refuses to sync with
a built-in node and says so, naming both engines
([CONFIGURATION.md](CONFIGURATION.md#substrate_sync--the-shared-merge-engine)).
So moving to a cloud node means moving **every** branch to `-tags dmtap` — build
each one with `npm run build:dmtap`, or run the container image everywhere. Do
that rollout before you expose anything; sync pauses only between a mismatched
pair, so it is safe to do node by node.

---

## 2. Bind address

The listener binds whatever `host` says; the default is loopback so a laptop
install is not accidentally public.

```bash
FLOWSTOCK_HOST=0.0.0.0 FLOWSTOCK_PORT=8787 ./flowstock
```

`0.0.0.0` binds every interface. If your provider gives you a private interface
as well, prefer binding the one address you mean:

```bash
FLOWSTOCK_HOST=10.0.0.4 ./flowstock     # behind a proxy on the same host
FLOWSTOCK_HOST=127.0.0.1 ./flowstock    # proxy on the same host, nothing else
```

Verify what you actually bound, rather than what you configured:

```bash
ss -ltnp | grep 8787       # Linux
```

## 3. TLS — FlowStock does not terminate it

**FlowStock speaks plain HTTP and has no TLS configuration.** There is no
certificate option, no ACME client, nothing. That is a deliberate limit, and on a
public address it means you **must** put a terminating reverse proxy in front of
it. Anything else sends business data across the internet in the clear; the sync
signatures authenticate the peers, they do not encrypt the payload.

A terminating proxy is a **trust boundary you are choosing**: it decrypts, reads
and re-encrypts every request, including the sync mesh's. It sees your catalog,
your orders and your sync secret while pairing. Run it yourself, on the same host
if you can; a managed TLS front-end operated by someone else is a party you have
added to the mesh.

Caddy, on the same instance, is the shortest honest version:

```caddyfile
# /etc/caddy/Caddyfile
flowstock.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

with `FLOWSTOCK_HOST=127.0.0.1`, so the only path in is through the proxy. Caddy
provisions and renews the certificate itself. nginx with certbot is equivalent
and more moving parts; either way what matters is:

- the certificate **renews** without you (check it, do not assume it);
- FlowStock binds loopback, not `0.0.0.0`, so the port cannot be reached around
  the proxy;
- peers use the `https://` name, never the bare IP and port.

Peer URLs may be `http://` or `https://`; on a public node use `https://`.

## 4. Firewall

Only the proxy's ports should be open:

```bash
ufw default deny incoming
ufw allow 22/tcp        # your own access — restrict the source if you can
ufw allow 80,443/tcp    # the proxy (80 is needed for ACME)
ufw enable
```

8787 is deliberately **not** in that list. If FlowStock binds `127.0.0.1` the
firewall is a second line rather than the only one, which is the arrangement you
want.

## 5. Deploy artifact

Two supported shapes.

**Container** (the artifact this repo builds for the purpose — see
`Dockerfile`, which builds `-tags dmtap`):

```bash
docker build --build-arg VERSION="$(cat VERSION)" -t flowstock:local .
docker run -d --name flowstock \
  -p 127.0.0.1:8787:8787 \
  -v flowstock-data:/data \
  --restart unless-stopped \
  flowstock:local
```

`-p 127.0.0.1:8787:8787` publishes the port **to loopback only**, so the proxy
can reach it and the internet cannot. Publishing `-p 8787:8787` binds all
interfaces and, on Docker with the default networking, punches through `ufw`.

> There is no published image to pull. `ghcr.io/vul-os/flowstock` does **not**
> exist: the release workflow builds archives, not images, and deliberately says
> so. Build the Dockerfile yourself.

**Binary + systemd** (release archive, verified — see
[GETTING-STARTED.md](GETTING-STARTED.md#install)). Note `npm run build:dmtap` if
you are building from source, because the release archives are the built-in-engine
build:

```ini
# /etc/systemd/system/flowstock.service
[Unit]
Description=FlowStock branch node
After=network-online.target
Wants=network-online.target

[Service]
User=flowstock
Group=flowstock
Environment=FLOWSTOCK_HOST=127.0.0.1
Environment=FLOWSTOCK_PORT=8787
Environment=FLOWSTOCK_DATA_DIR=/var/lib/flowstock
# Set a password on an internet-exposed node: it gates the app and the data API.
# The sync mesh authenticates separately, and more strictly.
Environment=FLOWSTOCK_PASSWORD=change-me
ExecStart=/usr/local/bin/flowstock
Restart=on-failure
RestartSec=2
# The data dir is the only thing this process needs to write.
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/var/lib/flowstock

[Install]
WantedBy=multi-user.target
```

```bash
useradd --system --home /var/lib/flowstock --shell /usr/sbin/nologin flowstock
install -d -o flowstock -g flowstock -m 0750 /var/lib/flowstock
systemctl enable --now flowstock
journalctl -u flowstock -f
```

The startup log states which engine is active and whether unsigned ops are
refused. Read it once after every deploy; that line is the compliance check you
get for free.

## 6. Enrol the branches

Discovery is **manual** — there is no directory and no default endpoint. You type
the address.

1. On the cloud node, open the app through the proxy, complete first-run setup,
   then **Settings → Sync** → _Generate_ a shared secret.
2. On each branch, **Settings → Sync**, paste the same secret, and add the cloud
   node as a peer: `https://flowstock.example.com`.
3. _Test connection_, then _Sync now_.

The secret is a **one-time pairing bootstrap**. The first successful round
records (trust-on-first-use) each side's Ed25519 key, and from then on the two
nodes authenticate by key; a later mismatch is refused rather than prompted.
Rotate the secret once every branch has paired — that closes new enrolments
without touching the branches that already have.

Only one side of a pair needs to be reachable, and a round pushes **and** pulls,
so branches behind NAT need no port of their own: they dial the cloud node.

## 7. Durability and backup

The node's authoritative state is `${FLOWSTOCK_DATA_DIR}/flowstock.db` — and that
file holds the node's **identity keypair**, the **workspace id**, its peers'
**enrolled keys**, and the whole oplog. Losing it does not just lose data; it
loses who this node _is_.

```bash
# Stop, copy every flowstock.db* file together, start.
systemctl stop flowstock
tar -czf "/backup/flowstock-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
    -C /var/lib/flowstock .
systemctl start flowstock
```

The glob matters: SQLite runs in WAL mode, so `flowstock.db-wal` can hold
committed writes that `flowstock.db` does not yet. Copy them together or use
`sqlite3 flowstock.db ".backup /backup/flowstock.db"` on a running node.

For the container: `docker stop flowstock && docker run --rm -v flowstock-data:/data -v /backup:/backup alpine tar -czf /backup/flowstock.tar.gz -C /data . && docker start flowstock`.

**Restore** is: stop, empty the data dir, unpack the backup into it, start. The
node comes back with the same node id, the same key, the same workspace and the
same enrolled peers — **no re-pairing**. That is asserted, not assumed:
`backend/internal/store/backup_restore_test.go` destroys a data directory,
restores it, and checks the identity, the peers' keys, the history and the clock.

Test a restore before you need one. A backup nobody has restored is a file.

## 8. Upgrade

```bash
systemctl stop flowstock
# verify the new archive first — install.sh and scripts/verify.sh both refuse
# bytes they could not check against SHA256SUMS.txt
install -m 0755 ./flowstock /usr/local/bin/flowstock
systemctl start flowstock
```

Take a backup first (§7): the schema migrates forward on open and there is no
downgrade path. Upgrade the cloud node and the branches in any order — nodes of
different versions sync, as long as they agree on the **merge engine**, which is
the one thing a rolling upgrade must not straddle. For the container, rebuild the
image and recreate the container against the same named volume.

## 9. What this setup still does not protect you from

Stated plainly, because a deployment page that lists only what works is a sales
page.

- **The proxy sees everything.** TLS is terminated in front of FlowStock, so the
  proxy — and whoever operates it — reads every request. Run it yourself.
- **Anyone with the shared secret can enrol a new node** until you rotate it. It
  cannot let them impersonate an already-enrolled node, but it is enough to join
  the workspace. Rotate it after pairing.
- **A compromised enrolled branch is inside the mesh.** Per-op signatures make
  its ops attributable to it and stop it forging another branch's, but it can
  still author whatever it likes as itself. Remove the peer row and rotate the
  secret to revoke.
- **The app password is a single shared owner password**, not per-user accounts.
  It is a gate, not an audit trail.
- **A cloud node is an attack surface you added on purpose.** The substrate
  reduces what an exposed node must be trusted for; it does not make exposure
  free.
