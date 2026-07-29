#!/usr/bin/env bash
# MAINNET deploy of the dpay-icrc canister wired into the LIVE ic-icrc1-ledger on the IC `ic`
# network (https://icp-api.io). The mainnet sibling of scripts/dfx-deploy-icrc.sh (which stands up
# a throwaway LOCAL replica). THIS SCRIPT SPENDS REAL CYCLES AND MOVES REAL STATE ON MAINNET.
#
# Self-asserting: exits non-zero on any mismatch. Read every comment before running.
#
# Chicken-and-egg this resolves:
#   * dpay-icrc's init references the LEDGER id (known upfront: the existing icrc_ledger/ic).
#   * the ledger REINSTALL references the dpay-icrc id (known only AFTER the dpay-icrc canister
#     is created).
#   So: create the dpay-icrc CANISTER first (empty, via the dpay canister's provision_ledger_canister
#   — the only way to spend the cycles the dpay canister holds, since the deploy identity has no
#   cycles wallet), capture its id, REINSTALL the ledger so minting_account.owner becomes that
#   dpay-icrc id, THEN install the dpay-icrc wasm (which references the ledger). The ledger has NO
#   funds yet, so the reinstall is lossless.
#
# Resumability: set DPAY_ICRC_ID=<existing id> in the env to skip provisioning and re-use an
# already-created dpay-icrc canister (e.g. to retry the install/verify steps after a failure).
#
# Hard facts (mainnet, verified):
#   OPERATOR (dfx identity `dpay`)              hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe
#   dpay canister (has provision(), holds cycles)  ssqti-wiaaa-aaaab-qhdia-cai
#   icrc_ledger (existing, funded, DUSD; currently minting owner = OPERATOR)  td2nx-oaaaa-aaaab-qhdnq-cai
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"

