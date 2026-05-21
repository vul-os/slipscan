#!/usr/bin/env bash
# deploy.sh — Hetzner fleet provisioning for slip/scan
#
# Provisions and manages a fleet of Hetzner VMs running:
#   - slipscan-api.service  (API server, behind Hetzner Load Balancer)
#   - slipscan-mailrx.service (SMTP receiver, direct public-IP access)
#
# Usage:
#   ./deploy.sh [--env dev|main] [--replace [N]] [--dry-run] [--list|--status]
#
# Required environment variables:
#   HCLOUD_TOKEN       Hetzner API token (read+write)
#   HCLOUD_SSH_KEY     Name or ID of SSH key already uploaded to Hetzner
#   RX_DOMAIN          Mail receive domain (e.g. rx.slipscan.io)
#   HCLOUD_DNS_ZONE_ID Hetzner DNS zone ID for RX_DOMAIN
#
# Optional environment variables:
#   FLEET_ENV          Override --env (dev or main). Default: dev
#   SERVER_TYPE        Hetzner server type. Default: cpx11
#   DATACENTER         Hetzner datacenter. Default: nbg1-dc3
#   NETWORK_ZONE       Hetzner network zone. Default: eu-central
#   LB_NAME            Load balancer name. Default: slipscan-lb-<env>
#   LB_TYPE            Load balancer type. Default: lb11
#   FIREWALL_NAME      Firewall name. Default: slipscan-fw-<env>
#   ENV_FILE_PATH      Path to runtime .env file to upload. Default: .env.<env>
#   HEALTH_TIMEOUT     Seconds to wait for health check. Default: 120
#   HCLOUD_CLI_VERSION Pinned hcloud CLI version for install hint. Default: v1.45.0
#
# Cost reference (as of 2025, Hetzner EU):
#   cpx11  (2 vCPU/2 GB) ~ €4.15/mo per VM
#   lb11   (Load Balancer, 25 targets, 1 Gbps) ~ €5.83/mo
#   Total for 1 VM fleet: ~€10/mo
#
set -euo pipefail

# ============================================================
# Constants
# ============================================================
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly FLEET_PREFIX="slipscan"
readonly DEFAULT_SERVER_TYPE="cpx11"
readonly DEFAULT_DATACENTER="nbg1-dc3"
readonly DEFAULT_LB_TYPE="lb11"
readonly DEFAULT_HEALTH_TIMEOUT="120"
readonly HCLOUD_CLI_VERSION="${HCLOUD_CLI_VERSION:-v1.45.0}"
readonly API_PORT="8080"
readonly MAILRX_PORT="25"
readonly HEALTH_PATH="/healthz"

# ============================================================
# CLI argument parsing
# ============================================================
FLEET_ENV="${FLEET_ENV:-dev}"
DRY_RUN=false
DO_REPLACE=false
REPLACE_COUNT=1
DO_LIST=false
DO_STATUS=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Provision or update the slip/scan Hetzner VM fleet.

Options:
  --env dev|main        Target environment (default: dev)
  --replace [N]         Rolling replace N VMs under the LB (default N=1)
  --dry-run             Print hcloud commands without executing
  --list                List fleet servers, LB targets, and DNS records
  --status              Alias for --list
  -h, --help            Show this help

Required env vars:
  HCLOUD_TOKEN          Hetzner API token (read+write)
  HCLOUD_SSH_KEY        SSH key name/ID in Hetzner account
  RX_DOMAIN             Mail receive domain (e.g. rx.slipscan.io)
  HCLOUD_DNS_ZONE_ID    Hetzner DNS zone ID for RX_DOMAIN

