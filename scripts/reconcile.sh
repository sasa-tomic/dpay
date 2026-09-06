#!/usr/bin/env bash
# reconcile — walk a currency's recent ledger debits on the facade canister and repair any
# orphaned ones (debit-without-credit), closing the cross-canister trap window
# (dpay-canister lib.rs "icrc3 reconcile"). FOUNDER-RUN operator hook: it signs as the
# canister's CONTROLLER key, so it needs DPAY_CONTROLLER_SEED (deploy/.env) and network access.
# WHEN to run it and how to read the report: docs/OPS.md (the reconcile runbook).
#
# The identity leg copies scripts/faucet-verify.sh's derivation verbatim: the seed is read with
# env_get (never echoed, never exported), validated as 64 hex chars, and turned into a principal
# with the same dev-principal helper bin. What is NEW here is making DFX sign as that key: dfx
# identities are normally secp256k1 PEMs, but the IC identity spec is Ed25519 PKCS#8 too — so the
# seed is wrapped in its canonical PKCS#8 prefix (302e020100300506032b657004220420) as a
# throwaway identity under a RELOCATED DFX_CONFIG_ROOT (the founder's real identity store is
# never touched), and the wiring is PROVEN read-only before any update: the identity's
# get-principal must equal the seed's self-authenticating principal, or the script refuses.
# require_admin (canister lib.rs) admits exactly that principal (the CONTROLLER cell).
#
# Usage:
#   just reconcile            # every catalog currency (see CURRENCIES below)
#   just reconcile 7          # just VCHF
#   bash scripts/reconcile.sh 0
#
# Exit 0 = every walk returned Ok (orphans_repaired may be 0 — that is the healthy answer).
# Exit 1 = a canister Err(text) or a wiring failure (message says which leg).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/env-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

NETWORK="${DPAY_DFX_NETWORK:-ic}"
CID="$(env_get DPAY_CANISTER_ID deploy/.env)"
[ -n "$CID" ] || { echo "reconcile: DPAY_CANISTER_ID is not set (deploy/.env). Deploy first: just deploy-ic" >&2; exit 1; }

# The compiled catalog's IC currencies (crates/dpay-relay/src/catalog.rs is the SOLE authority;
# if a currency is added there, add its id here — the drift is visible the moment this list is
# shorter than the catalog the app renders).
CURRENCIES="0 1 2 3 4 5 6 7 8 9"
WHAT="${1:-all}"
if [ "$WHAT" != "all" ]; then
  [[ "$WHAT" =~ ^[0-9]+$ ]] || { echo "reconcile: currency must be a nat32 id or 'all', got '$WHAT'" >&2; exit 1; }
  CURRENCIES="$WHAT"
fi