NETWORK=ic
OPERATOR=hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe
DPAY_CANISTER_ID=ssqti-wiaaa-aaaab-qhdia-cai   # holds the cycles; has provision_ledger_canister
LEDGER_ID=td2nx-oaaaa-aaaab-qhdnq-cai          # existing DUSD ledger (icrc_ledger/ic)
PROVISION_CYCLES=400000000000                   # 0.4T cycles — dpay has ~1.076T liquid; create overhead ~0.542T, so this fits with headroom
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Extract the first candid nat from a `dfx canister call` reply, e.g. `(7_500 : nat)` -> 7500.
nat()   { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }
# Extract the principal text from a provision reply `(variant { Ok = principal "xxxx" })`.
princ() { sed -n 's/.*Ok = principal "\([^"]*\)".*/\1/p' | head -1; }
# Hex string (even length) -> a candid blob literal `blob "\hh\hh..."`.
hexesc() { local h="$1" out="" i; for ((i=0; i<${#h}; i+=2)); do out+="\\${h:$i:2}"; done; printf '%s' "$out"; }
blob()   { printf 'blob "%s"' "$(hexesc "$1")"; }
# candid Account record: funds live under {owner: dpay-icrc, subaccount: <pubkey blob>}.
acct()   { echo "record { owner = principal \"$DPAY_ICRC_ID\"; subaccount = opt $1 }"; }

# --- preflight (mainnet safety) ---------------------------------------------------------------
command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }
echo "== preflight: dfx identity 'dpay' must be OPERATOR ($OPERATOR) =="
ACTUAL="$(dfx --identity dpay identity get-principal)"
[ "$ACTUAL" = "$OPERATOR" ] || {
  echo "FAIL: dfx identity 'dpay' principal is $ACTUAL; expected OPERATOR $OPERATOR" >&2
  exit 1
}
echo "   ok: $ACTUAL"
echo "   reach mainnet ($NETWORK)…"
dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network (dfx ping failed)" >&2; exit 1; }

# --- step 0: build the dpay-icrc wasm + guard the cached ledger wasm --------------------------
[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}
echo "== build dpay-canister-icrc wasm (release) =="
just build-canister-icrc

# --- step 1: deterministic signing material (offline-signed wire) -----------------------------
# Fixture prints shell-evaluable vars: PAYER_PK MERCHANT_PK WIRE (hex) + INIT_A AMOUNT CAP EXPIRY.
echo "== deterministic signing material (offline-signed wire) =="
eval "$(cargo run -q -p dpay-icrc-tests --bin fixture)"
PAYER_BLOB=$(blob "$PAYER_PK")
MERCHANT_BLOB=$(blob "$MERCHANT_PK")
WIRE_BLOB=$(blob "$WIRE")

# --- steps 2 + 3: provision the dpay-icrc canister (empty), or resume an existing id ----------
if [ -n "${DPAY_ICRC_ID:-}" ]; then
  echo "== resume: re-using existing dpay-icrc canister $DPAY_ICRC_ID (from DPAY_ICRC_ID env) =="
else
  echo "== provision a fresh dpay-icrc canister (empty; 0.4T cycles drawn from the dpay canister) =="
  # The deploy identity has no cycles wallet, so the only way to spend the dpay canister's cycles is
  # for its own code to attach them to a management-canister call. Admin-gated; caller = OPERATOR.
  # candid: (principal "OPERATOR", N : nat) -> (variant { Ok = principal "…"; Err = text })
  PROV_OUT="$(dfx --identity dpay canister call "$DPAY_CANISTER_ID" provision_ledger_canister \
    "(principal \"$OPERATOR\", ${PROVISION_CYCLES} : nat)" --network "$NETWORK")"
  case "$PROV_OUT" in
    *'Err'*) echo "FAIL: provision_ledger_canister returned Err: $PROV_OUT" >&2; exit 1;;
  esac
  DPAY_ICRC_ID="$(printf '%s' "$PROV_OUT" | princ)"
  [ -n "$DPAY_ICRC_ID" ] || { echo "FAIL: could not parse provisioned canister id from: $PROV_OUT" >&2; exit 1; }
  echo "   dpay-icrc canister: $DPAY_ICRC_ID"
fi

# --- step 4: bind DPAY_ICRC_ID into canister_ids.json (preserve the existing ic bindings) -----
# canister_ids.json is gitignored + machine-local. Read-modify-write with stdlib json so the existing
# dpay_canister/ic and icrc_ledger/ic bindings are preserved.
echo "== bind dpay_icrc/ic into canister_ids.json =="
DPAY_ICRC_ID="$DPAY_ICRC_ID" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path("canister_ids.json")
data = json.loads(p.read_text()) if p.exists() else {}
data.setdefault("dpay_icrc", {})["ic"] = os.environ["DPAY_ICRC_ID"]
p.write_text(json.dumps(data, indent=2) + "\n")
PY

# --- step 5: REINSTALL the ledger so minting_account.owner becomes the dpay-icrc canister ------
# Only minting_account.owner changes vs the current install (it becomes DPAY_ICRC_ID); the archive
# controller_id stays OPERATOR. The ledger has NO funds yet, so the reinstall is lossless.
# dfx 0.32.0 quirk: a custom canister needs `dfx build <name> --network ic` BEFORE install (there is
# no --wasm flag on `dfx canister install`). Run build as its OWN command — never `build | tail || …`
# (tail exits 0 and would mask a build failure).
echo "== reinstall icrc_ledger (minting owner -> dpay-icrc $DPAY_ICRC_ID) =="
dfx build icrc_ledger --network "$NETWORK"
dfx --identity dpay canister install icrc_ledger --network "$NETWORK" --mode reinstall --yes --argument "(variant { Init = record {
  minting_account = record { owner = principal \"${DPAY_ICRC_ID}\" };
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

# --- step 6: build + install the dpay-icrc wasm, wired to the ledger --------------------------
echo "== build + install dpay_icrc (currency 0 = DUSD, mintable; controller = OPERATOR) =="
dfx build dpay_icrc --network "$NETWORK"
# QUOTING: `principal` is a candid RESERVED word. As a RECORD FIELD NAME it must be quoted
# `"principal"`; inside this bash double-quoted --argument that inner quote is escaped \"principal\".
# Where `principal` appears as a TYPE annotation (`principal "…"`) the word itself is NOT quoted —
# only the string literal after it is. controller_id/owner/minting_account/etc. are not reserved and
# stay unquoted as field names.
dfx --identity dpay canister install dpay_icrc --network "$NETWORK" --argument "(record {
  ledgers = vec { record { currency = 0 : nat32; \"principal\" = principal \"${LEDGER_ID}\"; mintable = true } };
  per_tx_cap = 100000 : nat64;
  controller = opt principal \"${OPERATOR}\";
})"

# --- step 7: verify end-to-end on the LIVE ledger (assert each) -------------------------------
echo "== verify a: mint DUSD to the payer subaccount via dpay-icrc (caller = OPERATOR = controller) =="
MINT_OUT="$(dfx --identity dpay canister call dpay_icrc mint "($PAYER_BLOB, 0 : nat32, $INIT_A : nat64)" --network "$NETWORK")"
case "$MINT_OUT" in *Ok*) echo "   mint Ok";; *) echo "FAIL: mint did not return Ok: $MINT_OUT" >&2; exit 1;; esac

echo "== verify b: read the balance DIRECTLY off the ledger (must equal $INIT_A) =="
P0="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" --network "$NETWORK" | nat)"
echo "   ledger payer balance: $P0  (expect $INIT_A)"
[ "$P0" = "$INIT_A" ] || { echo "FAIL: payer not funded $INIT_A on the ledger (got $P0)" >&2; exit 1; }

