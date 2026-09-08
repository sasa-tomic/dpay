#!/usr/bin/env bash
# Deploy-fidelity gate for the dpay RELAY: assert the relay image RUNNING at the live endpoint is
# built from the current source. The OBJECTIVE canister gate (verify-deploy.sh) compares a wasm
# module hash; this is the relay analogue — it compares the live `/api/v1/version` commit (baked by
# dpay-relay's build.rs at image-build time) to `git rev-parse HEAD`.
#
# Outcomes:
#   MATCH          — the live relay's commit == HEAD (the running image is current).
#   DIRTY          — the live commit carries the `-dirty` marker build.rs bakes for a build made
#                    from a modified working tree. The image corresponds to NO commit, so it is
#                    neither current nor behind — it is unidentifiable. Checked FIRST, because a
#                    dirty build whose base SHA equals HEAD would otherwise read as MATCH. Exit 1.
#   BEHIND by N    — the live commit is an ANCESTOR of HEAD (HEAD is ahead; the image predates the
#                    source — redeploy per docs/OPS.md section 3). Exit 1.
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
# Extract the commit field without a jq dependency (the body is a flat 3-field JSON object). The
# match is the whole quoted value, NOT `[0-9a-f]*`: that older pattern stopped at the `-` of a
# `-dirty` marker and handed back a clean-looking 40-char SHA, which is precisely how a dirty image
# reported MATCH.
LIVE_RAW="$(printf '%s' "$LIVE_JSON" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
case "$LIVE_RAW" in
  *-dirty) LIVE="${LIVE_RAW%-dirty}"; LIVE_DIRTY=yes ;;
  *)       LIVE="$LIVE_RAW";          LIVE_DIRTY=no  ;;
esac
if [ -z "$LIVE" ] || [ "${#LIVE}" -ne 40 ]; then
  echo "verify-relay-version: live /version did not return a 40-char commit. body:" >&2
  printf '%s\n' "$LIVE_JSON" | head -c 400 >&2
  exit 2
fi
echo "== live relay: $LIVE_RAW  ($URL)"

# DIRTY first: the base SHA may well equal HEAD, and treating that as MATCH is the bug this state
# exists to make impossible. Uncommitted code was compiled into the image (deploy/build.sh builds
# the working tree), so no commit describes what is running.
if [ "$LIVE_DIRTY" = yes ]; then
  echo "FAIL: the live relay was built from a DIRTY working tree (/version reports $LIVE_RAW)."
  echo "      uncommitted changes were compiled into the image, so commit $LIVE does NOT describe"
  echo "      what prod is running and nothing here can tell you what does."
  echo "      commit the tree, then redeploy — docs/OPS.md section 3 (the image build now"
  echo "      refuses a dirty tree, so this state can only be an image built before that gate)."
  exit 1
fi

if [ "$LIVE" = "$HEAD" ]; then
  echo "PASS: the live relay is built from the current HEAD ($HEAD)."
  exit 0
fi

# Classify the divergence. `merge-base --is-ancestor A B` exits 0 iff A is reachable from B.
if git merge-base --is-ancestor "$LIVE" "$HEAD" 2>/dev/null; then
  BEHIND="$(git rev-list --count "$LIVE..$HEAD")"
  echo "FAIL: the live relay is BEHIND by $BEHIND commit(s) (live=$LIVE, HEAD=$HEAD)."
  echo "      the running image predates the current source — redeploy: docs/OPS.md section 3."
  exit 1
fi
echo "FAIL: the live relay commit ($LIVE) is NOT an ancestor of HEAD ($HEAD) — MISMATCH (divergent / different branch / force-push)."
echo "      redeploy from the intended branch — docs/OPS.md section 3."
exit 1