# --- identity: the controller seed, as a throwaway dfx identity (never echoed) ------------------
SEED_HEX="$(env_get DPAY_CONTROLLER_SEED deploy/.env)"
if ! [[ "$SEED_HEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "reconcile: DPAY_CONTROLLER_SEED is absent or not 64 hex chars (deploy/.env)." >&2
  echo "           Without it no caller matches the canister's CONTROLLER cell, and reconcile is" >&2
  echo "           refused ('unauthorized: admin ops require the controller principal'). Arm it" >&2
  echo "           with: just deploy-ic   (or see docs/OPS.md, key-rotation runbook)" >&2
  exit 1
fi
SEED_HEX="${SEED_HEX,,}"

# The seed's self-authenticating principal — the same helper faucet-verify.sh uses (leg 2).
SEED_PRINCIPAL="$(cargo run -q -p dpay-icp-e2e --bin dev-principal -- "$SEED_HEX")"

# Wrap the raw seed in its canonical Ed25519 PKCS#8 DER (prefix + 32-byte key = 48 bytes) and
# place it as a throwaway identity under a RELOCATED dfx config root (dfx nests identities at
# $DFX_CONFIG_ROOT/.config/dfx/identity/<name>/identity.pem — a pem alone is a valid identity,
# as the auto-created "default" proves). Removed on exit (trap). The DER bytes go through a
# FILE, never a command substitution — $(...) strips NUL bytes, and a seed containing 0x00 would
# silently corrupt the key (the length check below catches it anyway).
CFG_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dpay-reconcile.XXXXXX")"
trap 'rm -rf "$CFG_ROOT"' EXIT
chmod 700 "$CFG_ROOT"
IDENT_NAME="reconcile-controller"
IDENT_DIR="$CFG_ROOT/.config/dfx/identity/$IDENT_NAME"
mkdir -p "$IDENT_DIR"
chmod 700 "$IDENT_DIR"
HEXDER="302e020100300506032b657004220420$SEED_HEX"
# shellcheck disable=SC2059 — the format string is \xHH escapes BY DESIGN: printf must interpret
# them to emit the raw DER bytes (the hex comes from the validated [0-9a-f] seed + fixed prefix,
# so no stray % or backslash can ride along).
printf "$(printf '%s' "$HEXDER" | sed 's/\(..\)/\\x\1/g')" > "$IDENT_DIR/seed.der"
if [ "$(wc -c < "$IDENT_DIR/seed.der")" -ne 48 ]; then
  echo "reconcile: the DER wrap produced the wrong length — refusing to build an identity from it." >&2
  exit 1
fi
{
  echo "-----BEGIN PRIVATE KEY-----"
  base64 < "$IDENT_DIR/seed.der"
  echo "-----END PRIVATE KEY-----"
} > "$IDENT_DIR/identity.pem"
rm -f "$IDENT_DIR/seed.der"
chmod 600 "$IDENT_DIR/identity.pem"

# Prove the PEM derivation read-only BEFORE any update call: the identity's principal must be
# the seed's principal. If dfx cannot parse the PEM or the principals differ, refuse loudly —
# an update signed by the wrong key is a wasted refusal, not a repair.
DFX_PRINCIPAL="$(DFX_CONFIG_ROOT="$CFG_ROOT" dfx --identity "$IDENT_NAME" identity get-principal)"
if [ "$DFX_PRINCIPAL" != "$SEED_PRINCIPAL" ]; then
  echo "reconcile: the throwaway identity's principal does not match the seed's — refusing to call." >&2
  echo "           identity: $DFX_PRINCIPAL" >&2
  echo "           seed:     $SEED_PRINCIPAL" >&2
  exit 1
fi
echo "reconciling $CID on $NETWORK as the controller principal $SEED_PRINCIPAL"

# --- the walks ---------------------------------------------------------------------------------
FAILED=0
for C in $CURRENCIES; do
  REPLY="$(DFX_CONFIG_ROOT="$CFG_ROOT" dfx --identity "$IDENT_NAME" canister call "$CID" \
    reconcile "($C : nat32)" --network "$NETWORK" --output json)"
  if printf '%s' "$REPLY" | grep -q '"Err"'; then
    REASON="$(printf '%s' "$REPLY" | sed -n 's/.*"Err"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    echo "FAIL: reconcile($C) refused: $REASON"
    FAILED=1
    continue
  fi
  SCANNED="$(printf '%s' "$REPLY" | sed -n 's/.*"blocks_scanned"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')"
  REPAIRED="$(printf '%s' "$REPLY" | sed -n 's/.*"orphans_repaired"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')"
  echo "currency=$C blocks_scanned=${SCANNED:-?} orphans_repaired=${REPAIRED:-?}"
  if [ "${REPAIRED:-0}" -gt 0 ]; then
    echo "      repaired orphans — record this run in docs/OPS.md (the runbook's append section)"
  fi
done
if [ "$FAILED" -ne 0 ]; then
  echo "reconcile: at least one walk was REFUSED — see the reasons above (docs/OPS.md has the runbook)." >&2
  exit 1
fi
echo "done. All walks returned Ok — every scanned debit is paired with its credit."
