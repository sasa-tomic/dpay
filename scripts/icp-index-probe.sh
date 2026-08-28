#!/usr/bin/env bash
# OPT-IN mainnet read-only smoke for the native ICP index history adapter (U4) — NOT part of
# check/verify.
#
# Network IS required (https://icp-api.io). Read-only: query calls only — no cycles, no state
# change, throwaway fixed-seed key. Two proofs:
#   1. INDEX PIN: ledger_id() on the pinned ICP index (qhbym-qaaaa-aaaaa-aaafq-cai) == the
#      pinned canonical ICP ledger (ryjl3-tyaaa-aaaaa-aaaba-cai) — catches DFINITY re-pointing
#      the index (which would make ledger-principal dispatch read the wrong asset's history).
#   2. ADAPTER SMOKE: one small account-history query through transactions_on_ledger against
#      the REAL index — proves the query shape (account/start/max_results) is accepted and the
#      Candid reply decodes into the TxnRecord contract.
# Run via `just ic-index-probe` (explicit opt-in; never wired into check).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

DPAY_IC_MAINNET=1 cargo nextest run -p dpay-relay --features agent icp_index_mainnet
echo "PASS: icp-index-probe — pinned index fronts the pinned ICP ledger + adapter query OK on https://icp-api.io"
