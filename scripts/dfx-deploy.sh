#!/usr/bin/env bash
# Real dfx deploy — outer-loop fidelity gate for the canister/ledger path.
#
# Unlike the PocketIC in-process tests, this stands up an actual local dfx replica, installs the
# canister with init args, and drives it purely through `dfx canister call` — the same client path
# a real deployment uses. It submits the *exact* 196-byte offline-signed wire the phone would sign
# (built by dpay-fixture via the shared dpay-core), proves funds move, and proves a replayed
# payment is refused (nonce single-use). Self-asserting: exits non-zero on any mismatch.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name

# Extract the first candid nat value from a `dfx canister call` reply, e.g. `(7_500 : nat64)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }

echo "== build canister wasm (release) =="
cargo build -p "$CRATE" --target wasm32-unknown-unknown --release

echo "== refresh candid from the wasm =="
mkdir -p dfx
# Guard: without this tool the redirect below truncates the committed candid file to empty.
command -v candid-extractor >/dev/null 2>&1 || { echo "candid-extractor not found — cargo install candid-extractor" >&2; exit 1; }
candid-extractor "target/wasm32-unknown-unknown/release/${CANISTER}.wasm" > dfx/dpay_canister.did

echo "== generate deterministic candid args (offline-signed payment) =="
cargo run -q -p dpay-fixture

echo "== start a clean local replica =="
dfx stop >/dev/null 2>&1 || true
dfx start --clean --background >/tmp/dfx-start.log 2>&1
trap 'dfx stop >/dev/null 2>&1 || true' EXIT

echo "== deploy with init args =="
dfx deploy "$CANISTER" --argument-file dfx/args/init.arg

CID=$(dfx canister id "$CANISTER")
echo "   canister id: $CID"
echo "   cap: $(dfx canister call "$CANISTER" per_tx_cap)"

# shellcheck disable=SC1091
source dfx/args/expect.env
PA0=$(dfx canister call "$CANISTER" balance_of --argument-file dfx/args/payer.arg | nat)
MB0=$(dfx canister call "$CANISTER" balance_of --argument-file dfx/args/merchant.arg | nat)
echo "== opening balances: payer=$PA0  merchant=$MB0 =="

echo "== submit the offline-signed payment =="
dfx canister call "$CANISTER" pay --argument-file dfx/args/pay.arg

echo "== replay the same payment — must be refused (nonce single-use) =="
# A rejected payment returns a candid `Err` variant (a *successful* call, exit 0) — so inspect the
# reply, not the exit code. Only a trap/timeout would be a non-zero exit.
DUP=$(dfx canister call "$CANISTER" pay --argument-file dfx/args/pay.arg 2>&1 || true)
if echo "$DUP" | grep -q 'Err'; then
  echo "   refused: $(echo "$DUP" | grep -oE 'NonceReused|Err = \\?"[^"]*"' | head -1)"
else
  echo "FAIL: replayed payment was accepted: $DUP"; exit 1
fi

PA1=$(dfx canister call "$CANISTER" balance_of --argument-file dfx/args/payer.arg | nat)
MB1=$(dfx canister call "$CANISTER" balance_of --argument-file dfx/args/merchant.arg | nat)
echo "== closing balances: payer=$PA1 (expect $PAYER_AFTER)  merchant=$MB1 (expect $MERCHANT_AFTER) =="

if ! { [ "$PA1" = "$PAYER_AFTER" ] && [ "$MB1" = "$MERCHANT_AFTER" ]; }; then echo "FAIL: balances wrong"; exit 1; fi
echo
echo "== PASS: real dfx deploy settled the offline-signed payment; replay refused. =="
