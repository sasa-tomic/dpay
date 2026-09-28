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
# nextest's per-test libtest-json output (the $DPAY_TESTRUNS_TIMING feed) is experimental-gated
export NEXTEST_EXPERIMENTAL_LIBTEST_JSON := "1"

# list recipes
default:
    @just --list

# core unit + property tests (native, sub-second). dpay-fixture rides along because its tests ARE
# the core's golden drift alarms: each rebuilds a signing layout (pay / withdraw / receipt /
# checkout-open) from the emitted offsets ALONE and asserts the core still produces those exact bytes,
# and the checkout-open one additionally compares the COMMITTED dfx/checkout_open_signing.json against what
# today's core emits. They were previously on no recipe at all, so that drift could land green.
test-core:
    python3 scripts/testruns.py run test-core --sh 'cargo nextest run -p dpay-core --features rng --message-format libtest-json > "${DPAY_TESTRUNS_TIMING:-/dev/null}" && cargo nextest run -p dpay-fixture --message-format libtest-json >> "${DPAY_TESTRUNS_TIMING:-/dev/null}"'

# build the canister to wasm (release)
build-canister:
    cargo build -p dpay-canister --target wasm32-unknown-unknown --release

# build the test-only mock ckBTC minter to wasm (release) — never shipped to mainnet
build-mock-minter:
    cargo build -p dpay-mock-minter --target wasm32-unknown-unknown --release

# third_party/ is the gitignored local cache (see AGENTS.md). Exactly TWO entries are load-bearing —
# recipes, tests, and deploys read them at run time; every other entry is a research clone nothing
# ever reads:
#   third_party/bin/pocket-ic                       the PocketIC server (POCKET_IC_BIN; must match the
#                                                   `pocket-ic` crate pin in Cargo.toml)
#   third_party/ic-icrc1-ledger/{ic-icrc1-ledger.wasm,ledger.did}
#                                                   the REAL DFINITY ICRC-1 ledger installed by the
#                                                   canister/icp/relay-live tests, dfx.json, deploy scripts
# third_party/ is gitignored, so a fresh WORKTREE lacks both. The preflight below fails LOUD with the
# one-liner fix instead of a `cannot read ledger wasm` panic or a mold linker error mid-`just verify`.
third-party-check:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    for p in third_party/bin/pocket-ic third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm; do
      [ -e "$p" ] || { echo "third_party/ is missing $p — run: just third-party"; exit 1; }
    done

# repair third_party/'s load-bearing artifacts from any sibling checkout (../dpay-*). The reference
# caches (ic-js, oisy-wallet, wallet-core, ...) are NOT repaired — no recipe reads them.
third-party:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    ok=1
    for p in third_party/bin/pocket-ic third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm third_party/ic-icrc1-ledger/ledger.did; do
      if [ -e "$p" ]; then continue; fi
      src="$(ls -d ../*/"$p" 2>/dev/null | head -n1 || true)"
      if [ -n "$src" ]; then
        echo "repairing $p from $src"
        mkdir -p "$(dirname "$p")"
        cp -a --reflink=always "$src" "$p" 2>/dev/null || cp -a "$src" "$p"
      else
        echo "MISSING $p — no sibling checkout has it."
        echo "Copy it from any existing dpay checkout: pocket-ic must match the"
        echo "pocket-ic crate pin in Cargo.toml; the ledger is DFINITY's"
        echo "ic-icrc1-ledger wasm plus ledger.did."
        ok=0
      fi
    done
    [ "$ok" = 1 ] && echo "third_party load-bearing artifacts present."

# canister settlement tests on PocketIC (offline, deterministic). The facade settles on the REAL
# DFINITY ic-icrc1-ledger (cached in third_party/ic-icrc1-ledger/); multi-ledger proof incl. the
# double-spend concurrency regression. Fully offline.
test-canister: third-party-check build-canister build-mock-minter
    python3 scripts/testruns.py run test-canister --sh 'cargo nextest run -p dpay-canister-tests --message-format libtest-json > "${DPAY_TESTRUNS_TIMING:-/dev/null}"'
    @just pocketic-cleanup

# user-principal rail tests on PocketIC's make_live() gateway (offline, deterministic, seconds):
# raw-ed25519 device keys whose self-authenticating principals hold funds DIRECTLY on the REAL
# ic-icrc1-ledger move them via dpay-icp-signed envelopes over the real /api/v2 ingress — the
# PRODUCTION ic_validator checks every signature/expiry (bad sig → 400, expired → 400, replay
# deduped). Proves the user_transfer / offramp approve→retrieve legs + the principal derivation
# the app will use on mainnet, with envelope-only auth (funding is PocketIC-API scaffolding).
# ALSO runs the dpay-icp wire-contract goldens (byte-parity vs the cached production crates —
# seconds-fast, was previously on no recipe) and the dpay-wasm host tests (icp goldens).
test-icp: third-party-check build-mock-minter
    python3 scripts/testruns.py run test-icp --sh 'cargo nextest run -p dpay-icp --message-format libtest-json > "${DPAY_TESTRUNS_TIMING:-/dev/null}" && cargo nextest run -p dpay-wasm --message-format libtest-json >> "${DPAY_TESTRUNS_TIMING:-/dev/null}" && cargo nextest run -p dpay-icp-tests --message-format libtest-json >> "${DPAY_TESTRUNS_TIMING:-/dev/null}"'
    @just pocketic-cleanup

# PocketIC servers survive their test processes (nextest tags every PocketIC-suite test LEAK) and
# spin CPU while idle — two leaked servers at ~11 combined cores sat under `just verify`'s e2e
# phase and timeout-flaked healthy flows (the documented "Pocket-IC load flake" class). Kill them
# after every PocketIC suite so a composite run cannot poison its own later phases. Never fails:
# pkill exits 1 when nothing matched, which is the common case.
pocketic-cleanup:
    @if pkill -f 'bin/pocket-[i]c' 2>/dev/null; then echo "  ✓ leaked PocketIC server stopped"; else echo "  · PocketIC: none leaked"; fi

# relay DEFAULT-features compile gate: `cargo check -p dpay-relay` with no features. Every other
# recipe compiles the relay WITH a feature (test-relay: test-helpers; test-live: agent+test-helpers),
# and `--all-targets` is no substitute — the crate's dev-dependency on itself enables test-helpers
# for test units, so feature unification hides the lean build even under `--all-targets` with no
# `--features`. The lean build is REAL (scripts/stage-relay-probe.sh — the `just apk` probe —
# builds exactly this config), and a cfg hole in it sailed through every existing gate until
# 2026-09-11 (multi-venue fallback `fixture_venue_armed` referenced `catalog::VenueEntry` under
# default features → E0425; `just apk` was the only surface that found it). Depends on `web` for
# the same reason test-relay does: dpay-relay's build.rs embeds e2e/dist-prod and fails loud
# without it (just runs a recipe once per invocation, so `check` still builds it once).
# Warm cost ~1s: deps are shared with test-relay; only the relay crate's lean fingerprint is new.
relay-default-check: web
    python3 scripts/testruns.py run relay-default-check --sh 'cargo check -p dpay-relay'

