# dpay dev loop — fully offline, seconds. Run `just` to list recipes.
# Toolchain, PocketIC server, Node, and caches all live in-project (see CLAUDE.md).

set shell := ["bash", "-uc"]

root := justfile_directory()
export CARGO_HOME := root / ".dev/cargo"
export RUSTUP_HOME := root / ".dev/rustup"
export PATH := (root / ".dev/cargo/bin") + ":" + (root / ".dev/node/bin") + ":" + env_var('PATH')
export POCKET_IC_BIN := root / "third_party/bin/pocket-ic"
export DPAY_CANISTER_WASM := root / "target/wasm32-unknown-unknown/release/dpay_canister.wasm"
export DPAY_MOCK_MINTER_WASM := root / "target/wasm32-unknown-unknown/release/dpay_mock_minter.wasm"

# list recipes
default:
    @just --list

# core unit + property tests (native, sub-second)
test-core:
    cargo nextest run -p dpay-core --features rng

# build the canister to wasm (release)
build-canister:
    cargo build -p dpay-canister --target wasm32-unknown-unknown --release

# build the test-only mock ckBTC minter to wasm (release) — never shipped to mainnet
build-mock-minter:
    cargo build -p dpay-mock-minter --target wasm32-unknown-unknown --release

# canister settlement tests on PocketIC (offline, deterministic). The facade settles on the REAL
# DFINITY ic-icrc1-ledger (cached in third_party/ic-icrc1-ledger/); multi-ledger proof incl. the
# double-spend concurrency regression. Fully offline.
test-canister: build-canister build-mock-minter
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

# relay's test-helpers-gated tests (the deposit-seed route; OFF in the prod image — `just image` never enables it)
test-relay-test-helpers:
    cargo nextest run -p dpay-relay --features test-helpers

# emit the wire-layout JSON (single source of truth for the JS ed25519 signing shim) from the real Rust core
wire-layout:
    cargo run -p dpay-fixture --release -- wire-layout dfx/wire_layout.json

# radical e2e: drive the REAL app (App.tsx via react-native-web) + REAL relay (FakeLedger) + REAL
# browser (chrome-headless-shell), offline + seconds-fast. The inner-loop UI/flow gate — it BOTH
# drives every flow through the real app AND screenshots each state (shots land in e2e/shots/),
# superseding the old parallel-component ui/ harness (removed). Add a flow = add `e2e/tests/NN-name.mjs`.
e2e:
    cd e2e && npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps
    cd e2e && node run.mjs

# production gate: same harness drives the LIVE relay + canister at DPAY_E2E_BASE. Throwaway identities,
# throttled, read-only-ish (never sends real BTC). Honest ceiling until KYC-allowlist lands (see plan §4.3).
e2e-live:
    cd e2e && DPAY_E2E_MODE=live DPAY_E2E_BASE=https://dpay.kalaj.org node run.mjs

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

# OBJECTIVE deploy-fidelity gate: asserts the canister code RUNNING on mainnet is byte-identical to
# the code built from the current source (compares the dfx-built artifact's sha256 to the live module
# hash). Catches a stale WASM shipping while `just check` is green. Exit 1 = stale → `just deploy-ic`.
verify-deploy:
    bash scripts/verify-deploy.sh

# OBJECTIVE deploy-fidelity gate for the RELAY: curls the live `/api/v1/version` and compares its
# baked git commit to `git rev-parse HEAD`. MATCH = current; BEHIND-N / MISMATCH = stale image →
# `just image && just up`. No dfx needed (a plain curl). Override the target via DPAY_RELAY_URL.
verify-relay:
    bash scripts/verify-relay-version.sh

# operator hook: mint (credit) minor units to an account (controller-only). `just mint <64-hex-account> <cents>`
mint account amount currency='0':
    bash scripts/mint.sh {{account}} {{amount}} {{currency}}

# typecheck the RN app — catches bridge arity drift against the TS interfaces (tsc --noEmit, ~2s, no device)
typecheck:
    cd app && npm run typecheck

# bridge parity: assert every TS DpayCoreApi/DpayNfcApi method has a matching-arity Kotlin @ReactMethod
# (and vice-versa). Sub-second, no device — the static net that makes wire/arity drift fail the build.
bridge-parity:
    node scripts/bridge-parity.mjs

# the native Rust inner loop — core + canister + relay
check: test-core test-canister test-relay typecheck bridge-parity
    @echo "rust inner loop green"

# everything: rust loop + radical e2e (real app + real relay + real browser). The e2e harness
# superseded the old ui/ parallel-component golden-shot harness (drives the REAL App.tsx +
# screenshots every flow state), so `ui` is gone and `verify` runs `check e2e`.
verify: check e2e
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

# build + verify signed release APK/AAB; stage the APK to deploy/dist/dpay.apk for the relay
apk:
    bash scripts/build-apk.sh

# verify, build, certificate-check, and upload the signed AAB to Google Play internal testing
play-upload:
    bash scripts/play-upload.sh

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
