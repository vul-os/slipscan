# Getting started

## Install

**From a release** — download the archive for your platform from
[GitHub Releases](https://github.com/vul-os/flowstock/releases), unpack it, and
run it:

```bash
./flowstock            # serves http://127.0.0.1:8787
```

Open http://localhost:8787 in your browser.

Every release also attaches `SHA256SUMS.txt` covering each archive. Check yours
against it before running the binary — `install.sh` in this repo does exactly
that and refuses to install on a mismatch, a missing sums file, or a machine
with no SHA-256 tool to check with.

**With Docker** — build the image yourself; there is no published one to pull
(the release workflow builds archives, not images):

```bash
docker build -t flowstock:local .
docker run -p 127.0.0.1:8787:8787 -v flowstock-data:/data flowstock:local
```

The image builds `-tags dmtap`, so it merges with the shared engine and will not
sync with a branch running a release archive — see
[CLOUD-NODE.md](CLOUD-NODE.md#1-what-you-must-decide-first-which-build) before
mixing the two.

**From source** (needs Go 1.25+ and Node 18+):

```bash
git clone https://github.com/vul-os/flowstock.git
cd flowstock
npm install
npm run build:all      # builds the single ./flowstock binary (frontend embedded)
./flowstock
```

**Try it with zero setup** — the UI alone runs in a browser with seeded demo
data (no Go backend, nothing persisted beyond the tab):

```bash
npm install && npm run dev   # open http://localhost:5173
```

## First run

On first launch FlowStock asks for your **business name** and a name for
**this branch** (e.g. "Head Office"). That's it — you land on the dashboard.
Everything is stored locally in a single SQLite file (`~/.flowstock/flowstock.db`
by default).

A sensible first path through the app:

1. **Products** — create categories, products and variations (SKU, price,
   cost price, reorder point).
2. **Stock** — capture opening stock with an _Adjust stock_ (kind: receive)
   per variant, or receive your first purchase order instead.
3. **Partners** — add customers and suppliers.
4. **Purchase orders** — order from a supplier, _Send_ it, then _Receive
   goods_ when the delivery arrives (stock goes up).
5. **Orders** — capture a customer order and _Confirm_ it (stock goes down).
   Mark it _Paid_ when settled, or record part-payments under
   **Creditors & Debtors**.
6. **Reports** — valuation, movements, low stock, sales, accounts; every
   report exports CSV.

## Connecting a second branch

Each branch is its own FlowStock install with its own database. To link them:

1. Both branches must be reachable — run each with `FLOWSTOCK_HOST=0.0.0.0`
   (or `"host": "0.0.0.0"` in the config) so it accepts connections from other
   machines.
2. On **Settings → Sync**, set the **same shared secret** on every branch
   (use _Generate_ on one, copy it to the others). The secret pairs the branches
   the first time they sync; from then on they authenticate each other by
   Ed25519 key, so the secret is a one-time bootstrap rather than a standing
   password.
3. On one branch, add the others as **peers** — name + URL, e.g.
   `http://192.168.1.20:8787` (the same address the branch serves FlowStock on;
   sync shares the app port) — and press _Test connection_, then _Sync now_.

Branches sync automatically once a minute when reachable. A branch that goes
offline keeps trading normally and converges the next time it can reach any
peer (changes relay transitively through shared peers). One reachable peer per
pair is enough — a sync round pushes **and** pulls.

Steps 1–3 are the whole of it: you type the other branch's address, and there is
no directory, no default endpoint and no third party involved. `0.0.0.0` above
assumes a LAN or a VPN you run yourself — sync is plain HTTP and the signatures
authenticate the peers without encrypting the payload.

To reach branches across the internet, run one node on your own cloud instance
and have the others dial it. That is a different threat model — TLS, firewall,
which build, backups — and it has its own page:
[CLOUD-NODE.md](CLOUD-NODE.md). Do not simply point `0.0.0.0` at a public IP.

See [SYNC.md](SYNC.md) for topologies, transport security and merge semantics.

## Where is my data?

A single SQLite database (WAL mode) at `~/.flowstock/flowstock.db`
(override with `FLOWSTOCK_DATA_DIR`). It holds your business data **and** this
node's identity keypair, its workspace id and its peers' enrolled keys — so a
backup that keeps it is a backup that restores the same node, with no re-pairing.

Back it up like any file — copy all `flowstock.db*` files together (WAL mode means
`flowstock.db` alone can be missing the newest writes), or use `.backup` from the
sqlite3 CLI. [CLOUD-NODE.md §7](CLOUD-NODE.md#7-durability-and-backup) has the
stop/copy/start procedure and the restore.