# relay tests (native, in-memory — no network). `test-helpers` also compiles the fake-IC /api/v2
# gateway the e2e web harness points the app at (the seam is e2e-build-only — see shims.ts).
# Depends on `web`: dpay-relay's build.rs embeds e2e/dist-prod (the /wallet route serves the real
# app from it) and FAILS LOUD when it's missing — this dependency keeps every relay build honest.
test-relay: web
    python3 scripts/testruns.py run test-relay --sh 'cargo nextest run -p dpay-relay --features test-helpers --message-format libtest-json > "${DPAY_TESTRUNS_TIMING:-/dev/null}"'

# stage the local EVM rail (D26): a SCRATCH anvil (chain 31337, offline, 1s blocks), the COMMITTED
# MockZCHF blob (e2e/harness/evm/MockZCHF.hex) deployed with a raw signed type-2 tx — no forge/solc
# at runtime — and the DEVICE-derived EVM key funded (gas via anvil_setBalance + ZCHF from the
# deployer). Prints the config JSON and writes e2e/harness/evm/anvil.json for the flows; the chain
# stays RUNNING (detached; logs → anvil.log). Idempotent: a re-run replaces the previous instance
# on a fresh chain. Port collision (8545 held by something else): fail loud — pass another port:
#   just evm-anvil 8645     (or DPAY_EVM_ANVIL_PORT=8645)
evm-anvil port='':
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    [ -d e2e/node_modules ] || npm --prefix e2e install --prefer-offline --no-audit --no-fund --legacy-peer-deps
    p="{{port}}"
    [ -n "$p" ] || p="${DPAY_EVM_ANVIL_PORT:-8545}"
    exec env DPAY_EVM_ANVIL_PORT="$p" node e2e/harness/evm/anvil.mjs

# emit the committed core goldens from the real Rust core: the wire layout (single source of truth
# for the JS ed25519 signing shim) and the checkout-open signing document (the merchant's charge-open proof,
# read by scripts/check-wasm-core.mjs). `just test-core` fails when the checkout-open file is stale.
wire-layout:
    cargo run -p dpay-fixture --release -- wire-layout dfx/wire_layout.json
    cargo run -p dpay-fixture --release -- checkout-open dfx/checkout_open_signing.json

# chrome flow tier — the 9 KEEP-BROWSER visual/PWA flows and NOTHING else (FLOWS.md is the
# canonical list): screenshot capture (35 ux-tour, 39 store-screens), pixel baselines (40
# visual-regression, 84 visual-dark), QR scannability (78 qr-scannable), viewport/layout metrics
# (83 mobile-viewport, 146 money-forms-fit, 158 header-fits), PWA/service-worker boot (151
# offline-web-boot). Every behavioral flow was retired to the jest flow suite (`just flow`,
# app/__tests__/flow/) + the real-chain proofs (`just node-anvil`). Merge-gate activity — never
# part of the dev loop (AGENTS.md test tiers). Runs the DEFAULT enumeration (all 9; no
# meta.optional flows remain). A new behavioral test is a jest flow file, NOT a chrome flow.
e2e:
    python3 scripts/testruns.py run e2e --sh 'cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps) && node run.mjs'

# visual-regression gate (fast iteration on flow 40 alone): re-capture the 5 primary surfaces and
# pixel-diff each vs its committed baseline (e2e/shots/baselines/). Fails on drift >0.5%. Catches the
# exact class of style/layout regression that sails through the testID+textContent net. NOTE:
# flow 40 is one of the 9 flows in `just e2e` (merge gate), so the gate already runs the
# pixel-diff — this standalone recipe re-runs ONLY flow 40 in isolation for fast feedback after a
# UI tweak (no banner, no other flows). On an intentional UI change, regenerate the baselines via
# `just e2e-visual-seed` and commit the new baselines (the diff is reviewable in the commit).
e2e-visual:
    python3 scripts/testruns.py run e2e-visual --sh 'cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps) && DPAY_E2E_FILTER=40-visual-regression node run.mjs'

# regenerate the visual-regression baselines from the current app surfaces (run after an intentional
# UI/style change). Writes e2e/shots/baselines/<surface>.png for each of the 5 surfaces. COMMIT the
# new baselines — they ARE the contract; a future regression diffs against them.
e2e-visual-seed:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && DPAY_E2E_REGEN_BASELINES=1 DPAY_E2E_FILTER=40-visual-regression node run.mjs

# Play Store screenshot capture (flow 39) — an assert(true) render-only contract sweep, NOT a
# behavior gate. It runs inside `just e2e` with the other visual flows; this recipe is its
# dedicated entry point when compositing store assets; the raw captures feed
# `e2e/store-assets/compose.mjs` for marketing compositing.
e2e-store:
    python3 scripts/testruns.py run e2e-store --sh 'cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps) && DPAY_E2E_FILTER=store-screens node run.mjs'

# production gate: same harness drives the LIVE relay + canister at DPAY_E2E_BASE. Throwaway identities,
# throttled, read-only-ish (never sends real BTC). Honest ceiling until KYC-allowlist lands (see plan §4.3).
e2e-live:
    python3 scripts/testruns.py run e2e-live --sh 'cd e2e && DPAY_E2E_MODE=live DPAY_E2E_BASE=https://dpay.kalaj.org node run.mjs'

# LIVE testnet-wiring flow (OPEN_ISSUES #1/#2/#8) — drives a relay at DPAY_E2E_BASE carrying the
# testnet currencies against REAL IC testnet chain-key canisters. Proves the FREE testnet path:
# 3 testnet asset cards, real Testnet4 deposit address, relay deposit/onramp endpoints with the real
# testnet minter config + Sepolia ckERC20 helper. OPT-IN only — NEVER part of verify/check (hits
# mainnet + needs a relay). No real funds (IC testnet tokens are free).
# PROVEN route (prod ssqti; the testnet catalog ships compiled into the relay): run a LOCAL relay from HEAD —
#   DPAY_LEDGER=ic DPAY_CANISTER_ID=ssqti-wiaaa-aaaab-qhdia-cai DPAY_IC_URL=https://icp-api.io \
#   DPAY_RELAY_ADDR=127.0.0.1:8788 cargo run -p dpay-relay --features agent
# — then: DPAY_E2E_BASE=http://127.0.0.1:8788 just e2e-live-testnet
# (Alt: deploy scripts/dfx-deploy-ic-staging.sh for an isolated staging facade.)
e2e-live-testnet:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    node ../e2e-live/run.mjs

