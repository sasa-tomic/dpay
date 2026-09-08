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

# core unit + property tests (native, sub-second). dpay-fixture rides along because its tests ARE
# the core's golden drift alarms: each rebuilds a signing layout (pay / withdraw / receipt /
# till-open) from the emitted offsets ALONE and asserts the core still produces those exact bytes,
# and the till-open one additionally compares the COMMITTED dfx/till_open_signing.json against what
# today's core emits. They were previously on no recipe at all, so that drift could land green.
test-core:
    cargo nextest run -p dpay-core --features rng
    cargo nextest run -p dpay-fixture

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

# user-principal rail tests on PocketIC's make_live() gateway (offline, deterministic, seconds):
# raw-ed25519 device keys whose self-authenticating principals hold funds DIRECTLY on the REAL
# ic-icrc1-ledger move them via dpay-icp-signed envelopes over the real /api/v2 ingress — the
# PRODUCTION ic_validator checks every signature/expiry (bad sig → 400, expired → 400, replay
# deduped). Proves the user_transfer / offramp approve→retrieve legs + the principal derivation
# the app will use on mainnet, with envelope-only auth (funding is PocketIC-API scaffolding).
# ALSO runs the dpay-icp wire-contract goldens (byte-parity vs the cached production crates —
# seconds-fast, was previously on no recipe) and the dpay-wasm host tests (icp goldens).
test-icp: build-mock-minter
    cargo nextest run -p dpay-icp
    cargo nextest run -p dpay-wasm
    cargo nextest run -p dpay-icp-tests

# relay tests (native, in-memory — no network). `test-helpers` also compiles the fake-IC /api/v2
# gateway the e2e web harness points the app at (the seam is e2e-build-only — see shims.ts).
# Depends on `web`: dpay-relay's build.rs embeds e2e/dist-prod (the /wallet route serves the real
# app from it) and FAILS LOUD when it's missing — this dependency keeps every relay build honest.
test-relay: web
    cargo nextest run -p dpay-relay --features test-helpers

# emit the committed core goldens from the real Rust core: the wire layout (single source of truth
# for the JS ed25519 signing shim) and the till-open signing document (the merchant's ring-up proof,
# read by scripts/check-wasm-core.mjs). `just test-core` fails when the till-open file is stale.
wire-layout:
    cargo run -p dpay-fixture --release -- wire-layout dfx/wire_layout.json
    cargo run -p dpay-fixture --release -- till-open dfx/till_open_signing.json

# radical e2e: drive the REAL app (App.tsx via react-native-web) + REAL relay (FakeLedger) + REAL
# browser (chrome-headless-shell), offline + seconds-fast. The inner-loop UI/flow gate — it BOTH
# drives every flow through the real app AND screenshots each state (shots land in e2e/shots/),
# superseding the old parallel-component ui/ harness (removed). Add a flow = add `e2e/tests/NN-name.mjs`.
# Runs the DEFAULT enumeration: every flow except `meta.optional` render-only capture harnesses
# (flow 39 runs via `just e2e-store`; the flow catalog lives in FLOWS.md — never hardcode a count here).
e2e:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && node run.mjs

# visual-regression gate (fast iteration on flow 40 alone): re-capture the 5 primary surfaces and
# pixel-diff each vs its committed baseline (e2e/shots/baselines/). Fails on drift >0.5%. Catches the
# exact class of style/layout regression that sails through the testID+textContent e2e net. NOTE:
# flow 40 IS part of the default suite (see FLOWS.md for the canonical count), so `just verify` → `check e2e` already runs the pixel-diff —
# this standalone recipe re-runs ONLY flow 40 in isolation for fast feedback after a UI tweak (no
# banner, no other flows). On an intentional UI change, regenerate the baselines via
# `just e2e-visual-seed` and commit the new baselines (the diff is reviewable in the commit).
e2e-visual:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && DPAY_E2E_FILTER=40 node run.mjs

# regenerate the visual-regression baselines from the current app surfaces (run after an intentional
# UI/style change). Writes e2e/shots/baselines/<surface>.png for each of the 5 surfaces. COMMIT the
# new baselines — they ARE the contract; a future regression diffs against them.
e2e-visual-seed:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && DPAY_E2E_REGEN_BASELINES=1 DPAY_E2E_FILTER=40 node run.mjs

