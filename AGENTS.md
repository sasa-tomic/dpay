# dpay — agent instructions

## Project memory

Read **`CLAUDE.md`** first — it holds the project memory, the non-negotiables (autonomous + offline dev loop, shared Rust core, PocketIC, non-custodial/no-swap/no-exchange-creds), the positioning/monetization pointers, and the current build state. Treat its constraints as hard requirements, not preferences.

Then read **`OPEN_ISSUES.md`** — the authoritative list of known blockers and documented follow-ups (chain-key receipts, reconcile generalization, etc.). Check it before starting work so you don't re-derive what's already known or re-attempt something blocked on an external step. **The top of `OPEN_ISSUES.md` carries a "NEXT SESSION — work order" section: follow it.** It splits the genuinely-blocked (POSTPONE) from the unblocked work that must be done next session — do NOT re-label unblocked items as "founder outer-loop" to skip them. Note: some items are explicitly founder-owned and tagged **DO NOT NAG** (e.g. the governance stance is founder-set — govern in place, no NNS/SNS hand-off until critical mass; see `docs/GOVERNANCE.md` for the plan + objectives) — respect those tags and don't re-raise them in session summaries or as "next steps".

## Codebase analysis — read before working, keep current

**Read `CODEBASE_ANALYSIS.md` at the start of every coding session in this repo**, immediately after `CLAUDE.md`. It is the living structural analysis: architecture health, where the design earns its keep, and the risks to know before editing (canister controller, open `mint()`, unsigned receipt, etc.).

It is not a historical snapshot — it is maintained alongside the code:

- **When a change resolves a documented risk** (e.g. `mint()` gains a caller guard, the canister controller is governed, the receipt is canister-signed), strike that risk in `CODEBASE_ANALYSIS.md` in the same change and note the resolution.
- **When a change adds a new surface, invariant, or risk**, add it to `CODEBASE_ANALYSIS.md` in the same change.
- **If anything here stops matching the code, the doc is wrong — fix the doc.** Stale analysis is worse than none.

**Canister topology lives in `docs/CANISTERS.md`** — the authoritative map of which canisters exist on mainnet, who owns them, and what each is for. Do not restate its inventory here; the copy that used to sit on this line had drifted. The tracked `canister_ids.json` (repo root) holds the durable mainnet ids of the owned canisters; the deploy script resolves canister names against it, so adding an owned canister means adding both a `dfx.json` entry and its `ic` id there.

## Secrets and deploy/.env

Secrets live sops-encrypted in `secrets/*.sops.json` (rules + age recipients: `.sops.yaml`; agent identity: `.dev/age/agent-key.txt`). `deploy/.env` is AUTO-GENERATED (`scripts/gen-deploy-env.sh`, `just deploy-env`) from `deploy/env.config` (tracked non-secret config) + those sops files — never edit `.env` by hand. To add or rotate a secret: `sops secrets/<file>.sops.json`, then `just deploy-env` (every deploy path regenerates automatically). Never print or commit secret values.

## Working in this repo