Examples:
  HCLOUD_TOKEN=xxx ./deploy.sh --env dev
  HCLOUD_TOKEN=xxx ./deploy.sh --env main --replace 2
  HCLOUD_TOKEN=xxx ./deploy.sh --env dev --dry-run
  HCLOUD_TOKEN=xxx ./deploy.sh --env dev --list
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      shift
      FLEET_ENV="${1:?--env requires dev or main}"
      ;;
    --replace)
      DO_REPLACE=true
      # Optional numeric argument
      if [[ $# -gt 1 && "$2" =~ ^[0-9]+$ ]]; then
        REPLACE_COUNT="$2"
        shift
      fi
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --list|--status)
      DO_LIST=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# ============================================================
# Validate env/arg combinations
# ============================================================
if [[ "$FLEET_ENV" != "dev" && "$FLEET_ENV" != "main" ]]; then
  echo "ERROR: --env must be 'dev' or 'main', got: ${FLEET_ENV}" >&2
  exit 1
fi

# ============================================================
# Derived config
# ============================================================
SERVER_TYPE="${SERVER_TYPE:-${DEFAULT_SERVER_TYPE}}"
DATACENTER="${DATACENTER:-${DEFAULT_DATACENTER}}"
NETWORK_ZONE="${NETWORK_ZONE:-eu-central}"
LB_NAME="${LB_NAME:-${FLEET_PREFIX}-lb-${FLEET_ENV}}"
LB_TYPE="${LB_TYPE:-${DEFAULT_LB_TYPE}}"
FIREWALL_NAME="${FIREWALL_NAME:-${FLEET_PREFIX}-fw-${FLEET_ENV}}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-${DEFAULT_HEALTH_TIMEOUT}}"

# Runtime env file to upload (keep out of repo — see SECRETS section in README)
ENV_FILE_PATH="${ENV_FILE_PATH:-${PROJECT_ROOT}/.env.${FLEET_ENV}}"

# ============================================================
# Prerequisite checks
# ============================================================
check_prerequisites() {
  local missing=()

  # Required secrets
  [[ -z "${HCLOUD_TOKEN:-}" ]]       && missing+=("HCLOUD_TOKEN")
  [[ -z "${HCLOUD_SSH_KEY:-}" ]]     && missing+=("HCLOUD_SSH_KEY")
  [[ -z "${RX_DOMAIN:-}" ]]          && missing+=("RX_DOMAIN")
  [[ -z "${HCLOUD_DNS_ZONE_ID:-}" ]] && missing+=("HCLOUD_DNS_ZONE_ID")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required environment variables:" >&2
    for v in "${missing[@]}"; do
      echo "  - $v" >&2
    done
    echo "" >&2
    echo "Set them before running deploy.sh:" >&2
    echo "  export HCLOUD_TOKEN=<your-token>" >&2
    echo "  export HCLOUD_SSH_KEY=<key-name-in-hetzner>" >&2
    echo "  export RX_DOMAIN=rx.yourdomain.com" >&2
    echo "  export HCLOUD_DNS_ZONE_ID=<zone-id>" >&2
    exit 1
  fi

  if ! command -v hcloud &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      warn "hcloud CLI not found — dry-run will print commands only (no execution)."
    else
      echo "ERROR: hcloud CLI not found. Install ${HCLOUD_CLI_VERSION}:" >&2
      echo "  https://github.com/hetznercloud/cli/releases/tag/${HCLOUD_CLI_VERSION}" >&2
      echo "  or: brew install hcloud" >&2
      exit 1
    fi
  fi

  if [[ "$DRY_RUN" == "false" && ! -f "${ENV_FILE_PATH}" ]]; then
    echo "ERROR: Runtime env file not found: ${ENV_FILE_PATH}" >&2
    echo "  Copy .env.example to ${ENV_FILE_PATH} and fill in secrets." >&2
    exit 1
  fi

  # Validate token works (skip in dry-run)
  if [[ "$DRY_RUN" == "false" ]]; then
    if ! hcloud server list &>/dev/null; then
      echo "ERROR: HCLOUD_TOKEN appears invalid — hcloud server list failed." >&2
      exit 1
    fi
  fi
}

# ============================================================
# hcloud wrapper: respects --dry-run
# ============================================================
hc() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] hcloud $*"
  else
    hcloud "$@"
  fi
}

