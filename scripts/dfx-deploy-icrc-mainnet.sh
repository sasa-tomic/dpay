#!/usr/bin/env bash
# MAINNET end-to-end verify of the facade canister (ssqti) against the LIVE ic-icrc1-ledger on the
# IC `ic` network (https://icp-api.io). THIS SCRIPT SPENDS REAL CYCLES AND MOVES REAL STATE ON MAINNET.
#
# Self-asserting: exits non-zero on any mismatch. Read every comment before running.
#
# Precondition: ssqti is ALREADY upgraded to the facade wasm via `scripts/dfx-deploy-ic.sh`
# (mainnet step 1) — that is the facade upgrade and is kept separate so the wasm install is its own
# verifiable step. This script then does mainnet steps 2-3:
#   * REINSTALL the DUSD ledger td2nx so minting_account.owner becomes ssqti (lossless — no real
#     funds on td2nx), so the facade can mint DUSD.
#   * register the ledger in the facade, mint to a test account, submit the offline-signed pay,
#     assert it settles on the ledger (read DIRECTLY via icrc1_balance_of), assert replay refused.
#
# Hard facts (mainnet, verified):
#   OPERATOR (dfx identity `dpay`)   hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe
#   FACADE canister (the dpay canister)  ssqti-wiaaa-aaaab-qhdia-cai
#   DUSD ledger (existing, no real funds)  td2nx-oaaaa-aaaab-qhdnq-cai
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"

