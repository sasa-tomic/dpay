#!/usr/bin/env bash
# Deploy the dpay canister to ICP MAINNET (the built-in `ic` network) and print its canister id.
#
# The mainnet sibling of scripts/dfx-deploy.sh (which stands up a throwaway LOCAL replica and
# self-tests a settlement). Here we only build, (re)deploy, and read back a couple of *free* query
# calls as a sanity check — we deliberately do NOT push a state-changing payment to mainnet from a
# script.
#
# Prerequisites you must set up yourself (cannot be automated here):
#   * A dfx identity that holds cycles (or ICP + a cycles wallet): `dfx deploy --network ic` spends
#     cycles to create and install the canister. THAT IDENTITY BECOMES THE CANISTER CONTROLLER.
#   * Current demo phase: the canister ships WITHOUT the money-critical hardening — `mint` is
#     unauthenticated and the controller is your own key (not blackholed / not SNS-governed). That is
#     an ACCEPTED gap while there is no real money on the canister; it is a hard gate before the pilot.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name
NETWORK=ic                    # dfx's built-in mainnet alias — no dfx.json entry needed

# Extract the first candid nat value from a reply, e.g. `(7_500 : nat64)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }

command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }

echo "== preflight: reach mainnet + show the identity that will control the canister =="
dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the ic network (dfx ping ic failed)" >&2; exit 1; }
echo "   identity:  $(dfx identity whoami)"
echo "   principal: $(dfx identity get-principal)   <- this becomes the canister controller"

echo "== build canister wasm (release) =="
cargo build -p "$CRATE" --target wasm32-unknown-unknown --release

echo "== refresh candid from the wasm =="
mkdir -p dfx
candid-extractor "target/wasm32-unknown-unknown/release/${CANISTER}.wasm" > dfx/dpay_canister.did

echo "== generate deterministic candid init args (pre-funded demo accounts) =="
cargo run -q -p dpay-fixture

echo "== deploy to $NETWORK (creates + installs; spends cycles) =="
dfx deploy "$CANISTER" --network "$NETWORK" --argument-file dfx/args/init.arg

CID=$(dfx canister id "$CANISTER" --network "$NETWORK")
echo
echo "== deployed =="
echo "   canister id: $CID"
echo "   cap:         $(dfx canister call "$CANISTER" per_tx_cap --network "$NETWORK" --query 2>/dev/null | nat)"
PA0=$(dfx canister call "$CANISTER" balance_of --network "$NETWORK" --query --argument-file dfx/args/payer.arg 2>/dev/null | nat)
MB0=$(dfx canister call "$CANISTER" balance_of --network "$NETWORK" --query --argument-file dfx/args/merchant.arg 2>/dev/null | nat)
echo "   opening balances: payer=$PA0  merchant=$MB0"
echo
echo "next: point the relay at it — in deploy/.env set"
echo "   DPAY_LEDGER=ic  DPAY_CANISTER_ID=$CID  DPAY_IC_URL=https://icp-api.io  DPAY_IC_FETCH_ROOT_KEY=false"
echo "then complete the tunnel setup (deploy/README.md) and: just up"