# Play Store screenshot capture (flow 39) — an assert(true) render-only contract sweep, NOT a
# behavior gate, so it is EXCLUDED from the default `just e2e` run (saves ~37s) via its
# `meta.optional = true` marker. This recipe is its dedicated entry point; the raw captures feed
# `e2e/store-assets/compose.mjs` for marketing compositing.
e2e-store:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && DPAY_E2E_FILTER=store-screens node run.mjs

# watch mode (Phase 3): a LONG-RUNNING dev loop that re-runs a SUBSET of flows on every change to
# app/, e2e/, crates/dpay-core/src/, or crates/dpay-ffi/src/. The changed file is mapped to a journey
# (e.g. app/components/PayMode.tsx → the `pay` journey) and only that subset re-runs —
# sub-second-to-~5s feedback while iterating instead of the full ~23s suite. The shared relay+web+
# browser session PERSISTS across re-runs (only per-test contexts churn). Ctrl-C tears it down.
# Shared-infra changes (App.tsx, styles.ts, services/native.ts, harness/*, crates/**) re-run ALL.
e2e-watch:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && node watch.mjs

# watch mode PINNED to a filter token (journey/id/name/covers slug). The pinned filter always wins
# — the changed-file→journey mapping is bypassed. Use this to iterate on a specific journey or flow
# (e.g. `just e2e-watch pay` runs the 16 pay flows; `just e2e-watch 07` runs flow 07 alone).
e2e-watch-filter filter:
    cd e2e && ([ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps)
    cd e2e && DPAY_E2E_WATCH_FILTER={{filter}} node watch.mjs

# production gate: same harness drives the LIVE relay + canister at DPAY_E2E_BASE. Throwaway identities,
# throttled, read-only-ish (never sends real BTC). Honest ceiling until KYC-allowlist lands (see plan §4.3).
e2e-live:
    cd e2e && DPAY_E2E_MODE=live DPAY_E2E_BASE=https://dpay.kalaj.org node run.mjs

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
sim: build-canister
    cargo run -q -p dpay-sim

# relay <-> real canister over ic-agent against a live local IC (offline); feature-gated.
# Depends on `web`: builds dpay-relay, whose build.rs embeds e2e/dist-prod (fail-loud without it).
# Also builds the mock-minter wasm — the WAVE-5 live test drives TWO mock minters to prove the
# ckERC20 onramp's runtime `get_minter_info` helper read + its logged-constant fallback.
test-live: web
    CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo build -p dpay-canister --target wasm32-unknown-unknown --release
    CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo build -p dpay-mock-minter --target wasm32-unknown-unknown --release
    DPAY_CANISTER_WASM="{{root}}/.dev/target-relay/wasm32-unknown-unknown/release/dpay_canister.wasm" DPAY_MOCK_MINTER_WASM="{{root}}/.dev/target-relay/wasm32-unknown-unknown/release/dpay_mock_minter.wasm" CARGO_TARGET_DIR="{{root}}/.dev/target-relay" cargo nextest run -p dpay-relay --features agent,test-helpers

# UniFFI shared-core binding: build host lib, generate bindings, run the language roundtrip test
ffi:
    bash crates/dpay-ffi/verify.sh

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

# OFFLINE dfx-replica proof for the user-principal IC rail (~30-60s): boots a clean replica, installs
# the REAL ic-icrc1-ledger, funds the deterministic device principal P1, and drives the dpay-icp
# signed envelopes through /api/v2 (202 → read_state poll → replied; signed query; bad-sig/expired
# → 4xx). Second INDEPENDENT ingress implementation beyond the PocketIC gateway of test-live.
test-icp-replica:
    bash scripts/icp-replica-e2e.sh

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

# OPT-IN mainnet read-only TRIPWIRE for the delegated-conversion venue (NEEDS NETWORK, never in
# check/verify): one anonymous `metadata` query on the ICPSwap PoC pool, asserting its OWN
# token0/token1/fee still equal `swap_venue` in dfx/catalog_truth.json — the block the offline
# fake pool is seeded from. Free: a query costs nothing, moves nothing, signs nothing.
# `just test-live` is PocketIC and has NO ICPSwap pool in it, so it is structurally unable to
# see a venue fact; on 2026-09-07 that gap let a compiled pair pin sit BACKWARDS behind a fully
# green suite while live production quoted every ICP→VCHF trade at the VCHF→ICP rate (~5.9x
# against the user). Run it after any change to the conversion quote path, and whenever the
# venue itself may have changed.
swap-venue-probe:
    DPAY_IC_MAINNET=1 cargo nextest run -p dpay-relay --features agent -E 'binary(swap_venue_mainnet)' --no-capture

# OPT-IN live OpenCryptoPay probe (NEEDS NETWORK, never in check/verify): drives the REAL app
# against the REAL provider's public CHF-1 test till and stops at the review, having signed
# nothing. Reads only — a quote costs nothing and commits nothing, and the wallet it drives is a
# throwaway funded by the local relay's faucet, so no real money is reachable. Exists because
# flows 111/112 run against a fail-closed stub: a wrong belief about the provider's payload is
# invisible to them BY CONSTRUCTION, and one such belief made every real till unpayable behind a
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
    bash scripts/verify-deploy.sh

# OBJECTIVE deploy-fidelity gate for the RELAY: curls the live `/api/v1/version` and compares its
# baked git commit to `git rev-parse HEAD`. MATCH = current; DIRTY / BEHIND-N / MISMATCH = the image
# does not correspond to HEAD → redeploy per docs/OPS.md section 3. No dfx needed (a plain curl).
# Override the target via DPAY_RELAY_URL.
verify-relay:
    bash scripts/verify-relay-version.sh

# OBJECTIVE integrity gate for the FACADE CANISTER: curls the live `/api/v1/integrity` and asserts
# the canister's on-chain module hash matches the PIN the relay image was built with
# (deploy/facade-module-hash.txt — GOVERNANCE row 7). MATCH = the deployed facade is the recorded
# upgrade; MISMATCH = someone upgraded outside the recorded procedure; UNPINNED/UNREACHABLE = the
# check itself cannot run. Deliberately OFF the hot `verify` path — it is a network probe of PROD.
# Override the target via DPAY_RELAY_URL. The changelog this gate polices is docs/UPGRADES.md.
integrity-check:
    bash scripts/integrity-check.sh

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

# typecheck the RN app — catches bridge arity drift against the TS interfaces (tsc --noEmit, ~2s, no device)
typecheck:
    cd app && npm run typecheck

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
    cd app && npm test

# bridge parity: assert every TS DpayCoreApi/DpayNfcApi method has a matching-arity Kotlin @ReactMethod
# (and vice-versa). Sub-second, no device — the static net that makes wire/arity drift fail the build.
bridge-parity:
    node scripts/bridge-parity.mjs

# aid parity: assert each NFC AID's byte literal (Rust const / Kotlin val) is byte-equal to its XML
# <aid-filter> hex. Sub-second, no device — the static net that makes an AID routing drift fail the
# build (a mismatch silently breaks OS tap routing → opaque "not a dpay phone" / SW_NOT_READY).
aid-parity:
    node scripts/aid-parity.mjs

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
check: test-core test-canister test-relay test-live test-icp typecheck test-app bridge-parity aid-parity wasm-core flows-md
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

# Wasm-core parity: proves the COMMITTED crates/dpay-relay/assets/dpay-core.wasm (the bytes every
# web surface loads) signs/builds byte-identically to the JS oracle — catches a stale or corrupted
# staged artifact even when `just wasm` (which runs this same guard after rebuilding) wasn't run.
wasm-core:
    node scripts/check-wasm-core.mjs

# Build the prod WEB build of the REAL app (app/App.tsx via react-native-web) → e2e/dist-prod:
# the dist dpay-relay's build.rs embeds and serves at GET /wallet (+ /assets/*, immutable).
# Gitignored — built here / at image time, never committed. Same wasm-backed DpayCore shim the
# e2e suite exercises; the ONE divergent shim is the camera (real getUserMedia+jsQR vs inject).
# The seam guard FAILS the build if any __DPAY_TEST_* seam leaks into the prod bundle (they are
# mode-gated in e2e/web/shims.ts; `test-relay` depends on this, so `just check` enforces it too).
# This build ALSO emits the offline shell (sw.js + manifest + icon) and brotli-precompresses every
# compressible output — see `dpayWebProdAssets` in e2e/vite.config.js; build.rs refuses a dist
# where a compressible file arrived without its `.br`.
# The bundle bakes in the Solana RPC endpoint, so check-prod-sol runs first — `--no-probe` because
# this recipe is on the fully-offline inner loop (see that script's header for the two modes).
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
# screenshot proves pixels, zero console errors, and NO off-box origin contacted. Wired into
# `verify` (see that recipe for why there and not `check`).
# acceptance gate for the SHIPPED /wallet bytes — boots, onboards, persists, renders
web-smoke: web
    cd e2e && node web-wallet-smoke.mjs

# Decode gate for the prod web wallet's camera scanner: regenerates the fake-camera QR video
# (scripts/gen-scan-video.mjs → e2e/shots/scan-qr.y4m, a REAL 132-byte wire request rendered as a
# QR via chrome --use-file-for-fake-video-capture), rebuilds the dist, and drives the shipped
# bytes through the FULL pipeline: getUserMedia → <video> → rAF canvas → vendored jsQR →
# onCodeScanned → PayMode review. Catches every layer of the 2026-08-16 scan regression class
# (missing decoder bytes, UMD interop, codeScanner-shape mismatch) that web e2e (inject shim)
# and web-smoke (no camera) are structurally blind to. Wired into `verify` (see that recipe for why
# there and not `check`). Needs `ffmpeg` on PATH — the only tool in the inner loop that is not
# in-project; gen-scan-video.mjs says so by name if it is missing.
# decode gate for the SHIPPED /wallet camera: a real getUserMedia stream, decoded by the real jsQR
web-scan: web
    node scripts/gen-scan-video.mjs
    cd e2e && node web-scan-smoke.mjs

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

# web-smoke + web-scan are HERE and not in `check` (2026-09-08). They were on no gate at all, and
# both had been RED for days without anyone noticing — each carried its own private copy of the
# first-run sequence, which the app changed three times in five weeks. Being on a gate is what
# stops that; `verify` rather than `check` is where the cost fits, because they are the only two
# recipes besides `e2e` that drive a headless browser (~30s each) and `check` is the hot Rust loop
# people re-run on every edit. They add no build: `check` → `test-relay` already builds the dist
# they serve, and `just` runs a dependency once per invocation. They come BEFORE `e2e` so a broken
# SHIPPED bundle fails in half a minute rather than after the full flow suite.
# (The e2e harness superseded the old ui/ parallel-component golden-shot harness — it drives the
# REAL App.tsx and screenshots every flow state — so `ui` is gone.)
# everything: rust loop + the two shipped-bytes web smokes + radical e2e (real app, relay, browser)
verify: check web-smoke web-scan e2e
    @echo "full inner loop green"

# cross-compile dpay-ffi to Android .so for arm64-v8a + x86_64 (NDK)
ndk:
    bash scripts/ndk-build-ffi.sh

# device gate: run the shared core on the booted emulator/device (instrumented test)
ondevice:
    bash scripts/android-ondevice.sh

# device gate: assert REAL camera pixels render in the IC + SOL Pay scan boxes (no mocks)
campreview:
    bash scripts/android-campreview.sh

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

# build the relay container image (host-built binary --features agent -> slim runtime; verified).
# build.sh FIRST runs the prod web build of the real app (vite --mode web-prod → e2e/dist-prod),
# which the relay's build.rs embeds — /wallet ships inside the binary, nothing else to stage.
# REFUSES a dirty tree (deploy/git-lib.sh): the image bakes HEAD into /api/v1/version but compiles
# the working tree, so an uncommitted one produces an image no commit describes. No override.
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

# print the funding address for the agent's mainnet test float (no decryption)
agent-principal:
    node scripts/agent-key.mjs principal

# measure live mainnet balances of the test float — the ONLY source of truth for what it holds
agent-balance:
    node scripts/agent-key.mjs balance

# what the float's money actually DID: recent ICP ledger transfers, with the BLOCK INDEX of each.
# `agent-balance` says how much is left; this says where it went and at which block — and that block
# index is the exact proof an OpenCryptoPay payment reports to the provider, so it is how a payment
# made on a phone is verified from here, without taking anyone's word for it. Read-only, no decrypt.
agent-history:
    node scripts/agent-key.mjs history

# print the seed hex (DECRYPTS the sops secret). Only immediately before an approved spend.
agent-seed:
    node scripts/agent-key.mjs seed

# generate a NEW test-float key. Refuses if one exists — rotating strands any funds still held.
agent-key-init:
    node scripts/agent-key.mjs init
