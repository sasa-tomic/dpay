#!/usr/bin/env bash
# Local operator hook: mint (credit) minor units to an account on the dpay canister.
#
# CONTROLLER-ONLY. Runs as DPAY_DFX_IDENTITY, which must be a controller of the canister — the exact
# gate the canister enforces (is_controller(caller)). A random caller cannot mint this way. This is
# the demo stand-in for the real funding path (on-chain top-up → issuer mint); see FUNDING.md.
#
#   just mint <account-hex> <amount-minor-units>
# <account-hex> = 64 hex chars (the 32-byte Ed25519 account pubkey); <amount> = minor units (cents).
#   just mint 8a88e3dd…40f6f5c 5000     # credits $50.00
#
# Env (fall back to deploy/.env): DPAY_DFX_IDENTITY (controller), DPAY_CANISTER_ID, DPAY_DFX_NETWORK
# (default ic — set `local` to hit a local replica).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/dfx/bin:$PATH"
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh

ACCT="${1:-}"
AMOUNT="${2:-}"
[[ "$ACCT" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "usage: just mint <64-hex-account> <amount-minor-units>" >&2; exit 1; }
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || { echo "amount must be a whole number of minor units (cents), got '$AMOUNT'" >&2; exit 1; }

IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
CID="${DPAY_CANISTER_ID:-$(env_get DPAY_CANISTER_ID deploy/.env)}"
NETWORK="${DPAY_DFX_NETWORK:-ic}"
[ -n "$IDENT" ] || { echo "DPAY_DFX_IDENTITY unset (deploy/.env) — the mint identity must be a canister controller" >&2; exit 1; }
[ -n "$CID" ]   || { echo "DPAY_CANISTER_ID unset (deploy/.env)" >&2; exit 1; }
command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }

# 32-byte hex → candid blob escapes (one \xx per byte). sed (not ${//}): needs a per-pair backreference.
# shellcheck disable=SC2001
BLOB="$(sed 's/\(..\)/\\\1/g' <<<"$ACCT")"

echo "== mint $AMOUNT (minor units) to $ACCT on $NETWORK as '$IDENT' =="
dfx --identity "$IDENT" canister call "$CID" mint "(blob \"$BLOB\", $AMOUNT : nat64)" --network "$NETWORK"