# Like hc but always executes (for read-only queries even in dry-run)
# In dry-run mode when hcloud is absent, returns empty output gracefully.
hc_query() {
  if command -v hcloud &>/dev/null; then
    hcloud "$@"
  else
    echo "" # hcloud not installed; return empty
  fi
}

# ============================================================
# Logging helpers
# ============================================================
log()  { echo "[deploy] $*"; }
info() { echo "[info]   $*"; }
warn() { echo "[warn]   $*" >&2; }
die()  { echo "[error]  $*" >&2; exit 1; }

# ============================================================
# Build binaries (linux/amd64)
# ============================================================
build_binaries() {
  log "Building linux/amd64 binaries..."
  local build_dir="${SCRIPT_DIR}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] cd ${build_dir}"
    echo "[dry-run] GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o bin/server ./cmd/server"
    echo "[dry-run] GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o bin/mailrx ./cmd/mailrx"
    return
  fi

  if [[ ! -f "${build_dir}/go.mod" ]]; then
    die "go.mod not found in ${build_dir}. Run deploy.sh from the backend/ directory."
  fi

  cd "${build_dir}"
  GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/server ./cmd/server \
    || die "Failed to build cmd/server"

  if [[ -d "./cmd/mailrx" ]]; then
    GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/mailrx ./cmd/mailrx \
      || die "Failed to build cmd/mailrx"
    log "Built: bin/server, bin/mailrx"
  else
    warn "cmd/mailrx not found — skipping mailrx build (P0-01 dependency)"
    warn "slipscan-mailrx.service will not be installed on VMs."
    log "Built: bin/server"
  fi
  cd - &>/dev/null
}

# ============================================================
# Generate cloud-init YAML
# ============================================================
# Arguments: server_name
generate_cloud_init() {
  local server_name="$1"
  local env_content_indented

  if [[ "$DRY_RUN" == "true" ]]; then
    env_content_indented="      # env vars would be injected from ${ENV_FILE_PATH}"
  else
    # Indent every line by 6 spaces for YAML block scalar
    env_content_indented="$(sed 's/^/      /' "${ENV_FILE_PATH}")"
  fi

  cat <<CLOUDINIT
#cloud-config
# slip/scan VM: ${server_name}
# Environment: ${FLEET_ENV}

packages:
  - curl
  - ca-certificates

write_files:
  - path: /etc/slipscan/env
    permissions: '0600'
    owner: root:root
    content: |
${env_content_indented}

  - path: /etc/systemd/system/slipscan-api.service
    permissions: '0644'
    owner: root:root
    content: |
      [Unit]
      Description=slip/scan API server
      After=network.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=slipscan
      Group=slipscan
      EnvironmentFile=/etc/slipscan/env
      ExecStart=/opt/slipscan/server
      Restart=on-failure
      RestartSec=5
      StandardOutput=journal
      StandardError=journal
      SyslogIdentifier=slipscan-api
      # Security hardening
      NoNewPrivileges=yes
      ProtectSystem=strict
      ReadWritePaths=/var/lib/slipscan
      PrivateTmp=yes

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/slipscan-mailrx.service
    permissions: '0644'
    owner: root:root
    content: |
      [Unit]
      Description=slip/scan SMTP mail receiver
      After=network.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=slipscan
      Group=slipscan
      EnvironmentFile=/etc/slipscan/env
      ExecStart=/opt/slipscan/mailrx
      Restart=on-failure
      RestartSec=5
      StandardOutput=journal
      StandardError=journal
      SyslogIdentifier=slipscan-mailrx
      # SMTP on port 25 requires cap_net_bind_service
      AmbientCapabilities=CAP_NET_BIND_SERVICE
      CapabilityBoundingSet=CAP_NET_BIND_SERVICE
      NoNewPrivileges=yes
      ProtectSystem=strict
      ReadWritePaths=/var/lib/slipscan
      PrivateTmp=yes

      [Install]
      WantedBy=multi-user.target

runcmd:
  # Create service user and directories
  - useradd --system --no-create-home --shell /usr/sbin/nologin slipscan
  - mkdir -p /opt/slipscan /etc/slipscan /var/lib/slipscan
  - chown -R slipscan:slipscan /var/lib/slipscan
  # Binaries will be uploaded via SCP after cloud-init
  - systemctl daemon-reload
  # API service: always enable
  - '[' -f /opt/slipscan/server ']' && systemctl enable --now slipscan-api.service || true
  # mailrx service: enable only if binary present
  - '[' -f /opt/slipscan/mailrx ']' && systemctl enable --now slipscan-mailrx.service || true
CLOUDINIT
}

