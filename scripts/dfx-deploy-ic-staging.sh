#!/usr/bin/env bash
# Deploy (or redeploy) the dpay STAGING facade to ICP mainnet (the built-in `ic` network) as an
# explicit named dfx identity. The staging facade is a SEPARATE canister provisioned from the prod
# facade's (`ssqti`) cycle balance, wired to IC's FREE testnet chain-key tokens (ckBTC Testnet on
# Bitcoin Testnet4 + ckSepoliaUSDC + ckSepoliaETH on Sepolia). This closes OPEN_ISSUES #1/#2/#8: a
# live testnet path the e2e-live suite drives end-to-end WITHOUT real funds, alongside prod.
#
# The sibling of scripts/dfx-deploy-ic.sh (prod facade) + scripts/dfx-deploy.sh (local replica). It
# mirrors their structure (env vars, idempotency guards, jq merge into canister_ids.json) but:
#   * PROVISIONS the staging facade + a staging DUSD ledger from prod `ssqti`'s cycles via
#     `provision_ledger_canister` (the `dpay` identity is in ADMIN_CALLERS — authorized, no founder
#     op). 200 TC for the facade + 20 TC for the DUSD ledger.
#   * Registers the DEMO currency against a STAGING DUSD ledger (NOT prod `td2nx` — whose
#     minting_account.owner is the PROD facade `ssqti`, so the staging facade cannot mint from it;
#     a staging faucet needs a staging-owned DUSD ledger).
#   * Registers 3 testnet chain-key currencies against their REAL testnet ledgers (free, mainnet-
#     resident, DFINITY-operated): ckBTC Testnet, ckSepoliaUSDC, ckSepoliaETH. Exact validated
#     metadata is pinned below (confirmed live by the planner — do not edit the values).
#
# REHEARSAL FIRST: set DPAY_DFX_NETWORK=local to run the WHOLE script against `dfx start` (a local
# replica) with a mock DUSD ledger. The local mode proves the script structure (init arg,
# set_controller, the register_currency candid shape, the idempotency guard, the jq merge) BEFORE
# any mainnet cycles are spent. The 3 testnet register_currency calls are proven well-formed by
# asserting they reach the canister's cross-ledger VALIDATION (a mismatch reject, NOT a candid parse
# error — a malformed argument would fail to decode long before validation runs).
#
#   DPAY_DFX_IDENTITY   (required)  named dfx identity → becomes the staging facade controller
#                                   (both the dfx-level canister controller AND the facade-level
#                                   admin controller after set_controller). MUST be `dpay` (it is
#                                   the ADMIN_CALLERS entry authorized to call provision_ledger_canister
#                                   on prod `ssqti`).
#   DPAY_DFX_NETWORK    (optional)  `ic` (default, mainnet) | `local` (rehearsal against dfx start).
#   STAGING_CYCLES      (optional)  cycles to provision the staging facade with (mainnet only).
#                                   Default 200_000_000_000_000 (200 TC).
#
# MONEY-CRITICAL: the MAINNET run creates a PERSISTENT canister + spends 220 TC. The script is
# idempotent (re-running probes currencies() and skips already-registered ids), but the FIRST run is
# not reversible. See OPEN_ISSUES #1/#2 + the PAUSE-FOR-COURTESY rule: do NOT run with
# DPAY_DFX_NETWORK unset (→ mainnet) without founder greenlight.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh
CANISTER=dpay_canister_staging   # dfx canister name (distinct from the prod dpay_canister)
CRATE=dpay-canister              # cargo package name (same code as prod — same wasm)
NETWORK="${DPAY_DFX_NETWORK:-ic}" # `ic` = mainnet (default); `local` = rehearsal
PROD_FACADE="ssqti-wiaaa-aaaab-qhdia-cai" # the prod facade (provision_ledger_canister lives here)
STAGING_CYCLES_RAW="${STAGING_CYCLES:-200_000_000_000_000}" # 200 TC default for the staging facade
DUSD_CYCLES_RAW="20_000_000_000_000"                        # 20 TC for the staging DUSD ledger
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Validated testnet chain-key metadata (confirmed live by the planner — OPEN_ISSUES #1/#2). DO NOT
# edit these values — a wrong ledger principal / minter / decimals / fee / symbol makes the deposit
# path silently target the wrong canister (non-custodial-trust violation). register_currency
# STRICTLY validates decimals/fee/wrapper_name against the live ledger, so a mismatch rejects loudly
# (the safety net); these are the values that PASS that validation on the real testnet ledgers.
CKBTC_TESTNET_LEDGER="mc6ru-gyaaa-aaaar-qaaaq-cai"
CKBTC_TESTNET_MINTER="ml52i-qqaaa-aaaar-qaaba-cai"
CKSEPOLIA_USDC_LEDGER="yfumr-cyaaa-aaaar-qaela-cai"
CKSEPOLIA_USDC_MINTER="jzenf-aiaaa-aaaar-qaa7q-cai"   # shared ckETH minter (handles all ckERC20 + ckETH)
CKSEPOLIA_ETH_LEDGER="apia6-jaaaa-aaaar-qabma-cai"
CKSEPOLIA_ETH_MINTER="jzenf-aiaaa-aaaar-qaa7q-cai"     # same minter

# Strip the underscores dfx candid rejects in a bare `nat` literal (200_000_... → 200000...).
strip_us() { printf '%s' "$1" | tr -d '_'; }
STAGING_CYCLES="$(strip_us "$STAGING_CYCLES_RAW")"
DUSD_CYCLES="$(strip_us "$DUSD_CYCLES_RAW")"

command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }
[ -f "$LEDGER_WASM" ] || { echo "ledger wasm not found at $LEDGER_WASM (build it once: see ICRC3_INTEGRATION.md)" >&2; exit 1; }

