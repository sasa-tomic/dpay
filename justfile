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

# canister settlement tests on PocketIC (offline, deterministic)
test-canister: build-canister
    cargo nextest run -p dpay-canister-tests

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