# narrated end-to-end demo: offline sign -> canister -> Paid (self-checking)
sim: third-party-check build-canister
    python3 scripts/testruns.py run sim -- cargo run -q -p dpay-sim

# relay <-> real canister over ic-agent against a live local IC (offline); feature-gated.
# Depends on `web`: builds dpay-relay, whose build.rs embeds e2e/dist-prod (fail-loud without it).
# Also builds the mock-minter wasm — the WAVE-5 live test drives TWO mock minters to prove the
# ckERC20 onramp's runtime `get_minter_info` helper read + its logged-constant fallback.
test-live: third-party-check web
    python3 scripts/testruns.py run test-live --sh 'CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo build -p dpay-canister --target wasm32-unknown-unknown --release && CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo build -p dpay-mock-minter --target wasm32-unknown-unknown --release && DPAY_CANISTER_WASM="{{root}}/.dev/target-relay/wasm32-unknown-unknown/release/dpay_canister.wasm" DPAY_MOCK_MINTER_WASM="{{root}}/.dev/target-relay/wasm32-unknown-unknown/release/dpay_mock_minter.wasm" CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo nextest run -p dpay-relay --features agent,test-helpers --message-format libtest-json > "${DPAY_TESTRUNS_TIMING:-/dev/null}"'

# UniFFI shared-core binding: build host lib, generate bindings, run the language roundtrip test
ffi:
    python3 scripts/testruns.py run ffi -- bash crates/dpay-ffi/verify.sh

# outer-loop gate: real dfx replica deploy + settle the offline-signed wire via `dfx canister call`
deploy:
    bash scripts/dfx-deploy.sh

# deploy/upgrade the facade canister to ICP MAINNET as DPAY_DFX_IDENTITY (becomes controller); writes
# DPAY_CANISTER_ID into deploy/.env, arms the internal controller cell with the relay's dedicated
# Ed25519 key, and runs free query readbacks. NO currency registration (registry removed 2026-08-28):
# non-DEMO assets are compile-time FIXED_ASSETS consts, and the catalog the app renders is compiled
# into the relay (adding a currency = relay code change + `just up`). The ONE mainnet deploy path
# (state-preserving upgrade by default). See deploy/README.md + docs/CANISTERS.md.
# Requires a clean tree, and LEAVES one dirty (it re-bakes the tracked pin
# deploy/facade-module-hash.txt), so it prints the record-then-ship steps it hands you to.
# This is step 1 of the prod sequence — the whole of it is docs/OPS.md section 3.
deploy-ic:
    bash scripts/dfx-deploy-ic.sh

# REHEARSE the staging facade deploy OFFLINE against a local replica (mock DUSD ledger, no cycles).
# Proves the provision→install→lock flow + the demo_ledger init-arg shape before any mainnet spend.
# Set DPAY_DFX_NETWORK=ic (omitted) for the REAL mainnet staging deploy — REQUIRES founder greenlight.
deploy-ic-staging:
    DPAY_DFX_NETWORK=local bash scripts/dfx-deploy-ic-staging.sh

# dfx install-arg BYTE parity: run the REAL dfx-deploy.sh + the staging local rehearsal against the
# mock dfx (deploy/tests/mock-dfx.sh) and assert the Candid install arguments they emit are
# byte-identical to the committed captures in deploy/tests/fixtures/ — the net that keeps the shared
# literal builders in deploy/dfx-lib.sh (icrc_ledger_init_arg / facade_init_arg) from changing an
# install argument by one byte (the demo/staging candid-literal fork risk). Offline: dfx mocked,
# cargo real (warm seconds — the same builds `just deploy` does), so it stands alone rather than on
# check/verify. Regen ONLY on an intentional literal change and commit the new fixtures with it
# (like the e2e visual baselines): bash deploy/tests/literal-parity.sh regen.
dfx-arg-parity:
    bash deploy/tests/literal-parity.sh

# OFFLINE dfx-replica proof for the user-principal IC rail (~30-60s): boots a clean replica, installs
# the REAL ic-icrc1-ledger, funds the deterministic device principal P1, and drives the dpay-icp
# signed envelopes through /api/v2 (202 → read_state poll → replied; signed query; bad-sig/expired
# → 4xx). Second INDEPENDENT ingress implementation beyond the PocketIC gateway of test-live.
test-icp-replica:
    python3 scripts/testruns.py run test-icp-replica -- bash scripts/icp-replica-e2e.sh

# OPT-IN mainnet read-only probe (NEEDS NETWORK, never in check/verify): signed queries only —
# no cycles, no state change, throwaway fixed-seed key. Proves the envelope against the real
# https://icp-api.io ingress on the DUSD ledger AND the DFINITY-operated ckBTC ledger, with a
# bad-signature negative control. Asserts DUSD fee < 10^6 base units + decimals == 2
# (live-measured), ckBTC decimals == 8.
ic-mainnet-probe:
    bash scripts/icp-mainnet-probe.sh

# OPT-IN mainnet read-only smoke for the native ICP index history adapter (NEEDS NETWORK,
# never in check/verify): query calls only, no cycles, no state change, throwaway fixed-seed
# key. Proves the pinned index (qhbym) still fronts the pinned canonical ICP ledger (ryjl3)
# via ledger_id(), and runs one account-history query through the new adapter against the
# REAL index (query shape accepted + Candid reply decodes into the TxnRecord contract).
ic-index-probe:
    bash scripts/icp-index-probe.sh

# OPT-IN mainnet read-only TRIPWIRE for the delegated-conversion venues (NEEDS NETWORK, never in
# check/verify): walks EVERY real registry entry, one anonymous `metadata` query per pool,
# asserting its OWN token0/token1/fee still equal `venues[].fixture` in dfx/catalog_truth.json —
# the block the offline fake pools are seeded from (fixture-only entries are skipped: invented
# principals are never probed on mainnet). Free: a query costs nothing, moves nothing, signs
# nothing. `just test-live` is PocketIC and has NO ICPSwap pool in it, so it is structurally
# unable to see a venue fact; on 2026-09-07 that gap let a compiled pair pin sit BACKWARDS
# behind a fully green suite while live production quoted every ICP→VCHF trade at the
# VCHF→ICP rate (~5.9x against the user). Run it after any change to the conversion quote path,
# and whenever the venue itself may have changed.
# SETTLEMENT SLA (2026-09-20): to also measure cefi payout latency, run with
# DPAY_SIDESHIFT_PROBE_SHIFTS=venue_id=shiftId[,…] — real shift ids only (never creates
# orders). One verdict row per venue lands in dfx/venue_health.json; commit + redeploy ships
# the demotion (or clears it) via GET /api/v1/venues row order.
swap-venue-probe:
    DPAY_IC_MAINNET=1 cargo nextest run -p dpay-relay --features agent -E 'binary(swap_venue_mainnet)' --no-capture