# --- identity: required, must exist, becomes the controller ------------------------------------
IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
[ -n "$IDENT" ] || {
  echo "DPAY_DFX_IDENTITY is required — the identity that provisions + controls the staging facade." >&2
  echo "  it MUST be 'dpay' (the ADMIN_CALLERS entry authorized to call provision_ledger_canister)." >&2
  echo "  create it:  icp-cli new-identity dpay   (or: dfx identity new dpay)" >&2
  echo "  set it:     DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment)" >&2
  exit 1
}
dfx_i() { dfx --identity "$IDENT" "$@"; }
_iderr="$(mktemp)"
if ! PRINCIPAL="$(dfx_i identity get-principal 2>"$_iderr")"; then
  echo "cannot load dfx identity '$IDENT' — dfx reported:" >&2
  sed 's/^/    /' "$_iderr" >&2; rm -f "$_iderr"; exit 1
fi
rm -f "$_iderr"

echo "== staging deploy: network=$NETWORK   identity=$IDENT   principal=$PRINCIPAL =="
if [ "$NETWORK" != "local" ]; then
  dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network" >&2; exit 1; }
  echo "   PROVISIONING from prod facade $PROD_FACADE ($STAGING_CYCLES cycles facade + $DUSD_CYCLES DUSD)"
else
  echo "   LOCAL REHEARSAL — mock DUSD ledger, no cycles spent, no mainnet canister created."
fi

echo "== build canister wasm (release) =="
cargo build -p "$CRATE" --target wasm32-unknown-unknown --release

# --- resolve the staging facade + DUSD ledger canister ids -------------------------------------
# MAINNET: provision BOTH from prod ssqti's cycle balance via provision_ledger_canister (the dpay
#   identity is in ADMIN_CALLERS → authorized). The provisioned canister's dfx-level controller is
#   the dpay principal. Idempotent: reuse the id if canister_ids.json/deploy/.env carries one.
# LOCAL: dfx creates both via `dfx canister create` (free, tracked in .dfx/local/canister_ids.json).
STAGING_CID="$(env_get DPAY_STAGING_CANISTER_ID deploy/.env)"
DUSD_LEDGER_CID="$(env_get DPAY_STAGING_DUSD_LEDGER_ID deploy/.env)"

if [ "$NETWORK" = "local" ]; then
  echo "== start a clean local replica =="
  dfx stop >/dev/null 2>&1 || true
  dfx start --clean --background >/tmp/dfx-staging-start.log 2>&1
  trap 'dfx stop >/dev/null 2>&1 || true' EXIT
  echo "== reserve staging facade + DUSD ledger canister ids (local) =="
  dfx_i canister create "$CANISTER" --network local >/dev/null
  STAGING_CID="$(dfx_i canister id "$CANISTER" --network local)"
  # Reuse the dfx.json `icrc_ledger` entry as the staging DUSD ledger (local rehearsal only).
  dfx_i canister create icrc_ledger --network local >/dev/null
  DUSD_LEDGER_CID="$(dfx_i canister id icrc_ledger --network local)"
