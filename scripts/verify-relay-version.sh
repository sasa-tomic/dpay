#!/usr/bin/env bash
# Deploy-fidelity gate for the dpay RELAY: assert the relay image RUNNING at the live endpoint is
# built from the current source. The OBJECTIVE canister gate (verify-deploy.sh) compares a wasm
# module hash; this is the relay analogue — it compares the live `/api/v1/version` commit (baked by
# dpay-relay's build.rs at image-build time) to `git rev-parse HEAD`.
#
# Outcomes:
#   MATCH          — the live relay's commit == HEAD (the running image is current).
#   BEHIND by N    — the live commit is an ANCESTOR of HEAD (HEAD is ahead; the image predates the
#                    source — redeploy: `just image && just up`). Exit 1.
#   MISMATCH       — the live commit is NOT an ancestor of HEAD (divergent / force-pushed / different
#                    branch). Exit 1.
#   (unreachable)  — the live endpoint didn't answer or returned no commit. Exit 2.
#
# The relay /version needs NO dfx (unlike the canister gate); a plain curl with a timeout suffices.
# Uses `git rev-list --count` for the behind-count and `git merge-base --is-ancestor` to classify.
#
#   DPAY_RELAY_URL  (optional) the live base URL (default https://dpay.kalaj.org)
# Exit 0 = MATCH. Exit 1 = stale/divergent (needs redeploy). Exit 2 = unreachable / unparseable.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
URL="${DPAY_RELAY_URL:-https://dpay.kalaj.org}/api/v1/version"

HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$HEAD" ]; then
  echo "verify-relay-version: not a git checkout (no HEAD) — cannot compare." >&2
  exit 2
fi
echo "== local HEAD: $HEAD"

# Fetch the live /version with a bounded timeout. `-Ss` surfaces transport errors; `-f` would mask
# the body on a non-2xx, so check the HTTP code explicitly.
LIVE_JSON="$(curl -m 8 -Ss --connect-timeout 5 "$URL" 2>/dev/null)" || {
  echo "verify-relay-version: could not reach $URL (curl failed). Is the relay deployed + reachable?" >&2
  exit 2
}
# Extract the commit field without a jq dependency (the body is a flat 3-field JSON object).
LIVE="$(printf '%s' "$LIVE_JSON" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' | head -n1)"
if [ -z "$LIVE" ] || [ "${#LIVE}" -ne 40 ]; then
  echo "verify-relay-version: live /version did not return a 40-char commit. body:" >&2
  printf '%s\n' "$LIVE_JSON" | head -c 400 >&2
  exit 2
fi
echo "== live relay: $LIVE  ($URL)"

if [ "$LIVE" = "$HEAD" ]; then
  echo "PASS: the live relay is built from the current HEAD ($HEAD)."
  exit 0
fi

# Classify the divergence. `merge-base --is-ancestor A B` exits 0 iff A is reachable from B.
if git merge-base --is-ancestor "$LIVE" "$HEAD" 2>/dev/null; then
  BEHIND="$(git rev-list --count "$LIVE..$HEAD")"
  echo "FAIL: the live relay is BEHIND by $BEHIND commit(s) (live=$LIVE, HEAD=$HEAD)."
  echo "      the running image predates the current source — redeploy:  just image && just up"
  exit 1
fi
echo "FAIL: the live relay commit ($LIVE) is NOT an ancestor of HEAD ($HEAD) — MISMATCH (divergent / different branch / force-push)."
echo "      redeploy from the intended branch:  just image && just up"
exit 1
