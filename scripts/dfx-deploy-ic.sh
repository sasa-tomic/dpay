#!/usr/bin/env bash
# Deploy (or redeploy) the dpay canister to ICP MAINNET (the built-in `ic` network) as an explicit
# named dfx identity, then write the resulting canister id back into deploy/.env so the relay picks
# it up. The mainnet sibling of scripts/dfx-deploy.sh (which stands up a throwaway LOCAL replica and
# self-tests a settlement). Here we only build, (re)deploy, and read back a couple of *free* query
# calls as a sanity check — we deliberately do NOT push a state-changing payment to mainnet.
#
# Identity (DPAY_DFX_IDENTITY) is REQUIRED and load-bearing: `dfx deploy --network ic` spends the
# identity's cycles AND makes it the CANISTER CONTROLLER (upgrade authority). Create one with
# `icp-cli new-identity dpay` (or `dfx identity new dpay`) — both land in the dfx identity store —
# and set DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment).
#
#   DPAY_DFX_IDENTITY   (required)  named dfx identity to deploy as → becomes the controller
#   DPAY_DEPLOY_MODE    (redeploy)  dfx install mode; defaults to `upgrade` when the canister already
#                                   has code. `reinstall` = wipe + re-run init (re-fund the demo
#                                   accounts). `install` = empty canister only. (Empty → install.)
#   DPAY_DFX_NETWORK    (optional)  dfx network; default `ic` (mainnet). Set `local` to rehearse the
#                                   whole flow against a running local replica before spending cycles.
#   DPAY_CANISTER_ID    (deploy/.env) if set, deploy TARGETS that existing canister (dfx installs into
#                                   / upgrades it — no new canister, no create-cycles). Unset → create.
#
# Two money-critical caveats for this demo-phase canister:
#   * UPGRADE PRESERVES STATE. Balances + spent nonces live in stable structures (StableBTreeMap /
#     StableCell), so `--mode upgrade` (the redeploy default) carries them across automatically — no
#     serialization hooks. `--mode reinstall` wipes and re-runs init (clean, re-funded demo accounts);
#     `install` is for an empty canister. ONE-TIME MIGRATION: upgrading from the original
#     pre-stable-memory build finds empty stable memory → starts with an EMPTY ledger; reinstall once
#     to re-fund, after which upgrades preserve state.
#   * UNHARDENED. `mint` is unauthenticated and the controller is your own key (not blackholed /
#     not SNS-governed). Accepted only while there is no real money on the canister.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name
NETWORK="${DPAY_DFX_NETWORK:-ic}"   # `ic` = mainnet (default); `local` to rehearse on a local replica

# Extract the first candid nat value from a reply, e.g. `(7_500 : nat64)` -> 7500.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }

command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }
# Guard before the `> dfx/dpay_canister.did` redirect below, which would otherwise truncate the
# committed candid file to empty (→ dfx "no main service") when the tool is absent.
command -v candid-extractor >/dev/null 2>&1 || { echo "candid-extractor not found — cargo install candid-extractor" >&2; exit 1; }

# --- identity: required, must exist, becomes the controller ------------------------------------
IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
[ -n "$IDENT" ] || {
  echo "DPAY_DFX_IDENTITY is required — the identity that deploys becomes the canister CONTROLLER." >&2
  echo "  create it:  icp-cli new-identity dpay   (or: dfx identity new dpay)" >&2
  echo "  set it:     DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment)" >&2
  exit 1
}
dfx_i() { dfx --identity "$IDENT" "$@"; }
# Load the principal, surfacing dfx's ACTUAL error (keyring/encryption/missing) rather than hiding it
# behind a generic message. stderr is captured separately so PRINCIPAL stays clean on success.
_iderr="$(mktemp)"
if ! PRINCIPAL="$(dfx_i identity get-principal 2>"$_iderr")"; then
  echo "cannot load dfx identity '$IDENT' — dfx reported:" >&2
  sed 's/^/    /' "$_iderr" >&2
  rm -f "$_iderr"
  echo "  if it is keyring-backed in a headless env, point dfx at the on-disk key instead: set" >&2
  echo "  keyring_identity_suffix to null in ~/.config/dfx/identity/$IDENT/identity.json (identity.pem is the key)." >&2
  exit 1
fi
rm -f "$_iderr"

echo "== preflight: reach $NETWORK + the identity that will control the canister =="
dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network (dfx ping $NETWORK failed)" >&2; exit 1; }
echo "   identity:  $IDENT"
echo "   principal: $PRINCIPAL   <- becomes/controls the canister"

echo "== build canister wasm (release) =="
cargo build -p "$CRATE" --target wasm32-unknown-unknown --release

echo "== refresh candid from the wasm =="
mkdir -p dfx
candid-extractor "target/wasm32-unknown-unknown/release/${CANISTER}.wasm" > dfx/dpay_canister.did

echo "== generate deterministic candid init args (pre-funded demo accounts) =="
cargo run -q -p dpay-fixture