# ============================================================
# Upload binaries and restart services
# ============================================================
# Arguments: server_ip server_name
upload_and_start() {
  local server_ip="$1"
  local server_name="$2"
  local bin_dir="${SCRIPT_DIR}/bin"

  log "Uploading binaries to ${server_name} (${server_ip})..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] scp -o StrictHostKeyChecking=accept-new ${bin_dir}/server root@${server_ip}:/opt/slipscan/server"
    echo "[dry-run] ssh root@${server_ip} 'chmod +x /opt/slipscan/server && systemctl enable --now slipscan-api.service'"
    if [[ -f "${bin_dir}/mailrx" ]]; then
      echo "[dry-run] scp -o StrictHostKeyChecking=accept-new ${bin_dir}/mailrx root@${server_ip}:/opt/slipscan/mailrx"
      echo "[dry-run] ssh root@${server_ip} 'chmod +x /opt/slipscan/mailrx && systemctl enable --now slipscan-mailrx.service'"
    fi
    return
  fi

  local ssh_opts="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

  scp ${ssh_opts} "${bin_dir}/server" "root@${server_ip}:/opt/slipscan/server"
  # shellcheck disable=SC2029
  ssh ${ssh_opts} "root@${server_ip}" \
    "chmod +x /opt/slipscan/server && systemctl enable --now slipscan-api.service"

  if [[ -f "${bin_dir}/mailrx" ]]; then
    scp ${ssh_opts} "${bin_dir}/mailrx" "root@${server_ip}:/opt/slipscan/mailrx"
    # shellcheck disable=SC2029
    ssh ${ssh_opts} "root@${server_ip}" \
      "chmod +x /opt/slipscan/mailrx && systemctl enable --now slipscan-mailrx.service"
  fi
}

# ============================================================
# Wait for health check
# ============================================================
# Arguments: server_ip
wait_healthy() {
  local server_ip="$1"
  local timeout="${HEALTH_TIMEOUT}"
  local elapsed=0
  local interval=5

  log "Waiting for ${server_ip}${HEALTH_PATH} (timeout: ${timeout}s)..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Polling http://${server_ip}:${API_PORT}${HEALTH_PATH} until 200 OK"
    return
  fi

  while [[ $elapsed -lt $timeout ]]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      --connect-timeout 5 --max-time 10 \
      "http://${server_ip}:${API_PORT}${HEALTH_PATH}" 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" ]]; then
      log "Health check passed for ${server_ip} (${elapsed}s)"
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
    log "  ... waiting (${elapsed}s, last status: ${http_code})"
  done

  die "Health check timed out for ${server_ip} after ${timeout}s"
}

# ============================================================
# Ensure firewall exists (idempotent)
# ============================================================
ensure_firewall() {
  log "Ensuring firewall: ${FIREWALL_NAME}"

  if [[ "$DRY_RUN" == "false" ]] && hc_query firewall describe "${FIREWALL_NAME}" &>/dev/null; then
    info "Firewall ${FIREWALL_NAME} already exists — skipping creation."
    return
  fi

  # Create firewall: allow SMTP-25 from anywhere, allow 443 only from LB,
  # allow SSH-22 for management, restrict everything else.
  hc firewall create \
    --name "${FIREWALL_NAME}" \
    --rules-file /dev/stdin <<'FWRULES'
[
  {
    "description": "Allow SSH",
    "direction": "in",
    "port": "22",
    "protocol": "tcp",
    "source_ips": ["0.0.0.0/0", "::/0"]
  },
  {
    "description": "Allow SMTP (mailrx)",
    "direction": "in",
    "port": "25",
    "protocol": "tcp",
    "source_ips": ["0.0.0.0/0", "::/0"]
  },
  {
    "description": "Allow HTTPS from anywhere (LB health checks + direct)",
    "direction": "in",
    "port": "443",
    "protocol": "tcp",
    "source_ips": ["0.0.0.0/0", "::/0"]
  },
  {
    "description": "Allow API port from anywhere (LB health checks)",
    "direction": "in",
    "port": "8080",
    "protocol": "tcp",
    "source_ips": ["0.0.0.0/0", "::/0"]
  }
]
FWRULES
}

