#!/usr/bin/env bash
# e2e/live-relay.sh — start the LOCAL MAINNET relay (DPAY_LEDGER=ic) with the SideShift
# partner credentials decrypted from sops at process start (never written to disk, never
# echoed). The xff proxy (e2e/live-xff-proxy.mjs) fronts this for CeFi ops.
set -euo pipefail
cd "$(dirname "$0")/.."
export SOPS_AGE_KEY_FILE=.dev/age/agent-key.txt
CREDS="$(sops -d secrets/sideshift.sops.json)"
export DPAY_SIDESHIFT_AFFILIATE_ID="$(node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!c.account_id||!c.secret) process.exit(3); console.log(c.account_id)' <<<"$CREDS")"
export DPAY_SIDESHIFT_SECRET="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).secret)' <<<"$CREDS")"
unset CREDS
export DPAY_LEDGER=ic DPAY_CANISTER_ID=ssqti-wiaaa-aaaab-qhdia-cai DPAY_IC_URL=https://icp-api.io
export DPAY_RELAY_ADDR=127.0.0.1:8899
# SOL RPC proxy — without this the relay answers /api/v1/solana/rpc 503 and every device-side
# submit/balance read on the SOL rail dies (found live 2026-09-20: c1 submit parked
# convert-stuck, nothing on-chain). The app derives its RPC list from the relay bases.
export DPAY_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
exec ./target/debug/dpay-relay
