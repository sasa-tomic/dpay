# dpay — agent instructions

## Project memory

Read **`CLAUDE.md`** first — it holds the project memory, the non-negotiables (autonomous + offline dev loop, shared Rust core, PocketIC, non-custodial/no-swap/no-exchange-creds), the positioning/monetization pointers, and the current build state. Treat its constraints as hard requirements, not preferences.

Then read **`OPEN_ISSUES.md`** — the authoritative list of known blockers and documented follow-ups (chain-key receipts, governance hand-off, reconcile generalization, etc.). Check it before starting work so you don't re-derive what's already known or re-attempt something blocked on an external step.

## Codebase analysis — read before working, keep current

**Read `CODEBASE_ANALYSIS.md` at the start of every coding session in this repo**, immediately after `CLAUDE.md`. It is the living structural analysis: architecture health, where the design earns its keep, and the risks to know before editing (canister controller, open `mint()`, unsigned receipt, etc.).

It is not a historical snapshot — it is maintained alongside the code:

- **When a change resolves a documented risk** (e.g. `mint()` gains a caller guard, the canister controller is governed, the receipt is canister-signed), strike that risk in `CODEBASE_ANALYSIS.md` in the same change and note the resolution.
- **When a change adds a new surface, invariant, or risk**, add it to `CODEBASE_ANALYSIS.md` in the same change.
- **If anything here stops matching the code, the doc is wrong — fix the doc.** Stale analysis is worse than none.

## Working in this repo

Inner loop runs fully offline via `just` and completes in seconds (`just verify` = core + canister + relay + e2e; `just test-core`, `just test-canister`, `just test-relay`, `just sim`, `just ffi` for individual slices). `third_party/` is the canonical local source cache — look there first; `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. The Android emulator / physical devices are an outer-loop fidelity gate only, never on the inner loop.

**The RN app (`app/`) is a modular tree, not a monolith** (split 2026-07-31; see `2026-07-31-app-split-plan.md`). `app/App.tsx` (~80 lines) is the root — it loads identity + relay, self-checks, and routes `Onboarding | Wallet`. The rest is layered: `config/` (palette, constants incl. the module-level `POLL`, currency catalog), `lib/` (types + pure format helpers), `hooks/`, `services/` (the single `NativeModules.DpayCore/DpayNfc` destructure + relay/withdraw fetch clients + receipt verify), `styles.ts` (ONE `StyleSheet.create` block — do NOT partition it; the e2e net matches testID + textContent only and cannot catch a dropped style key), and `components/` (all presentational components incl. the `Wallet` container). Four production modules also live at the `app/` root: `payments.ts` (pure settlement-outcome logic + the receipt↔request nonce-match helper), `wallet.ts` (EIP-1193 onramp provider resolution), `cketh.ts` (byte-exact ckERC20 calldata builder), and `walletconnect.ts` (the ONLY file that statically imports `@walletconnect/*`, reached via a dynamic `import('./walletconnect')` in `wallet.ts` — an intentional isolation boundary so `just verify` never executes WC SDK code). Use relative imports only (no `@/` aliases). Only `app/App.tsx` imports `./relayConfig` (the e2e `?relay=` override is anchored on that path); thread `relayUrl` as a prop everywhere else.

## Pre-merge gates off the hot verify path

`just verify` (core + canister + relay + typecheck + bridge-parity + e2e) is fully offline and runs in seconds, but it does **not** exercise the real RN→Kotlin→`libdpay_ffi.so` bridge — that needs the Android emulator (outer-loop). A wire/bridge-arity regression (e.g. the 2026-07-31 wire-v2 launch crash) sails through `verify` and only explodes on a device. The two static guards now in `check` (`typecheck` + `bridge-parity`, see `scripts/bridge-parity.mjs`) catch most of this class, but they are not exhaustive.

### Structural blind spots of browser e2e (the classes `just verify` CANNOT see)

The e2e harness and jest both run under Node/V8 (or a headless browser), NOT Hermes/RN. Three classes of bug are **structurally invisible** to `just verify` and ONLY surface on a real device:

1. **Native-module / autolinking changes.** Adding/removing a native dependency, changing `app/react-native.config.js`, or first use of a Web API (e.g. `globalThis.crypto.getRandomValues`) that needs a polyfill on RN but is native on web/Node. Example: the `react-native-get-random-values` codegenConfig + `newArchEnabled=false` autolinking skip (PR20 regression → `DPAY_SELFCHECK FAIL` on device, invisible to e2e).
2. **Android-only rendering / platform APIs.** `StatusBar` translucency, `SafeAreaView` gaps, hardware-back behavior, intent/deep-link handling — browsers render none of these. Example: content rendering under the status bar (`translucent={true}` default).
3. **Wire/bridge arity.** A JS↔Kotlin argument-count or type mismatch throws on the native-modules thread, bypassing the JS self-check's try/catch (hard process kill, not a caught error). Example: the wire-v2 launch crash.

**Before merging a change that touches any of the trigger paths below, run the device gates off the hot path.** The trigger paths are intentionally broad — when in doubt, run the gate.

- `app/android/**`, `crates/dpay-ffi/**`, `app/lib/types.ts`, `app/services/**`, or the core wire consts (`WIRE_LEN`/`SIGNING_LEN`/`REQUEST_LEN` in `crates/dpay-core/src/lib.rs`) — the wire/bridge surface (blind spot 3).
- `app/react-native.config.js`, `app/package.json` (add/remove a native dep), `app/index.js` (polyfill imports) — the native-module/autolinking surface (blind spot 1).
- Any change introducing a NEW dependency on a Web API (`crypto`, `fetch` internals, `WebAssembly`, `URL`/`URLSearchParams`, etc.) that may need a RN polyfill — first-use-of-native-API surface (blind spot 1).
- `app/components/**` changes touching `StatusBar`, `SafeAreaView`, `BackHandler`, or `Platform`-gated rendering — the Android-rendering surface (blind spot 2).

The gates:

- **`just app`** (~1 min) — rebuilds the APK and launches it; assert `DPAY_SELFCHECK PASS` in logcat. Proves the full `NativeModules`→`@ReactMethod`→UniFFI→`.so` surface, incl. `wireLen`/`signWithdrawal`, AND that every autolinked native module (e.g. `RNGetRandomValues`) is present and callable.
- **`just ondevice`** — 8 instrumented tests driving the real UniFFI binding + NFC framing on the emulator.

This is the documented resolution of OPEN_ISSUES #10 Layer 3 (the path-filtered pre-merge gate) + the 2026-08-02 process fix (blind spots 1+2 added after a user-filed `---` balance / status-bar / self-check triple regression that sailed through `verify`). The gate code path is proven and green; the checklist keeps it from being skipped.

## E2e flow catalog

**`FLOWS.md`** is the authoritative manifest of every tested user flow (28 flows, organized by journey). Read it to see what's covered and how to add a new flow. Run `just e2e` (all) or `DPAY_E2E_FILTER=NN node e2e/run.mjs` (one flow).

## Human expectations

**`CLAUDE.md`** is the human-expectations document: the non-negotiables (non-custodial/no-swap/offline-dev-loop), the positioning/pitch, the monetization direction, and the scope boundaries. Keep it current when the founder provides guidance. Treat its constraints as hard requirements.
