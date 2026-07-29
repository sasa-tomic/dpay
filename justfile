# dpay dev loop — fully offline, seconds. Run `just` to list recipes.
# Toolchain, PocketIC server, Node, and caches all live in-project (see CLAUDE.md).

set shell := ["bash", "-uc"]

root := justfile_directory()
export CARGO_HOME := root / ".dev/cargo"
export RUSTUP_HOME := root / ".dev/rustup"
export PATH := (root / ".dev/cargo/bin") + ":" + (root / ".dev/node/bin") + ":" + env_var('PATH')
export POCKET_IC_BIN := root / "third_party/bin/pocket-ic"
export DPAY_CANISTER_WASM := root / "target/wasm32-unknown-unknown/release/dpay_canister.wasm"

# list recipes
default:
    @just --list

# core unit + property tests (native, sub-second)
test-core:
    cargo nextest run -p dpay-core --features rng

# build the canister to wasm (release)
build-canister:
    cargo build -p dpay-canister --target wasm32-unknown-unknown --release

# canister settlement tests on PocketIC (offline, deterministic). The facade settles on the REAL
# DFINITY ic-icrc1-ledger (cached in third_party/ic-icrc1-ledger/); multi-ledger proof incl. the
# double-spend concurrency regression. Fully offline.
test-canister: build-canister
    cargo nextest run -p dpay-canister-tests

# MAINNET deploy of the facade canister (ssqti) into the LIVE ic-icrc1-ledger on the IC `ic` network.
# Spends REAL cycles + moves REAL state on mainnet; self-asserting end-to-end (register ledger ->
# mint -> settle -> replay-refused -> balance check, reading balances DIRECTLY off the ledger). Read
# scripts/dfx-deploy-icrc-mainnet.sh before running. See CODEBASE_ANALYSIS.md.
icrc-deploy-mainnet:
    bash scripts/dfx-deploy-icrc-mainnet.sh

# relay tests (native, in-memory FakeLedger — no network)
test-relay:
    cargo nextest run -p dpay-relay

# headless UI: build screens, screenshot with system chromium, visual-diff (offline)
ui:
    cd ui && npm run ui

# narrated end-to-end demo: offline sign -> canister -> Paid (self-checking)
sim: build-canister
    cargo run -q -p dpay-sim

# relay <-> real canister over ic-agent against a live local IC (offline); feature-gated
test-live:
    CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo build -p dpay-canister --target wasm32-unknown-unknown --release
    DPAY_CANISTER_WASM="{{root}}/.dev/target-relay/wasm32-unknown-unknown/release/dpay_canister.wasm" CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo nextest run -p dpay-relay --features agent

# UniFFI shared-core binding: build host lib, generate bindings, run the language roundtrip test
ffi:
    bash crates/dpay-ffi/verify.sh

# outer-loop gate: real dfx replica deploy + settle the offline-signed wire via `dfx canister call`
deploy:
    bash scripts/dfx-deploy.sh

# deploy/upgrade the canister to ICP MAINNET as DPAY_DFX_IDENTITY (becomes controller); writes
# DPAY_CANISTER_ID into deploy/.env. Redeploy defaults to upgrade (state preserved). See deploy/README.md
deploy-ic:
    bash scripts/dfx-deploy-ic.sh

# operator hook: mint (credit) minor units to an account (controller-only). `just mint <64-hex-account> <cents>`
mint account amount currency='0':
    bash scripts/mint.sh {{account}} {{amount}} {{currency}}

# the native Rust inner loop — core + canister + relay
check: test-core test-canister test-relay
    @echo "rust inner loop green"

# everything: rust loop + headless UI
verify: check ui
    @echo "full inner loop green"

# cross-compile dpay-ffi to Android .so for arm64-v8a + x86_64 (NDK)
ndk:
    bash scripts/ndk-build-ffi.sh

# device gate: run the shared core on the booted emulator/device (instrumented test)
ondevice:
    bash scripts/android-ondevice.sh

# build + run the React Native app on the emulator/device; assert it signed via dpay-core
app:
    bash scripts/rn-run.sh

# build a downloadable release APK (no device needed) + stage it to deploy/dist/dpay.apk for the relay
apk:
    bash scripts/build-apk.sh

# live demo: dfx replica + canister + relay + merchant terminal (Ctrl-C to stop). Open the printed URL.
demo:
    bash scripts/demo.sh