# OPT-IN mainnet READ probe (NEEDS NETWORK, keyless, never in check/verify): the D30
# custody-semantics tripwire (docs/specs/2026-09-26-evm-rail-spec.md §6) — for BOTH pinned ZCHF
# deployments (Ethereum + Arbitrum One) it asserts symbol/decimals/balanceOf(0x0) and that
# DOMAIN_SEPARATOR() equals the locally computed MINIMAL permit domain (ERC20PermitLight). A
# mismatch blocks permit signing until app/evm/chains.ts is fixed. Endpoints overridable via
# DPAY_EVM_PROBE_ETH_URL / DPAY_EVM_PROBE_ARB_URL.
evm-probe-mainnet:
    node scripts/evm-probe-zchf-mainnet.mjs

# OPT-IN Arbitrum Sepolia read-only probe (NEEDS NETWORK, keyless, never in check/verify): the
# D29 free-path gate (docs/specs/2026-09-26-evm-rail-spec.md §6) — asserts the truth file pins
# chain 421614 with NO ZCHF (absent by design), the official public RPC answers and the chain
# advances, and the relay halves of the dev-token env-row mechanism (503 evm-unconfigured /
# 404 evm-unknown-chain / the DPAY_EVM_SEPOLIA_TOKEN catalog row + pipe forward when the env
# is engaged). With the env set it also checks the deployed token answers as MockZCHF-shaped
# ERC-20PermitLight (symbol/decimals/MINIMAL permit domain). Endpoint overridable via
# DPAY_EVM_PROBE_ARB_SEPOLIA_URL.
evm-probe-sepolia:
    node scripts/evm-probe-arbitrum-sepolia.mjs

# OPT-IN LIVE Trocador partner probe (NEEDS NETWORK + DPAY_TROCADOR_API_KEY, never in check/verify
# — it makes LIVE key-gated calls to the real venue): GET /coins (the full coin/network vocabulary,
# printed pretty NEXT TO the adapter's pinned codes from crates/dpay-relay/src/trocador.rs
# TROCADOR_ASSETS, MISMATCH = exit 2) + ONE new_rate quote for the registered ICP↔SOL pair (fixed,
# best_only, min_kycrating=A, markup=0, small amount — read-only, commits nothing). This is the
# partner agreement's step (3): re-pin the codes + the trade-status vocabulary BEFORE the first
# real trade — docs/specs/2026-09-22-trocador-partner-agreement.md.
#   DPAY_TROCADOR_API_KEY=… just trocador-probe
trocador-probe:
    node scripts/trocador_live_probe.mjs

# OPT-IN live OpenCryptoPay probe (NEEDS NETWORK, never in check/verify): drives the REAL app
# against the REAL provider's public CHF-1 test checkout and stops at the review, having signed
# nothing. Reads only — a quote costs nothing and commits nothing, and the wallet it drives is a
# throwaway funded by the local relay's faucet, so no real money is reachable. Exists because
# flows 111/112 run against a fail-closed stub: a wrong belief about the provider's payload is
# invisible to them BY CONSTRUCTION, and one such belief made every real checkout unpayable behind a
# fully green suite (review ledger row 16). Run it after any change to the OCP parser or client.
live-ocp:
    node e2e/live-ocp-probe.mjs

# OPT-IN live OpenCryptoPay LEDGER-SELECTION probe (NEEDS NETWORK, never in check/verify): asks the
# REAL provider which ledger it resolves a reported `tx` against, by bracketing which block indexes
# it agrees exist. FREE and commits nothing — every index is fabricated, so no funds move and no
# transfer is claimed. This is the measurement that diagnosed the payment lost on 2026-09-03 (the
# spelling of the reported id, not the `asset` parameter, picks the ledger — findings doc). The rule
# it establishes reached dpay by EMAIL and is in no documentation the provider publishes, so re-run
# this before trusting `ocpIcTxId` after any provider-side change.
ocp-ledger-probe:
    bash e2e/ocp-ledger-probe.sh

# OPT-IN mainnet UPDATE probe (NEEDS NETWORK, never in check/verify): the state-changing twin of
# ic-mainnet-probe — user-principal signed UPDATES (POST /api/v2/canister/<id>/call) with the full
# read_state lifecycle, against OUR OWN canisters ONLY (facade ssqti + DUSD play-money ledger
# td2nx, fee 0; NEVER DFINITY-operated ledgers/minters — hard constants, no env override).
# Throwaway fixed-seed keys; play-money cents. Proves: bad-sig update → 4xx; facade faucet update
# (real ledger state change) + IDENTICAL-envelope REPLAY dedup on mainnet; DUSD icrc1_transfer
# P1→P2 (decoded InsufficientFunds — P1 unfunded by design; no operator hook funds a user
# principal, see tests/mainnet_update.rs module docs); icrc2_approve (self-contained real
# Ok(block_index) at fee 0); benign facade init_receipt_key bronze proof.
ic-mainnet-update-probe:
    bash scripts/icp-mainnet-update-probe.sh


# OBJECTIVE deploy-fidelity gate: asserts the canister code RUNNING on mainnet is byte-identical to
# the code built from the current source (compares the dfx-built artifact's sha256 to the live module
# hash). Catches a stale WASM shipping while `just check` is green. Exit 1 = stale → `just deploy-ic`.
verify-deploy:
    python3 scripts/testruns.py run verify-deploy -- bash scripts/verify-deploy.sh

# OBJECTIVE deploy-fidelity gate for the RELAY: curls the live `/api/v1/version` and compares its
# baked git commit to `git rev-parse HEAD`. MATCH = current; DIRTY / BEHIND-N / MISMATCH = the image
# does not correspond to HEAD → redeploy per docs/OPS.md section 3. No dfx needed (a plain curl).
# Override the target via DPAY_RELAY_URL.
verify-relay:
    python3 scripts/testruns.py run verify-relay -- bash scripts/verify-relay-version.sh

