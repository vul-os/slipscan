---
id: P0-02
title: Hetzner VM fleet deploy script (backend + mailrx + LB + DNS)
phase: 0
status: todo
depends_on: [P0-03]
owner: unassigned
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
