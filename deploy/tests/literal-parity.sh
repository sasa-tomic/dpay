#!/usr/bin/env bash
# shellcheck shell=bash
#
# BYTE-PARITY harness for the dfx install arguments (the Candid init literals): runs the REAL
# scripts/dfx-deploy.sh and scripts/dfx-deploy-ic-staging.sh (local rehearsal — exactly how the
# justfile's deploy-ic-staging recipe invokes it) against the mock dfx (mock-dfx.sh) and asserts
# the Candid arguments they hand to `dfx canister install` / `dfx deploy` are BYTE-IDENTICAL to the
# committed fixtures in deploy/tests/fixtures/. That is the proof that the shared literal builders
# in deploy/dfx-lib.sh (icrc_ledger_init_arg / facade_init_arg) — and any future edit to them —
# never change an emitted install argument by one byte.
#
# Fully offline: the cargo work is REAL (dpay-fixture regenerates dfx/args/ — deterministic, so
# even the fixture-derived CAP lands in the captured literal), only dfx is mocked.
# scripts/dfx-deploy.sh is EXPECTED to abort at its post-install ledger-balance assert (the mock
# answers every query with a constant) — AFTER both installs; the harness asserts the captured
# argument count instead of that script's exit code. The staging rehearsal completes (exit 0).
#
#   bash deploy/tests/literal-parity.sh         # check against the committed fixtures
#   bash deploy/tests/literal-parity.sh regen   # RE-CAPTURE the fixtures — only on an INTENTIONAL
#                                               # literal change; commit them with it (like the
#                                               # e2e visual baselines)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
FIXTURE_DIR=deploy/tests/fixtures

# Hermetic: the runs below must not touch (or fail on) sops — sourcing deploy/env-lib.sh
# auto-regenerates deploy/.env otherwise, which needs the age key this harness must not require.
export DPAY_ENV_SYNC=0

# A real dfx landing AHEAD of the mock in PATH would silently drive a live replica instead of being
# captured. setup_dfx_env (deploy/dfx-lib.sh) prepends .dev/cargo/bin and $HOME/.local/share/dfx/bin;
# the runs below jail HOME to neutralize the second, and a dfx inside the cargo toolchain bin — the
# first — is refused loudly rather than raced.
[ ! -e .dev/cargo/bin/dfx ] || { echo "REFUSING: .dev/cargo/bin/dfx would shadow the mock dfx" >&2; exit 1; }

REGEN=0
if [ "${1:-}" = "regen" ]; then REGEN=1; fi
if [ $# -gt 1 ]; then echo "usage: $0 [regen]" >&2; exit 1; fi

TMP="$(mktemp -d)"
cleanup() {
  code=$?
  if [ "$code" -eq 0 ]; then rm -rf "$TMP"; else echo "left $TMP for inspection" >&2; fi
}
trap cleanup EXIT
mkdir -p "$TMP/bin" "$TMP/home" "$FIXTURE_DIR"
install -m 755 deploy/tests/mock-dfx.sh "$TMP/bin/dfx"

mock_env() { # $1=stem — point the mock's capture at per-script files, reset both
  export DPAY_DFX_MOCK_TRACE="$TMP/$1.trace" DPAY_DFX_MOCK_ARGS="$TMP/$1.args"
  : >"$DPAY_DFX_MOCK_TRACE"
  : >"$DPAY_DFX_MOCK_ARGS"
}

assert_count() { # $1=stem $2=expected captured arguments
  local stem="$1" want="$2" got
  got=$(($(wc -l <"$TMP/$stem.args")))
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: $stem captured $got install argument(s), expected $want — the script aborted before/during the installs. Trace tail:" >&2
    tail -5 "$TMP/$stem.trace" >&2
    exit 1
  fi
}

decode() { # $1=file $2=label — pretty-print each captured line as label + decoded Candid
  local file="$1" label="$2" line
  while IFS= read -r line; do
    printf -- '--- %s: %s\n' "$label" "${line% *}"
    printf '%s' "${line##* }" | base64 -d
    printf '\n'
  done <"$file"
}

echo "== scripts/dfx-deploy.sh under the mock dfx =="
mock_env dfx-deploy
if PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash scripts/dfx-deploy.sh; then
  echo "   (completed under the mock)"
else
  # Expected: the ledger-balance assert fires post-install (the mock answers every query (0 : nat)).
  echo "   (aborted after the installs — the mock's constant balances guarantee it; captures kept)"
fi
assert_count dfx-deploy 2

echo "== DPAY_DFX_NETWORK=local scripts/dfx-deploy-ic-staging.sh under the mock dfx =="
mock_env dfx-deploy-ic-staging
if ! PATH="$TMP/bin:$PATH" HOME="$TMP/home" DPAY_DFX_NETWORK=local DPAY_DFX_IDENTITY=dpaymock \
  bash scripts/dfx-deploy-ic-staging.sh; then
  echo "FAIL: the staging local rehearsal must COMPLETE under the mock. Trace tail:" >&2
  tail -5 "$TMP/dfx-deploy-ic-staging.trace" >&2
  exit 1
fi
assert_count dfx-deploy-ic-staging 2

for stem in dfx-deploy dfx-deploy-ic-staging; do
  if [ "$REGEN" -eq 1 ]; then
    cp "$TMP/$stem.args" "$FIXTURE_DIR/$stem.args"
    echo "   regenerated $FIXTURE_DIR/$stem.args"
  elif ! diff -u "$FIXTURE_DIR/$stem.args" "$TMP/$stem.args"; then
    echo "FAIL: $stem's install arguments drifted from $FIXTURE_DIR/$stem.args — decoded, committed vs emitted now:" >&2
    decode "$FIXTURE_DIR/$stem.args" committed >&2
    decode "$TMP/$stem.args" emitted-now >&2
    exit 1
  fi
done

echo "PASS: dfx install arguments byte-identical to $FIXTURE_DIR (2 literals per script)"