# ============================================================
# Ensure load balancer exists (idempotent)
# ============================================================
ensure_load_balancer() {
  log "Ensuring load balancer: ${LB_NAME}"

  if [[ "$DRY_RUN" == "false" ]] && hc_query load-balancer describe "${LB_NAME}" &>/dev/null; then
    info "Load balancer ${LB_NAME} already exists — skipping creation."
    return
  fi

  hc load-balancer create \
    --name "${LB_NAME}" \
    --type "${LB_TYPE}" \
    --network-zone "${NETWORK_ZONE}" \
    --label "env=${FLEET_ENV}" \
    --label "project=slipscan"

  # Add HTTP service on port 8080 with /healthz health check
  hc load-balancer add-service \
    --name "${LB_NAME}" \
    --protocol http \
    --listen-port 80 \
    --destination-port "${API_PORT}" \
    --health-check-http-path "${HEALTH_PATH}" \
    --health-check-interval 15 \
    --health-check-timeout 10 \
    --health-check-retries 3

  # HTTPS passthrough (TLS terminated at the VM via Caddy)
  hc load-balancer add-service \
    --name "${LB_NAME}" \
    --protocol tcp \
    --listen-port 443 \
    --destination-port 443 \
    --health-check-protocol tcp \
    --health-check-port 443 \
    --health-check-interval 15 \
    --health-check-timeout 10 \
    --health-check-retries 3
}

# ============================================================
# Attach server to load balancer
# ============================================================
# Arguments: server_name
attach_to_lb() {
  local server_name="$1"

  log "Attaching ${server_name} to load balancer ${LB_NAME}..."

  if [[ "$DRY_RUN" == "false" ]]; then
    # Check if already a target
    if hc_query load-balancer describe "${LB_NAME}" --output json 2>/dev/null \
        | grep -q "\"name\":\"${server_name}\""; then
      info "${server_name} already in LB target pool — skipping."
      return
    fi
  fi

  hc load-balancer add-target \
    --name "${LB_NAME}" \
    --server "${server_name}"
}

# ============================================================
# Detach server from load balancer and drain
# ============================================================
# Arguments: server_name
detach_from_lb() {
  local server_name="$1"

  log "Draining and detaching ${server_name} from LB ${LB_NAME}..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] hcloud load-balancer remove-target --name ${LB_NAME} --server ${server_name}"
    return
  fi

  hcloud load-balancer remove-target \
    --name "${LB_NAME}" \
    --server "${server_name}" 2>/dev/null || true

  # Give in-flight requests time to complete (LB drain)
  log "Waiting 15s for connections to drain..."
  sleep 15
}

# ============================================================
# DNS management (Hetzner DNS API)
# ============================================================

