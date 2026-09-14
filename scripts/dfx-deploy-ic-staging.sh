#!/usr/bin/env bash
# Deploy (or redeploy) the dpay STAGING facade to ICP mainnet (the built-in `ic` network) as an
# explicit named dfx identity. The staging facade is a SEPARATE canister provisioned from the prod
# facade's (`ssqti`) cycle balance, wired to its OWN staging DUSD ledger via the init arg's
# `demo_ledger` (the staging facade must own that ledger's minting account to run the demo faucet —
# prod `td2nx`'s minting account is owned by prod `ssqti`). There is NO currency registration
# anymore (the canister's registry was removed 2026-08-28): every non-DEMO asset the facade serves
# is a compile-time FIXED_ASSETS const, and the catalog the app renders is compiled into whichever
# relay it talks to — a staging canister changes NOTHING about the catalog.
#
# The sibling of scripts/dfx-deploy-ic.sh (prod facade) + scripts/dfx-deploy.sh (local replica). It
# mirrors their structure (env vars, module-hash mode resolution, jq merge into canister_ids.json):
#   * PROVISIONS the staging facade + a staging DUSD ledger from prod `ssqti`'s cycles via
#     `provision_ledger_canister` (the `dpay` identity is in ADMIN_CALLERS — authorized, no founder
#     op). 200 TC for the facade + 20 TC for the DUSD ledger.
#   * Deploys the facade wasm with `demo_ledger` = the staging DUSD ledger. Idempotent re-run:
#     reuse the provisioned ids from deploy/.env and UPGRADE in place (state preserved; the init
#     arg only takes effect on a fresh install — there is no post_upgrade).
#
# REHEARSAL FIRST: set DPAY_DFX_NETWORK=local to run the WHOLE script against `dfx start` (a clean
# local replica) with a mock DUSD ledger — no cycles spent, no mainnet canister created; proves the
# provision→install→lock flow and the init-arg shape before any mainnet spend.
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
# MONEY-CRITICAL: the MAINNET run creates PERSISTENT canisters + spends 220 TC. The script is
# idempotent (re-runs reuse the ids in deploy/.env and upgrade in place), but the FIRST run is not
# reversible. Do NOT run with DPAY_DFX_NETWORK unset (→ mainnet) without founder greenlight.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env
CANISTER=dpay_canister_staging   # dfx canister name (distinct from the prod dpay_canister)
CRATE=dpay-canister              # cargo package name (same code as prod — same wasm)
NETWORK="${DPAY_DFX_NETWORK:-ic}" # `ic` = mainnet (default); `local` = rehearsal
PROD_FACADE="ssqti-wiaaa-aaaab-qhdia-cai" # the prod facade (provision_ledger_canister lives here)
STAGING_CYCLES_RAW="${STAGING_CYCLES:-200_000_000_000_000}" # 200 TC default for the staging facade
DUSD_CYCLES_RAW="20_000_000_000_000"                        # 20 TC for the staging DUSD ledger
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm

# Strip the underscores dfx candid rejects in a bare `nat` literal (200_000_... → 200000...).
strip_us() { printf '%s' "$1" | tr -d '_'; }
STAGING_CYCLES="$(strip_us "$STAGING_CYCLES_RAW")"
DUSD_CYCLES="$(strip_us "$DUSD_CYCLES_RAW")"

require_cmd dfx "dfx not found on PATH"
[ -f "$LEDGER_WASM" ] || { echo "ledger wasm not found at $LEDGER_WASM (build it once: see ICRC3_INTEGRATION.md)" >&2; exit 1; }

# --- identity: required, must exist, becomes the controller ------------------------------------
load_identity "DPAY_DFX_IDENTITY is required — the identity that provisions + controls the staging facade.
  it MUST be 'dpay' (the ADMIN_CALLERS entry authorized to call provision_ledger_canister).
  create it:  icp-cli new-identity dpay   (or: dfx identity new dpay)
  set it:     DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment)"

echo "== staging deploy: network=$NETWORK   identity=$IDENT   principal=$PRINCIPAL =="
if [ "$NETWORK" != "local" ]; then
  dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network" >&2; exit 1; }
  echo "   PROVISIONING from prod facade $PROD_FACADE ($STAGING_CYCLES cycles facade + $DUSD_CYCLES DUSD)"
else
  echo "   LOCAL REHEARSAL — mock DUSD ledger, no cycles spent, no mainnet canister created."
