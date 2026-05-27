#!/usr/bin/env bash
# =============================================================================
# cloudflare-app-dns.sh — Create application + Email Routing DNS records
#                         in Cloudflare for slipscan.app
# =============================================================================
#
# USAGE
# -----
#   # 1. Set required env vars:
#   export CF_API_TOKEN="<cloudflare-api-token>"   # Needs Zone:Edit DNS
#   export CF_ZONE_ID="<zone-id-for-slipscan.app>"
#
#   # 2. (Optional) Override defaults:
#   export APEX_DOMAIN="slipscan.app"           # default if unset
#   export PAGES_HOSTNAME="<project>.pages.dev" # Cloudflare Pages subdomain
#   export API_WORKERS_HOSTNAME="slipscan-api.workers.dev"
#
#   # 3. Create all app + Email Routing records:
#   ./cloudflare-app-dns.sh
#
#   # 4. To create the SES sending records (SPF/DKIM/DMARC), run the sibling:
#   ./cloudflare-ses-dns.sh [--dkim <token1> <token2> <token3>]
#
# WHAT THIS SCRIPT CREATES
# -------------------------
#   app.slipscan.app  CNAME → <PAGES_HOSTNAME>          (proxied)
#   api.slipscan.app  CNAME → <API_WORKERS_HOSTNAME>    (proxied)
#
#   Email Routing MX + TXT records for mail.slipscan.app
#   (the same records Cloudflare adds automatically when you enable Email
#   Routing in the dashboard — this script is for automated / IaC workflows):
#     mail.slipscan.app  MX  route1.mx.cloudflare.net  (priority 82)
#     mail.slipscan.app  MX  route2.mx.cloudflare.net  (priority 37)
#     mail.slipscan.app  MX  route3.mx.cloudflare.net  (priority 14)
#     mail.slipscan.app  TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
#
# IDEMPOTENCY
# -----------
# Each record creation is a POST (Cloudflare create, not upsert).
# Duplicate records return an error that is treated as a WARNING, not a
# failure — so the script is safe to re-run; existing records are left as-is.
#
# PROXIED vs DNS-ONLY flags
# -------------------------
#   app / api CNAME records: proxied=true  (orange cloud — routes through CF CDN)
#   Email Routing MX / TXT:  proxied=false (DNS only — mail delivery requires it)
#
# REQUIRED TOOLS
# --------------
#   curl, jq (jq is optional — errors are printed as raw JSON if absent)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
APEX_DOMAIN="${APEX_DOMAIN:-slipscan.app}"
PAGES_HOSTNAME="${PAGES_HOSTNAME:-}"
API_WORKERS_HOSTNAME="${API_WORKERS_HOSTNAME:-slipscan-api.workers.dev}"

MAIL_SUBDOMAIN="mail.${APEX_DOMAIN}"

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_API_TOKEN is not set." >&2
  exit 1
fi
if [[ -z "${CF_ZONE_ID:-}" ]]; then
  echo "ERROR: CF_ZONE_ID is not set." >&2
  exit 1
fi

CF_API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"

