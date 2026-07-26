#!/usr/bin/env bash
# Headless Cloudflare Tunnel provisioning for the dpay relay — replaces the manual dashboard steps
# in README.md ("One-time tunnel setup") with one command. No browser, no `cloudflared login`.
#
# It creates a REMOTELY MANAGED named tunnel, points its ingress at the relay container, publishes
# the proxied DNS route, reads back the tunnel token, and writes it to deploy/.env as
# CF_TUNNEL_TOKEN — exactly what docker-compose.yml already consumes. Nothing about the running
# stack changes; this only fills the one secret you used to copy out of the dashboard by hand.
#
# Create-only by design: if a tunnel of this name already exists it aborts (run tunnel-destroy.sh).
# One code path — it provisions cleanly or it fails loud.
#
# Requires an API token (Account API Token, NOT the Global API Key) with:
#   Account · Cloudflare Tunnel · Edit     create the tunnel, set its config, read its token
#   Zone    · DNS               · Edit     publish the CNAME
# The token is a provisioning-time secret with more power than the tunnel token, so it is passed in
# the environment and is NEVER written to .env.
#
# Env:
#   CF_API_TOKEN          (required) the scoped API token above
#   DPAY_PUBLIC_HOSTNAME  (required) public hostname to serve, e.g. relay.dpay.example
#   DPAY_TUNNEL_NAME      (optional) tunnel name; default dpay-relay
#   CF_ACCOUNT_ID         (optional) only needed if the token spans more than one account
#
#   just tunnel-provision            # after: set DPAY_CANISTER_ID in deploy/.env, then `just up`
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/cf-lib.sh
source "$DEPLOY_DIR/cf-lib.sh"
# shellcheck source=deploy/env-lib.sh
source "$DEPLOY_DIR/env-lib.sh"

cf_require_tools
: "${DPAY_PUBLIC_HOSTNAME:?set DPAY_PUBLIC_HOSTNAME, e.g. relay.dpay.example}"
HOST="$DPAY_PUBLIC_HOSTNAME"
TUNNEL_NAME="${DPAY_TUNNEL_NAME:-dpay-relay}"

cf_verify_token
ACCOUNT_ID="$(cf_account_id)"
read -r ZONE_ID ZONE_NAME <<<"$(cf_zone_for_host "$HOST")"

# Guard: create-only. A name collision means a prior run (or the dashboard) already made this tunnel.
existing="$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false")"
if [ "$(jq '.result | length' <<<"$existing")" != "0" ]; then
  echo "tunnel '$TUNNEL_NAME' already exists (id $(jq -r '.result[0].id' <<<"$existing"))." >&2
  echo "run 'just tunnel-destroy' first, or set DPAY_TUNNEL_NAME to a fresh name." >&2
  exit 1
fi

echo "== creating tunnel '$TUNNEL_NAME' in account $ACCOUNT_ID =="
tunnel_id="$(cf POST "/accounts/$ACCOUNT_ID/cfd_tunnel" \
  "$(jq -nc --arg n "$TUNNEL_NAME" '{name:$n, config_src:"cloudflare"}')" \
  | jq -r '.result.id')"
if [ -z "$tunnel_id" ] || [ "$tunnel_id" = "null" ]; then echo "tunnel create returned no id" >&2; exit 1; fi

echo "== ingress $HOST -> http://relay:8787 =="
cf PUT "/accounts/$ACCOUNT_ID/cfd_tunnel/$tunnel_id/configurations" \
  "$(jq -nc --arg h "$HOST" \
      '{config:{ingress:[{hostname:$h, service:"http://relay:8787", originRequest:{}},
                         {service:"http_status:404"}]}}')" >/dev/null

echo "== DNS: $HOST CNAME -> $tunnel_id.cfargotunnel.com (proxied) in zone $ZONE_NAME =="
cf POST "/zones/$ZONE_ID/dns_records" \
  "$(jq -nc --arg n "$HOST" --arg c "$tunnel_id.cfargotunnel.com" \
      '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1}')" >/dev/null

token="$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel/$tunnel_id/token" | jq -r '.result')"
if [ -z "$token" ] || [ "$token" = "null" ]; then echo "tunnel token endpoint returned nothing" >&2; exit 1; fi

env_file="$DEPLOY_DIR/.env"
[ -f "$env_file" ] || echo "creating deploy/.env from .env.example — you still must set DPAY_CANISTER_ID before 'just up'"
env_set CF_TUNNEL_TOKEN "$token" "$env_file"

cat <<EOF

✓ tunnel '$TUNNEL_NAME' ($tunnel_id) published
    https://$HOST  ->  http://relay:8787   (zone $ZONE_NAME, proxied CNAME)
    CF_TUNNEL_TOKEN written to deploy/.env

next:
  1) set DPAY_CANISTER_ID (and the ledger vars) in deploy/.env
  2) just up
  3) curl -sS https://$HOST/health          # {"status":"ok"}
EOF