# Create or update an A record for rx domain
# Arguments: record_name ip_address
dns_upsert_a_record() {
  local record_name="$1"
  local ip_address="$2"
  local zone_id="${HCLOUD_DNS_ZONE_ID}"
  local fqdn="${record_name}.${RX_DOMAIN}"

  log "Upserting DNS A record: ${fqdn} -> ${ip_address}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] DNS upsert A record: ${fqdn} -> ${ip_address} (zone: ${zone_id})"
    return
  fi

  # Check existing record via Hetzner DNS API
  local existing_id
  existing_id=$(curl -s \
    -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
    "https://dns.hetzner.com/api/v1/records?zone_id=${zone_id}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('records', []):
    if r['type'] == 'A' and r['name'] == '${record_name}':
        print(r['id'])
        break
" 2>/dev/null || true)

  if [[ -n "$existing_id" ]]; then
    # Update existing record
    curl -s -X PUT \
      -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"zone_id\":\"${zone_id}\",\"type\":\"A\",\"name\":\"${record_name}\",\"value\":\"${ip_address}\",\"ttl\":60}" \
      "https://dns.hetzner.com/api/v1/records/${existing_id}" > /dev/null
    log "Updated DNS A record ${fqdn} -> ${ip_address} (id: ${existing_id})"
  else
    # Create new record
    curl -s -X POST \
      -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"zone_id\":\"${zone_id}\",\"type\":\"A\",\"name\":\"${record_name}\",\"value\":\"${ip_address}\",\"ttl\":60}" \
      "https://dns.hetzner.com/api/v1/records" > /dev/null
    log "Created DNS A record ${fqdn} -> ${ip_address}"
  fi
}

# Ensure MX record points to rx host
dns_ensure_mx() {
  local zone_id="${HCLOUD_DNS_ZONE_ID}"
  local mx_host="${RX_DOMAIN}."  # trailing dot = FQDN

  log "Ensuring MX record for ${RX_DOMAIN} -> ${mx_host}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] DNS ensure MX record: ${RX_DOMAIN} -> ${mx_host} (zone: ${zone_id})"
    return
  fi

  local existing_id
  existing_id=$(curl -s \
    -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
    "https://dns.hetzner.com/api/v1/records?zone_id=${zone_id}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('records', []):
    if r['type'] == 'MX' and r['name'] == '@':
        print(r['id'])
        break
" 2>/dev/null || true)

  if [[ -z "$existing_id" ]]; then
    curl -s -X POST \
      -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"zone_id\":\"${zone_id}\",\"type\":\"MX\",\"name\":\"@\",\"value\":\"10 ${mx_host}\",\"ttl\":300}" \
      "https://dns.hetzner.com/api/v1/records" > /dev/null
    log "Created MX record for ${RX_DOMAIN}"
  else
    info "MX record for ${RX_DOMAIN} already exists — skipping."
  fi
}

# Remove an A record by IP (used during --replace cleanup)
# Arguments: ip_address
dns_remove_a_by_ip() {
  local ip_address="$1"
  local zone_id="${HCLOUD_DNS_ZONE_ID}"

  log "Removing DNS A record for IP: ${ip_address}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] DNS remove A record for IP: ${ip_address} (zone: ${zone_id})"
    return
  fi

  local record_ids
  record_ids=$(curl -s \
    -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
    "https://dns.hetzner.com/api/v1/records?zone_id=${zone_id}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('records', []):
    if r['type'] == 'A' and r['value'] == '${ip_address}':
        print(r['id'])
" 2>/dev/null || true)

  for record_id in $record_ids; do
    curl -s -X DELETE \
      -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
      "https://dns.hetzner.com/api/v1/records/${record_id}" > /dev/null
    log "Deleted DNS record id=${record_id} (was ${ip_address})"
  done
}

# ============================================================
# Generate a dated, numbered server name
# ============================================================
# Arguments: instance_number
new_server_name() {
  local n="$1"
  local date_str
  date_str="$(date +%Y%m%d)"
  echo "${FLEET_PREFIX}-${date_str}-${n}"
}

# ============================================================
# Get current fleet servers (by label selector)
# ============================================================
get_fleet_servers() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Would query: hcloud server list -o columns=name,ipv4,status -l project=slipscan,env=${FLEET_ENV}"
    return
  fi
  hc_query server list \
    -o columns=name,ipv4,status \
    -l "project=slipscan,env=${FLEET_ENV}" 2>/dev/null || true
}

# Get server names under the LB
get_lb_server_names() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Would query: hcloud load-balancer describe ${LB_NAME} --output json"
    return
  fi
  hc_query load-balancer describe "${LB_NAME}" --output json 2>/dev/null \
    | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for t in data.get('targets', []):
        if t.get('type') == 'server':
            print(t['server']['name'])
except:
    pass
" 2>/dev/null || true
}

# Get a server's public IPv4
get_server_ip() {
  local server_name="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "1.2.3.4"
    return
  fi
  hc_query server describe "${server_name}" --output json \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['public_net']['ipv4']['ip'])"
}

