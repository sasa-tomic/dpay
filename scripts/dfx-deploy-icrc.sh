#!/usr/bin/env bash
# Real dfx deploy of the ICRC-ledger integration — outer-loop fidelity gate, sibling of
# scripts/dfx-deploy.sh. Stands up an actual local dfx replica, installs the REAL DFINITY
# ic-icrc1-ledger (cached in third_party/) + the dpay-canister-icrc variant wired to it, funds a
# demo payer, and drives the *exact* 196-byte offline-signed wire the phone would sign — proving
# funds move ON the separate ledger (read back directly via icrc1_balance_of) and a replay is
# refused. Self-asserting: exits non-zero on any mismatch.
#
# Archive cost control: the ledger is installed with trigger_threshold = 10_000_000, so it only
# ever spawns an archive canister after 10M settled blocks — effectively never for a demo/pilot,
# so no cycles are spent on archive creation. See ICRC3_INTEGRATION.md.
#
# One-time prereq (online): build the ledger wasm into third_party/ — see ICRC3_INTEGRATION.md
# "The ledger wasm: build-from-source". This script errors clearly if the cache is missing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"

DPAY_CRATE=dpay-canister-icrc          # cargo package
DPAY_WASM=target/wasm32-unknown-unknown/release/dpay_canister_icrc.wasm
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Extract the first candid nat value from a `dfx canister call` reply, e.g. `(7_500 : nat)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }

# Hex string (even length) -> a candid blob literal `blob "\hh\hh..."`.
hexesc() { local h="$1" out="" i; for ((i=0; i<${#h}; i+=2)); do out+="\\${h:$i:2}"; done; printf '%s' "$out"; }
blob() { printf 'blob "%s"' "$(hexesc "$1")"; }

[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}

echo "== build dpay-canister-icrc wasm (release) =="
cargo build -p "$DPAY_CRATE" --target wasm32-unknown-unknown --release

echo "== deterministic signing material (offline-signed wire) =="
# Fixture prints shell-evaluable vars: PAYER_PK MERCHANT_PK WIRE (hex) + INIT_A AMOUNT CAP EXPIRY.
eval "$(cargo run -q -p dpay-icrc-tests --bin fixture)"
PAYER_BLOB=$(blob "$PAYER_PK")
WIRE_BLOB=$(blob "$WIRE")

echo "== start a clean local replica =="
dfx stop >/dev/null 2>&1 || true
dfx start --clean --background >/tmp/dfx-icrc-start.log 2>&1
trap 'dfx stop >/dev/null 2>&1 || true' EXIT

echo "== reserve both canister ids (create empty) =="
dfx canister create dpay_icrc
dfx canister create icrc_ledger
DPAY_ID=$(dfx canister id dpay_icrc)
LEDGER_ID=$(dfx canister id icrc_ledger)
echo "   dpay canister:  $DPAY_ID"
echo "   icrc ledger:    $LEDGER_ID"

echo "== install the REAL ic-icrc1-ledger (minting account owned by the dpay canister) =="
# Cost-tuned archive_options: trigger_threshold=10M => archives never spawn in a demo/pilot.
# The minting account owner is the dpay canister, so dpay.mint()/burn() (transfer to/from it) work.
dfx build icrc_ledger >/dev/null
dfx canister install icrc_ledger --argument "(variant { Init = record {
  minting_account = record { owner = principal \"$DPAY_ID\" };
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
    controller_id = principal \"$DPAY_ID\";
  };
  index_principal = null;
} })"

echo "== install dpay-canister-icrc, wired to the ledger (currency 0 = DUSD, mintable) =="
dfx build dpay_icrc >/dev/null
dfx canister install dpay_icrc --argument "(record {
  ledgers = vec { record { currency = (0 : nat32); \"principal\" = principal \"$LEDGER_ID\"; mintable = true } };
  per_tx_cap = $CAP : nat64;
  controller = null;
})"

echo "== fund the demo payer via dpay mint ($INIT_A DUSD base units) =="
dfx canister call dpay_icrc mint "($PAYER_BLOB, 0 : nat32, $INIT_A : nat64)"

# Read the balance DIRECTLY off the ledger (funds really live there, under {owner: dpay, subaccount: payer}).
acct() { echo "record { owner = principal \"$DPAY_ID\"; subaccount = opt $1 }"; }
P0=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" | nat)
echo "   ledger payer balance: $P0  (expect $INIT_A)"
[ "$P0" = "$INIT_A" ] || { echo "FAIL: payer not funded on the ledger"; exit 1; }

echo "== submit the offline-signed payment ($AMOUNT DUSD base units -> merchant) =="
dfx canister call dpay_icrc pay "($WIRE_BLOB)"

echo "== replay the same payment — must be refused (nonce single-use) =="
DUP=$(dfx canister call dpay_icrc pay "($WIRE_BLOB)" 2>&1 || true)
if echo "$DUP" | grep -q 'Err'; then
  echo "   refused (nonce already used)"
else
  echo "FAIL: replayed payment was accepted: $DUP"; exit 1
fi

MERCHANT_BLOB=$(blob "$MERCHANT_PK")
P1=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" | nat)
M1=$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$MERCHANT_BLOB")" | nat)
EXPECT_P=$((INIT_A - AMOUNT))
echo "== ledger balances after settle: payer=$P1 (expect $EXPECT_P)  merchant=$M1 (expect $AMOUNT) =="
if ! { [ "$P1" = "$EXPECT_P" ] && [ "$M1" = "$AMOUNT" ]; }; then echo "FAIL: ledger balances wrong"; exit 1; fi

echo
echo "== PASS: real dfx deploy — dpay-canister-icrc settled an offline-signed payment on the real"
echo "   ic-icrc1-ledger; funds moved under {owner: dpay, subaccount: <pubkey>}; replay refused. =="
echo "   dpay canister: $DPAY_ID   ledger: $LEDGER_ID"
