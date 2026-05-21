---
id: P0-02
title: Hetzner VM fleet deploy script (backend + mailrx + LB + DNS)
phase: 0
status: review
depends_on: [P0-03]
owner: sonnet-agent
---

## Goal
`backend/deploy.sh` provisions and updates a Hetzner fleet that runs **both**
the API server (behind a load balancer) and the mailrx SMTP receiver (on each
VM's public IP). Supports `--replace` for rolling, dated, numbered replacement
and configures Hetzner DNS for the `rx` mail domain automatically. Start with 1 VM.

## Context
From the `todo`: backend runs on the VMs too; the load balancer fronts the API;
mail goes directly to public IPs; DNS is in Hetzner; `--replace` rebuilds VMs
under the LB with auto date+instance-number naming and reconfigures DNS. Needs a
Hetzner CLI token from a deploy-time env/secret.

## Existing assets
- `cmd/server` (API) and `cmd/mailrx` (P0-01) are the two binaries to ship.
- `backend/Makefile` for build targets; `backend/bin/` is build output.
- Env files `.env.dev` / `.env.main` define per-environment config.

## Scope
**In:** `backend/deploy.sh` using `hcloud` CLI; build static Go binaries; create
server(s) from a base image/cloud-init; install + run both binaries as systemd
units; attach to a Hetzner Load Balancer (API/HTTPS target); set firewall (open
25 for mailrx, 443 to LB only); manage A/MX/PTR-ish DNS records via `hcloud`;
`--replace [N]` rolling replacement with names like `slipscan-YYYYMMDD-1`.
**Out:** the app code itself; TLS cert issuance can use Caddy/automatic in
cloud-init; Terraform (shell script per the `todo`, keep it simple).

## Implementation
1. Preamble: require `HCLOUD_TOKEN`, target env (`--env dev|main`), region,
   server type; `set -euo pipefail`.
2. Build: `make build` producing `server` and `mailrx` for linux/amd64.
3. Cloud-init template: install binaries, drop systemd units
   (`slipscan-api.service`, `slipscan-mailrx.service`), pull env from a secrets
   mechanism (document the choice: env file uploaded over SSH, or hcloud secret).
4. Provision: create server, wait healthy (`/healthz`), attach to LB target
   pool, add to DNS (`rx.<domain>` A-record per VM IP; ensure MX → rx host).
5. `--replace [N]`: enumerate current fleet under the LB, create replacement(s)
   named `slipscan-<date>-<n>`, health-check, swap into LB, drain + delete old,
   update DNS. Idempotent and re-runnable.
6. `--list` / `--status` helper to show fleet + LB members + DNS records.

## Acceptance criteria
- [ ] `./deploy.sh --env dev` from scratch yields 1 VM running API (reachable via
      LB `/healthz`) and mailrx on port 25 at the VM's public IP, with DNS set.
- [ ] `./deploy.sh --env dev --replace 1` creates a new dated VM, health-checks
      it, moves it under the LB, removes the old one, and updates DNS — with no
      API downtime (LB drains).
- [ ] Re-running provisioning is idempotent (no duplicate DNS/LB members).
- [ ] Script fails fast and clearly when `HCLOUD_TOKEN` or required env is missing.
- [ ] README section documents prerequisites, secrets handling, and usage.

## Tests
- Dry-run mode (`--dry-run`) that prints the `hcloud` commands without executing,
  exercised in CI. Manual smoke test against a real project documented in PR.

## Notes
Keep secrets out of the repo. Pin `hcloud` CLI version. Record cost notes
(server type, LB tier) in the PR so we can reason about per-VM economics.

---

### Implementation notes (sonnet-agent, 2026-05-21)

**What was built:**

- `backend/deploy.sh` — bash script (`set -euo pipefail`) using the `hcloud` CLI
- `backend/DEPLOY.md` — full documentation: prerequisites, secrets, usage, cost reference

**deploy.sh capabilities:**

| Flag | Behaviour |
|------|-----------|
| `--env dev\|main` | Target environment; names LB and firewall accordingly |
| (no flag) | Provisions from scratch: build → firewall → LB → VM → upload → health-check → DNS |
| `--replace [N]` | Zero-downtime rolling replace: create N new dated VMs, health-check, swap LB, drain+delete old, update DNS |
| `--dry-run` | Prints all `hcloud` and DNS API commands without executing; works without hcloud installed |
| `--list` / `--status` | Shows fleet servers, LB targets, DNS records |

**Server naming:** `slipscan-YYYYMMDD-<n>` (e.g. `slipscan-20260521-1`); instance number auto-increments per day to support multiple replacements.

**Services deployed per VM:**
- `slipscan-api.service` — API server on port 8080, fronted by Hetzner LB
- `slipscan-mailrx.service` — SMTP receiver on port 25, direct public-IP access

**Secrets/credentials the human must provide:**

| Secret | Description |
|--------|-------------|
| `HCLOUD_TOKEN` | Hetzner Cloud API token with Read+Write permissions |
| `HCLOUD_SSH_KEY` | Name of SSH key already uploaded to Hetzner account |
| `RX_DOMAIN` | Mail receive domain/subdomain (e.g. `rx.slipscan.io`) |
| `HCLOUD_DNS_ZONE_ID` | Hetzner DNS zone ID for the domain above |
| `.env.dev` / `.env.main` | Runtime env file (DB URL, JWT secret, API keys) — copy from `.env.example`, fill in, never commit |

**Cost:** cpx11 VM (~€4.15/mo) + lb11 Load Balancer (~€5.83/mo) = ~€10/mo for a 1-VM fleet.

**Dry-run verified:** All paths (`--env dev --dry-run`, `--replace 2 --dry-run`, `--list --dry-run`) produce correct command output and exit 0. Error cases (missing env vars, invalid `--env`) exit 1 with clear messages. `bash -n deploy.sh` passes.

**What can only be tested against a live Hetzner account:**
- Actual server creation and cloud-init execution
- SSH/SCP binary upload
- Real `/healthz` health-check polling
- LB target attachment and traffic routing
- Hetzner DNS API record creation/update
- End-to-end SMTP mail receive on port 25

**Dependency:** Requires `cmd/mailrx` (P0-01) to install `slipscan-mailrx.service`. Script gracefully skips mailrx binary if the package is not yet built (warns, continues with API only).
