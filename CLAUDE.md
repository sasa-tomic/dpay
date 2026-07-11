# Memory

## Me

Solo founder & engineer building **dpay** (working name TBD). Contact: tomic.cld@kalaj.org.
Currently pre-seed: building the investor proof-of-concept, then a first pilot.

## Non-negotiable: how Claude must be able to iterate

These are hard requirements, **not preferences**. Do not accept a design that violates them — restructure the design instead.

- Claude must run the **full dev cycle autonomously** — analyze UI, test, identify/debug, fix, verify the fix — with **no human in the loop**.
- It must run **locally and offline**: no network, no external services, no cloud on the inner loop.
- The inner dev/test cycle must complete **in seconds** (target < ~10s end to end).
- Money- and protocol-critical logic lives in a **strongly-typed Rust core** (`dpay-core`) shared by the canister, relay, phone app (via UniFFI Turbo Module), and a headless test harness — so the code Claude tests is the code that ships.
- Canister/ledger iteration uses **PocketIC** (in-process, deterministic, offline; `dfx` now defaults to it).
- The **Android emulator / physical device is a fidelity gate only** — never on the inner loop, by design. (This sandbox *does* now have `/dev/kvm` + the emulator, so `just ondevice` / `just app` run here — but they stay an outer-loop gate; the fast inner loop remains headless.) UI is verified headlessly (`react-native-web` + headless chromium screenshots).

Full plan and rationale: `dev-loop-plan.md`.

## Projects

| Name | What |
|------|------|
| **dpay** | Consumer wallet with Venmo/Alipay-style UX that settles in digital dollars on the Internet Computer. Signature feature: the payer authorizes a payment **fully offline**; the online merchant submits it and gets a final confirmation in seconds. Borderless, no bank account needed. |
| **PoC demo** | Smallest build that proves the offline-pay / online-confirm flow for investors — Android RN app, Node relay, ICP canister ledger, two phones, ~60s airplane-mode demo. Everything else deferred. |

## Terms

| Term | Meaning |
|------|---------|
| ICP | Internet Computer — the decentralized ledger dpay settles on |
| canister | ICP smart contract acting as the demo ledger (verifies sig, checks nonce/expiry/cap/balance, moves funds atomically, returns receipt) |
| relay | tiny Node/Express + `@dfinity/agent` service that submits the merchant's authorization to the canister; the **only online dependency** in the demo |
| authorization | signed payment payload `{from, to, amount, nonce, expiry}` the payer builds and signs offline |
| nonce | per-payment idempotency key; prevents double-spend / double-charge |
| offline payer | the phone that signs while in airplane mode |
| online merchant | the phone that scans + submits and shows "Paid ✓" |
| ckUSDC | chain-key USDC on ICP — the real stablecoin dpay would use off the internal demo ledger |
| `$` | how money is shown in the UI; the underlying stablecoin/ledger is never surfaced |

## Architecture (PoC)

- **Mobile app** — one React Native app (Android only), Pay + Receive modes; on-device key; QR generate/scan; builds & **signs the authorization fully offline**.
- **Relay** — Node + Express + `@dfinity/agent`; receives merchant submission, calls canister; small idempotency store (in-memory is fine for the demo).
- **Canister (ICP)** — Motoko or Rust (`ed25519-dalek`); verifies Ed25519 sig, checks nonce unused/unexpired, checks amount within balance and cap, atomic transfer, records nonce, returns receipt. Two accounts pre-funded at init.

## Payment flow (decided): two-scan, amount-bound

1. **Merchant (online)** shows a request QR: `{to, amount, request_id, expiry}`.
2. **Payer (offline)** scans it, reviews "Pay $X to <merchant>", approves → signs `Authorization {from, to, amount, nonce=request_id, expiry}` → shows a signed-auth QR.
3. **Merchant** scans the signed-auth QR → submits via relay → canister verifies sig + nonce/expiry/cap/balance, settles atomically → "Paid ✓".

