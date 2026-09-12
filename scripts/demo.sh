#!/usr/bin/env bash
# `just demo` — bring up the whole merchant side of the live demo with one command.
#
#   dfx replica  →  icrc_ledger + dpay canister (real ledger)  →  relay (settles via ic-agent)  →  merchant terminal
#
# You run this on a laptop. It prints a URL you open in the laptop's browser; that page uses the
# webcam to scan the payer phone's QR (or you paste the code), submits to the relay, and the payment
# settles on the real local replica. Ctrl-C tears everything down.
#
# ONE ledger end to end (F1, 2026-09-12): the relay's catalog names THIS replica's icrc_ledger
# (DPAY_DEMO_LEDGER), the facade's init arg does too (demo_ledger), and the relay's faucet mints
# from the facade-owned minting account on it. The phone points at the replica via the app's
# Settings ▸ Advanced ▸ IC gateway override (F2) — see the PAYER section of the banner.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"

PORT="${DPAY_RELAY_PORT:-8787}"
LEDGER_WASM=third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm
# The demo controller seed — the relay agent's Ed25519 identity for this throwaway replica. NOT
# secret (it only ever gates the faucet on a clean local replica that dies with this script);
# fixed so the banner/phone steps are identical run after run.
DEMO_SEED="$(printf '5a%.0s' $(seq 1 32))"

echo "== build canister wasm + relay (agent) =="
cargo build -q -p dpay-canister --target wasm32-unknown-unknown --release
candid-extractor target/wasm32-unknown-unknown/release/dpay_canister.wasm > dfx/dpay_canister.did
cargo run -q -p dpay-fixture                     # writes dfx/args/* + expect.env (we need CAP)
source dfx/args/expect.env                        # CAP (per_tx_cap) for the facade init arg
CARGO_TARGET_DIR="$ROOT/.dev/target-relay" cargo build -q -p dpay-relay --features agent
RELAY_BIN="$ROOT/.dev/target-relay/debug/dpay-relay"

[ -f "$LEDGER_WASM" ] || {
  echo "ledger wasm not found at $LEDGER_WASM" >&2
  echo "  build it once (online): see ICRC3_INTEGRATION.md 'The ledger wasm: build-from-source'" >&2
  exit 1
}

echo "== start local replica + deploy both canisters =="
killall -q dpay-relay 2>/dev/null || true   # clear a stale relay from a previous run (frees the port)
dfx stop >/dev/null 2>&1 || true
dfx killall || true
dfx start --clean --background
dfx canister create dpay_canister
dfx canister create icrc_ledger
CID="$(dfx canister id dpay_canister)"
LEDGER_ID="$(dfx canister id icrc_ledger)"
# The controller the relay will authenticate as — the SAME seed as DPAY_CONTROLLER_SEED below,
# so the faucet's controller-gated mint passes the canister's admin gate on first try.
RELAY_PID_TEXT="$(DPAY_CONTROLLER_SEED="$DEMO_SEED" "$RELAY_BIN" --print-controller-principal)"

# The REAL ic-icrc1-ledger, minting account owned by the facade (same shape as scripts/dfx-deploy.sh
# and the PocketIC faucet tests — archives never spawn at these thresholds).
dfx build icrc_ledger >/dev/null
dfx canister install icrc_ledger --argument "(variant { Init = record {
  minting_account = record { owner = principal \"$CID\" };
  transfer_fee = 0 : nat;
  decimals = opt (2 : nat8);
  token_symbol = \"DUSD\";
  token_name = \"dpay demo USD\";
  metadata = vec {};
  initial_balances = vec {};
  feature_flags = opt record { icrc2 = true; icrc152 = false };
  archive_options = record {
    num_blocks_to_archive = 10_000 : nat64;
    trigger_threshold = 10_000_000 : nat64;
    controller_id = principal \"$CID\";
  };
  index_principal = null;
} })" >/tmp/dfx-deploy-demo.log 2>&1

# Facade wired to THIS replica's ledger, admin gate locked to the relay identity from birth (the
# tracked dfx/args/init.arg bakes the MAINNET td2nx ledger — F1's root cause — so the init arg is
# built inline instead; the ledger id is only known now).
dfx build dpay_canister >/dev/null
dfx canister install dpay_canister --argument \
  "(record { demo_ledger = principal \"$LEDGER_ID\"; per_tx_cap = ${CAP} : nat64; controller = opt principal \"$RELAY_PID_TEXT\" })" >>/tmp/dfx-deploy-demo.log 2>&1

RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; dfx stop >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "== start relay + web wallet (merchant side = Receive tab; settling on canister $CID) =="
# DPAY_DEMO_LEDGER: the catalog's DEMO row points at THIS replica's icrc_ledger (F1) so faucet,
# balance reads and the phone's signed transfers all hit ONE ledger. DPAY_CONTROLLER_SEED: the
# relay authenticates as the facade's controller (the identity whose principal was baked into the
# init arg above) — without it the agent build refuses the faucet and the phone cannot get funds.
# DPAY_ENABLE_FAUCET is not consulted on the agent build (the seed is the gate); kept unset.
DPAY_LEDGER=ic DPAY_CANISTER_ID="$CID" DPAY_IC_URL="http://127.0.0.1:4943" \
  DPAY_IC_FETCH_ROOT_KEY=true DPAY_DEMO_LEDGER="$LEDGER_ID" DPAY_CONTROLLER_SEED="$DEMO_SEED" \
  DPAY_RELAY_ADDR="0.0.0.0:$PORT" \
  "$RELAY_BIN" &
RELAY_PID=$!

# wait for the terminal to answer
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break || sleep 0.3
done
# The loop above falls through silently after 30 tries — fail loud here instead of printing the
# "demo is up" banner for a relay that never started (the EXIT trap still tears everything down).
curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null || {
  echo "relay did not come up" >&2
  exit 1
}

TSIP="$(tailscale ip -4 2>/dev/null | head -1)"
if [ -n "$TSIP" ]; then TS_URL="http://$TSIP:$PORT"; else TS_URL="http://<this-laptop-tailscale-ip>:$PORT"; fi
cat <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │  dpay live demo is up.                                               │
  └──────────────────────────────────────────────────────────────────────┘

  MERCHANT (this laptop)
    Open  ▶  http://localhost:$PORT/wallet     (localhost is required for the webcam)
    Onboard once, then use the Receive tab: it builds the request QR, polls for
    settlement, and its camera scans the payer's signed QR (offline fallback).

  PAYER (the phone)   —  just app  installs it; two operator settings, once:
    Settings ▸ Advanced ▸ relay list     ▶  $TS_URL
    Settings ▸ Advanced ▸ IC gateway     ▶  http://10.0.2.2:4943   (emulator → this
      laptop's replica; on a physical phone use the laptop's LAN/Tailscale IP).
    Then faucet the wallet (Accounts ▸ the Demo \$ row) — it starts at \$0 and the faucet
    mints \$100 once per wallet (rate-limited by pubkey).

  DEMO
    1. Laptop: enter the amount → "Create request" → a request QR appears.
    2. Phone: scan it → review "Pay \$X to Café Demo" → Approve.
         • ONLINE  → the phone pays directly; the laptop shows Paid ✓ within ~1s.
         • OFFLINE / flaky → after 5s the phone shows a QR; the laptop scans it.
    3. Balance drops on the phone; the payment appears in both "Recent" lists.
    4. Settle the same request twice → nothing settles twice: balances stay put,
       neither "Recent" list gains a row (one envelope settles once).

  Canister $CID, ledger $LEDGER_ID on a local replica.  Ctrl-C to shut it all down.

EOF

wait "$RELAY_PID"