# composite prod-floor gate (replaces the hand-bumped floor): classifies the live relay commit
# vs HEAD exactly like verify-relay (DIRTY first / MATCH / BEHIND-by-N / MISMATCH), then looks up
# which suites scripts/testruns.py recorded as green AT THE LIVE COMMIT — prod is "on the floor"
# iff it runs a clean commit whose --require suite (default: verify) passed on this machine.
# The evidence comes from the automatic annotations every `just` test recipe writes via
# scripts/testruns.py into the gitignored .dev/testruns.db — the ONLY interface to that record
# is the script (agents: never open the DB directly).
floor:
    python3 scripts/testruns.py floor

# per-test timing breakdown of a recorded run: `just timing e2e` prints the slowest flows
# (or tests, for the nextest/jest suites) first, with the run's wall + CPU seconds on top.
# Bare `just timing` lists every recorded suite by wall time. The data is what suites
# write to $DPAY_TESTRUNS_TIMING during testruns.py runs.
timing *args:
    python3 scripts/testruns.py timing {{args}}

# evidence query: which suites recorded at a commit and did they pass — `just report` (HEAD),
# `just report <commit>`, `--json` for machines. Read-only; never reruns anything.
report *args:
    python3 scripts/testruns.py report {{args}}

# OBJECTIVE integrity gate for the FACADE CANISTER: curls the live `/api/v1/integrity` and asserts
# the canister's on-chain module hash matches the PIN the relay image was built with
# (deploy/facade-module-hash.txt — GOVERNANCE row 7). MATCH = the deployed facade is the recorded
# upgrade; MISMATCH = someone upgraded outside the recorded procedure; UNPINNED/UNREACHABLE = the
# check itself cannot run. Deliberately OFF the hot `verify` path — it is a network probe of PROD.
# Override the target via DPAY_RELAY_URL. The changelog this gate polices is docs/UPGRADES.md.
integrity-check:
    python3 scripts/testruns.py run integrity-check -- bash scripts/integrity-check.sh

# operator hook: mint (credit) minor units to an account (controller-only). `just mint <64-hex-account> <cents>`
mint account amount currency='0':
    bash scripts/mint.sh {{account}} {{amount}} {{currency}}

# operator hook (FOUNDER-RUN, needs DPAY_CONTROLLER_SEED): reconcile — walk a currency's recent
# ledger debits and repair any orphaned ones (the trap closer; docs/OPS.md says WHEN + how to read
# the report). `just reconcile` walks every catalog currency; `just reconcile 7` walks just VCHF.
reconcile currency='all':
    bash scripts/reconcile.sh {{currency}}

# faucet WIRING gate: asserts the relay's DPAY_CONTROLLER_SEED, the canister's IC-level
# controllers, and the facade's internal CONTROLLER cell all refer to the deploy identity —
# the three-party agreement the authenticated faucet needs (else every top-up 422s
# "unauthorized: admin ops require the controller principal"). Read-only unless args given:
# `just faucet-verify --mint` additionally POSTs the LIVE relay for a throwaway burner account
# (end-to-end proof; mints fixed play-DUSD to a burner, never a real account). Extra args pass
# through to scripts/faucet-verify.sh (e.g. --relay https://staging.example.com --mint).
faucet-verify *args:
    bash scripts/faucet-verify.sh {{args}}

# smoke tier (spec tmp/jest-flow-migration-spec.md §3): ONLY the files in
# app/__tests__/smoke/manifest.ts, pure node, <=250ms/test (budget wrapper), <=12s total
# (the timeout 20s wrapper is the hard kill). THE iteration gate — seconds-fast forever.
# `just timing smoke` reads the per-test JSON this recipe records. DPAY_SMOKE_TIMING lets
# scripts/smoke-watch.mjs capture the same JSON testruns.py consumes (testruns owns
# DPAY_TESTRUNS_TIMING and deletes its temp file after reading).
smoke:
    python3 scripts/testruns.py run smoke --sh 'cd app && timeout 20s env DPAY_SMOKE=1 npx jest --selectProjects smoke --silent --maxWorkers=4 --json --outputFile="${DPAY_SMOKE_TIMING:-${DPAY_TESTRUNS_TIMING:-/dev/null}}" $(node ../scripts/smoke-files.mjs)'

# smoke budget watchdog: runs `just smoke` once, compares wall + per-test times against the
# budgets, writes tmp/smoke-watch-status.json, exits nonzero with a one-line verdict when over.
# THE alert condition — over budget = a fix agent flattens/merges; never raise the budget.
smoke-watch:
    node scripts/smoke-watch.mjs

# flow suite (ported e2e, full-app jest; spawns the test relay ONCE via globalSetup). Merge-gate
# activity — never part of the dev-loop iteration (AGENTS.md test tiers).
flow:
    python3 scripts/testruns.py run flow --sh 'cd app && npx jest --selectProjects flow --silent --maxWorkers=4 --json --outputFile="${DPAY_TESTRUNS_TIMING:-/dev/null}"'

# real-chain proofs: anvil + relay pipe, NO browser, NO DOM mount (jest project `node-anvil`).
# ONE scratch anvil (31337, 1s blocks) + the REAL test-helpers relay are staged ONCE per run by
# the jest globalSetup (app/jest.node-anvil-setup.js → app/__tests__/node-anvil/stage-child.mjs,
# which reuses e2e/harness/evm/{anvil,pipe}.mjs verbatim and sets the DPAY_EVM_RPC_URL[_31337] /
# DPAY_EVM_ANVIL_TOKEN env itself, so nothing leaks in from the shell). The app's own evm seam
# drives the chain THROUGH the relay pipe (sendErc20 / settleEvmClaim / balance+history polls);
# assertions read REAL anvil state DIRECT as the second source. Teardown is three-layered
# (teardown group-kill → the child's SIGTERM handler → its sync exit SIGKILL backstop, the
# e2e/harness/procs.mjs discipline) with an orphan sweep behind it.
# Warm target < 90s; a FRESH worktree pays the one-time relay build (~70s, same as `just flow`).
node-anvil:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    if [ ! -x "$HOME/.foundry/bin/anvil" ] && [ ! -x third_party/bin/anvil ]; then
      echo "node-anvil: anvil not found — fix (one line): curl -L https://foundry.paradigm.xyz | bash && foundryup" >&2
      exit 1
    fi
    # the staging child imports @noble/* from the e2e workspace (the `just evm-anvil` precedent)
    [ -d e2e/node_modules ] || npm --prefix e2e install --prefer-offline --no-audit --no-fund --legacy-peer-deps
    python3 scripts/testruns.py run node-anvil --sh 'cd app && DPAY_NODE_ANVIL=1 npx jest --selectProjects node-anvil --silent --maxWorkers=1 --json --outputFile="${DPAY_TESTRUNS_TIMING:-/dev/null}"'
    just node-anvil-cleanup

