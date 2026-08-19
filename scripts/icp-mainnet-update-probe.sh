#!/usr/bin/env bash
# OPT-IN mainnet UPDATE probe for the user-principal IC rail — NOT part of check/verify.
#
# Network IS required (https://icp-api.io). STATE-CHANGING but confined to dpay's OWN canisters:
# the facade (ssqti-wiaaa-aaaab-qhdia-cai) and the DUSD play-money ledger
# (td2nx-oaaaa-aaaab-qhdnq-cai, fee 0, decimals 2). NEVER any DFINITY-operated canister
# (ckBTC/ckUSDC/ckETH ledgers or minters) — the ids are hard constants in tests/mainnet_update.rs
# with no env override. Throwaway FIXED-SEED ed25519 keys only; amounts are cents of play money.
#
# What this proves (tests/mainnet_update.rs, gate DPAY_IC_MAINNET=1 + DPAY_IC_MAINNET_UPDATE=1):
#   phase 1 (cheapest possible abort): bad-signature UPDATE control → 4xx.
#   phase 2: user-principal signed UPDATEs (POST /api/v2/canister/<id>/call) with the FULL
#     read_state lifecycle on mainnet — facade faucet (real ledger state change + IDENTICAL-bytes
#     REPLAY dedup observation), DUSD icrc1_transfer P1→P2 (decoded InsufficientFunds — P1 is
#     unfunded by design: no operator hook can fund a user principal, see the test module docs),
#     DUSD icrc2_approve (self-contained real Ok(block_index) at fee 0), and the benign
#     facade init_receipt_key bronze proof.
# Run via `just ic-mainnet-update-probe` (explicit opt-in; never wired into check).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

# Phase 1 — the control ALONE: if the ingress does not 4xx a corrupted-signature update,
# abort before submitting any valid update anywhere.
DPAY_IC_MAINNET=1 DPAY_IC_MAINNET_UPDATE=1 cargo nextest run -p dpay-icp-e2e -E 'binary(mainnet_update) & test(bad_signature)'

# Phase 2 — the full battery, serial + no-capture (the transcript is the deliverable; the control
# re-runs first, harmlessly — one more rejected POST).
DPAY_IC_MAINNET=1 DPAY_IC_MAINNET_UPDATE=1 cargo nextest run -p dpay-icp-e2e -E 'binary(mainnet_update)' --no-capture
echo "PASS: icp-mainnet-update-probe — user-principal signed UPDATEs accepted by https://icp-api.io (facade ssqti + DUSD ledger td2nx), full read_state lifecycle + replay dedup observed"
