#!/usr/bin/env bash
# Local operator hook: mint (credit) minor units of a currency to an account on the dpay canister.
#
# OPEN FAUCET. The canister's `mint : (blob, nat32, nat64) -> nat64` is unauthenticated — any caller
# (including the anonymous principal the relay uses) can mint. This script runs as DPAY_DFX_IDENTITY
# purely so it shares the same canister-id / network plumbing as deploy; it is NOT a controller gate.
# This is the demo stand-in for the real funding path (on-chain top-up → issuer mint); see FUNDING.md.
#
#   just mint <account-hex> <amount-minor-units> [currency]
# <account-hex> = 64 hex chars (the 32-byte Ed25519 account pubkey); <amount> = minor units (cents);
# <currency> = u32 currency id (default 0 = DEMO_USD).
#   just mint 8a88e3dd…40f6f5c 5000            # credits $50.00 DEMO_USD
#   just mint 8a88e3dd…40f6f5c 5000 1           # credits 5000 units of currency 1
#
# Env (fall back to deploy/.env): DPAY_DFX_IDENTITY, DPAY_CANISTER_ID, DPAY_DFX_NETWORK
# (default ic — set `local` to hit a local replica).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/dfx/bin:$PATH"
# shellcheck source=deploy/env-lib.sh
source deploy/env-lib.sh

ACCT="${1:-}"
AMOUNT="${2:-}"
CURRENCY="${3:-0}"
[[ "$ACCT" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "usage: just mint <64-hex-account> <amount-minor-units> [currency]" >&2; exit 1; }
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || { echo "amount must be a whole number of minor units (cents), got '$AMOUNT'" >&2; exit 1; }
[[ "$CURRENCY" =~ ^[0-9]+$ ]] || { echo "currency must be a non-negative integer (u32), got '$CURRENCY'" >&2; exit 1; }

IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
CID="${DPAY_CANISTER_ID:-$(env_get DPAY_CANISTER_ID deploy/.env)}"
NETWORK="${DPAY_DFX_NETWORK:-ic}"
[ -n "$IDENT" ] || { echo "DPAY_DFX_IDENTITY unset (deploy/.env)" >&2; exit 1; }
[ -n "$CID" ]   || { echo "DPAY_CANISTER_ID unset (deploy/.env)" >&2; exit 1; }
command -v dfx >/dev/null 2>&1 || { echo "dfx not found on PATH" >&2; exit 1; }

# 32-byte hex → candid blob escapes (one \xx per byte). sed (not ${//}): needs a per-pair backreference.
# shellcheck disable=SC2001
BLOB="$(sed 's/\(..\)/\\\1/g' <<<"$ACCT")"

echo "== mint $AMOUNT (minor units) of currency $CURRENCY to $ACCT on $NETWORK =="
dfx --identity "$IDENT" canister call "$CID" mint "(blob \"$BLOB\", $CURRENCY : nat32, $AMOUNT : nat64)" --network "$NETWORK"
