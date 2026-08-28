#!/usr/bin/env bash
# Deploy (or redeploy) the dpay canister to ICP MAINNET (the built-in `ic` network) as an explicit
# named dfx identity, then write the resulting canister id back into deploy/.env so the relay picks
# it up. The mainnet sibling of scripts/dfx-deploy.sh (which stands up a throwaway LOCAL replica and
# self-tests a settlement). This is the ONE mainnet deploy path: it builds the wasm, refreshes the
# candid, (re)installs the facade with the init arg `record { demo_ledger; per_tx_cap; controller }`
# (demo_ledger = the mainnet DUSD ledger, cross-checked below), arms the internal controller cell
# with the relay's dedicated Ed25519 faucet key, reads back a couple of *free* query calls, and
# writes DPAY_CANISTER_ID + DPAY_CONTROLLER_SEED to deploy/.env.
#
# There is NO currency registration anymore (founder decision 2026-08-28: the canister's registry
# is gone). Every non-DEMO asset the facade serves is a compile-time FIXED_ASSETS const, and the
# catalog the app renders is compiled into the RELAY serving /api/v1/currencies — adding a currency
# is a relay code change + `just up`, never a canister step. This script also deliberately does NOT
# push a state-changing payment to mainnet: the one-time settle smoke was run at initial deploy and
# the settlement kernel is covered going forward by PocketIC canister tests + e2e + `just
# verify-deploy` (wasm-hash fidelity).
#
# Identity (DPAY_DFX_IDENTITY) is REQUIRED and load-bearing: `dfx deploy --network ic` spends the
# identity's cycles AND makes it the CANISTER CONTROLLER (upgrade authority). Create one with
# `icp-cli new-identity dpay` (or `dfx identity new dpay`) — both land in the dfx identity store —
# and set DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment).
#
#   DPAY_DFX_IDENTITY   (required)  named dfx identity to deploy as → becomes the controller
#   DPAY_DEPLOY_MODE    (redeploy)  dfx install mode; defaults to `upgrade` when the canister already
#                                   has code. `reinstall` = wipe + re-run init (balances reset to
#                                   zero). `install` = empty canister only. (Empty → install.)
#   DPAY_DFX_NETWORK    (optional)  dfx network; default `ic` (mainnet). Set `local` to rehearse the
#                                   whole flow against a running local replica before spending cycles.
#   DPAY_CANISTER_ID    (deploy/.env) if set, deploy TARGETS that existing canister (dfx installs into
#                                   / upgrades it — no new canister, no create-cycles). Unset → create.
#
# Two money-critical caveats for this demo-phase canister:
#   * UPGRADE PRESERVES STATE. Balances + spent nonces live in stable structures (StableBTreeMap /
#     StableCell), so `--mode upgrade` (the redeploy default) carries them across automatically — no
#     serialization hooks. The init arg is type-checked against the .did on every deploy but only
#     TAKES EFFECT on a fresh install (there is no post_upgrade; init never re-runs). `--mode
#     reinstall` wipes and re-runs init (clean, zero-balance ledger); `install` is for an empty
#     canister. ONE-TIME MIGRATION: upgrading from the original pre-stable-memory build finds empty
#     stable memory → starts with an EMPTY ledger; reinstall once to re-fund, after which upgrades
#     preserve state.
#   * DEMO-PHASE HARDENING LEVEL: `mint` is CONTROLLER-gated (require_admin; only the facade's
#     internal CONTROLLER key can mint — normally the relay's DPAY_CONTROLLER_SEED identity), but
#     the controller is your own key (not blackholed / not SNS-governed). Accepted only while
#     there is no real money on the canister.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env
CANISTER=dpay_canister        # dfx canister name + wasm artifact basename (cargo maps - to _)
CRATE=dpay-canister           # cargo package name
NETWORK="${DPAY_DFX_NETWORK:-ic}"   # `ic` = mainnet (default); `local` to rehearse on a local replica