# ---------------------------------------------------------------------------
# Helper: create a DNS record via the Cloudflare API (idempotent — warns on dup)
# ---------------------------------------------------------------------------
# Usage: cf_create_record <type> <name> <content> [priority] [ttl] [proxied]
cf_create_record() {
  local record_type="$1"
  local name="$2"
  local content="$3"
  local priority="${4:-}"
  local ttl="${5:-300}"
  local proxied="${6:-false}"

  # Build JSON payload
  local payload
  if [[ -n "$priority" ]]; then
    payload=$(printf \
      '{"type":"%s","name":"%s","content":"%s","priority":%s,"ttl":%s,"proxied":%s}' \
      "$record_type" "$name" "$content" "$priority" "$ttl" "$proxied")
  else
    payload=$(printf \
      '{"type":"%s","name":"%s","content":"%s","ttl":%s,"proxied":%s}' \
      "$record_type" "$name" "$content" "$ttl" "$proxied")
  fi

  echo "  Creating ${record_type} ${name} → ${content} (proxied=${proxied}) ..."

  local response
  response=$(curl --silent --request POST \
    --url "$CF_API" \
    --header "Authorization: Bearer ${CF_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$payload")

  # Surface errors
  if command -v jq &>/dev/null; then
    local success
    success=$(echo "$response" | jq -r '.success')
    if [[ "$success" != "true" ]]; then
      local errors
      errors=$(echo "$response" | jq -r '.errors[]?.message // "unknown error"')
      # Duplicate record errors are warnings, not failures
      if echo "$errors" | grep -qi "already exists\|duplicate"; then
        echo "  WARNING (skip): ${record_type} ${name} already exists — skipping." >&2
      else
        echo "  WARNING: Cloudflare API error for ${record_type} ${name}: ${errors}" >&2
      fi
    else
      echo "  OK"
    fi
  else
    # jq not available — print raw response
    echo "  Response: $response"
  fi
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      head -60 "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "=== Cloudflare application + Email Routing DNS setup ==="
echo "Zone ID:       ${CF_ZONE_ID}"
echo "Apex domain:   ${APEX_DOMAIN}"
echo "Mail subdomain:${MAIL_SUBDOMAIN}"
echo ""

# ---------------------------------------------------------------------------
# API Worker custom domain
# api.slipscan.app → slipscan-api.workers.dev (proxied CNAME)
# NOTE: wrangler deploy also creates this record automatically when
# custom_domain = true is set in wrangler.toml. This section is provided
# for environments where the DNS must be pre-created before the first deploy.
# ---------------------------------------------------------------------------
echo "--- API Worker: api.${APEX_DOMAIN} (proxied CNAME) ---"
if [[ -n "$API_WORKERS_HOSTNAME" ]]; then
  cf_create_record "CNAME" "api.${APEX_DOMAIN}" "${API_WORKERS_HOSTNAME}" "" "1" "true"
  # ttl=1 means "automatic" in Cloudflare for proxied records
else
  echo "  SKIP: API_WORKERS_HOSTNAME not set. Wrangler sets this on deploy."
fi

echo ""

# ---------------------------------------------------------------------------
# Pages custom domain
# app.slipscan.app → <project>.pages.dev (proxied CNAME)
# ---------------------------------------------------------------------------
echo "--- Pages: app.${APEX_DOMAIN} (proxied CNAME) ---"
if [[ -n "$PAGES_HOSTNAME" ]]; then
  cf_create_record "CNAME" "app.${APEX_DOMAIN}" "${PAGES_HOSTNAME}" "" "1" "true"
else
  echo "  NOTE: PAGES_HOSTNAME not set. Set it from the Cloudflare Pages"
  echo "        dashboard under your Pages project → Custom domains → Add."
  echo "  Example: export PAGES_HOSTNAME=slipscan-frontend.pages.dev"
  echo "  Skipping app.${APEX_DOMAIN} CNAME."
fi

echo ""

# ---------------------------------------------------------------------------
# Email Routing MX records (DNS only — MUST NOT be proxied)
# These are the standard Cloudflare Email Routing MX servers.
# Cloudflare adds these automatically when you enable Email Routing in the
# dashboard. This script adds them for IaC/automated workflows.
# ---------------------------------------------------------------------------
echo "--- Email Routing: ${MAIL_SUBDOMAIN} MX records (DNS only) ---"
echo "NOTE: If Email Routing is already enabled in the dashboard, these"
echo "records likely already exist. Duplicates will be warned and skipped."
echo ""

cf_create_record "MX" "${MAIL_SUBDOMAIN}" "route1.mx.cloudflare.net" "82" "300" "false"
cf_create_record "MX" "${MAIL_SUBDOMAIN}" "route2.mx.cloudflare.net" "37" "300" "false"
cf_create_record "MX" "${MAIL_SUBDOMAIN}" "route3.mx.cloudflare.net" "14" "300" "false"

echo ""

# ---------------------------------------------------------------------------
# Email Routing SPF TXT record (DNS only)
# This certifies that Cloudflare's mail servers are authorised senders for
# the mail.slipscan.app domain (for Email Routing ownership/inbound only).
#
# NOTE: The SES SPF record (v=spf1 include:amazonses.com ~all) on the same
# label is created by cloudflare-ses-dns.sh. Cloudflare TXT records on the
# same label with different values are stored as SEPARATE TXT records, which
# is correct — a receiving MTA will see both and check each one.
# There is NO SPF record conflict between these two records.
# ---------------------------------------------------------------------------
echo "--- Email Routing: ${MAIL_SUBDOMAIN} ownership TXT (DNS only) ---"
cf_create_record "TXT" "${MAIL_SUBDOMAIN}" \
  "v=spf1 include:_spf.mx.cloudflare.net ~all" "" "300" "false"

echo ""

# ---------------------------------------------------------------------------
# Summary and verification commands
# ---------------------------------------------------------------------------
echo "=== Done. Verify with:"
echo "  dig CNAME api.${APEX_DOMAIN} +short"
if [[ -n "$PAGES_HOSTNAME" ]]; then
  echo "  dig CNAME app.${APEX_DOMAIN} +short"
fi
echo "  dig MX    ${MAIL_SUBDOMAIN}  +short"
echo "  dig TXT   ${MAIL_SUBDOMAIN}  +short"
echo ""
echo "Next steps:"
echo "  1. Enable Email Routing in Cloudflare dashboard (if not already enabled)."
echo "     Dashboard → Email → Email Routing → Enable."
echo "  2. Add catch-all rule: *@${MAIL_SUBDOMAIN} → Worker → slipscan-email-ingest."
echo "  3. Run cloudflare-ses-dns.sh to add SES sending records (SPF/DMARC/DKIM)."
echo "     ./cloudflare-ses-dns.sh [--dkim <token1> <token2> <token3>]"
