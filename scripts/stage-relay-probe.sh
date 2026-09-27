#!/usr/bin/env bash
# Stage the relay THIS TREE builds and run the strict Solana probe against it.
#
# The probe's question is "does the build being shipped serve a working Solana rail" — a
# question about CODE + deploy config, never about deploy state. Probing PRODUCTION coupled
# every build to whatever was last deployed, which deadlocked the first R2 ship (`just apk`
# needed the new relay live; `just up` embeds the apk — docs/OPS.md §3), and probed the WRONG
# relay in steady state too (the old one). So the shipping paths stage the tree's own relay on
# loopback, hand it the same provider endpoint the deploy env carries, and probe THAT:
# the verdict covers the relay code + the key + the upstream, on every build, cutover or not.
#
# Called by scripts/build-apk.sh and deploy/build.sh. The probe itself is unchanged
# (scripts/check-prod-sol.mjs, strict mode) — only its target moved.
#
# The provider endpoint (SECRET — never echoed here) resolves from DPAY_SOLANA_RPC_URL in the
# environment, else the DPAY_SOLANA_RPC_URL= line in deploy/.env. Absent is a failed build: the
# relay about to ship would answer 503 solana-unconfigured and every wallet pointing at it
# would carry a dark Solana rail.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

RPC_URL="${DPAY_SOLANA_RPC_URL:-}"
if [ -z "$RPC_URL" ]; then
  # deploy/.env is generated — refresh from its sources first (fails closed when sops is unusable).
  bash "$ROOT/scripts/gen-deploy-env.sh" -q
  # `|| true`: grep exits 1 when the line is absent, and under pipefail that must mean
  # "empty, fall through to the loud failure below", not a silent early exit.
  RPC_URL="$(grep -E '^DPAY_SOLANA_RPC_URL=' deploy/.env | tail -1 | cut -d= -f2- || true)"
fi
if [ -z "$RPC_URL" ]; then
  echo "FAIL: no DPAY_SOLANA_RPC_URL (environment or secrets/deploy.sops.json)." >&2
  echo "       The relay this build ships proxies every Solana read through that endpoint" >&2
  echo "       (full provider URL incl. api key); without it the" >&2
  echo "       rail it serves is dark. Add it: sops secrets/deploy.sops.json, then just deploy-env." >&2
  exit 1
fi

# The probe binary embeds the web wallet (crates/dpay-relay/build.rs panics without it). The
# wallet bytes are irrelevant to this probe — any existing dist answers — so build it only
# when absent, exactly the way deploy/build.sh does.
if [ ! -f e2e/dist-prod/wallet.html ]; then
  echo "== e2e/dist-prod missing — one-off web build (the relay binary embeds it) =="
  ( cd e2e && \
    { [ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps; } && \
    node node_modules/vite/bin/vite.js build --mode web-prod )
fi

export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$PATH"

echo "== build the relay from this tree (debug — the probe target) =="
cargo build -q -p dpay-relay
BIN="$ROOT/target/debug/dpay-relay"
[ -x "$BIN" ] || { echo "FAIL: no relay binary at $BIN" >&2; exit 1; }

# Bind loopback on one of a few ports; the relay exits on a bind clash, so try the next.
LOG="$(mktemp)"
RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT
PORT=""
for candidate in 38787 38893 38971 39051; do
  RELAY_PID=""
  DPAY_RELAY_ADDR="127.0.0.1:$candidate" DPAY_SOLANA_RPC_URL="$RPC_URL" "$BIN" >"$LOG" 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 100); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$candidate/api/v1/version" >/dev/null 2>&1; then
      PORT="$candidate"; break
    fi
    kill -0 "$RELAY_PID" 2>/dev/null || break   # relay died (bind clash) — next port
    sleep 0.1
  done
  [ -n "$PORT" ] && break
  RELAY_PID=""
done
if [ -z "$PORT" ]; then
  echo "FAIL: could not stage the relay on loopback. Its last words:" >&2
  tail -5 "$LOG" >&2
  exit 1
fi

echo "== strict Solana probe against the staged relay (127.0.0.1:$PORT, built from this tree) =="
DPAY_RELAY_BASE="http://127.0.0.1:$PORT" node scripts/check-prod-sol.mjs