require_cmd dfx "dfx not found on PATH"
# Guard before the `> dfx/dpay_canister.did` redirect in refresh_candid, which would otherwise
# truncate the committed candid file to empty (→ dfx "no main service") when the tool is absent.
require_cmd candid-extractor "candid-extractor not found — cargo install candid-extractor"

# --- identity: required, must exist, becomes the controller ------------------------------------
# Keyring troubleshooting hint, surfaced on dfx's PRINCIPAL-load failure (headless envs). load_identity
# sets IDENT before invoking the hook, so $IDENT resolves to the configured identity name.
identity_load_hint() {
  echo "  if it is keyring-backed in a headless env, point dfx at the on-disk key instead: set" >&2
  echo "  keyring_identity_suffix to null in ~/.config/dfx/identity/$IDENT/identity.json (identity.pem is the key)." >&2
}
load_identity "DPAY_DFX_IDENTITY is required — the identity that deploys becomes the canister CONTROLLER.
  create it:  icp-cli new-identity dpay   (or: dfx identity new dpay)
  set it:     DPAY_DFX_IDENTITY=dpay in deploy/.env (or the environment)"

echo "== preflight: reach $NETWORK + the identity that will control the canister =="
dfx ping "$NETWORK" >/dev/null || { echo "cannot reach the '$NETWORK' network (dfx ping $NETWORK failed)" >&2; exit 1; }
echo "   identity:  $IDENT"
echo "   principal: $PRINCIPAL   <- becomes/controls the canister"

echo "== build canister wasm (release) =="
build_canister_wasm "$CRATE"

echo "== refresh candid from the wasm =="
refresh_candid "$CANISTER"

echo "== generate deterministic candid args (init arg + offline-signed payment) =="
cargo run -q -p dpay-fixture