else
  # MAINNET: provision from prod ssqti's cycles. Idempotent — reuse the id if deploy/.env carries one.
  if [ -z "$STAGING_CID" ]; then
    echo "== provision staging facade ($STAGING_CYCLES cycles from $PROD_FACADE) =="
    PROV="$(dfx_i canister call "$PROD_FACADE" provision_ledger_canister \
      "(principal \"$PRINCIPAL\", ${STAGING_CYCLES} : nat)" --network "$NETWORK")"
    STAGING_CID="$(printf '%s' "$PROV" | grep -oE '[a-z0-9-]{20,}' | head -1)"
    [[ "$STAGING_CID" =~ ^[a-z0-9-]+$ ]] || { echo "provision_ledger_canister did not return a valid id: $PROV" >&2; exit 1; }
    echo "   staging facade provisioned: $STAGING_CID"
  else
    echo "== reuse existing staging facade $STAGING_CID (from deploy/.env) =="
  fi
  if [ -z "$DUSD_LEDGER_CID" ]; then
    echo "== provision staging DUSD ledger ($DUSD_CYCLES cycles from $PROD_FACADE) =="
    PROV2="$(dfx_i canister call "$PROD_FACADE" provision_ledger_canister \
      "(principal \"$PRINCIPAL\", ${DUSD_CYCLES} : nat)" --network "$NETWORK")"
    DUSD_LEDGER_CID="$(printf '%s' "$PROV2" | grep -oE '[a-z0-9-]{20,}' | head -1)"
    [[ "$DUSD_LEDGER_CID" =~ ^[a-z0-9-]+$ ]] || { echo "provision_ledger_canister (DUSD) did not return a valid id: $PROV2" >&2; exit 1; }
    echo "   staging DUSD ledger provisioned: $DUSD_LEDGER_CID"
  else
    echo "== reuse existing staging DUSD ledger $DUSD_LEDGER_CID (from deploy/.env) =="
  fi
fi

# MERGE the staging facade id into the TRACKED canister_ids.json (never clobber). Keyed under
# `dpay_canister_staging.ic` (mainnet only; the local rehearsal does not pollute the tracked file).
if [ "$NETWORK" != "local" ]; then
  _tmp="$(mktemp)"
  jq --arg c "$CANISTER" --arg n "$NETWORK" --arg id "$STAGING_CID" '.[$c][$n] = $id' canister_ids.json > "$_tmp" && mv "$_tmp" canister_ids.json
fi

echo "== deploy facade wasm into $STAGING_CID (init: controller=null, ledgers=vec{}, cap=100000) =="
# Open admin during setup (controller=null). set_controller below locks it to the dpay principal,
# which enables register_currency (require_admin passes once msg_caller == controller).
dfx_i deploy "$CANISTER" --network "$NETWORK" --mode install --yes --argument \
  "(record { ledgers = vec {}; per_tx_cap = 100_000 : nat64; controller = null })"

echo "== install the staging DUSD ICRC ledger (minting_account.owner = staging facade) =="
# The staging facade MUST own the DUSD ledger's minting account (the faucet mints via icrc1_transfer
# from it). Reusing prod `td2nx` would NOT work: its minting_account.owner = prod `ssqti`, so the
# staging facade cannot mint from it. decimals=2, fee=0, symbol="DUSD" (validated by register_currency
# below — wrapper_name MUST match the ledger's icrc1_symbol exactly).
_install_ledger() { # $1=decimals  $2=fee  $3=symbol  $4=token_name
  local dec="$1" fee="$2" sym="$3" name="$4"
  local init_arg="(variant { Init = record {
      minting_account = record { owner = principal \"$STAGING_CID\" };
      transfer_fee = ${fee} : nat;
      decimals = opt (${dec} : nat8);
      token_symbol = \"${sym}\";
      token_name = \"${name}\";
      metadata = vec {};
      initial_balances = vec {};
      feature_flags = opt record { icrc2 = true; icrc152 = false };
      archive_options = record {
        num_blocks_to_archive = 10_000 : nat64;
        trigger_threshold = 10_000_000 : nat64;
        controller_id = principal \"$STAGING_CID\";
      };
      index_principal = null;
    } })"
  # A freshly-created canister has no code → --mode install (the first call). A re-run against an
  # already-installed ledger → --mode reinstall (replaces with a fresh init). Surface any real error
  # (a swallowed install failure leaves the canister codeless → every register_currency validation
  # rejects with "no Wasm module", which is confusing).
  local ierr="$(mktemp)"
  if ! dfx_i canister install icrc_ledger --network "$NETWORK" --mode install \
      --wasm "$LEDGER_WASM" --argument "$init_arg" 2>"$ierr"; then
    # Retry as reinstall (the canister already had code from a prior run).
    if ! dfx_i canister install icrc_ledger --network "$NETWORK" --mode reinstall \
        --wasm "$LEDGER_WASM" --argument "$init_arg" 2>>"$ierr"; then
      echo "FAILED to install the staging DUSD ledger — dfx reported:" >&2
      sed 's/^/     /' "$ierr" >&2; rm -f "$ierr"; exit 1
    fi
  fi
  rm -f "$ierr"
}
_install_ledger 2 0 DUSD "dpay staging DUSD"