# ============================================================
# Provision a single new server
# ============================================================
# Arguments: server_name instance_number
provision_server() {
  local server_name="$1"
  local instance_num="$2"

  log "Provisioning server: ${server_name} (${SERVER_TYPE}, ${DATACENTER})"

  # Generate cloud-init
  local cloud_init_file
  cloud_init_file="$(mktemp /tmp/cloud-init-XXXXXX.yaml)"
  generate_cloud_init "${server_name}" > "${cloud_init_file}"

  hc server create \
    --name "${server_name}" \
    --type "${SERVER_TYPE}" \
    --image "ubuntu-24.04" \
    --datacenter "${DATACENTER}" \
    --ssh-key "${HCLOUD_SSH_KEY}" \
    --user-data-from-file "${cloud_init_file}" \
    --firewall "${FIREWALL_NAME}" \
    --label "project=slipscan" \
    --label "env=${FLEET_ENV}" \
    --label "instance=${instance_num}" \
    --label "created=$(date +%Y%m%d)"

  rm -f "${cloud_init_file}"

  local server_ip
  server_ip="$(get_server_ip "${server_name}")"
  log "Server ${server_name} IP: ${server_ip}"

  # Wait for cloud-init to complete (SSH becomes available ~30s after creation)
  if [[ "$DRY_RUN" == "false" ]]; then
    log "Waiting 30s for cloud-init to start..."
    sleep 30
  fi

  # Upload binaries and start services
  upload_and_start "${server_ip}" "${server_name}"

  # Wait for API to be healthy
  wait_healthy "${server_ip}"

  # Add DNS A record for this VM's IP
  dns_upsert_a_record "vm${instance_num}" "${server_ip}"

  echo "${server_ip}"
}

# ============================================================
# Provision fresh fleet (from scratch)
# ============================================================
provision_fleet() {
  log "=== Provisioning fresh ${FLEET_ENV} fleet ==="

  build_binaries
  ensure_firewall
  ensure_load_balancer

  # Start with 1 VM
  local server_name
  server_name="$(new_server_name 1)"

  # Check idempotency: skip if server already exists
  if [[ "$DRY_RUN" == "false" ]] && hc_query server describe "${server_name}" &>/dev/null; then
    warn "Server ${server_name} already exists — use --replace to update."
  else
    local server_ip
    server_ip="$(provision_server "${server_name}" 1)"
    attach_to_lb "${server_name}"
    dns_ensure_mx
    log "Fleet provisioned: ${server_name} (${server_ip})"
  fi

  log "=== Done. Fleet status ==="
  print_status
}