# --- init.arg sanity: the demo_ledger it bakes must be the tracked DUSD ledger ------------------
# `demo_ledger` is FIXED AT INSTALL (init; upgrades ignore it) and the DEMO currency (0) settles on
# it, so a stale/mismatched arg would silently wire a FRESH canister to the wrong ledger. On `ic`
# the TRACKED canister_ids.json is the durable map of owned canisters (icrc_ledger -> td2nx);
# abort on drift or on an unresolvable ledger. A local rehearsal skips this (td2nx does not exist
# there; init only STORES the principal, so the rehearsal still proves the arg shape + flow).
if [ "$NETWORK" != "local" ]; then
  DEMO_LEDGER="$(dfx_i canister id icrc_ledger --network "$NETWORK")" \
    || { echo "cannot resolve icrc_ledger on $NETWORK — canister_ids.json must track the DUSD ledger (docs/CANISTERS.md)" >&2; exit 1; }
  ARG_LEDGER="$(sed -n 's/^.*demo_ledger = principal "\([^"]*\)".*$/\1/p' dfx/args/init.arg)"
  [ -n "$ARG_LEDGER" ] || { echo "dfx/args/init.arg carries no demo_ledger — regenerate it (cargo run -p dpay-fixture)" >&2; exit 1; }
  if [ "$ARG_LEDGER" != "$DEMO_LEDGER" ]; then
    echo "ABORT: init.arg demo_ledger ($ARG_LEDGER) != tracked icrc_ledger ($DEMO_LEDGER)." >&2
    echo "       A fresh install would wire the DEMO currency to the wrong ledger. Fix the fixture" >&2
    echo "       (crates/dpay-fixture, DEMO_LEDGER_MAINNET) or canister_ids.json — never deploy past this." >&2
    exit 1
  fi
  echo "   init.arg demo_ledger = $DEMO_LEDGER (matches the tracked icrc_ledger)"
fi

# --- resolve the deploy TARGET + MODE ----------------------------------------------------------
# The operator's source of truth for "which canister" is DPAY_CANISTER_ID in deploy/.env. On a real
# (remote) network, if it is set, point dfx at that exact canister so deploy installs/upgrades IT
# instead of trying to create — and pay cycles for — a brand-new one. dfx reads canister ids for
# remote networks from ./canister_ids.json (regenerated here from .env, so .env stays authoritative).
EXISTING_CID="$(env_get DPAY_CANISTER_ID deploy/.env)"
if [ "$NETWORK" != "local" ] && [ -n "$EXISTING_CID" ]; then
  # MERGE the facade id into the TRACKED canister_ids.json — never clobber (the file is the durable
  # map of ALL owned canisters; overwriting would drop icrc_ledger/td2nx). .env stays the operator's
  # source of truth for the facade id; see docs/CANISTERS.md.
  merge_canister_id "$CANISTER" "$NETWORK" "$EXISTING_CID"
  echo "== target: existing canister $EXISTING_CID on $NETWORK (from deploy/.env) =="
  # Mode from the canister's ACTUAL state: no code yet → a safe first install (nothing to lose); code
  # already installed → upgrade (default) preserves state via stable memory; reinstall wipes.
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
      echo "   mode=upgrade: balances + spent nonces are preserved via stable memory (reinstall wipes)."
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
# The argument file feeds init on a FRESH install; on upgrade dfx type-checks it against the .did
# and the canister ignores it (no post_upgrade — init never re-runs).
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
echo "   cap: $CAP   cached balances: payer=$PA0  merchant=$MB0"

# --- arm the admin gate with the relay's DEDICATED Ed25519 faucet key ---------------------------
# `require_admin` reads the canister's INTERNAL CONTROLLER stable cell (NOT the dfx-level canister
# controller). The production controller is NOT the deploy identity: dfx identities are secp256k1
# while the relay's agent can only sign Ed25519 (ic-agent BasicIdentity), so the controller key can
# never be the identity's PEM material. Instead the relay owns a DEDICATED 32-byte Ed25519 key —
# DPAY_CONTROLLER_SEED — and this step arms the cell with that key's derived principal
# (self_authenticating over its verifying key). The dfx deploy identity keeps running admin ops via
# the ADMIN_CALLERS operator allowlist (`just mint`) and stays the IC-level controller (upgrade
# authority). Blast radius of the dedicated key: demo-$ mint only; rotation = set_controller + seed
# swap (docs/GOVERNANCE.md, govern-in-place pillar 2).
# Idempotent by design: an existing DPAY_CONTROLLER_SEED in deploy/.env is REUSED (never regenerated
# — regenerating would orphan the armed controller), and a cell already holding the derived
# principal is left alone (free admin_controller readback instead of a set_controller tx).
echo "== arm the admin gate: CONTROLLER cell ← relay's dedicated Ed25519 faucet key =="
SEED_HEX="${DPAY_CONTROLLER_SEED:-$(env_get DPAY_CONTROLLER_SEED deploy/.env)}"
if [ -n "$SEED_HEX" ] && [[ "$SEED_HEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "   faucet key: reusing DPAY_CONTROLLER_SEED from deploy/.env (rotation-stable)"
else
  SEED_HEX="$(openssl rand -hex 32)"
  echo "   faucet key: generated a NEW dedicated Ed25519 seed"
fi
RELAY_PRINCIPAL="$(cargo run -q -p dpay-icp-e2e --bin dev-principal -- "$SEED_HEX")" \
  || { echo "could not derive the faucet key's principal (cargo run -p dpay-icp-e2e --bin dev-principal)" >&2; exit 1; }
CUR_CONTROLLER="$(dfx_i canister call "$CANISTER" admin_controller --network "$NETWORK" --query 2>/dev/null \
  | tr -d '\n' | sed -n 's/.*opt principal "\([^"]*\)".*/\1/p')"
if [ "$CUR_CONTROLLER" = "$RELAY_PRINCIPAL" ]; then
  echo "   CONTROLLER already = relay faucet key — armed (no set_controller needed)"
elif [ -n "$CUR_CONTROLLER" ]; then
  # Readback resolved but differs: still attempt the rotation (only the CURRENT controller can
  # perform it — a deploy identity that is the current controller legitimately rotates; anything
  # else fails loudly below and we do NOT touch that canister's governance).
  case "$(dfx_i canister call "$CANISTER" set_controller "(opt principal \"$RELAY_PRINCIPAL\")" --network "$NETWORK" 2>&1)" in
    *Ok*) echo "   CONTROLLER rotated: $CUR_CONTROLLER → $RELAY_PRINCIPAL (relay faucet key armed)" ;;
    *) echo "WARN: set_controller refused — the internal controller is governed by $CUR_CONTROLLER," >&2
       echo "      not '$IDENT'. The relay's faucet mint will 422 'unauthorized' until THAT key" >&2
       echo "      rotates the cell. (Governed canister? See docs/GOVERNANCE.md.)" >&2 ;;
  esac
else
  # Fresh canister (or one predating the admin_controller query): null cell → open-mode lockdown
  # lets ANY caller arm it once; an older locked cell surfaces as an honest set_controller failure.
  case "$(dfx_i canister call "$CANISTER" set_controller "(opt principal \"$RELAY_PRINCIPAL\")" --network "$NETWORK" 2>&1)" in
    *Ok*) echo "   CONTROLLER = $RELAY_PRINCIPAL (admin gate armed; faucet/mint enabled)" ;;
    *) echo "WARN: set_controller did not return Ok — the internal controller is governed by ANOTHER" >&2
       echo "      principal (readback was empty but the cell is locked). Admin ops (mint/burn/" >&2
       echo "      reconcile) as '$IDENT' will be refused until the current controller rotates the" >&2
       echo "      cell. To fix, have the CURRENT controller run" >&2
       echo "        dfx canister call $CANISTER set_controller '(opt principal \"$RELAY_PRINCIPAL\")' --network $NETWORK" >&2
       echo "      (the relay's key cannot sign dfx calls; DPAY_CONTROLLER_SEED below is the target)" >&2
       echo "      (Governed canister? See docs/GOVERNANCE.md.)" >&2 ;;
  esac
fi
# Persist the seed for the relay container (compose reads deploy/.env). Written even if arming WARNed
# — it is still the key the relay must sign with once governance is resolved. Local rehearsals never
# touch deploy/.env (same discipline as DPAY_CANISTER_ID).
if [ "$NETWORK" != "local" ]; then
  env_set DPAY_CONTROLLER_SEED "$SEED_HEX" deploy/.env
  echo "   wrote DPAY_CONTROLLER_SEED (relay's dedicated faucet key) to deploy/.env"
fi

# --- connective tissue: hand the canister id to the relay's config -----------------------------
# Only for the real network: a local rehearsal must not overwrite the mainnet id in deploy/.env.
if [ "$NETWORK" != "local" ]; then
  env_set DPAY_CANISTER_ID "$CID" deploy/.env
  echo "   wrote DPAY_CANISTER_ID=$CID to deploy/.env"
else
  echo "   (local rehearsal: leaving deploy/.env untouched; local canister id $CID)"
fi

echo
echo "done. The catalog the app renders is NOT set here — it is compiled into the relay"
echo "      (crates/dpay-relay/src/catalog.rs); adding a currency = relay code change + 'just up'."
echo "next: deploy/.env now carries the canister id (and, on ic, the controller seed). Confirm"
echo "      DPAY_LEDGER=ic, DPAY_IC_URL=https://icp-api.io, and DPAY_IC_FETCH_ROOT_KEY=false"
echo "      there, optionally run 'just faucet-verify' (asserts seed↔controller wiring — needs"
echo "      the relay up: 'just up'), then set up the tunnel (just tunnel-provision) and: just up"