Inner loop runs fully offline via `just` and completes in seconds (`just verify` = core unit + smoke + typecheck; `just test-core`, `just test-canister`, `just test-relay`, `just sim`, `just ffi` for individual slices). `third_party/` is the canonical local source cache — look there first; `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. Exactly TWO `third_party/` entries are load-bearing — `bin/pocket-ic` (the PocketIC server, `POCKET_IC_BIN`) and `ic-icrc1-ledger/` (the real DFINITY ICRC-1 ledger wasm + .did installed by the canister/icp/relay-live tests, `dfx.json`, and the deploy scripts); everything else in there is research material no recipe reads. Because the dir is gitignored, a fresh WORKTREE lacks both — `just third-party` repairs them from a sibling checkout, and the `third-party-check` preflight (wired into `test-canister`/`test-icp`/`test-live`/`sim`) fails with that instruction instead of a cryptic test/linker failure. The Android emulator / physical devices are an outer-loop fidelity gate only, never on the inner loop.

**Prod deploy (founder-run) has ONE runbook: `docs/OPS.md` §3 — do not restate it anywhere.** It is deliberately not a one-liner: `just deploy-ic` re-bakes a TRACKED pin, so the commit that records the upgrade sits *between* the canister step and the image step, and `deploy/build.sh` auto-commits a dirty tree before building (`deploy/git-lib.sh` `committed_tree_for`, founder friction call 2026-09-10) so every image corresponds to exactly one commit — the refusal that used to stand there is how the 2026-09-08 unidentifiable-prod incident was first fixed; the auto-commit buys the same guarantee without the mandatory manual commit. Everything else in the inner loop is offline.

**Prod state is CHECKED, never asserted** (founder rule 2026-08-27): never claim "prod is behind / current / shipped" from memory or from prose in these docs — the relay reports its exact source live: `curl -s https://dpay.kalaj.org/api/v1/version` → `{"commit", "commit_date"}` (baked at image-build time by `crates/dpay-relay/build.rs`), and `just verify-relay` classifies live vs HEAD (MATCH / DIRTY / BEHIND-by-N / MISMATCH; exit 1 when stale). **A live commit ending in `-dirty` is its own outcome and is never "current":** `deploy/build.sh` compiles the WORKING TREE, not the commit, so uncommitted code really ships; the marker says the image corresponds to no commit at all, whatever its base SHA compares to. Checked before MATCH for exactly that reason. The standing expectation is a FLOOR, not HEAD-equality — and the floor is DERIVED, never asserted, never hand-bumped: every `just` test recipe auto-annotates its result via `scripts/testruns.py run` into the gitignored `.dev/testruns.db` (commit + WORKING-TREE hash + dirty flag + suite + result + wall/CPU seconds + per-test timings — `just timing <suite> [commit]` prints the slowest tests/flows first and bare `just timing` lists every recorded suite by wall time (the first stop before optimizing any suite); the `check`/`verify` composites record pass only when their deps all passed), and `just floor` resolves the composite gate: live commit from the version curl, classified exactly like `verify-relay` (DIRTY checked first), then the evidence RECORDED AT THAT COMMIT — exit 0 iff prod runs a clean commit whose `verify` record is green ON THE COMMIT'S EXACT TREE on this machine. `git commit` never changes the worktree, so a suite run made just before committing satisfies the committed state; any edit after the run diverges the tree hash and the record reads `stale-tree` — a green row can never count for more than the exact bytes it exercised. A missing record is UNKNOWN, never fail. `just report [commit]` (`--json` for machines) queries the evidence; **`scripts/testruns.py` is the ONLY interface to the record — never open the DB directly.** Unwired by design: `e2e-visual-seed` (baseline regen, not a gate), `e2e-live-testnet` (opt-in env). The condition behind a `-dirty` reading is unchanged — it is a build-time auto-commit artifact (`deploy/build.sh` commits a dirty tree before building, `docs/OPS.md` §3, founder 2026-09-10) and still means the live source is UNKNOWN until the relay is redeployed from a committed tree. Below floor or unreachable → flag it with the check output; ahead of live → name exactly what's unshipped (`just floor` prints the `live..HEAD` log itself) (the facade WASM is a separate surface with its own record — `docs/UPGRADES.md`, gated by `just integrity-check`).

**The RN app (`app/`) is a modular tree, not a monolith** (split 2026-07-31; see `docs/specs/2026-07-31-app-split-plan.md`). `app/App.tsx` is the root — it loads identity + relay, self-checks, and routes `Onboarding | Wallet`. The rest is layered: `config/`, `lib/`, `hooks/`, `services/` (native modules + IC rail + residual relay clients), `i18n/` (four locales; ALL user-facing copy, reached as `M.*`), `solana/` (the app-scoped SOL rail), `styles.ts` (ONE `StyleSheet.create` block), and `components/`. Four production modules also live at the app root: `wallet.ts`, `cketh.ts`, `solana.ts`, and `walletconnect.ts`; SOL-only receipt classification lives in `app/solana/payments.ts`. Use relative imports only. Only `app/App.tsx` imports `./relayConfig`; thread `relayUrl` as a prop everywhere else.

## Pre-merge gates off the hot verify path

`just check` (core + canister + relay + typecheck + bridge-parity + aid-parity) is fully offline and runs in seconds, but it does **not** exercise the real RN→Kotlin→`libdpay_ffi.so` bridge — that needs the Android emulator (outer-loop). A wire/bridge-arity regression (e.g. the 2026-07-31 wire-v2 launch crash) sails through the offline gates and only explodes on a device. The static guards now in `check` (`typecheck` + `bridge-parity` + `aid-parity`, see `scripts/`; plus the generated-doc freshness gates `flows-md` and `convert-matrix`) catch most of this class, but they are not exhaustive. (The old `wallet-wire` and `merchant-wire` guards are GONE — `/wallet` is the real app and the hand-rolled `/merchant` page was merged into it 2026-08-16; /wallet IS the real RN-web app served by the relay.)

### Structural blind spots of browser e2e (the classes the offline gates CANNOT see)

The e2e harness and jest both run under Node/V8 (or a headless browser), NOT Hermes/RN. Three classes of bug are **structurally invisible** to `just verify` and ONLY surface on a real device:

