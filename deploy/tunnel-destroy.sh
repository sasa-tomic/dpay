#!/usr/bin/env bash
# Tear down what tunnel-provision.sh created: the DNS route and the named tunnel. The inverse of
# provisioning, so the create-only provision has a clean redo loop (destroy -> provision).
#
# Stop the stack first (`just compose-down`) — a tunnel with live connections cannot be deleted.
# This clears any lingering connection records, then deletes the tunnel and the CNAME. Missing
# pieces are reported and skipped (there is nothing to delete), never treated as an error.
#
# Same token/env as tunnel-provision.sh:
#   CF_API_TOKEN (required)  ·  DPAY_PUBLIC_HOSTNAME (required)
#   DPAY_TUNNEL_NAME (default dpay-relay)  ·  CF_ACCOUNT_ID (only if the token spans >1 account)
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/cf-lib.sh
source "$DEPLOY_DIR/cf-lib.sh"

cf_require_tools
: "${DPAY_PUBLIC_HOSTNAME:?set DPAY_PUBLIC_HOSTNAME, e.g. relay.dpay.example}"
HOST="$DPAY_PUBLIC_HOSTNAME"
TUNNEL_NAME="${DPAY_TUNNEL_NAME:-dpay-relay}"

cf_verify_token
ACCOUNT_ID="$(cf_account_id)"
read -r ZONE_ID ZONE_NAME <<<"$(cf_zone_for_host "$HOST")"

# DNS record (delete before the tunnel so a re-provision cannot collide on the CNAME).
rec="$(cf GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$HOST")"
rid="$(jq -r '.result[0].id // empty' <<<"$rec")"
if [ -n "$rid" ]; then
  cf DELETE "/zones/$ZONE_ID/dns_records/$rid" >/dev/null
  echo "deleted DNS $HOST (zone $ZONE_NAME)"
else
  echo "no DNS record for $HOST — nothing to delete"
fi

# Tunnel (clear connections first; a tunnel with live connections refuses deletion).
existing="$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false")"
if [ "$(jq '.result | length' <<<"$existing")" = "0" ]; then
  echo "no tunnel named '$TUNNEL_NAME' — nothing to delete"
  exit 0
fi
tunnel_id="$(jq -r '.result[0].id' <<<"$existing")"
cf DELETE "/accounts/$ACCOUNT_ID/cfd_tunnel/$tunnel_id/connections" >/dev/null
cf DELETE "/accounts/$ACCOUNT_ID/cfd_tunnel/$tunnel_id" >/dev/null
echo "deleted tunnel '$TUNNEL_NAME' ($tunnel_id)"
