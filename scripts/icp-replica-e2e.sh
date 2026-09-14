#!/usr/bin/env bash
# Offline dfx-replica e2e for the user-principal IC rail (dpay-icp + dpay-icp-e2e).
#
# dpay-icp-tests proves the hand-rolled envelopes against ONE ingress implementation (the
# PocketIC gateway). This script proves them against a SECOND, independent one: a real
# `dfx start` replica whose /api/v2 at 127.0.0.1:4943 is fronted by the dfx webserver
# (dfx 0.32 → PocketIC backend) — different ingress code agreeing on envelope/signature
# verification and the ingress-expiry window.
#
# Boots a clean ephemeral replica, installs the REAL ic-icrc1-ledger (cached in third_party/)
# with the default dfx identity as minting account, funds the deterministic device principal P1
# (icrc1_transfer from the minting account — the ICRC-1 mint path), then runs the env-gated
# tests in crates/dpay-icp-e2e:
#   signed update icrc1_transfer P1→P2 → 202 → read_state poll → replied → Ok
#   signed query  icrc1_balance_of      → 200 replied, decoded balance > 0
#   bad-signature update                → 4xx
#   expired ingress                     → 4xx
# Fully offline, ~30-60s. Self-asserting (exits non-zero on any mismatch); deterministic
# teardown (dfx stop + port check on exit). Run via `just test-icp-replica`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=deploy/dfx-lib.sh
source deploy/dfx-lib.sh
setup_dfx_env

LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm
[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}

REPLICA_URL=http://127.0.0.1:4943
FUND_E8S=1000000            # 10_000.00 DUSD at decimals=2 — far more than the tests transfer
P1_SEED_HEX=$(printf '01%.0s' $(seq 1 32))   # P1_SEED = [0x01; 32] in crates/dpay-icp-e2e

echo "== start a clean local replica =="
dfx stop >/dev/null 2>&1 || true
dfx start --clean --background >/tmp/dfx-start.log 2>&1
trap 'dfx stop >/dev/null 2>&1 || true' EXIT

echo -n "   waiting for the replica on $REPLICA_URL "
up=no
for _ in $(seq 1 60); do
  # NB: brief C said POST /api/v2/status → 200, but dfx 0.32's webserver answers 405 to POST
  # (allow: GET,HEAD only) — GET is the correct liveness probe here (deviation noted, live-tested).
  if curl -sf -o /dev/null "$REPLICA_URL/api/v2/status"; then up=yes; break; fi
  echo -n "."; sleep 1
done
if [ "$up" = no ]; then
  echo " replica did not come up — last lines of /tmp/dfx-start.log:" >&2
  tail -n 20 /tmp/dfx-start.log >&2
  exit 1
fi
echo " up"

echo "== install the REAL ic-icrc1-ledger (minting account = default dfx identity) =="
dfx canister create icrc_ledger >/dev/null
DFX_PID=$(dfx identity get-principal)
LEDGER_ID=$(dfx canister id icrc_ledger)
echo "   ledger: $LEDGER_ID  (minting account $DFX_PID)"
dfx build icrc_ledger >/dev/null
# Cost-tuned archive_options: trigger_threshold=10M => archives never spawn in a demo/pilot. The
# literal is the SHARED icrc_ledger_init_arg builder (deploy/dfx-lib.sh) — the same record every
# deploy surface installs; only this owner (default identity) + token_name differ here.
dfx canister install icrc_ledger --argument "$(icrc_ledger_init_arg "$DFX_PID" 0 2 DUSD "dpay replica e2e DUSD")"

echo "== fund device principal P1 from the minting account (ICRC-1 mint path) =="
P1_PID=$(cargo run -q -p dpay-icp-e2e --bin dev-principal -- "$P1_SEED_HEX")
echo "   P1: $P1_PID"
# The minting account may transfer tokens it does not hold — this IS the ICRC-1 mint path.
# NB: fee is `opt nat` in this ledger's TransferArg (live-tested: `0 : nat` fails to serialize);
# null is fine — the ledger's transfer_fee is 0 by Init above.
dfx canister call icrc_ledger icrc1_transfer "(record {
  to = record { owner = principal \"$P1_PID\"; subaccount = null };
  fee = null;
  memo = null;
  from_subaccount = null;
  created_at_time = null;
  amount = $FUND_E8S : nat;
})" >/dev/null
BAL=$(dfx canister call icrc_ledger icrc1_balance_of "(record { owner = principal \"$P1_PID\" })" | nat)
[ "$BAL" -eq "$FUND_E8S" ] || { echo "FAIL: P1 balance is $BAL, expected $FUND_E8S" >&2; exit 1; }
echo "   P1 funded: $BAL e8s"

echo "== run the env-gated replica tests =="
DPAY_IC_REPLICA_URL=$REPLICA_URL DPAY_IC_LEDGER_ID=$LEDGER_ID cargo nextest run -p dpay-icp-e2e

echo "== teardown (deterministic — assert no port leak) =="
dfx stop >/dev/null 2>&1 || true
sleep 2
if curl -sf -o /dev/null --max-time 2 "$REPLICA_URL/api/v2/status"; then
  echo "FAIL: $REPLICA_URL still answers after dfx stop — port leak" >&2
  exit 1
fi
trap - EXIT
echo "PASS: icp-replica-e2e — envelopes accepted by the second (dfx webserver) ingress implementation"
