#!/usr/bin/env bash
# Integrity gate for the FACADE CANISTER (GOVERNANCE row 7): assert the wasm RUNNING on mainnet is
# the one the relay's build PINNED (deploy/facade-module-hash.txt, baked at image-build time by
# dpay-relay's build.rs). The relay reads the live hash off the public IC state tree and compares
# — this script just curls the verdict, so it needs no dfx and no seed (a plain curl).
#
# Outcomes (the route's own status field):
#   MATCH         — the deployed facade is the recorded upgrade. Exit 0.
#   MISMATCH      — the canister changed outside the recorded procedure → check who upgraded it,
#                   then re-record: `just deploy-ic` (rewrites the pin) + a docs/UPGRADES.md row.
#                   Exit 1.
#   UNPINNED      — the running relay image was built with no pin (an integrity surface that
#                   cannot say MATCH). Exit 1.
#   UNREACHABLE   — the IC read failed (or the relay has no facade configured). Retry; if it
#                   persists, the boundary/agent path is down — check /health too. Exit 1.
#   (unreachable) — the relay endpoint itself didn't answer. Exit 2.
#
#   DPAY_RELAY_URL  (optional) the live base URL (default https://dpay.kalaj.org)
# Exit 0 = MATCH. Exit 1 = not MATCH. Exit 2 = relay unreachable / unparseable.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
URL="${DPAY_RELAY_URL:-https://dpay.kalaj.org}/api/v1/integrity"

# Fetch the verdict with a bounded timeout. `-Ss` surfaces transport errors; `-f` would mask the
# body on a non-2xx (the route degrades to 200 + honest status rather than 5xx, but stay safe).
LIVE_JSON="$(curl -m 8 -Ss --connect-timeout 5 "$URL" 2>/dev/null)" || {
  echo "integrity-check: could not reach $URL (curl failed). Is the relay deployed + reachable?" >&2
  exit 2
}
# Extract the status field without a jq dependency (flat top-level field of the response).
STATUS="$(printf '%s' "$LIVE_JSON" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([A-Z]*\)".*/\1/p' | head -n1)"
if [ -z "$STATUS" ]; then
  echo "integrity-check: live /integrity did not return a status. body:" >&2
  printf '%s\n' "$LIVE_JSON" | head -c 400 >&2
  exit 2
fi
echo "== facade integrity: $STATUS  ($URL)"
printf '%s' "$LIVE_JSON" | sed -n 's/.*"pinned_module_hash"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/== pinned hash:  \1/p' | head -n1
printf '%s' "$LIVE_JSON" | sed -n 's/.*"live_module_hash"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/== live hash:    \1/p' | head -n1

case "$STATUS" in
  MATCH)
    echo "PASS: the deployed facade canister is the pinned, recorded upgrade."
    exit 0
    ;;
  MISMATCH)
    echo "FAIL: the facade canister's module hash differs from the pin — an upgrade happened outside the recorded procedure."
    echo "      check who upgraded it, then re-record:  just deploy-ic   (rewrites the pin) + a docs/UPGRADES.md row"
    exit 1
    ;;
  UNPINNED)
    echo "FAIL: the running relay image was built with no pin — rebuild the image from this checkout (deploy/facade-module-hash.txt)."
    exit 1
    ;;
  UNREACHABLE)
    echo "FAIL: the relay could not read the facade's module hash off the IC state tree."
    echo "      retry in a minute; if it persists check the relay's own /health and /version (is the image current?)."
    exit 1
    ;;
  *)
    echo "integrity-check: unknown status \"$STATUS\". body:" >&2
    printf '%s\n' "$LIVE_JSON" | head -c 400 >&2
    exit 2
    ;;
esac