# --- resolve the deploy TARGET + MODE ----------------------------------------------------------
# The operator's source of truth for "which canister" is DPAY_CANISTER_ID in deploy/.env. On a real
# (remote) network, if it is set, point dfx at that exact canister so deploy installs/upgrades IT
# instead of trying to create — and pay cycles for — a brand-new one. dfx reads canister ids for
# remote networks from ./canister_ids.json (regenerated here from .env, so .env stays authoritative).
EXISTING_CID="$(env_get DPAY_CANISTER_ID deploy/.env)"
if [ "$NETWORK" != "local" ] && [ -n "$EXISTING_CID" ]; then
  jq -n --arg c "$CANISTER" --arg n "$NETWORK" --arg id "$EXISTING_CID" '{($c):{($n):$id}}' > canister_ids.json
  echo "== target: existing canister $EXISTING_CID on $NETWORK (from deploy/.env) =="
  # Mode from the canister's ACTUAL state: no code yet → a safe first install (nothing to lose); code
  # already installed → upgrade (default) preserves state via stable memory; reinstall re-funds.
  _ierr="$(mktemp)"
  if ! _info="$(dfx_i canister info "$EXISTING_CID" --network "$NETWORK" 2>"$_ierr")"; then
    echo "cannot read canister $EXISTING_CID on $NETWORK — dfx reported:" >&2
    sed 's/^/    /' "$_ierr" >&2; rm -f "$_ierr"; exit 1
  fi
  rm -f "$_ierr"
  HASH="$(sed -n 's/^Module hash: //p' <<<"$_info")"
  if [ -z "$HASH" ] || [ "$HASH" = "None" ]; then
    MODE="${DPAY_DEPLOY_MODE:-install}"
    echo "   canister has no code yet → mode=$MODE (nothing to lose)"
  else
    MODE="${DPAY_DEPLOY_MODE:-upgrade}"
    if [ "$MODE" = upgrade ]; then
      echo "   mode=upgrade: balances + spent nonces are preserved via stable structures."
      echo "   (First migration from the pre-stable-memory build starts empty — reinstall once first.)"
    fi
    echo "   canister has code (module hash $HASH) → REDEPLOY mode=$MODE"
  fi
else
  # No id in deploy/.env (first-ever deploy) or a local rehearsal: let dfx manage the id. Probe its
  # record; an UNEXPECTED failure is surfaced, never silently read as "new".
  _probe="$(mktemp)"
  if dfx_i canister id "$CANISTER" --network "$NETWORK" >/dev/null 2>"$_probe"; then
    MODE="${DPAY_DEPLOY_MODE:-upgrade}"
    if [ "$MODE" = upgrade ]; then
      echo "   mode=upgrade: balances + spent nonces are preserved via stable memory (reinstall re-funds)."
    fi
    echo "== REDEPLOY (mode=$MODE) =="
  elif grep -qiE 'cannot find|not been created|does not exist|no canister' "$_probe"; then
    MODE="${DPAY_DEPLOY_MODE:-install}"
    echo "== first-ever deploy on $NETWORK (mode=$MODE) — dfx will CREATE the canister (spends cycles on ic) =="
  else
    echo "could not determine whether '$CANISTER' exists on $NETWORK — dfx reported:" >&2
    sed 's/^/    /' "$_probe" >&2; rm -f "$_probe"; exit 1
  fi
  rm -f "$_probe"
fi

echo "== deploy to $NETWORK as '$IDENT' (it becomes/keeps the controller; spends cycles on ic) =="
# --yes: `--mode reinstall` otherwise prompts to confirm the state reset, which aborts (exit 255)
# when run non-interactively. Setting DPAY_DEPLOY_MODE=reinstall above IS that explicit confirmation.
dfx_i deploy "$CANISTER" --network "$NETWORK" --mode "$MODE" --yes --argument-file dfx/args/init.arg

CID=$(dfx_i canister id "$CANISTER" --network "$NETWORK")
[[ "$CID" =~ ^[a-z0-9-]+$ ]] || { echo "did not get a valid canister id back (got: '$CID')" >&2; exit 1; }

echo
echo "== deployed =="
echo "   canister id: $CID"
# Sanity readbacks (free queries). No stderr suppression: a failed query aborts loudly, not silently.
CAP="$(dfx_i canister call "$CANISTER" per_tx_cap --network "$NETWORK" --query | nat)" || { echo "readback failed: per_tx_cap query" >&2; exit 1; }
PA0="$(dfx_i canister call "$CANISTER" balance_of --network "$NETWORK" --query --argument-file dfx/args/payer.arg | nat)" || { echo "readback failed: payer balance query" >&2; exit 1; }
MB0="$(dfx_i canister call "$CANISTER" balance_of --network "$NETWORK" --query --argument-file dfx/args/merchant.arg | nat)" || { echo "readback failed: merchant balance query" >&2; exit 1; }
echo "   cap: $CAP   opening balances: payer=$PA0  merchant=$MB0"

# --- connective tissue: hand the canister id to the relay's config -----------------------------
# Only for the real network: a local rehearsal must not overwrite the mainnet id in deploy/.env.
if [ "$NETWORK" != "local" ]; then
  env_set DPAY_CANISTER_ID "$CID" deploy/.env
  echo "   wrote DPAY_CANISTER_ID=$CID to deploy/.env"
else
  echo "   (local rehearsal: leaving deploy/.env untouched; local canister id $CID)"
fi

echo
echo "next: deploy/.env now carries the canister id. Confirm DPAY_LEDGER=ic, DPAY_IC_URL=https://icp-api.io,"
echo "      and DPAY_IC_FETCH_ROOT_KEY=false there, then set up the tunnel (just tunnel-provision) and: just up"