The signature binds the **exact amount + payee + request**, so consent is unambiguous and the merchant-issued `request_id` doubles as the ledger nonce (single-use → no double-charge). Short `expiry` (~2 min) kills stale replays. Rejected: single-scan payer-presented pre-auth (merchant fills the amount) — faster but weaker consent. Deferred: a signed receipt QR back to the payer for offline confirmation.

## Local dev cache & offline (`third_party/`)

Claude and all subagents treat `third_party/` as the canonical local source cache — **look there first; clone any missing repo there (shallow) instead of re-fetching from the network.** Crates are vendored to `vendor/` (`cargo vendor`); the PocketIC **server** binary lives at `third_party/bin/pocket-ic` (v14.0.0) and is referenced via `POCKET_IC_BIN`. The Rust + Node toolchains and a vendored headless browser (`chrome-headless-shell`, because the sandbox's `/usr/bin/chromium-browser` is a non-functional snap stub) install under `.dev/` (kept in-project because the sandbox recycles `$HOME`, so this keeps iteration fast across sessions). `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. Inner-loop builds/tests run fully offline against these.

## What's built (all green offline via `just`; inner loop ~7s)

- **dpay-core** — signing/verify/validate/QR codec, proptests incl. conservation-of-funds + tamper; compiles to wasm with `getrandom` gated out.
  - `nfc` module — pure, panic-free ISO 7816-4/ISO-DEP **transport framing** for the *same* bytes QR carries (request + 192-byte wire): APDU codec, chunking/reassembly, and `CardSession` (payer/HCE) ↔ `ReaderConductor` (merchant) state machines (custom AID, `other` category → no Google Wallet clash; re-tap safe; explicit approve/decline). Exposes a `SessionPhase` + `phase()` on both sides (Idle/Linking/Exchanging/AwaitingApproval/Complete/Declined) — the live signal a UI status view renders; failures stay typed errors, never a phase. 24 proptests/unit tests incl. a full card↔reader simulation over random payloads/chunk sizes + a real signed wire that survives transit and still `verify()`s + phase-sequence assertions, all failure paths typed. Transport-only; the radio hop stays a physical device gate.
- **dpay-canister** — ic-cdk ledger; PocketIC tests (happy/nonce/expiry/cap/insufficient).
- **dpay-relay** — axum; idempotency/retries/`/health`/safe-mode over a `Ledger` trait. `FakeLedger` (inner loop) + `AgentLedger` (feature `agent`: real `ic-agent` → live PocketIC HTTP gateway, verified end-to-end).
- **dpay-sim** — narrated, self-checking end-to-end demo (offline sign → canister → Paid ✓ → double-spend refused → expired refused).
- **dpay-ffi** — UniFFI wrapper; a Python roundtrip proves the app calls the *exact* compiled core; Kotlin binding emitted for Android. Now also exports the NFC objects (`FfiCardSession`/`FfiReaderConductor`, `NfcStep`, `NfcPhase` + `phase()`/`is_complete()`, `nfc_request_bytes`/`nfc_decode_request`) so the Kotlin HCE service/reader are thin loops over the real core; the Python gate drives an end-to-end card↔reader tap (single-frame + 1-byte-fragmented) and asserts the phase transitions the UI shows.
- **ui/** — react-native-web Pay/Receive screens, headless-chromium screenshots + golden visual-regression. Includes an **NFC status chip** (`NfcChip`, on/off/absent) driven by an injectable seam (`?nfc=` / `window.__DPAY_TEST_NFC`), and a **live NFC-tap status view** (`NfcSession`: listening / connecting / communicating-spinner / awaiting-approval / paid✓ / declined / error-with-reason) on a `?screen=nfc&phase=` route + `__DPAY_TEST_NFC_SESSION` seam. 12 golden shots cover the radio states + every session phase.

**Device gate — now built and runnable in-sandbox** (this environment has `/dev/kvm`, the Android SDK/NDK, an x86_64 emulator, and `dfx`; see [[sandbox-can-run-device-gate]]):
- **real dfx deploy** (`just deploy`, `scripts/dfx-deploy.sh`) — a live local replica settles the *exact* offline-signed 192-byte wire via `dfx canister call` (built by `dpay-fixture` from the shared core); funds move, replay refused. `dfx.json` + extracted candid in `dfx/`.
- **NDK build** (`just ndk`, `scripts/ndk-build-ffi.sh`) — `libdpay_ffi.so` for arm64-v8a + x86_64, **16 KB-page-aligned** (Android 15 / Play); auto-detects the newest installed NDK.
- **on-device core** (`just ondevice`) — instrumented tests on the emulator; the phone produces **byte-identical** wire/QR/verify/validate to the host, and drives a full **NFC card↔reader exchange** (`FfiCardSession`↔`FfiReaderConductor`, single-frame + 1-byte-fragmented, phase transitions) so the tap protocol runs on real Android (`android/`, 7 tests green).
- **NFC HCE glue** (in `app/android/.../com/dpay/`) — the real tap transport: `DpayHostApduService` (payer/HCE card, AID `F06470617901` under category `other` via `res/xml/apduservice.xml` → **no Google Wallet clash**), `DpayNfc` coordinator + reader-mode `IsoDep` loop (merchant), `DpayNfcModule` RN bridge (arm/approve/decline/startReader) emitting live `DpayNfcEvent` phases. Both roles are thin loops over the exact core. Compiles + ships in the release APK (merged manifest registers the service); the radio hop between two phones is the one physical-only step left.
- **RN app** (`just app`, `app/`) — React Native 0.75 Pay/Receive app; a Kotlin native module (`DpayCoreModule`) bridges JS → the UniFFI binding → `libdpay_ffi.so`, so the phone signs offline with the real core. Runs on the emulator; a logcat self-check + tap-driven Pay→Approve→Paid✓ screenshots (`app/shots/`) prove it end to end. (Pragmatic bridge module chosen over `uniffi-bindgen-react-native`; see [[device-gate-shipped]].) Header shows an **NFC status chip** (`NfcPill`) fed by a native `DpayCore.nfcStatus()` reading the real `NfcAdapter` (radio on/off/absent; degrades to hidden 'unknown'); `android.permission.NFC` + optional `uses-feature` added. Pay/Receive now also have **Tap-to-pay / Tap-to-collect** entry points (`NfcTap` component) driving the HCE glue and rendering the live tap phase (spinner/success/declined/error) from `DpayNfcEvent`s.

Recipes: `just verify` (core+canister+relay+UI), `just test-live` (relay↔live canister via ic-agent), `just ffi` (UniFFI), `just sim` (demo), `just deploy` / `just ndk` / `just ondevice` / `just app` (device gate). Pinned: ic-cdk 0.19, pocket-ic 14.0.0, ic-agent 0.48.1, uniffi 0.29.5, dfx 0.32.0, RN 0.75.4, AGP 8.7.3, NDK 27.3.13750724.

Remaining for real-hardware fidelity only: run on two physical arm64 phones for the **NFC radio hop** (HCE↔reader) and the two-phone airplane-mode gesture, and a real camera (the demo fakes the scan). Everything protocol-critical — including the full NFC tap state machines — is verified on the emulator; only antenna coupling / OS AID routing between two devices is unproven.

## Scope

- **In:** Android app (Pay + Receive), on-device key, QR generate/scan, offline signing, relay, canister ledger, two pre-funded demo accounts, single `$` unit, the airplane-mode flow.
- **Out (deferred):** iOS, login/KYC, fiat on/off-ramp, funding flow, secure-element hardening, contacts/P2P discovery, multi-merchant, real onboarding. Software keys are fine for the demo.

## Preferences

- Be concise and direct; minimal formatting, no filler.
- Money is always shown as `$`; never surface the stablecoin or ledger in the UI.
- Demo-critical: the relay must be rock solid (idempotency, retries, health check, safe-mode fallback).