echo "== lock the staging facade: set_controller(dpay principal) — enables register_currency =="
# set_controller is the ONE admin op callable in open mode (require_controller_rotation: None→any).
# After this, msg_caller == controller → require_admin passes → register_currency works.
dfx_i canister call "$CANISTER" set_controller "(opt principal \"$PRINCIPAL\")" --network "$NETWORK"

# --- register_currency is NOT idempotent (rejects an existing id) — guard by probing currencies() -
# Probe the live catalog; skip ids already present. This makes the script safely re-runnable without
# a "currency already exists" reject on the second pass.
CATALOG="$(dfx_i canister call "$CANISTER" currencies --network "$NETWORK" --query 2>/dev/null || true)"
has_currency() { echo "$CATALOG" | grep -qE "currency = $1 : nat32" && echo yes || echo no; }

# _register: call register_currency, expect Ok on mainnet (real ledgers validate). On local rehearsal
# against the mock DUSD ledger, the testnet calls (currency 3/4/5) are EXPECTED to reject with a
# metadata-mismatch error (the mock ledger has DUSD metadata, not ckTESTBTC) — a reject that is a
# VALIDATION failure (not a decode/transport error) proves the register_currency argument is
# well-formed candid. We pass a 2nd arg "expect_mismatch" to treat that case as success locally.
_register() { # $1=arg  $2=expect_mismatch (optional, local rehearsal only)
  local arg="$1" expect="${2:-}"
  local out rc
  set +e
  out="$(dfx_i canister call "$CANISTER" register_currency "$arg" --network "$NETWORK" 2>&1)"
  rc=$?
  set -e
  if echo "$out" | grep -q 'Ok'; then
    echo "   → Ok"
  elif [ "$expect" = expect_mismatch ] && echo "$out" | grep -qiE 'metadata mismatch'; then
    echo "   → expected validation mismatch (local rehearsal: mock ledger ≠ target metadata) — call shape OK"
  elif [ "$expect" = expect_mismatch ] && echo "$out" | grep -qiE 'icrc1_(decimals|fee|symbol)|wrapper_name'; then
    echo "   → expected validation mismatch (local rehearsal) — call shape OK"
  else
    echo "   → UNEXPECTED register_currency outcome:" >&2
    sed 's/^/     /' <<<"$out" >&2
    exit 1
  fi
}

# (a) DEMO (currency 0) — staging DUSD ledger. onramp=Direct (faucet), offramp=Unavailable (play $).
#     Full proof: validates against the real (staging) DUSD ledger on BOTH mainnet and local.
if [ "$(has_currency 0)" = no ]; then
  echo "== register_currency DEMO(0) → staging DUSD ledger $DUSD_LEDGER_CID =="
  _register "(record {
       currency = 0 : nat32;
       ledger = principal \"$DUSD_LEDGER_CID\";
       mintable = true;
       minter = null;
       symbol = opt \"\$\";
       decimals = 2 : nat8;
       minter_family = null;
       wrapper_name = \"DUSD\";
       backing_symbol = null;
       network = null;
       display_decimals = null;
       fee = 0 : nat64;
       cap = opt (100_000 : nat64);
       chain_id = null;
       token_contract = null;
       onramp = variant { Direct };
       offramp = variant { Unavailable };
     })"
else
  echo "== DEMO(0) already registered — skipping (idempotent) =="
fi

# (b) ckBTC Testnet (currency 3) — REAL Bitcoin Testnet4 chain-key ledger (free, DFINITY-operated).
#     onramp=Direct (Bitcoin Testnet deposit_address), offramp=Direct (retrieve_btc_with_approval).
if [ "$(has_currency 3)" = no ]; then
  echo "== register_currency ckBTC Testnet(3) → $CKBTC_TESTNET_LEDGER =="
  _register "(record {
       currency = 3 : nat32;
       ledger = principal \"$CKBTC_TESTNET_LEDGER\";
       mintable = false;
       minter = opt principal \"$CKBTC_TESTNET_MINTER\";
       symbol = opt \"₿\";
       decimals = 8 : nat8;
       minter_family = opt variant { CkBtcUtxo };
       wrapper_name = \"ckTESTBTC\";
       backing_symbol = opt \"BTC\";
       network = opt \"Bitcoin Testnet\";
       display_decimals = null;
       fee = 10 : nat64;
       cap = opt (100_000 : nat64);
       chain_id = null;
       token_contract = null;
       onramp = variant { Direct };
       offramp = variant { Direct };
     })" "$([ "$NETWORK" = local ] && echo expect_mismatch)"
