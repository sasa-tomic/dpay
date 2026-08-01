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
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Extract the first candid nat value from a `dfx canister call` reply, e.g. `(7_500 : nat64)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }
# Hex string (even length) -> a candid blob literal `blob "\hh\hh..."`.
hexesc() { local h="$1" out="" i; for ((i=0; i<${#h}; i+=2)); do out+="\\${h:$i:2}"; done; printf '%s' "$out"; }
blob()   { printf 'blob "%s"' "$(hexesc "$1")"; }

[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}

echo "== build facade wasm (release) =="
cargo build -p "$CRATE" --target wasm32-unknown-unknown --release

echo "== refresh candid from the wasm =="
mkdir -p dfx
command -v candid-extractor >/dev/null 2>&1 || { echo "candid-extractor not found — cargo install candid-extractor" >&2; exit 1; }
candid-extractor "target/wasm32-unknown-unknown/release/${CANISTER}.wasm" > dfx/dpay_canister.did

echo "== generate deterministic candid args (offline-signed payment) =="
cargo run -q -p dpay-fixture            # writes dfx/args/{init,pay,payer,merchant}.arg + expect.env
# shellcheck source=/dev/null
source dfx/args/expect.env              # AMOUNT, PAYER_AFTER, MERCHANT_AFTER
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
# Cost-tuned archive_options: trigger_threshold=10M => archives never spawn in a demo/pilot.
dfx build icrc_ledger >/dev/null
dfx canister install icrc_ledger --argument "(variant { Init = record {
  minting_account = record { owner = principal \"$CID\" };
  transfer_fee = 0 : nat;
  decimals = opt (2 : nat8);
  token_symbol = \"DUSD\";
  token_name = \"dpay demo USD\";
  metadata = vec {};
  initial_balances = vec {};
  feature_flags = opt record { icrc2 = true; icrc152 = false };
  archive_options = record {
    num_blocks_to_archive = 10_000 : nat64;
    trigger_threshold = 10_000_000 : nat64;
    controller_id = principal \"$CID\";
  };
  index_principal = null;
} })"

echo "== install the facade (no ledgers at init; cap from dpay-fixture; open controller) =="
dfx build "$CANISTER" >/dev/null
dfx canister install "$CANISTER" --argument-file dfx/args/init.arg

echo "== set the deploy identity as controller (open→locked; enables register_ledger/mint) =="
# init.arg seeds controller=null (open-demo mode). set_controller is the ONE admin op callable in
# open mode (require_controller_rotation: None→any caller). After this, register_ledger/mint work.
MY_PID=$(dfx identity get-principal)
dfx canister call "$CANISTER" set_controller "(opt principal \"$MY_PID\")"

echo "== register the DUSD ledger in the facade (currency 0 = DEMO_USD, mintable) =="
# register_ledger : (nat32, principal, bool) — POSITIONAL args, so the principal is a bare typed
# literal `principal "..."` (no field name; the reserved-word quoting only applies to record labels).
dfx canister call "$CANISTER" register_ledger "(0 : nat32, principal \"$LEDGER_ID\", true)"

echo "== register the DEMO currency metadata (MC1 unit 5 + MC2 U1: onramp=Direct faucet, offramp=Unavailable, cap) =="
# register_currency_meta : (nat32, opt text, opt nat8, opt MinterFamily, opt text, opt text, opt text,
#   opt nat8, opt opt nat64, opt nat64, opt nat32, opt text, RampCapability, RampCapability) — the
# DEMO currency is play money: Direct faucet onramp, Unavailable offramp (no cash-out).
# MC2 U1: pay reads the per-currency cap (fail-closed — a cap-less currency rejects every non-zero
# pay). Register an explicit DEMO cap = the global per_tx_cap default ($1,000.00 = 100_000 minor) so
# DEMO pays keep working; ckBTC/ckUSDC caps are real-currency policy registered separately.
dfx canister call "$CANISTER" register_currency_meta \
  "(0 : nat32, opt \"\$\", opt (2 : nat8), null, null, null, null, null, null, opt (100_000 : nat64), null, null, variant { Direct }, variant { Unavailable })"

acct() { echo "record { owner = principal \"$CID\"; subaccount = opt $1 }"; }

echo "== fund the demo payer via facade mint ($INIT_A DUSD base units) =="
dfx canister call "$CANISTER" mint "($PAYER_BLOB, 0 : nat32, $INIT_A : nat64)"

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
