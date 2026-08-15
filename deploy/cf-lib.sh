# shellcheck shell=bash
# Shared Cloudflare API client for the dpay tunnel scripts (tunnel-provision.sh / tunnel-destroy.sh).
#
# Sourced, not executed. It defines the thin curl+jq client and the three lookups both scripts need
# (verify token, resolve the account, resolve the zone that owns a hostname). Every call fails loud:
# a non-2xx or `"success": false` from Cloudflare aborts with the API's own error text — never a
# silent skip, never a guess.
#
# Contract for the caller: export CF_API_TOKEN before sourcing; the functions read it directly.

CF_API="https://api.cloudflare.com/client/v4"

# cf METHOD PATH [JSON_BODY]  ->  prints the full JSON response on success, aborts on any failure.
cf() {
  local method="$1" path="$2" body="${3:-}"
  # Bounded like scripts/verify-relay-version.sh: a black-holed connection must fail (loudly,
  # via --fail-with-body) within 30s, not hang tunnel-provision/destroy forever.
  local args=(--silent --show-error --fail-with-body --request "$method"
              --max-time 30 --connect-timeout 10
              --header "Authorization: Bearer ${CF_API_TOKEN}"
              --header "Content-Type: application/json")
  [ -n "$body" ] && args+=(--data "$body")
  local resp
  if ! resp="$(curl "${args[@]}" "${CF_API}${path}")"; then
    echo "Cloudflare API request failed: $method $path" >&2
    if [ -n "$resp" ]; then
      if jq -e . >/dev/null 2>&1 <<<"$resp"; then
        jq -r '.errors[]? | "  [\(.code)] \(.message)"' <<<"$resp" >&2
      else
        printf '  %s\n' "$resp" >&2   # not JSON — show the raw body rather than swallow it
      fi
    fi
    exit 1
  fi
  if [ "$(jq -r '.success' <<<"$resp")" != "true" ]; then
    echo "Cloudflare API error: $method $path" >&2
    jq -r '.errors[]? | "  [\(.code)] \(.message)"' <<<"$resp" >&2
    exit 1
  fi
  printf '%s' "$resp"
}

cf_require_tools() {
  local t
  for t in curl jq; do
    command -v "$t" >/dev/null 2>&1 || { echo "required tool not found on PATH: $t" >&2; exit 1; }
  done
  : "${CF_API_TOKEN:?set CF_API_TOKEN — a scoped API token with Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit}"
}

# Aborts unless the token is valid and active. Cheapest possible fail-fast for a bad/expired token.
cf_verify_token() {
  local status
  status="$(cf GET /user/tokens/verify | jq -r '.result.status')"
  [ "$status" = "active" ] || { echo "API token is not active (status: $status)" >&2; exit 1; }
}

# Prints the account id. Uses CF_ACCOUNT_ID if set; otherwise the sole account the token can see,
# and aborts (rather than pick one) when the token spans zero or several accounts.
cf_account_id() {
  [ -n "${CF_ACCOUNT_ID:-}" ] && { printf '%s' "$CF_ACCOUNT_ID"; return; }
  local accounts n
  accounts="$(cf GET '/accounts?per_page=50')"
  n="$(jq '.result | length' <<<"$accounts")"
  [ "$n" = "1" ] || {
    echo "token can see $n accounts — set CF_ACCOUNT_ID to choose one:" >&2
    jq -r '.result[] | "  \(.id)  \(.name)"' <<<"$accounts" >&2
    exit 1
  }
  jq -r '.result[0].id' <<<"$accounts"
}

# cf_zone_for_host HOST  ->  prints "ZONE_ID ZONE_NAME" for the most specific zone that is a DNS
# suffix of HOST. Aborts if no zone on the account owns the hostname.
cf_zone_for_host() {
  local host="$1" zones cand zid
  zones="$(cf GET '/zones?per_page=50')"
  cand="$host"
  while [ -n "$cand" ]; do
    zid="$(jq -r --arg n "$cand" '.result[] | select(.name==$n) | .id' <<<"$zones")"
    [ -n "$zid" ] && { printf '%s %s' "$zid" "$cand"; return; }
    local next="${cand#*.}"
    [ "$next" = "$cand" ] && break
    cand="$next"
  done
  echo "no Cloudflare zone on this account owns '$host' — is the domain added to Cloudflare?" >&2
  exit 1
}