1. **Native-module / autolinking changes.** Adding/removing a native dependency, changing `app/react-native.config.js`, or first use of a Web API (e.g. `globalThis.crypto.getRandomValues`) that needs a polyfill on RN but is native on web/Node. Example: the `react-native-get-random-values` codegenConfig + `newArchEnabled=false` autolinking skip (PR20 regression → `DPAY_SELFCHECK FAIL` on device, invisible to e2e).
2. **Android-only rendering / platform APIs.** `StatusBar` translucency, `SafeAreaView` gaps, hardware-back behavior, intent/deep-link handling — browsers render none of these. Example: content rendering under the status bar (`translucent={true}` default).
3. **Wire/bridge arity.** A JS↔Kotlin argument-count or type mismatch throws on the native-modules thread, bypassing the JS self-check's try/catch (hard process kill, not a caught error). Example: the wire-v2 launch crash.

### Prod reconciliation (don't wait for the founder to find prod-only bugs)

The e2e harness drives the REAL app but against the offline **test-helpers relay** — the value path there is its **in-process fake-IC `/api/v2` gateway** (the stand-in for `icp-api.io`; the `FakeLedger` survives as catalog/faucet sugar). It is **structurally blind** to prod-only catalog entries (e.g. testnet ckBTC/ckUSDC/ckETH that render as duplicate "BTC"/"USDC" rows), prod-only latency (real boundary-node round trips with a 6-currency catalog), and prod-only UI rows (e.g. the SOL bolt-on with extra buttons not present for IC assets). Before declaring catalog/balance/Balances/UI work done, reconcile against **prod**:

- **One curl** against the prod relay reconciles the catalog: `curl -s https://dpay.kalaj.org/api/v1/currencies | jq '.networks[] | {protocol,environment,assets: [.assets[] | {currency,token,network,backing_symbol,minter_family}]}'` (Catalog v2, 2026-08-27: network-first envelope — icp mainnet / icp testnet / solana mainnet sections; a row is testnet iff its icp section says so; the flat mixed list is gone). Post-cutover this catalog is display/config metadata — the ledger/minter principals the app's own signed envelopes target — not a list of settlement routes. Compare against what the app renders — duplicates, missing rows, testnet rows leaking into the mainnet section, and unexpected families are all visible here.
- When the emulator is booted (`dpay_api36` in tmux), **drive the real app against the real relay** (NOT the e2e fake) for any UX change touching Balances, catalog rendering, or balance polling. Screenshot + zai-vision confirms what the user sees. The e2e fake catalog hides exactly these classes of bug.
- This is context-cheap (one curl + one screenshot) and catches the bugs that sailed through `just verify`.

**Before merging a change that touches any of the trigger paths below, run the device gates off the hot path.** The trigger paths are intentionally broad — when in doubt, run the gate.

- `app/android/**` (incl. `MainApplication.kt` — `SoLoader.init(... OpenSourceMergedSoMapping)` + the `ReactNativeHost`/New-Arch setup; a regression here throws on the native-modules thread and only surfaces on device), `crates/dpay-ffi/**`, `app/lib/types.ts`, `app/services/**`, or the core wire consts (`WIRE_LEN`/`SIGNING_LEN`/`REQUEST_LEN` in `crates/dpay-core/src/lib.rs`) — the wire/bridge surface (blind spot 3).
- **NFC AID surface** — the 2 NFC AIDs are each duplicated as a byte literal AND an XML `<aid-filter>` hex with no compile-time link: IC `F06470617901` = `crates/dpay-core/src/nfc/mod.rs` `pub const AID` + `app/android/.../res/xml/apduservice.xml`; SOL `F06470617902` = `app/android/.../DpaySolNfc.kt` `SOL_AID` + `app/android/.../res/xml/solapduservice.xml`. A mismatch silently breaks OS tap routing (tap dies as an opaque "not a dpay phone" / `SW_NOT_READY`, sails through `just verify`). The static `just aid-parity` (in `check`) decodes the XML hex and asserts byte-equality against the literal — **run it on any AID change** (then `just app` + `just ondevice` for the radio hop).
- `app/react-native.config.js`, `app/package.json` (add/remove a native dep), `app/index.js` (polyfill imports) — the native-module/autolinking surface (blind spot 1).
- Any change introducing a NEW dependency on a Web API (`crypto`, `fetch` internals, `WebAssembly`, `URL`/`URLSearchParams`, etc.) that may need a RN polyfill — first-use-of-native-API surface (blind spot 1).
- `app/components/**` changes touching `StatusBar`, `SafeAreaView`, `BackHandler`, or `Platform`-gated rendering — the Android-rendering surface (blind spot 2).
- **Scan-screen layout** — any change to `QrScanner.tsx`, `PayMode.tsx`, `SolPayMode.tsx`, `SolReceiveMode.tsx`, `ReceiveMode.tsx`, `S.camBox`/`S.center`/`S.scanWrap` in `app/styles.ts`, or anything else in the scan-screen layout tree. `S.camBox` sizes via `alignSelf:'stretch'` + `aspectRatio:1` — an unstyled/content-sized View interposed between it and `S.center` collapses it to 0×0 (the 2026-08-14 SOL black-box bug: camera mounted + streaming but invisible; web e2e is structurally blind because the web camera shim renders the content-sized permission placeholder). Run `just campreview` (blind spot 2).

