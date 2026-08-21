#!/usr/bin/env bash
# faucet-verify — assert the prod faucet's IDENTITY WIRING before a user ever hits a 422.
#
# The faucet is a two-party authenticated flow:
#     relay (signs as DPAY_CONTROLLER_SEED — a DEDICATED Ed25519 key) ──mint──▶ facade
#       `require_admin` checks the INTERNAL CONTROLLER cell (armed with that key's principal)
#     dfx deploy identity (DPAY_DFX_IDENTITY) armed the cell via set_controller, is admitted to
#       admin ops via the ADMIN_CALLERS operator allowlist, and holds IC-level upgrade control.
#
# The CONTROLLER is deliberately NOT the deploy identity: dfx identities are secp256k1 while the
# relay's agent can only sign Ed25519, so the seed can never be the identity's PEM material (the
# 2026-08-20 discovery behind the original prod failure: relay anonymous/mismatched → 422
# 'unauthorized: admin ops require the controller principal'). This script pins each leg,
# cheapest-first, ALL READ-ONLY unless --mint is given:
#
#   1. LOCAL  DPAY_CONTROLLER_SEED is present in deploy/.env and well-formed (64 hex / 32 bytes).
#   2. KEY    The seed derives a principal (self-authenticating Ed25519 over its verifying key) —
#             the identity the relay will actually sign as.
#   3. CANIST The canister's admin_controller readback == that principal (free query). null → not
#             armed; a different principal → governed by another key. Either way: exit 1.
#   4. IC     The canister's IC-level controllers (dfx canister info) contain the deploy identity —
#             the upgrade authority that ran set_controller (govern-in-place root key).
#   5. RELAY  (--mint only) POST the LIVE relay's /api/v1/faucet for a THROWAWAY account and
#             expect 200 — the end-to-end proof a user's top-up goes through. Mints the fixed
#             play-DUSD FAUCET_AMOUNT to a burner account; never pass a real account.
#
# Fixing a failed leg is `just deploy-ic` (generates/reuses the seed, arms the cell, writes .env)
# — this script only verifies.
#
# Usage:
#   just faucet-verify                 # legs 1-4 (offline crypto + free IC readbacks)
#   just faucet-verify --mint          # + leg 5 against https://dpay.kalaj.org (default relay)
#   scripts/faucet-verify.sh --relay https://staging.example.com --mint
#
# Exits 0 only if every leg run passed. Needs the canister deployed (DPAY_CANISTER_ID in
# deploy/.env — written by scripts/dfx-deploy-ic.sh) and dfx network access for legs 3-4.
# NOTE leg 3 requires a canister wasm WITH the admin_controller query (2026-08-20+); an older
# deployment fails leg 3 loudly — upgrade via `just deploy-ic`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

NETWORK="${DPAY_DFX_NETWORK:-ic}"
MINT=no
RELAY_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mint)  MINT=yes ;;
    --relay) RELAY_URL="${2:?--relay needs a URL}"; shift ;;
    *) echo "unknown arg: $1 (expected --mint and/or --relay URL)" >&2; exit 2 ;;
  esac
  shift
done
: "${RELAY_URL:=https://dpay.kalaj.org}"

require_cmd dfx "dfx not found on PATH"
load_identity "faucet-verify needs the deploy identity (DPAY_DFX_IDENTITY) to compare principals"
CID="$(env_get DPAY_CANISTER_ID deploy/.env)"
[ -n "$CID" ] || { echo "FAIL: DPAY_CANISTER_ID missing from deploy/.env — run scripts/dfx-deploy-ic.sh first" >&2; exit 1; }

echo "== leg 1: DPAY_CONTROLLER_SEED present + well-formed in deploy/.env =="
SEED_HEX="$(env_get DPAY_CONTROLLER_SEED deploy/.env)" || SEED_HEX=""
if [ -z "$SEED_HEX" ]; then
  echo "FAIL: DPAY_CONTROLLER_SEED is not set in deploy/.env — the relay comes up ANONYMOUS and" >&2
  echo "      every faucet top-up 422s 'unauthorized: admin ops require the controller principal'." >&2
  echo "      Fix: re-run scripts/dfx-deploy-ic.sh (generates + arms + writes it)." >&2
  exit 1
