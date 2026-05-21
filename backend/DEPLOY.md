# slip/scan — Hetzner Deploy Guide

`backend/deploy.sh` provisions and manages the Hetzner VM fleet that runs the
slip/scan backend: the API server (behind a Load Balancer) and the SMTP mail
receiver (direct public-IP access).

## Architecture

```
Internet
   |
   ├─[SMTP :25]──> VM public IP ──> slipscan-mailrx.service
   |
   └─[HTTPS :443]─> Hetzner LB ──> VM :8080 ──> slipscan-api.service
                        |
                    /healthz checks
```

Each VM runs both services. The LB fronts only the API; mail goes directly to
the VM's public IP (required for MX records to work with multiple VMs).

DNS (managed via Hetzner DNS API):
- `rx.yourdomain.com`       A record → each VM IP (`vm1.rx.…`, `vm2.rx.…`)
- `@` MX record             → `rx.yourdomain.com.` (for mail inbound)

## Prerequisites

### Tools

| Tool | Minimum version | Install |
|------|----------------|---------|
| `hcloud` CLI | v1.45.0 | `brew install hcloud` or [releases](https://github.com/hetznercloud/cli/releases/tag/v1.45.0) |
| `bash` | 4.x+ | macOS: `brew install bash` |
| `curl` | any | standard |
| `python3` | 3.8+ | standard |
| `go` | 1.22+ | https://go.dev/dl |
| `ssh` / `scp` | any | standard |

### Hetzner account setup (one-time)

1. Create a Hetzner Cloud project at https://console.hetzner.cloud
2. Generate an **API token** (Read + Write) — Settings → API Tokens
3. Upload your SSH public key — Security → SSH Keys (note the key name)
4. Set up a DNS zone for your domain — Hetzner DNS Console at https://dns.hetzner.com
   - Copy the zone ID from the URL or API

### Domain setup

Point your domain's nameservers to Hetzner DNS or use an existing Hetzner DNS
zone. The deploy script manages `A` and `MX` records within that zone.

## Required secrets

Set these environment variables before running deploy.sh. **Never commit
them to the repository.**

```bash
export HCLOUD_TOKEN="<your-hetzner-api-token>"    # Read+Write token
export HCLOUD_SSH_KEY="<ssh-key-name-in-hetzner>"  # Key already uploaded
export RX_DOMAIN="rx.yourdomain.com"               # Mail receive subdomain
export HCLOUD_DNS_ZONE_ID="<hetzner-dns-zone-id>"  # Zone containing RX_DOMAIN
```

For CI/CD (GitHub Actions etc.), store these as repository secrets and inject
them as environment variables in the deploy workflow.

### Runtime env file

The script uploads a `.env.dev` or `.env.main` file to each VM at
`/etc/slipscan/env`. This file contains all runtime secrets (DB URL, JWT
secret, API keys). It **must exist locally** before running a live deploy.

```bash
cp .env.example .env.dev   # or .env.main
# Edit with real values — never commit this file
```

The `.gitignore` already excludes `.env.dev` and `.env.main`.

## Usage

```bash
cd backend

# Provision a fresh fleet (creates 1 VM, LB, firewall, DNS)
HCLOUD_TOKEN=xxx HCLOUD_SSH_KEY=mykey RX_DOMAIN=rx.example.com \
  HCLOUD_DNS_ZONE_ID=zzz ./deploy.sh --env dev

# Rolling replacement (blue/green: create new VM, health-check, swap LB, delete old)
./deploy.sh --env dev --replace
./deploy.sh --env dev --replace 2    # replace with 2 new VMs

# Production fleet
./deploy.sh --env main --replace 1

# List current fleet / status
./deploy.sh --env dev --list

# Dry-run (prints all hcloud commands without executing — for CI verification)
./deploy.sh --env dev --dry-run
./deploy.sh --env dev --replace 2 --dry-run
```

## Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_TYPE` | `cpx11` | Hetzner server type |
| `DATACENTER` | `nbg1-dc3` | Hetzner datacenter |
| `NETWORK_ZONE` | `eu-central` | Hetzner network zone |
| `LB_NAME` | `slipscan-lb-<env>` | Load balancer name |
| `LB_TYPE` | `lb11` | Load balancer type |
| `FIREWALL_NAME` | `slipscan-fw-<env>` | Firewall name |
| `ENV_FILE_PATH` | `.env.<env>` | Runtime env file path |
| `HEALTH_TIMEOUT` | `120` | Seconds to wait for health check |
| `HCLOUD_CLI_VERSION` | `v1.45.0` | Version hint in error messages |

## Server naming convention

Servers are named `slipscan-YYYYMMDD-<n>` where:
- `YYYYMMDD` is the date of provisioning
- `<n>` is a sequential instance number, starting at 1 and incrementing if
  multiple replacements happen on the same day

Example: `slipscan-20260521-1`, `slipscan-20260521-2`

## Rolling replacement (`--replace`)

The `--replace [N]` flag implements zero-downtime rolling updates:

1. Build fresh linux/amd64 binaries from source
2. For each of N replacements:
   a. Create a new dated+numbered VM with cloud-init
   b. Upload binaries via SCP
   c. Wait for `/healthz` to return 200
   d. Attach new VM to the Load Balancer
3. For each old VM previously under the LB:
   a. Detach from LB (triggers drain)
   b. Wait 15s for in-flight requests to complete
   c. Remove DNS A record for old VM IP
   d. Delete the old VM
5. Update MX record if needed

The LB health checks ensure traffic only reaches healthy targets, providing
API continuity throughout the swap.

## Cloud-init & systemd services

cloud-init (Ubuntu 24.04) does on first boot:
- Creates `slipscan` system user (no login shell)
- Creates `/opt/slipscan/`, `/etc/slipscan/`, `/var/lib/slipscan/`
- Writes systemd unit files for `slipscan-api.service` and `slipscan-mailrx.service`
- Writes `/etc/slipscan/env` (the env file from deploy time, mode 0600)
- Enables and starts both services once binaries are uploaded

Binaries are uploaded via `scp` after cloud-init completes (separate step),
then services are enabled with `systemctl enable --now`.

### slipscan-api.service

- Binary: `/opt/slipscan/server`
- Port: `8080`
- EnvironmentFile: `/etc/slipscan/env`
- Capabilities: none (runs as `slipscan` user, unprivileged port)

### slipscan-mailrx.service

- Binary: `/opt/slipscan/mailrx`
- Port: `25` (SMTP)
- EnvironmentFile: `/etc/slipscan/env`
- Capabilities: `CAP_NET_BIND_SERVICE` (for port 25)
- Dependency: requires `cmd/mailrx` from P0-01 to be built

## Firewall rules

| Direction | Port | Protocol | Source | Purpose |
|-----------|------|----------|--------|---------|
| in | 22 | TCP | 0.0.0.0/0 | SSH management |
| in | 25 | TCP | 0.0.0.0/0 | SMTP (mailrx) |
| in | 443 | TCP | 0.0.0.0/0 | HTTPS (via LB) |
| in | 8080 | TCP | 0.0.0.0/0 | API (LB health checks) |

## Cost reference (as of 2025, Hetzner EU)

| Resource | Type | Cost/month |
|----------|------|-----------|
| VM | cpx11 (2 vCPU, 2 GB RAM, 40 GB SSD) | ~€4.15 |
| Load Balancer | lb11 (25 targets, 1 Gbps) | ~€5.83 |
| **Total (1 VM)** | | **~€10/month** |
| Outbound traffic | First 20 TB free | — |
| DNS | Hetzner DNS | Free |

To scale: `cpx21` (4 vCPU / 4 GB) is ~€7.55/mo. Multiple VMs multiply the VM cost.

## Idempotency

- `ensure_firewall` and `ensure_load_balancer` check if resources exist before creating
- DNS upserts use PUT if record exists, POST if not
- `--replace` auto-increments instance numbers to avoid name collisions on the same day
- Re-running provision on an already-existing server name prints a warning and skips

## Secrets handling

| Secret | Where stored | How injected |
|--------|-------------|--------------|
| `HCLOUD_TOKEN` | CI secrets / local env | Shell env var |
| `HCLOUD_SSH_KEY` | Hetzner account | Referenced by name |
| Runtime secrets (DB_URL, JWT_SECRET, etc.) | `.env.dev`/`.env.main` (gitignored) | Uploaded via SCP to `/etc/slipscan/env` (mode 0600) |

**Never commit** `.env.dev`, `.env.main`, or any file containing real tokens.

## Dependencies

- **P0-01 (mailrx):** `cmd/mailrx` must exist as a buildable Go package for
  `slipscan-mailrx.service` to be installed. The script gracefully skips the
  mailrx binary if `cmd/mailrx` is absent (warn + continue).
- **hcloud CLI v1.45.0:** pinned for reproducibility. Update `HCLOUD_CLI_VERSION`
  if upgrading.

## What requires a live Hetzner account

The following cannot be tested with `--dry-run` alone:

- Actual server creation and cloud-init execution
- SSH/SCP upload of binaries
- Health check polling against a real VM
- LB target attachment and traffic routing
- Hetzner DNS API calls (A/MX record creation)
- Firewall creation and attachment

For a first live deploy, run `./deploy.sh --env dev` against a real Hetzner
project with a test domain, verify `/healthz` returns 200 via the LB IP, and
send a test SMTP connection to port 25 on the VM IP.