NETWORK=ic
OPERATOR=hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe
FACADE_ID=ssqti-wiaaa-aaaab-qhdia-cai   # the dpay canister — IS the facade now
LEDGER_ID=td2nx-oaaaa-aaaab-qhdnq-cai   # existing DUSD ledger (icrc_ledger/ic)
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Extract the first candid nat from a `dfx canister call` reply, e.g. `(7_500 : nat)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }
# Hex string (even length) -> candid blob escapes.
hexesc() { local h="$1" out="" i; for ((i=0; i<${#h}; i+=2)); do out+="\\${h:$i:2}"; done; printf '%s' "$out"; }
blob()  { printf 'blob "%s"' "$(hexesc "$1")"; }
# candid Account record: funds live under {owner: facade, subaccount: <pubkey blob>}.
acct()  { echo "record { owner = principal \"$FACADE_ID\"; subaccount = opt $1 }"; }

# --- preflight (mainnet safety) ---------------------------------------------------------------
command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }
echo "== preflight: dfx identity 'dpay' must be OPERATOR ($OPERATOR) =="
ACTUAL="$(dfx --identity dpay identity get-principal)"
[ "$ACTUAL" = "$OPERATOR" ] || { echo "FAIL: dfx identity 'dpay' principal is $ACTUAL; expected OPERATOR $OPERATOR" >&2; exit 1; }
echo "   ok: $ACTUAL"
echo "   reach mainnet ($NETWORK)…"
dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network (dfx ping failed)" >&2; exit 1; }
[ -f "$LEDGER_WASM" ] || { echo "ledger wasm not found at $LEDGER_WASM (see ICRC3_INTEGRATION.md)" >&2; exit 1; }

# --- step 1: deterministic signing material (offline-signed wire) -----------------------------
echo "== deterministic signing material (offline-signed wire) =="
eval "$(cargo run -q -p dpay-canister-tests --bin fixture)"
PAYER_BLOB=$(blob "$PAYER_PK")
MERCHANT_BLOB=$(blob "$MERCHANT_PK")
WIRE_BLOB=$(blob "$WIRE")

# --- step 2: REINSTALL the DUSD ledger so minting_account.owner becomes the facade -------------
# Only minting_account.owner changes vs the current install (it becomes ssqti). The ledger has NO
# real funds, so the reinstall is lossless. dfx 0.32.0: custom canister needs `dfx build` before
# install (no --wasm flag); `--mode reinstall` needs `--yes`. Run build as its OWN command — never
# `build | tail || …` (tail exits 0 and masks a build failure).
echo "== reinstall DUSD ledger td2nx (minting owner -> facade $FACADE_ID) =="
dfx build icrc_ledger --network "$NETWORK"
dfx --identity dpay canister install icrc_ledger --network "$NETWORK" --mode reinstall --yes --argument "(variant { Init = record {
  minting_account = record { owner = principal \"${FACADE_ID}\" };
  transfer_fee = 0 : nat;
  decimals = opt (2 : nat8);
  token_symbol = \"DUSD\";
  token_name = \"dpay demo USD\";
  metadata = vec {};
  initial_balances = vec {};
  feature_flags = opt record { icrc2 = true; icrc152 = false };
  archive_options = record {
    num_blocks_to_archive = 10000 : nat64;
    trigger_threshold = 10_000_000 : nat64;
    controller_id = principal \"${OPERATOR}\";
  };
  index_principal = null;
} })"

# --- step 3: register the ledger in the facade, then settle end-to-end ------------------------
# WHY register_ledger + register_currency_meta (piecemeal) instead of register_currency (atomic)?
# This script runs against the PERSISTENT mainnet canister and is designed to be RE-RUNNABLE: a
# second invocation re-runs `register_ledger(0, DUSD, true)`, which under MC2 U2 is same-value
# idempotent Ok. `register_currency` (MC2 U4) activates a NEW currency and REJECTS an already-existing
# id (immutability) — so switching this line to register_currency would break the second run with
# Err "currency 0 already exists". The piecemeal path remains the correct mainnet pattern for the
# DEMO currency (already-registered); `register_currency` is the path for genuinely NEW currencies
# (F4 — keep piecemeal for incremental corrections + already-seeded ids; F5 — switch to
# register_currency for new activations). See CLAUDE.md / OPEN_ISSUES MC2 U4.
echo "== register the DUSD ledger in the facade (currency 0 = DEMO_USD, mintable) =="
# register_ledger : (nat32, principal, bool) — POSITIONAL args, so the principal is a bare typed
# literal `principal "..."`. (The reserved-word quoting of `principal` applies only to record field
# NAMES, e.g. inside the ledger InitArg below — not to a positional typed literal.)
REG_OUT="$(dfx --identity dpay canister call "$FACADE_ID" register_ledger \
  "(0 : nat32, principal \"${LEDGER_ID}\", true)" --network "$NETWORK")"
case "$REG_OUT" in *Ok*) echo "   register Ok";; *) echo "FAIL: register_ledger did not return Ok: $REG_OUT" >&2; exit 1;; esac

echo "== register the DEMO currency metadata (MC1 unit 5 + MC2 U1: onramp=Direct faucet, offramp=Unavailable, cap) =="
# register_currency_meta : (nat32, opt text, opt nat8, opt MinterFamily, opt text, opt text, opt text,
#   opt nat8, opt nat64, opt nat64, opt nat32, opt text, RampCapability, RampCapability). DEMO = play
# money: Direct faucet onramp, Unavailable offramp (no cash-out).
# MC2 U1: pay reads the per-currency cap (fail-closed — a cap-less currency rejects every non-zero
# pay). Register an explicit DEMO cap = the global per_tx_cap default ($1,000.00 = 100_000 minor) so
# DEMO pays keep working on mainnet.
META_OUT="$(dfx --identity dpay canister call "$FACADE_ID" register_currency_meta \
  "(0 : nat32, opt \"\$\", opt (2 : nat8), null, null, null, null, null, null, opt (100_000 : nat64), null, null, variant { Direct }, variant { Unavailable })" --network "$NETWORK")"
case "$META_OUT" in *Ok*) echo "   meta Ok";; *) echo "WARN: register_currency_meta did not return Ok: $META_OUT" >&2;; esac

echo "== verify a: mint DUSD to the payer subaccount via the facade (caller = OPERATOR) =="
MINT_OUT="$(dfx --identity dpay canister call "$FACADE_ID" mint "($PAYER_BLOB, 0 : nat32, $INIT_A : nat64)" --network "$NETWORK")"
case "$MINT_OUT" in *Ok*) echo "   mint Ok";; *) echo "FAIL: mint did not return Ok: $MINT_OUT" >&2; exit 1;; esac

echo "== verify b: read the balance DIRECTLY off the ledger (must equal $INIT_A) =="
P0="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" --network "$NETWORK" | nat)"
echo "   ledger payer balance: $P0  (expect $INIT_A)"
[ "$P0" = "$INIT_A" ] || { echo "FAIL: payer not funded $INIT_A on the ledger (got $P0)" >&2; exit 1; }

echo "== verify c: submit the offline-signed payment ($AMOUNT DUSD base units -> merchant) =="
PAY_OUT="$(dfx canister call "$FACADE_ID" pay "($WIRE_BLOB)" --network "$NETWORK")"
case "$PAY_OUT" in *Ok*) echo "   pay Ok (settled)";; *) echo "FAIL: pay did not settle: $PAY_OUT" >&2; exit 1;; esac

echo "== verify d: replay the same payment — must be refused (nonce single-use) =="
DUP="$(dfx canister call "$FACADE_ID" pay "($WIRE_BLOB)" --network "$NETWORK" 2>&1 || true)"
case "$DUP" in *Err*) echo "   refused (nonce already used)";; *) echo "FAIL: replayed payment was accepted: $DUP" >&2; exit 1;; esac

echo "== verify e: ledger balances after settle (payer=$((INIT_A - AMOUNT)), merchant=$AMOUNT) =="
P1="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" --network "$NETWORK" | nat)"
M1="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$MERCHANT_BLOB")" --network "$NETWORK" | nat)"
EXPECT_P=$((INIT_A - AMOUNT))
echo "   payer=$P1 (expect $EXPECT_P)   merchant=$M1 (expect $AMOUNT)"
[ "$P1" = "$EXPECT_P" ] && [ "$M1" = "$AMOUNT" ] || { echo "FAIL: ledger balances wrong" >&2; exit 1; }

# --- PASS banner -----------------------------------------------------------------------------
echo
echo "== PASS: MAINNET facade verify =="
echo "   the facade ($FACADE_ID) settled an offline-signed payment on the LIVE"
echo "   ic-icrc1-ledger ($LEDGER_ID); funds moved under {owner: facade, subaccount: <pubkey>};"
echo "   replay refused."