# orphan sweep behind `just node-anvil`: the staging child's three teardown layers make a leaked
# chain structurally rare; this is the pocketic-cleanup precedent (best-effort, never fails).
# Scoped to the scratch 31337 chain shape both this recipe and `just evm-anvil` spawn.
node-anvil-cleanup:
    @if pkill -f 'anvil --host 127\.0\.0\.1 --port .* --chain-id 31337' 2>/dev/null; then echo "  ✓ leaked node-anvil chain stopped"; else echo "  · node-anvil: none leaked"; fi

# typecheck the RN app — catches bridge arity drift against the TS interfaces (tsc --noEmit, ~2s, no device)
typecheck:
    python3 scripts/testruns.py run typecheck --sh 'cd app && npm run typecheck'

# regenerate crates/dpay-relay/assets/palette.css from app/config/palette.ts — the ONE source of
# dpay's colour values. Run it after ANY palette edit; `just test-app` fails until you do
# (app/__tests__/relay-palette.test.ts byte-compares the artifact against the emitter), which is
# what stops the website from shipping a palette the app no longer uses. No bundler: Node imports
# the TypeScript directly.
palette-css:
    node scripts/gen-relay-palette.mjs

# app unit tests (jest) — 1000+ cases driving the real components, hooks, formatters and catalog.
# Wired into `check` because it WASN'T: the suite ran only by hand, so a broken component or a
# regressed formatter passed `just verify` green. Same shape as `typecheck` above.
test-app:
    python3 scripts/testruns.py run test-app --sh 'cd app && npm test -- --json --outputFile="${DPAY_TESTRUNS_TIMING:-/dev/null}"'

# bridge parity: assert every TS DpayCoreApi/DpayNfcApi method has a matching-arity Kotlin @ReactMethod
# (and vice-versa). Sub-second, no device — the static net that makes wire/arity drift fail the build.
bridge-parity:
    python3 scripts/testruns.py run bridge-parity -- node scripts/bridge-parity.mjs

# aid parity: assert each NFC AID's byte literal (Rust const / Kotlin val) is byte-equal to its XML
# <aid-filter> hex. Sub-second, no device — the static net that makes an AID routing drift fail the
# build (a mismatch silently breaks OS tap routing → opaque "not a dpay phone" / SW_NOT_READY).
aid-parity:
    python3 scripts/testruns.py run aid-parity -- node scripts/aid-parity.mjs

# the native Rust inner loop — core + canister + relay. test-live is INCLUDED (not off-path):
# it is offline (PocketIC HTTP gateway) + ~seconds-fast, and exercises the AgentLedger↔real-canister
# path that test-relay's FakeLedger cannot (receipt recovery, TTL balance refresh, currency wiring).
# Keeping it on the hot path closes the gap that once let a fail-closed-cap change break test-live
# silently while `just verify` stayed green (MC2 U1 / OPEN_ISSUES #10 lesson).
# test-icp is INCLUDED for the same reason: the user-principal IC rail e2e (dpay-icp envelopes
# against the real ic-icrc1-ledger over a PocketIC make_live /api/v2 gateway) is offline ~7.5s —
# same class as test-live — so the rail's decoders/goldens can't silently rot either.
# (dfx-replica e2e + mainnet probe stay OFF the hot path: `just test-icp-replica` / `just ic-mainnet-probe`.)
# (wallet-wire is GONE: /wallet is the real app now — its parity IS wasm-core + the e2e suite.)
# (merchant-wire is GONE 2026-08-16: the hand-rolled /merchant page was merged into /wallet — the
#  real app builds requests through its own wasm core, so the hand-rolled-encoder drift class it
#  guarded against no longer has a surface to live on.)
check: test-core test-canister relay-default-check test-relay test-live test-icp typecheck test-app bridge-parity aid-parity wasm-core flows-md convert-matrix
    @python3 scripts/testruns.py record check pass
    @echo "rust inner loop green"

# FLOWS.md is GENERATED from each flow's own `meta` (e2e/harness/meta.mjs is the single reader), so
# the catalog cannot drift from the tests — but only if something checks. This compares the file
# on disk against what the generator produces RIGHT NOW, not against HEAD: an uncommitted flow with
# a correctly-regenerated manifest is fine, a stale manifest is not. Until this existed, an edited
# `verifies`/`covers` with a stale FLOWS.md was caught by nothing.
flows-md:
    @cp FLOWS.md {{justfile_directory()}}/.dev/FLOWS.md.before
    @node e2e/gen-flows-md.mjs >/dev/null
    @diff -u {{justfile_directory()}}/.dev/FLOWS.md.before FLOWS.md \
      || (echo "FLOWS.md was STALE — regenerated above from the flows' own meta; keep the new file." && exit 1)
    @rm -f {{justfile_directory()}}/.dev/FLOWS.md.before

# GENERATED convert-coverage doc (docs/CONVERT_MATRIX.md): every row derived from the venue
# registry the app itself derives from (dfx/catalog_truth.json venues[] + dfx/venue_health.json
# + app/solana/tokens.ts) — never a hand list, never an app input. The --check pass (in `check`)
# fails on a stale or hand-edited doc; app/__tests__/convertMatrix.test.ts pins the same drift
# plus the registry-coverage invariant (every mainnet row reachable in the pickers).
convert-matrix:
    node scripts/gen_convert_matrix.mjs
    node scripts/gen_convert_matrix.mjs --check

# Wasm-core parity: proves the COMMITTED crates/dpay-relay/assets/dpay-core.wasm (the bytes every
# web surface loads) signs/builds byte-identically to the JS oracle — catches a stale or corrupted
# staged artifact even when `just wasm` (which runs this same guard after rebuilding) wasn't run.
wasm-core:
    python3 scripts/testruns.py run wasm-core -- node scripts/check-wasm-core.mjs

# Build the prod WEB build of the REAL app (app/App.tsx via react-native-web) → e2e/dist-prod:
# the dist dpay-relay's build.rs embeds and serves at GET /wallet (+ /assets/*, immutable).
# Gitignored — built here / at image time, never committed. Same wasm-backed DpayCore shim the
# e2e suite exercises; the ONE divergent shim is the camera (real getUserMedia+jsQR vs inject).
# The seam guard FAILS the build if any __DPAY_TEST_* seam leaks into the prod bundle (they are
# mode-gated in e2e/web/shims.ts; `test-relay` depends on this, so `just check` enforces it too).
# This build ALSO emits the offline shell (sw.js + manifest + icon) and brotli-precompresses every
# compressible output — see `dpayWebProdAssets` in e2e/vite.config.js; build.rs refuses a dist
# where a compressible file arrived without its `.br`.
# The bundle derives the Solana RPC endpoint from the relay (R2), so check-prod-sol first asserts
# that invariant — `--no-probe` because this recipe is on the fully-offline inner loop, and the
# live route check needs the network (see that script's header for the two modes).
web:
    node scripts/check-prod-sol.mjs --no-probe
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && node node_modules/vite/bin/vite.js build --mode web-prod
    node scripts/check-web-prod-seams.mjs