fi
if ! [[ "$SEED_HEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "FAIL: DPAY_CONTROLLER_SEED is malformed (want 64 hex chars / 32 bytes), got ${#SEED_HEX} chars" >&2
  exit 1
fi
echo "   ok: seed present, 32-byte Ed25519"

echo "== leg 2: seed derives the relay's signing principal =="
SEED_PRINCIPAL="$(cargo run -q -p dpay-icp-e2e --bin dev-principal -- "$SEED_HEX")" \
  || { echo "FAIL: could not derive the seed's principal (cargo run -p dpay-icp-e2e --bin dev-principal)" >&2; exit 1; }
echo "   ok: seed ⇒ $SEED_PRINCIPAL (the identity the relay signs as)"

echo "== leg 3: canister admin_controller readback == that principal =="
RB="$(dfx_i canister call "$CID" admin_controller --network "$NETWORK" --query 2>&1)" \
  || { echo "FAIL: admin_controller query failed: $RB" >&2
       echo "      (Wasm predates the readback query? Upgrade: just deploy-ic)" >&2
       exit 1; }
CUR_CONTROLLER="$(tr -d '\n' <<<"$RB" | sed -n 's/.*opt principal "\([^"]*\)".*/\1/p')"
if [ -z "$CUR_CONTROLLER" ]; then
  echo "FAIL: the CONTROLLER cell is NULL (open-demo mode, admin ops denied) — arm it:" >&2
  echo "      re-run scripts/dfx-deploy-ic.sh (arms the relay's dedicated key automatically)." >&2
  exit 1
fi
if [ "$CUR_CONTROLLER" != "$SEED_PRINCIPAL" ]; then
  echo "FAIL: CONTROLLER cell holds $CUR_CONTROLLER but the seed derives $SEED_PRINCIPAL — the" >&2
  echo "      relay would authenticate as a non-controller and every mint would be refused. Either" >&2
  echo "      deploy/.env carries the wrong seed, or the cell was armed with a different key." >&2
  echo "      Fix: scripts/dfx-deploy-ic.sh (reuses the .env seed and arms the cell to match)." >&2
  exit 1
fi
echo "   ok: CONTROLLER == seed principal — the relay's mint passes require_admin"

echo "== leg 4: IC-level controllers of $CID contain $PRINCIPAL (deploy identity) =="
INFO="$(dfx_i canister info "$CID" --network "$NETWORK" 2>&1)" || { echo "FAIL: $INFO" >&2; exit 1; }
if grep -q " $PRINCIPAL" <<<"$INFO"; then
  echo "   ok: deploy identity is an IC-level controller (upgrade authority, govern-in-place)"
else
  echo "FAIL: $PRINCIPAL is NOT among the canister's IC-level controllers:"" $INFO" >&2
  exit 1
fi

if [ "$MINT" != yes ]; then
  echo
  echo "PASS: faucet wiring verified (read-only legs 1-4). End-to-end proof: 'just faucet-verify --mint'"
  exit 0
fi

echo "== leg 5: LIVE relay faucet mints for a throwaway account =="
BURNER_SEED="$(openssl rand -hex 32)"
BURNER_PK="$(cargo run -q -p dpay-icp-e2e --bin dev-pubkey -- "$BURNER_SEED" 2>/dev/null)" \
  || { echo "FAIL: dev-pubkey helper unavailable (crates/dpay-icp-e2e)" >&2; exit 1; }
RESP="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$RELAY_URL/api/v1/faucet" \
  -H 'content-type: application/json' \
  -d "{\"account\":\"$BURNER_PK\",\"amount\":\"10000\"}")" || { echo "FAIL: relay unreachable at $RELAY_URL" >&2; exit 1; }
CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"
if [ "$CODE" = 200 ]; then
  echo "   ok: relay 200 ($BODY) — throwaway play-DUSD credited at the burner's user principal"
else
  echo "FAIL: relay returned $CODE: $BODY" >&2
  echo "      Legs 1-4 passed, so suspect the RELAY container's env (compose not restarted after" >&2
  echo "      deploy/.env changed? 'just up') or its DPAY_IC_* settings." >&2
  exit 1
fi

echo
echo "PASS: faucet wiring verified end-to-end (legs 1-5, live mint OK)."
