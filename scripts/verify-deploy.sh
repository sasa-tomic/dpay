#!/usr/bin/env bash
# Deploy-fidelity gate for the dpay canister: assert the code RUNNING on mainnet is byte-identical to
# the code built from the current source tree. OBJECTIVE by construction — no heuristics, no version
# string to keep in sync: it compares the SHA-256 of the exact artifact dfx would install against the
# module hash the IC reports as currently installed. The class of bug this catches is the one that bit
# this project twice (a stale relay IMAGE + a stale canister WASM shipped while `just check` was green).
#
# It works because dfx embeds the `candid:service` metadata section before installing, so the raw
# cargo-built wasm hash does NOT match the installed hash — but `dfx build` reproduces the SAME
# metadata-embedded artifact, whose hash equals the installed module hash (verified empirically). So
# the gate is: build from source → dfx-embed metadata → hash → compare to the live module hash.
#
#   DPAY_DFX_IDENTITY  (deploy/.env) named dfx identity with query rights
#   DPAY_DFX_NETWORK   (optional)    default `ic` (mainnet); set `local` to rehearse
#   DPAY_CANISTER_ID   (deploy/.env) the canister to audit
# Exit 0 = deployed code == source (current). Exit 1 = STALE (deployed code predates the source).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh

CANISTER=dpay_canister
CRATE=dpay-canister
NETWORK="${DPAY_DFX_NETWORK:-ic}"

command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }

IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
[ -n "$IDENT" ] || { echo "DPAY_DFX_IDENTITY is required" >&2; exit 1; }
CID="$(env_get DPAY_CANISTER_ID deploy/.env)"
[ -n "$CID" ] || { echo "DPAY_CANISTER_ID is required (deploy/.env)" >&2; exit 1; }
dfx_i() { dfx --identity "$IDENT" "$@"; }

echo "== build canister wasm from source (release) =="
cargo build -q -p "$CRATE" --target wasm32-unknown-unknown --release

echo "== dfx build: embed candid:service metadata (reproduces the installed artifact) =="
dfx build "$CANISTER" --network "$NETWORK" >/dev/null
ARTIFACT=".dfx/$NETWORK/canisters/$CANISTER/$CANISTER.wasm"
[ -f "$ARTIFACT" ] || { echo "dfx build did not produce $ARTIFACT" >&2; exit 1; }
BUILT="$(sha256sum "$ARTIFACT" | awk '{print $1}')"

echo "== read the INSTALLED module hash from $NETWORK =="
INFO="$(dfx_i canister info "$CID" --network "$NETWORK")"
LIVE="$(sed -n 's/^Module hash: 0x//p' <<<"$INFO")"
[ -n "$LIVE" ] && [ "$LIVE" != "None" ] || {
  echo "canister $CID has no installed code on $NETWORK (Module hash empty)" >&2
  exit 1
}

echo "   source-built: $BUILT"
echo "   live mainnet: $LIVE"
echo
if [ "$BUILT" = "$LIVE" ]; then
  echo "PASS: deployed $CID is byte-identical to the current source."
  exit 0
else
  echo "FAIL: deployed $CID is STALE — the running code predates the current source."
  echo "      redeploy:  just deploy-ic"
  exit 1
fi