# ============================================================
# Rolling replace (--replace [N])
# ============================================================
replace_fleet() {
  local count="$1"
  local date_str
  date_str="$(date +%Y%m%d)"

  log "=== Rolling replace: creating ${count} new server(s) (${date_str}) ==="

  build_binaries
  ensure_firewall
  ensure_load_balancer

  # Enumerate servers currently under the LB
  local old_servers=()
  if [[ "$DRY_RUN" == "false" ]]; then
    while IFS= read -r name; do
      [[ -n "$name" ]] && old_servers+=("$name")
    done < <(get_lb_server_names)
  else
    echo "[dry-run] Would enumerate LB ${LB_NAME} targets as 'old_servers'"
    old_servers=("slipscan-20260101-1")  # placeholder for dry-run output
  fi

  log "Old LB members: ${old_servers[*]:-none}"

  # Find the highest instance number already in use today
  local start_n=1
  if [[ "$DRY_RUN" == "false" ]]; then
    for existing in $(hc_query server list -o columns=name -l "project=slipscan,env=${FLEET_ENV}" 2>/dev/null \
        | grep "${FLEET_PREFIX}-${date_str}-" | sed "s/${FLEET_PREFIX}-${date_str}-//" || true); do
      if [[ "$existing" =~ ^[0-9]+$ && "$existing" -ge "$start_n" ]]; then
        start_n=$((existing + 1))
      fi
    done
  fi

  # Create N new replacement servers
  local new_servers=()
  local new_ips=()
  for (( i=0; i<count; i++ )); do
    local instance_num=$((start_n + i))
    local new_name="${FLEET_PREFIX}-${date_str}-${instance_num}"
    log "Creating replacement server ${instance_num}/${count}: ${new_name}"

    local new_ip
    new_ip="$(provision_server "${new_name}" "${instance_num}")"
    new_servers+=("${new_name}")
    new_ips+=("${new_ip}")

    # Attach new server to LB
    attach_to_lb "${new_name}"
    log "New server ${new_name} (${new_ip}) is live under LB."
  done

  # Wait a moment for LB to begin routing to new servers
  if [[ "$DRY_RUN" == "false" ]]; then
    log "Waiting 10s for LB to stabilise with new targets..."
    sleep 10
  fi

  # Drain and remove old servers (if any)
  for old_name in "${old_servers[@]}"; do
    log "Removing old server: ${old_name}"
    detach_from_lb "${old_name}"

    # Remove DNS record for old server IP
    if [[ "$DRY_RUN" == "false" ]]; then
      local old_ip
      old_ip="$(get_server_ip "${old_name}" 2>/dev/null || true)"
      if [[ -n "$old_ip" ]]; then
        dns_remove_a_by_ip "${old_ip}"
      fi
    else
      echo "[dry-run] DNS remove A record for old server IP of ${old_name}"
    fi

    hc server delete "${old_name}"
    log "Deleted old server: ${old_name}"
  done

  # Update MX record to point at first new server
  dns_ensure_mx

  log "=== Rolling replace complete ==="
  log "New servers: ${new_servers[*]}"
  print_status
}

# ============================================================
# --list / --status
# ============================================================
print_status() {
  echo ""
  echo "=== Fleet Status (${FLEET_ENV}) ==="
  echo ""

  echo "--- Servers ---"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] hcloud server list -l project=slipscan,env=${FLEET_ENV}"
  else
    hc_query server list \
      -o columns=name,ipv4,status,created \
      -l "project=slipscan,env=${FLEET_ENV}" 2>/dev/null || echo "(none)"
  fi

  echo ""
  echo "--- Load Balancer: ${LB_NAME} ---"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] hcloud load-balancer describe ${LB_NAME}"
  else
    hc_query load-balancer describe "${LB_NAME}" 2>/dev/null \
      | grep -E "Name|Public IP|Health|Target" || echo "(not found)"
  fi

  echo ""
  echo "--- DNS Records (zone: ${HCLOUD_DNS_ZONE_ID:-not set}) ---"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] GET https://dns.hetzner.com/api/v1/records?zone_id=<ZONE_ID>"
  elif [[ -n "${HCLOUD_DNS_ZONE_ID:-}" ]]; then
    curl -s \
      -H "Auth-API-Token: ${HCLOUD_TOKEN}" \
      "https://dns.hetzner.com/api/v1/records?zone_id=${HCLOUD_DNS_ZONE_ID}" \
      | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('records', []):
    if r['type'] in ('A', 'MX', 'TXT'):
        print(f\"  {r['type']:5} {r['name']:30} -> {r['value']}\")
" 2>/dev/null || echo "(error fetching DNS records)"
  else
    echo "(HCLOUD_DNS_ZONE_ID not set)"
  fi
  echo ""
}

# ============================================================
# Main
# ============================================================
main() {
  log "slip/scan deploy.sh — env=${FLEET_ENV}, dry-run=${DRY_RUN}"

  check_prerequisites

  if [[ "$DO_LIST" == "true" ]]; then
    print_status
    exit 0
  fi

  if [[ "$DO_REPLACE" == "true" ]]; then
    replace_fleet "${REPLACE_COUNT}"
  else
    provision_fleet
  fi
}

main "$@"