else
  echo "== ckBTC Testnet(3) already registered — skipping (idempotent) =="
fi

# (c) ckSepoliaUSDC (currency 4) — REAL Sepolia ckERC20 ledger (free). onramp=Direct (ckETH helper),
#     offramp=Unavailable (no testnet cash-out). The ERC-20 contract is the real Sepolia USDC.
if [ "$(has_currency 4)" = no ]; then
  echo "== register_currency ckSepoliaUSDC(4) → $CKSEPOLIA_USDC_LEDGER =="
  _register "(record {
       currency = 4 : nat32;
       ledger = principal \"$CKSEPOLIA_USDC_LEDGER\";
       mintable = false;
       minter = opt principal \"$CKSEPOLIA_USDC_MINTER\";
       symbol = opt \"ckSepoliaUSDC\";
       decimals = 6 : nat8;
       minter_family = opt variant { CkEthErc20 };
       wrapper_name = \"ckSepoliaUSDC\";
       backing_symbol = opt \"USDC\";
       network = opt \"Sepolia\";
       display_decimals = null;
       fee = 4000 : nat64;
       cap = opt (100_000 : nat64);
       chain_id = opt (11155111 : nat32);
       token_contract = opt \"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238\";
       onramp = variant { Direct };
       offramp = variant { Unavailable };
     })" "$([ "$NETWORK" = local ] && echo expect_mismatch)"
else
  echo "== ckSepoliaUSDC(4) already registered — skipping (idempotent) =="
fi

# (d) ckSepoliaETH (currency 5) — REAL Sepolia ckETH ledger (free). CkEthErc20 family (shares the
#     ckETH minter) but token_contract=null (native ETH, not an ERC20 — the ckerc20 onramp fails
#     closed for it, which is correct; native ETH deposit uses a separate path not wired here).
#     display_decimals=6 (ETH at 18 dec is unwieldy in the UI). onramp=Direct, offramp=Unavailable.
if [ "$(has_currency 5)" = no ]; then
  echo "== register_currency ckSepoliaETH(5) → $CKSEPOLIA_ETH_LEDGER =="
  _register "(record {
       currency = 5 : nat32;
       ledger = principal \"$CKSEPOLIA_ETH_LEDGER\";
       mintable = false;
       minter = opt principal \"$CKSEPOLIA_ETH_MINTER\";
       symbol = opt \"Ξ\";
       decimals = 18 : nat8;
       minter_family = opt variant { CkEthErc20 };
       wrapper_name = \"ckSepoliaETH\";
       backing_symbol = opt \"ETH\";
       network = opt \"Sepolia\";
       display_decimals = opt (6 : nat8);
       fee = 10_000_000_000 : nat64;
       cap = opt (100_000 : nat64);
       chain_id = opt (11155111 : nat32);
       token_contract = null;
       onramp = variant { Direct };
       offramp = variant { Unavailable };
     })" "$([ "$NETWORK" = local ] && echo expect_mismatch)"
else
  echo "== ckSepoliaETH(5) already registered — skipping (idempotent) =="
fi

# --- record the staging ids in deploy/.env (mainnet only — local rehearsal leaves it untouched) -
if [ "$NETWORK" != "local" ]; then
  env_set DPAY_STAGING_CANISTER_ID "$STAGING_CID" deploy/.env
  env_set DPAY_STAGING_DUSD_LEDGER_ID "$DUSD_LEDGER_CID" deploy/.env
fi

# --- readback: the catalog now carries DEMO + the 3 testnet currencies (mainnet) ----------------
CATALOG2="$(dfx_i canister call "$CANISTER" currencies --network "$NETWORK" --query 2>/dev/null || true)"
NCUR="$(printf '%s' "$CATALOG2" | grep -cE 'currency = [0-9]+ : nat32' || true)"

echo
echo "== staging deploy complete =="
echo "   network:         $NETWORK"
echo "   staging facade:  $STAGING_CID"
echo "   staging DUSD:    $DUSD_LEDGER_CID"
echo "   catalog:         ${NCUR} currencies"
if [ "$NETWORK" = local ]; then
  echo "   (local rehearsal — DEMO registered fully; testnet calls proven well-formed via"
  echo "    validation-mismatch rejects. No mainnet canister created, no cycles spent.)"
  dfx stop >/dev/null 2>&1 || true
else
  echo "   relay target:    set DPAY_CANISTER_ID=$STAGING_CID + DPAY_LEDGER=ic for a staging relay"
fi
