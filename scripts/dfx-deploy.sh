#!/usr/bin/env bash
# Real dfx deploy — outer-loop fidelity gate for the facade + ICRC ledger.
#
# Unlike the PocketIC in-process tests, this stands up an actual local dfx replica, installs the
# REAL DFINITY ic-icrc1-ledger (cached in third_party/) + the dpay FACADE canister wired to it, and
# drives the *exact* 292-byte offline-signed wire the phone would sign (built by dpay-fixture via
# the shared dpay-core) purely through `dfx canister call`. Proves funds move ON the ledger (read
# back directly via icrc1_balance_of) and a replayed payment is refused (nonce single-use).
# Self-asserting: exits non-zero on any mismatch.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Hex string (even length) -> a candid blob literal `blob "\hh\hh..."`.
hexesc() { local h="$1" out="" i; for ((i=0; i<${#h}; i+=2)); do out+="\\${h:$i:2}"; done; printf '%s' "$out"; }
blob()   { printf 'blob "%s"' "$(hexesc "$1")"; }

[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}

echo "== build facade wasm (release) =="
build_canister_wasm "$CRATE"

echo "== refresh candid from the wasm =="
require_cmd candid-extractor "candid-extractor not found — cargo install candid-extractor"
refresh_candid "$CANISTER"

echo "== generate deterministic candid args (offline-signed payment) =="
cargo run -q -p dpay-fixture            # writes dfx/args/{init,pay,payer,merchant}.arg + expect.env
# shellcheck source=/dev/null
source dfx/args/expect.env              # AMOUNT, CAP, PAYER_AFTER, MERCHANT_AFTER
# Raw hex keys + wire from the fixture bin (the args files store escaped blobs, NOT raw hex, so they
# can't be grep'd back into a blob — use the fixture's KEY=hex output directly).
eval "$(cargo run -q -p dpay-canister-tests --bin fixture)"
PAYER_BLOB=$(blob "$PAYER_PK")
MERCHANT_BLOB=$(blob "$MERCHANT_PK")
INIT_A=$((PAYER_AFTER + AMOUNT))

echo "== start a clean local replica =="
dfx stop >/dev/null 2>&1 || true
dfx start --clean --background >/tmp/dfx-start.log 2>&1
trap 'dfx stop >/dev/null 2>&1 || true' EXIT

echo "== reserve both canister ids =="
dfx canister create "$CANISTER"
dfx canister create icrc_ledger
CID=$(dfx canister id "$CANISTER")
LEDGER_ID=$(dfx canister id icrc_ledger)
echo "   facade:  $CID"
echo "   ledger:  $LEDGER_ID"

echo "== install the REAL ic-icrc1-ledger (minting account owned by the facade) =="
# Cost-tuned archive_options: trigger_threshold=10M => archives never spawn in a demo/pilot. The
# literal is the SHARED icrc_ledger_init_arg builder (deploy/dfx-lib.sh) — one copy for this local
# replica + the staging deploy, so a field edit can never fork their init args; byte-parity against
# the captured baseline is pinned by `just dfx-arg-parity` (deploy/tests/fixtures/).
dfx build icrc_ledger >/dev/null
dfx canister install icrc_ledger --argument "$(icrc_ledger_init_arg "$CID" 0 2 DUSD "dpay demo USD")"

echo "== install the facade (demo_ledger = this replica's DUSD ledger; cap from dpay-fixture; open controller) =="
dfx build "$CANISTER" >/dev/null
# The tracked dfx/args/init.arg bakes the MAINNET DUSD ledger (td2nx); this replica's ledger id is
# only known now, so the init arg is built inline. init merely STORES the principal (no cross-
# canister validation), and the ledger above already has code. controller=null = open demo mode;
# set_controller below locks the admin gate to the deploy identity.
dfx canister install "$CANISTER" --argument "$(facade_init_arg "$LEDGER_ID" "$CAP")"

echo "== lock the admin gate: set_controller(deploy identity) (open→locked; enables controller-gated mint) =="
# init.arg seeds controller=null (open-demo mode). set_controller is the ONE admin op callable in
# open mode (require_controller_rotation: None→any caller). After this, mint run as this identity
# passes the controller gate (msg_caller == controller).
MY_PID=$(dfx identity get-principal)
dfx canister call "$CANISTER" set_controller "(opt principal \"$MY_PID\")"

acct() { echo "record { owner = principal \"$CID\"; subaccount = opt $1 }"; }

echo "== fund the demo payer via the facade's self-service faucet ($INIT_A DUSD base units) =="
# The faucet credits the FACADE-CUSTODY account {owner: canister, subaccount: pubkey} — the account
# `pay` debits — with the FIXED FAUCET_AMOUNT ($100.00 = 10_000 base units). `mint` is NOT used
# here: since the 2026-08-20 faucet re-target it credits the USER principal (which the custody-pay
# path cannot spend). INIT_A = PAYER_AFTER + AMOUNT = 10_000 = FAUCET_AMOUNT by construction; the
# ledger assertion below fails loudly if the canister's FAUCET_AMOUNT ever drifts from it.
dfx canister call "$CANISTER" faucet "($PAYER_BLOB, 0 : nat32)"

P0=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" | nat)
echo "   ledger payer balance: $P0  (expect $INIT_A)"
[ "$P0" = "$INIT_A" ] || { echo "FAIL: payer not funded on the ledger"; exit 1; }

echo "== submit the offline-signed payment ($AMOUNT DUSD base units -> merchant) =="
dfx canister call "$CANISTER" pay --argument-file dfx/args/pay.arg

echo "== replay the same payment — must be refused (nonce single-use) =="
DUP=$(dfx canister call "$CANISTER" pay --argument-file dfx/args/pay.arg 2>&1 || true)
if echo "$DUP" | grep -q 'Err'; then
  echo "   refused (nonce already used)"
else
  echo "FAIL: replayed payment was accepted: $DUP"; exit 1
fi

P1=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" | nat)
M1=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$MERCHANT_BLOB")" | nat)
echo "== ledger balances after settle: payer=$P1 (expect $PAYER_AFTER)  merchant=$M1 (expect $MERCHANT_AFTER) =="
if ! { [ "$P1" = "$PAYER_AFTER" ] && [ "$M1" = "$MERCHANT_AFTER" ]; }; then echo "FAIL: ledger balances wrong"; exit 1; fi

echo
echo "== PASS: real dfx deploy — the facade settled an offline-signed payment on the real"
echo "   ic-icrc1-ledger; funds moved under {owner: facade, subaccount: <pubkey>}; replay refused. =="
echo "   facade: $CID   ledger: $LEDGER_ID"