The gates:

- **`just app`** (~1 min) — rebuilds the APK and launches it; assert `DPAY_SELFCHECK PASS` in logcat. Proves the full `NativeModules`→`@ReactMethod`→UniFFI→`.so` surface, incl. `wireLen`/`signWithdrawal`, AND that every autolinked native module (e.g. `RNGetRandomValues`) is present and callable.
- **`just ondevice`** — 10 instrumented tests driving the real UniFFI binding + NFC framing + the QR-scan halves (MLKit barcode decode of a bundled QR; CameraX frame-flow asserting ImageAnalysis frames arrive from the back camera) on the emulator. The camera gates require the AVD to expose BOTH lenses: `hw.camera.back = emulated` AND `hw.camera.front = emulated` in `~/.android/avd/dpay_api36.avd/config.ini` (front=`none` makes CameraX's lens-validation fail and vision-camera's `useCameraDevice('back')` returns null → "No camera found on this device" placeholder; `virtualscene-image` injection never renders headless, so no on-emulator QR-in-view e2e).
- **`just campreview`** (~45 s) — the REAL camera-preview pixel gate, zero mocks: launches the installed APK, navigates to the IC (DEMO, positive control) and SOL scan screens via uiautomator bounds-taps (never hardcoded pixels), crops the camera box from a lossless `screencap`, and asserts real camera-HAL pixels are visible (per-channel stddev ≥ 10 AND mean luminance ≥ 60; healthy ≈ 80/194, broken ≈ 0.0/7.0). Anchors on the `scan-cam-box` testID, falling back to the hint-text bottom. Catches the 0×0-camBox-collapse class that web e2e, `just app`, and `just ondevice` are all blind to (camera can mount + stream while visually invisible). Requires a booted emulator with both lenses emulated.

This is the documented resolution of OPEN_ISSUES #10 Layer 3 (the path-filtered pre-merge gate) + the 2026-08-02 process fix (blind spots 1+2 added after a user-filed `---` balance / status-bar / self-check triple regression that sailed through `verify`). The gate code path is proven and green; the checklist keeps it from being skipped.

**Stricter typecheck (commit `8a6ca28`).** `just typecheck` runs `tsc --noEmit --noUnusedLocals --noUnusedParameters`, so dead imports / unused locals / unused params now FAIL the gate (previously sailed through under plain `tsc --noEmit`). A green `just typecheck` is now a positive proof of no dead declarations in `app/`, not just a type-correctness check.

## Test tiers: what runs where (strict)

Dev-loop tests MUST finish in SECONDS, not minutes. That is the objective of the whole tier system.

- **`just smoke`** (seconds, run constantly during iteration): only the files in
  `app/__tests__/smoke/manifest.ts`. Pure node, zero network, zero chrome/anvil, deterministic,
  <=250 ms per test, <=12 s total. Money-defining invariants ONLY: wire bytes, key derivation,
  gas-gate ordering, permit/claim semantics, catalog parse/drift, amount parsing, settlement state
  machines. Adding a test to smoke = adding ONE line to the manifest and meeting every criterion;
  the drift test (`smokeManifest.test.ts`) and the budget wrapper (`budget-setup.js`) reject
  everything else. NEVER put screen flows, fetch calls, or timing-sensitive code in smoke. If your
  change touches a money invariant, add/extend a smoke test for it.
- **Domain suites** (`app/__tests__/*.test.*`, run via `just test-app`): component + service tests,
  mocked fetch/fake timers allowed. This is where most new tests belong. Iterate with `just smoke`
  plus the ONE domain suite you touched.