# build the relay container image (host-built binary --features agent -> slim runtime; verified)
image:
    bash deploy/build.sh

# provision the Cloudflare Tunnel headlessly (creates tunnel + DNS, writes CF_TUNNEL_TOKEN to deploy/.env)
# needs CF_API_TOKEN + DPAY_PUBLIC_HOSTNAME in the environment; see deploy/README.md
tunnel-provision:
    bash deploy/tunnel-provision.sh

# tear down the Cloudflare Tunnel + DNS this project created (inverse of tunnel-provision)
tunnel-destroy:
    bash deploy/tunnel-destroy.sh

# bring the relay + cloudflared tunnel up with docker compose (reads deploy/.env; see deploy/README.md)
up: image
    #!/usr/bin/env bash
    set -euo pipefail
    cd deploy
    # Fail before Compose interpolation if the remotely managed tunnel token is absent.
    if ! grep -Eq '^CF_TUNNEL_TOKEN=.+$' .env 2>/dev/null; then
      echo "missing CF_TUNNEL_TOKEN in deploy/.env — run 'just tunnel-provision' (headless), or copy the token from the Cloudflare dashboard (deploy/README.md)." >&2
      exit 1
    fi
    docker compose up -d && docker compose ps
    sleep 1
    curl -sS https://dpay.kalaj.org/api/v1/health

# tear the compose stack down
compose-down:
    cd deploy && docker compose down

alias down := stop

# stop every local dev background process: relay, dfx replica, PocketIC server, Android emulator, Metro, Gradle daemon
stop:
    #!/usr/bin/env bash
    # Best-effort + idempotent: each step is guarded and never fails the recipe, so it's safe to
    # run anytime to get back to a clean slate (nothing of ours left listening or holding /dev/kvm).
    set -uo pipefail
    export PATH="$HOME/.local/share/dfx/bin:$HOME/Android/Sdk/platform-tools:$PATH"
    echo "stopping dpay dev background processes…"

    # relay (LAN settle service) — `just demo` or a manual `cargo run -p dpay-relay`. Frees port 8787.
    if pkill -f 'dpay-relay' 2>/dev/null; then echo "  ✓ relay stopped"; else echo "  · relay: none"; fi

    # dfx local replica and everything it manages (replica, canister_sandbox, icx-proxy, pocket-ic).
    if command -v dfx >/dev/null 2>&1; then
      dfx stop >/dev/null 2>&1 || true
      dfx killall >/dev/null 2>&1 || true
      echo "  ✓ dfx replica stopped"
    else
      echo "  · dfx: not found (skipped)"
    fi

    # A PocketIC server left over from canister/relay tests (the in-project server binary).
    if pkill -f 'bin/pocket-ic' 2>/dev/null; then echo "  ✓ PocketIC server stopped"; else echo "  · PocketIC: none"; fi

    # Metro / React Native packager on port 8081, if one was started (`npm start`).
    if pkill -f 'react-native/cli.js start' 2>/dev/null || pkill -f 'node .*metro' 2>/dev/null; then
      echo "  ✓ Metro bundler stopped"
    else
      echo "  · Metro: none"
    fi

    # Android emulator(s): power each off cleanly via adb, then stop the adb daemon. A wedged
    # emulator that ignores `emu kill` is caught by the AVD-scoped qemu fallback.
    if command -v adb >/dev/null 2>&1; then
      mapfile -t EMUS < <(adb devices 2>/dev/null | awk '/^emulator-[0-9]+[[:space:]]/{print $1}')
      for e in "${EMUS[@]:-}"; do
        [ -n "$e" ] && adb -s "$e" emu kill >/dev/null 2>&1 && echo "  ✓ emulator $e killed"
      done
      pkill -f 'qemu-system-.*-avd' 2>/dev/null || true
      adb kill-server >/dev/null 2>&1 || true
      [ "${#EMUS[@]}" -eq 0 ] && echo "  · emulator: none"
    else
      echo "  · adb: not found (skipped)"
    fi

    # Long-lived Gradle daemon from `just app` / `just ondevice`.
    if [ -x app/android/gradlew ]; then
      (cd app/android && ./gradlew --stop >/dev/null 2>&1) && echo "  ✓ Gradle daemon stopped" || echo "  · Gradle: none"
    fi

    echo "done."