echo "== verify c: submit the offline-signed payment ($AMOUNT DUSD base units -> merchant) =="
PAY_OUT="$(dfx canister call dpay_icrc pay "($WIRE_BLOB)" --network "$NETWORK")"
case "$PAY_OUT" in *Ok*) echo "   pay Ok (settled)";; *) echo "FAIL: pay did not settle: $PAY_OUT" >&2; exit 1;; esac

echo "== verify d: replay the same payment — must be refused (nonce single-use) =="
DUP="$(dfx canister call dpay_icrc pay "($WIRE_BLOB)" --network "$NETWORK" 2>&1 || true)"
case "$DUP" in *Err*) echo "   refused (nonce already used)";; *) echo "FAIL: replayed payment was accepted: $DUP" >&2; exit 1;; esac

echo "== verify e: ledger balances after settle (payer=$((INIT_A - AMOUNT)), merchant=$AMOUNT) =="
P1="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$PAYER_BLOB")" --network "$NETWORK" | nat)"
M1="$(dfx canister call icrc_ledger icrc1_balance_of "$(acct "$MERCHANT_BLOB")" --network "$NETWORK" | nat)"
EXPECT_P=$((INIT_A - AMOUNT))
echo "   payer=$P1 (expect $EXPECT_P)   merchant=$M1 (expect $AMOUNT)"
[ "$P1" = "$EXPECT_P" ] && [ "$M1" = "$AMOUNT" ] || { echo "FAIL: ledger balances wrong" >&2; exit 1; }

# --- step 8: PASS banner ----------------------------------------------------------------------
echo
echo "== PASS: MAINNET ICRC deploy =="
echo "   dpay-canister-icrc ($DPAY_ICRC_ID) settled an offline-signed payment on the LIVE"
echo "   ic-icrc1-ledger ($LEDGER_ID); funds moved under {owner: dpay-icrc, subaccount: <pubkey>};"
echo "   replay refused."
echo "   dpay-icrc: $DPAY_ICRC_ID   ledger: $LEDGER_ID"