- **`just flow`** (jest full-app flow suite): full `<App/>` mounts against the real test-helpers
  relay (spawned once per run by jest's globalSetup). Screen-level behavior lives here, never in
  smoke.
- **`just node-anvil`**: real-chain proofs (anvil + relay pipe, no browser, no jest). EVM
  send/permit-settle/gas-refusal live here.
- **`just e2e`** (merge gate only, chrome): the 9 kept visual/PWA flows — screenshot capture
  (35, 39), pixel baselines (40, 84), QR scannability (78), viewport/layout metrics (83, 146,
  158), PWA/service-worker boot (151). Every behavioral flow was retired to the jest tiers above;
  the chrome tier is frozen.
- **`just e2e-visual`** (merge gate only, chrome): pixel baselines, QR scannability, viewport
  layout, PWA boot. No behavioral assertions move back here.

**Slow suites run EXACTLY ONCE, immediately before commits move back to main — NEVER during
iteration. This is a HARD rule.** Slow means: full jest (`just test-app`), `just flow`,
`just node-anvil`, `just e2e`, `just e2e-visual`, anything minutes-long. If you are iterating,
`just smoke` plus your one touched domain suite is the entire menu; launching chrome is a bug.

**Standing perf mandate.** When anything in the quick tiers exceeds its budget, that is an ALERT:
a fix agent must identify the slow parts, merge or flatten tests, and RADICALLY cut setup and
teardown time and memory/CPU. Parallelization alone is not a fix. `just smoke` over budget = stop
and fix, never raise the budget. `node scripts/smoke-watch.mjs` is the watchdog: it runs
`just smoke` once, compares wall (12 s) and per-test (250 ms) times, writes
`/home/sat/projects/dpay/tmp/smoke-watch-status.json` (machine-checkable: `ok`, `verdict`,
`wallSeconds`, `overBudget`, `slowest`), prints a one-line verdict, and exits nonzero when over.

## Parallel agents / CPU

Never launch chrome-headless-shell (or any chrome) directly; browser access goes only through the harness recipes (`just e2e`, `just e2e-visual`, `just web-smoke`, ...), which share ONE machine-wide shell via the cross-run gate in `e2e/harness/browser.mjs`. Browser access is serialized machine-wide by `/tmp/opencode/dpay-chrome.lock`: parallel runs may QUEUE at the browser step for minutes — that is normal, do not kill anything to "fix" it, and never pkill chrome globally (the box runs other projects' browsers and a production relay). `just e2e-sweep` reaps dead discovery files and idle clientless gate shells; run it if the box feels hot.

## E2e flow catalog

**`FLOWS.md`** is the authoritative manifest of the chrome flow tier, GENERATED from each flow's `meta` — it is the only place the flow count lives, so do not copy the count here again. The chrome tier is FROZEN at the 9 visual/PWA flows (35 ux-tour, 39 store-screens, 40 visual-regression, 78 qr-scannable, 84 visual-dark, 151 offline-web-boot, 83 mobile-viewport, 146 money-forms-fit, 158 header-fits); every behavioral flow was retired to the jest flow suite (`app/__tests__/flow/`, run via `just flow`) and the real-chain proofs (`app/__tests__/node-anvil/`, run via `just node-anvil`) — new flows go THERE, never back to chrome. Recipes (merge-gate or opt-in, never the dev loop): `just e2e` (the 9 visual flows); `just e2e-visual` (pixel-diff flow 40 standalone — fast feedback after a UI tweak; flow 40 also runs in `just e2e`); `just e2e-visual-seed` (regenerate the visual baselines after an intentional UI change — commit the new baselines); `just e2e-store` (the Play Store capture, flow 39 standalone). One flow: `DPAY_E2E_FILTER=NN node e2e/run.mjs`.

## Completion standard (hard rules, founder-set 2026-08-14)

1. **Full-exercise rule.** An implementation is "complete" ONLY after every flow it touches has been fully exercised by the agent itself (real gate runs — jest, e2e, device gates where triggered — not static review), audited for ANY signs of gaps, bugs, or half-wired code (state-matrix walkthrough of every gate/branch), and found FULLY clean. Green gates on stale coverage do not count; if a path has no coverage, add it. Only then may completeness be claimed.
2. **Autonomous iteration.** Work autonomously — no questions — until the work is completely prod-ready or a HARD FORK in the design or a HARD external blocker is hit (emulator/device unavailable, mainnet funds needed, founder-owned step). Anything short of a hard fork or a hard blocker is work to do, not work to ask about. Use subagents to preserve main-session context.

## Human expectations

**`CLAUDE.md`** is the human-expectations document: the non-negotiables (non-custodial/no-swap/offline-dev-loop), the positioning/pitch, the monetization direction, and the scope boundaries. Keep it current when the founder provides guidance. Treat its constraints as hard requirements.