# Regenerate e2e/web/fonts/*.woff2 from the APK's own res/font TTFs (the one font source in the
# repo) and PROVE the subset lost no codepoint the app can paint. Off the inner loop — the .woff2
# files are committed, exactly as the .ttf files they replaced were; run this only when the fonts
# or the set of characters the UI can render changes. Needs python3 + fontTools.
fonts:
    python3 scripts/subset-web-fonts.py

# Acceptance gate for the prod web wallet: builds the dist (`web`), serves the EXACT bytes a
# real relay would, and drives them in headless chrome — DPAY_SELFCHECK PASS (wasm core boots),
# onboarding against a real relay, identity persists across reload, wallet chrome renders,
# screenshot proves pixels, zero console errors, and NO off-box origin contacted. Opt-in: it
# drives headless chrome, so it is merge-gate material, never the hot loop (AGENTS.md tiers).
# acceptance gate for the SHIPPED /wallet bytes — boots, onboards, persists, renders
web-smoke: web
    python3 scripts/testruns.py run web-smoke --sh 'cd e2e && node web-wallet-smoke.mjs'

# Decode gate for the prod web wallet's camera scanner: regenerates the fake-camera QR video
# (scripts/gen-scan-video.mjs → e2e/shots/scan-qr.y4m, a REAL 132-byte wire request rendered as a
# QR via chrome --use-file-for-fake-video-capture), rebuilds the dist, and drives the shipped
# bytes through the FULL pipeline: getUserMedia → <video> → rAF canvas → vendored jsQR →
# onCodeScanned → PayMode review. Catches every layer of the 2026-08-16 scan regression class
# (missing decoder bytes, UMD interop, codeScanner-shape mismatch) that web e2e (inject shim)
# and web-smoke (no camera) are structurally blind to. Opt-in for the same reason as web-smoke:
# it drives headless chrome, so it is merge-gate material, never the hot loop. Needs `ffmpeg` on
# PATH — the only tool in the inner loop that is not
# in-project; gen-scan-video.mjs says so by name if it is missing.
# decode gate for the SHIPPED /wallet camera: a real getUserMedia stream, decoded by the real jsQR
web-scan: web
    python3 scripts/testruns.py run web-scan --sh 'node scripts/gen-scan-video.mjs && cd e2e && node web-scan-smoke.mjs'

# Build the frozen wire core (crates/dpay-wasm) for wasm32-unknown-unknown and stage it as the
# committed relay asset crates/dpay-relay/assets/dpay-core.wasm (served at GET /dpay-core.wasm —
# "one signing source for every web surface"). The parity guard loads the STAGED artifact, so it
# runs after the copy and proves the exact bytes that would be served sign identically to
# e2e/harness/wire.mjs (the trusted JS oracle).
wasm:
    cargo build -p dpay-wasm --target wasm32-unknown-unknown --release
    cp target/wasm32-unknown-unknown/release/dpay_wasm.wasm crates/dpay-relay/assets/dpay-core.wasm
    node scripts/check-wasm-core.mjs
    @echo "staged crates/dpay-relay/assets/dpay-core.wasm ($(stat -c%s crates/dpay-relay/assets/dpay-core.wasm) bytes)"

# THE hot loop (AGENTS.md test tiers): cargo unit tier (core unit + property tests — the
# dpay-fixture golden drift alarms ride along) + the smoke jest tier + typecheck. Seconds-fast,
# fully offline, no chrome, no relay spawn. The heavier rust suites (canister/relay/live/icp) and
# the static parity/doc gates stay on `check`; the jest flow suite (`just flow`), the real-chain
# proofs (`just node-anvil`), and the chrome visual tier (`just e2e` / `just e2e-visual`) are
# merge-gate activity. web-smoke / web-scan remain opt-in shipped-bytes gates (chrome).
verify: test-core smoke typecheck
    @python3 scripts/testruns.py record verify pass
    @echo "inner loop green"

# cross-compile dpay-ffi to Android .so for arm64-v8a + x86_64 (NDK)
ndk:
    bash scripts/ndk-build-ffi.sh

# device gate: run the shared core on the booted emulator/device (instrumented test)
ondevice:
    python3 scripts/testruns.py run ondevice -- bash scripts/android-ondevice.sh

# device gate: assert REAL camera pixels render in the IC + SOL Pay scan boxes (no mocks)
campreview:
    python3 scripts/testruns.py run campreview -- bash scripts/android-campreview.sh

# build + run the React Native app on the emulator/device; assert it signed via dpay-core
app:
    python3 scripts/testruns.py run app -- bash scripts/rn-run.sh

# build + verify signed release APK/AAB; stage the APK to deploy/dist/dpay.apk for the relay
apk:
    bash scripts/build-apk.sh

# verify, build, certificate-check, and upload the signed AAB to Google Play internal testing
play-upload:
    bash scripts/play-upload.sh

# live demo: dfx replica + canister + relay + merchant terminal (Ctrl-C to stop). Open the printed URL.
demo:
    bash scripts/demo.sh

# build the relay container image (host-built binary --features agent -> slim runtime; verified).
# build.sh FIRST runs the prod web build of the real app (vite --mode web-prod → e2e/dist-prod),
# which the relay's build.rs embeds — /wallet ships inside the binary, nothing else to stage.
# REFUSES a dirty tree (deploy/git-lib.sh): the image bakes HEAD into /api/v1/version but compiles
# the working tree, so an uncommitted one produces an image no commit describes. No override.
image:
    bash deploy/build.sh

# regenerate deploy/.env from deploy/env.config + secrets/*.sops.json (sops) — the only sanctioned
# way deploy/.env comes into existence; every deploy path also runs it automatically
deploy-env:
    bash scripts/gen-deploy-env.sh

