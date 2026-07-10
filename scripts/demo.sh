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
dfx start --clean --background >/tmp/dfx-demo.log 2>&1
dfx deploy dpay_canister --argument-file dfx/args/init.arg >/tmp/dfx-deploy-demo.log 2>&1
CID="$(dfx canister id dpay_canister)"

RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; dfx stop >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "== start relay + merchant terminal (settling on canister $CID) =="
DPAY_CANISTER_ID="$CID" DPAY_IC_URL="http://127.0.0.1:4943" DPAY_RELAY_ADDR="0.0.0.0:$PORT" \
  "$RELAY_BIN" &
RELAY_PID=$!

# wait for the terminal to answer
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break || sleep 0.3
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │  dpay live demo is up.                                                 │
  └──────────────────────────────────────────────────────────────────────┘

  MERCHANT (this laptop)
    Open  ▶  http://localhost:$PORT/
    (use *localhost* on the laptop running this — browsers only allow the
     webcam on localhost/https. ${LAN_IP:+LAN: http://$LAN_IP:$PORT/ — paste-only, no camera})

  PAYER (the phone)
    In another terminal:  just app
    The dpay app opens as "You" pre-funded with \$100.00. Airplane mode is fine —
    the phone only scans a QR and signs; it never touches the network.

  DEMO — two scans (about 30 seconds)
    1. Laptop: enter the amount → "Create request" → a request QR appears.
    2. Phone: "Scan to pay" → point at the laptop's QR → review "Pay \$X to Café Demo"
       → Approve. The phone signs offline and shows a signed QR.
    3. Laptop (step 2 · Collect): the camera scans the phone's QR → Paid ✓, balance drops.
    4. Try to settle the same request twice → "Already paid — not charged twice".

  Canister $CID on a local replica.  Ctrl-C to shut it all down.

EOF

wait "$RELAY_PID"