fi

echo "== build canister wasm (release) =="
build_canister_wasm "$CRATE"

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
  merge_canister_id "$CANISTER" "$NETWORK" "$STAGING_CID"
fi

# --- deploy the facade wasm into $STAGING_CID ---------------------------------------------------
# Mode from the canister's ACTUAL state: no code yet → install; code → upgrade (state preserved;
# the init arg is type-checked against the .did but only takes effect on install — no post_upgrade).
# demo_ledger = the staging DUSD ledger; controller=null (open) → set_controller below locks it.
_ierr="$(mktemp)"
if ! _info="$(dfx_i canister info "$STAGING_CID" --network "$NETWORK" 2>"$_ierr")"; then
  echo "cannot read staging facade $STAGING_CID — dfx reported:" >&2
  sed 's/^/    /' "$_ierr" >&2; rm -f "$_ierr"; exit 1
fi
rm -f "$_ierr"
HASH="$(sed -n 's/^Module hash: //p' <<<"$_info")"
if [ -z "$HASH" ] || [ "$HASH" = "None" ]; then
  MODE=install
  echo "== install facade wasm into $STAGING_CID (fresh; demo_ledger = staging DUSD $DUSD_LEDGER_CID) =="
else
  MODE=upgrade
  echo "== upgrade facade wasm in $STAGING_CID (state preserved; init arg ignored on upgrade) =="
fi
dfx_i deploy "$CANISTER" --network "$NETWORK" --mode "$MODE" --yes \
  --argument "$(facade_init_arg "$DUSD_LEDGER_CID" 100_000)"

echo "== install the staging DUSD ICRC ledger (minting_account.owner = staging facade) =="
# The staging facade MUST own the DUSD ledger's minting account (the faucet mints via icrc1_transfer
# from it). Reusing prod `td2nx` would NOT work: its minting_account.owner = prod `ssqti`, so the
# staging facade cannot mint from it. decimals=2, fee=0, symbol="DUSD" (the DEMO play-money shape).
_install_ledger() { # $1=decimals  $2=fee  $3=symbol  $4=token_name
  local dec="$1" fee="$2" sym="$3" name="$4"
  # SHARED literal (deploy/dfx-lib.sh icrc_ledger_init_arg) — the same record scripts/dfx-deploy.sh
  # installs on the local replica, parameterized where staging differs (owner/controller = the
  # staging facade; fee/decimals/symbol/name via the args below). The trailing 4-space BASE_INDENT
  # arg is baked into the emitted string so it stays byte-identical to this script's pre-builder
  # literal — pinned against deploy/tests/fixtures/ by `just dfx-arg-parity`.
  local init_arg
  init_arg="$(icrc_ledger_init_arg "$STAGING_CID" "$fee" "$dec" "$sym" "$name" "    ")"
  # A freshly-created canister has no code → --mode install (the first call). A re-run against an
  # already-installed ledger → --mode reinstall (replaces with a fresh init). Surface any real error
  # (a swallowed install failure leaves the canister codeless → every DEMO ledger call rejects with
  # "no Wasm module", which is confusing).
  local ierr
  ierr="$(mktemp)"
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

echo "== lock the staging facade: set_controller(deploy identity) =="
# set_controller is the ONE admin op callable in open mode (require_controller_rotation: None→any).
# After this, mint/burn/reconcile on the staging facade are gated to this principal (the controller).
dfx_i canister call "$CANISTER" set_controller "(opt principal \"$PRINCIPAL\")" --network "$NETWORK"

# --- record the staging ids in deploy/.env (mainnet only — local rehearsal leaves it untouched) -
if [ "$NETWORK" != "local" ]; then
  env_set DPAY_STAGING_CANISTER_ID "$STAGING_CID" deploy/.env
  env_set DPAY_STAGING_DUSD_LEDGER_ID "$DUSD_LEDGER_CID" deploy/.env
fi

echo
echo "== staging deploy complete =="
echo "   network:         $NETWORK"
echo "   staging facade:  $STAGING_CID"
echo "   staging DUSD:    $DUSD_LEDGER_CID"
if [ "$NETWORK" = local ]; then
  echo "   (local rehearsal — no mainnet canister created, no cycles spent.)"
  dfx stop >/dev/null 2>&1 || true
else
  echo "   relay target:    set DPAY_CANISTER_ID=$STAGING_CID + DPAY_LEDGER=ic for a staging relay"
fi
