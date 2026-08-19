#!/usr/bin/env bash
# OPT-IN mainnet read-only probe for the user-principal IC rail — NOT part of check/verify.
#
# Network IS required (https://icp-api.io). Read-only: signed QUERY calls only — no cycles,
# no state change — from a throwaway fixed-seed key. Two proofs + one negative control:
#   1. DUSD ledger (td2nx-oaaaa-aaaab-qhdnq-cai, ours): icrc1_fee + icrc1_decimals via a
#      signed query → 200 + sane decode (fee < 10^6 base units, decimals == 2 — live-measured;
#      the deployed ledger runs 2, not the 8 an 8-decimals assumption would suggest).
#   2. ckBTC ledger (mxzaz-hqaaa-aaaar-qaada-cai, DFINITY-operated): icrc1_decimals → 8 —
#      proves the envelope works against DFINITY-operated ledgers, not just our own.
#      (NB: both this canister id's form in early drafts and docs/CANISTERS.md carried
#      structurally-invalid base32 lengths; the id above CRC32-verifies — see tests/mainnet.rs.)
#   3. bad-signature control → 4xx (ingress rejects before execution).
# Run via `just ic-mainnet-probe` (explicit opt-in; never wired into check).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

DPAY_IC_MAINNET=1 cargo nextest run -p dpay-icp-e2e mainnet
echo "PASS: icp-mainnet-probe — signed read-only queries accepted by https://icp-api.io (DUSD + ckBTC ledgers)"
