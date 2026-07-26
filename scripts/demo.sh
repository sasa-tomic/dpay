#!/usr/bin/env bash
# `just demo` — bring up the whole merchant side of the live demo with one command.
#
#   dfx replica  →  dpay canister (real ledger)  →  relay (settles via ic-agent)  →  merchant terminal
#
# You run this on a laptop. It prints a URL you open in the laptop's browser; that page uses the
# webcam to scan the payer phone's QR (or you paste the code), submits to the relay, and the payment
# settles on the real local replica. Ctrl-C tears everything down.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"

PORT="${DPAY_RELAY_PORT:-8787}"

echo "== build canister wasm + relay (agent) =="
cargo build -q -p dpay-canister --target wasm32-unknown-unknown --release
candid-extractor target/wasm32-unknown-unknown/release/dpay_canister.wasm > dfx/dpay_canister.did
cargo run -q -p dpay-fixture                     # deterministic init args (payer pre-funded $100)
CARGO_TARGET_DIR="$ROOT/.dev/target-relay" cargo build -q -p dpay-relay --features agent
RELAY_BIN="$ROOT/.dev/target-relay/debug/dpay-relay"

echo "== start local replica + deploy canister =="
killall -q dpay-relay 2>/dev/null || true   # clear a stale relay from a previous run (frees the port)
dfx stop >/dev/null 2>&1 || true
dfx killall || true
dfx start --clean --background
dfx deploy dpay_canister --argument-file dfx/args/init.arg >/tmp/dfx-deploy-demo.log 2>&1
CID="$(dfx canister id dpay_canister)"

RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; dfx stop >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "== start relay + merchant terminal (settling on canister $CID) =="
# DPAY_ENABLE_FAUCET: the demo funds a freshly-generated phone account via POST /faucet, which
# mints. It's off by default on the real-ledger path (an exposed faucet is an open money printer);
# this is a throwaway local replica, so turn it on explicitly.
DPAY_LEDGER=ic DPAY_CANISTER_ID="$CID" DPAY_IC_URL="http://127.0.0.1:4943" \
  DPAY_IC_FETCH_ROOT_KEY=true DPAY_ENABLE_FAUCET=true DPAY_RELAY_ADDR="0.0.0.0:$PORT" \
  "$RELAY_BIN" &
RELAY_PID=$!

# wait for the terminal to answer
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break || sleep 0.3
done

TSIP="$(tailscale ip -4 2>/dev/null | head -1)"
if [ -n "$TSIP" ]; then TS_URL="http://$TSIP:$PORT"; else TS_URL="http://<this-laptop-tailscale-ip>:$PORT"; fi
cat <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │  dpay live demo is up.                                                 │
  └──────────────────────────────────────────────────────────────────────┘

  MERCHANT (this laptop)
    Open  ▶  http://localhost:$PORT/merchant     (localhost is required for the webcam)

  PAYER (the phone)   —  just app  installs it (ledger URL baked to Tailscale)
    The wallet opens as "You" with \$100.00. It reaches the ledger over Tailscale
    at $TS_URL — set that in the app's "ledger" field if needed.

  DEMO
    1. Laptop: enter the amount → "Create request" → a request QR appears.
    2. Phone: scan it → review "Pay \$X to Café Demo" → Approve.
         • ONLINE  → the phone pays directly; the laptop shows Paid ✓ within ~1s.
         • OFFLINE / flaky → after 5s the phone shows a QR; the laptop scans it.
    3. Balance drops on the phone; the payment appears in both "Recent" lists.
    4. Settle the same request twice → "Already paid — not charged twice".

  Canister $CID on a local replica.  Ctrl-C to shut it all down.

EOF

wait "$RELAY_PID"