# provision the Cloudflare Tunnel headlessly (stores CF_TUNNEL_TOKEN encrypted in secrets/deploy.sops.json)
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
    # deploy/.env is generated — refresh it from its sources first (no-op when fresh, fails
    # closed naming the fix when sops is unusable).
    bash scripts/gen-deploy-env.sh -q
    cd deploy
    # Fail before Compose interpolation if the remotely managed tunnel token is absent.
    if ! grep -Eq '^CF_TUNNEL_TOKEN=.+$' .env 2>/dev/null; then
      echo "missing CF_TUNNEL_TOKEN in deploy/.env — run 'just tunnel-provision' (headless), or copy the token from the Cloudflare dashboard (deploy/README.md)." >&2
      exit 1
    fi
    docker compose up -d && docker compose ps
    sleep 1
    curl -sS https://dpay.kalaj.org/api/v1/health
    echo
    echo "next — prove what is now live (docs/OPS.md section 3):"
    echo "    just verify-relay      # live /version == HEAD, and NOT '-dirty'"
    echo "    just integrity-check   # live facade module hash == the pin this image baked"

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

    # scratch EVM chain from `just evm-anvil` — frees port 8545 (or wherever it was staged).
    if [ -f e2e/harness/evm/anvil.pid ] && kill -0 "$(cat e2e/harness/evm/anvil.pid 2>/dev/null)" 2>/dev/null; then
      kill "$(cat e2e/harness/evm/anvil.pid)" && echo "  ✓ anvil stopped"
    else
      echo "  · anvil: none"
    fi

    # dfx local replica and everything it manages (replica, canister_sandbox, icx-proxy, pocket-ic).
    if command -v dfx >/dev/null 2>&1; then
      dfx stop >/dev/null 2>&1 || true
      dfx killall >/dev/null 2>&1 || true
      echo "  ✓ dfx replica stopped"
    else
      echo "  · dfx: not found (skipped)"
    fi

    # A PocketIC server left over from canister/relay tests (the in-project server binary).
    if pkill -f 'bin/pocket-[i]c' 2>/dev/null; then echo "  ✓ PocketIC server stopped"; else echo "  · PocketIC: none"; fi

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

# full idle-time teardown: everything `just stop` kills (relay, dfx, PocketIC, Metro, emulator,
# Gradle daemon) PLUS the leftover disk artifacts the device gates leave behind — campreview mktemp
# dirs, tmux emulator stdout logs, ndk build logs, and the gitignored `just app` screenshots
# (app/shots/, regenerated by the next device run). Safe anytime, like `stop`.
# `just cleanup wipe` ALSO resets the AVD's qcow2 userdata/cache images — the multi-GB overlay that
# only ever grows (2.7G on dpay_api36). Deleted only while no emulator is running; regenerated from
# the system image on next boot, so it costs a `just app` reinstall + camera-permission re-grant.
cleanup wipe='': stop
    #!/usr/bin/env bash
    set -uo pipefail
    freed=0
    take() { # rm -rf <paths...>, tally their KiB into $freed
      local kb
      kb="$(du -sk "$@" 2>/dev/null | awk '{s+=$1} END{print s+0}')"
      rm -rf "$@"
      freed=$((freed + kb))
    }

    # device-gate temp artifacts: campreview leaves its mktemp dirs behind for inspection, emu*.log
    # are the tmux emulator stdout captures, ndk*.log come from rn-run.sh / android-ondevice.sh.
    # (Scoped patterns only — /tmp/opencode is shared with unrelated tooling.)
    shopt -s nullglob
    tmp=(/tmp/opencode/campreview.* /tmp/opencode/emu*.log /tmp/ndk.log /tmp/ndk-build.log)
    if [ "${#tmp[@]}" -gt 0 ]; then
      take "${tmp[@]}"
      echo "  ✓ device-gate temp artifacts removed (${#tmp[@]})"
    else
      echo "  · temp artifacts: none"
    fi

    # `just app` screenshots (gitignored; scripts/rn-run.sh recreates the dir)
    if [ -d app/shots ]; then
      take app/shots
      echo "  ✓ app/shots/ cleared"
    else
      echo "  · app/shots: none"
    fi

    # orphaned e2e web-root servers: killed harness runs (SIGKILL'd before the async teardown)
    # leave sirv reparented to PID 1, holding its port forever. The harness also self-reaps at
    # spawn time (e2e/harness/web.mjs); this is the operator-side sweep for the backlog.
    # Tightly scoped: the exact sirv-cli bin path + this repo's e2e/dist root + --single flag.
    if pkill -f "sirv-cli/bin\\.js {{root}}/e2e/dist --single" 2>/dev/null; then
      echo "  ✓ orphaned e2e sirv servers reaped"
    else
      echo "  · orphaned sirv: none"
    fi

    if [ "{{wipe}}" = "wipe" ]; then
      if pgrep -f 'qemu-system-.*-avd' >/dev/null 2>&1; then
        echo "  ! emulator still alive — AVD wipe SKIPPED (rerun 'just cleanup wipe' once stopped)"
      else
        qc=()
        for avd in "$HOME"/.android/avd/*.avd; do
          for f in userdata-qemu.img.qcow2 cache.img.qcow2; do
            [ -f "$avd/$f" ] && qc+=("$avd/$f")
          done
        done
        if [ "${#qc[@]}" -gt 0 ]; then
          # close the pgrep→rm TOCTOU window: an emulator started in between would have its live
          # qcow2 deleted under it
          if pgrep -f 'qemu-system-.*-avd' >/dev/null 2>&1; then
            echo "  ! emulator started mid-cleanup — AVD wipe SKIPPED (rerun 'just cleanup wipe')"
          else
            take "${qc[@]}"
            echo "  ✓ AVD userdata/cache qcow2 reset (regenerated on next boot)"
          fi
        else
          echo "  · AVD qcow2: none"
        fi
      fi
    fi

    echo "done — ~$((freed / 1024)) MB freed."

# --- agent test float (real mainnet money — rules in CLAUDE.md, mechanism in docs/AGENT-FUNDS.md) ---

# THE one entry point for the test float (founder ask 2026-09-20: a single way to do all of it).
#   just funds                  overview: every wallet + every live balance + totals in CHF + fees paid + the abandoned watch
#   just funds address [W]      the funding address, no decryption
#                               (W: icp-float | sol-rail | sol-float | evm-float)
#   just funds balance [W]      live census for one wallet, measured (UNREADABLE is never 0)
#   just funds history [W]      what the money DID: ICP transfers + block indexes (IC wallets)
#   just funds seed <W>         the seed hex — DECRYPTS; only immediately before an approved spend
#                               (a derived wallet — sol-rail — has no seed of its own and refuses)
#   just funds init <W>         generate a NEW key for that wallet (refuses if one exists)
#   just funds reconcile        ledger vs MEASURED — drift = an unrecorded movement (exit 1)
#   just funds doc              re-render the GENERATED tables in docs/AGENT-FUNDS.md from funds/
funds *args:
    node scripts/funds.mjs {{args}}
