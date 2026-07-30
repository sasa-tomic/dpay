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

## Positioning (main pitch)

**Full doc: `positioning.md`. This is the primary go-to-market story — lead with it.** Summary:

- **Who:** travelers/tourists abroad on no or poor connectivity — foreign SIM, roaming off, or dead signal inside airports, malls, hotels, stadiums, metros.
- **What:** tap-to-pay (NFC) or scan-to-pay (QR) a local merchant; **your** phone never needs a connection.
- **Why it fits perfectly:** dpay lets the **payer** be offline, and the tourist *is* the payer. The design's one asymmetry (someone must be online) is satisfied for free — it's the merchant, who has wifi. The generic "both offline" weakness becomes the selling point.
- **Currencies — multi-*rail*, never a swap.** The merchant's request names the settlement asset; the payer pays that **exact** asset; the canister settles it. dpay never converts one asset to another (no-swap non-negotiable). If the payer lacks the merchant's asset, a **licensed third party** converts at the edge — user authorizes it directly, dpay stays a screen. **USDC is the tourist lingua franca** (no conversion at all). UI shows the **backing native currency symbol** when known (`$`, `€`, `CHF`, `₿`/BTC, `Ξ`/ETH, `◎`/SOL) and only falls back to the wrapper (`ck*`) symbol when the backing is unknown; raw internal ledger/token identifiers (e.g. `DEMO_USD`, `DUSD`, ledger canister ids) are never surfaced.
- **Assets (Jul 2026):** live on IC = ckUSDC (launch rail), ckBTC, ckETH, native ICP. Near-term = EUR via EURC (verify ckEURC). Roadmap/nascent = SOL (no ckSOL yet) and CHF (no ckCHF; thin issuance). "Pay with BTC" = **ckBTC on the IC** (native L1 can't be tap-instant; IC finalizes in ~1–2s).
- **Edge vs Apple Pay/Visa abroad:** their payer must be online *and* they add cross-border FX/interchange; dpay's payer is offline and same-asset settlement has no card-network FX toll.
- **Scope:** PoC stays single-`$`/ckUSDC; multi-currency + tourist framing are the pitch/roadmap on top, not PoC work. Nothing here weakens the non-custodial / no-swap non-negotiables.

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
| backing symbol | the UI shows the asset's backing native currency symbol when known (`$`, `€`, `CHF`, BTC, ETH, SOL); falls back to the wrapper symbol (`ck*`) only when the backing is unknown. Raw ledger/token identifiers are never surfaced. |

## Architecture (PoC)

- **Mobile app** — one React Native app (Android only), Pay + Receive modes; on-device key; QR generate/scan; builds & **signs the authorization fully offline**.
- **Relay** — Node + Express + `@dfinity/agent`; receives merchant submission, calls canister; small idempotency store (in-memory is fine for the demo).
- **Canister (ICP)** — Motoko or Rust (`ed25519-dalek`); verifies Ed25519 sig, checks nonce unused/unexpired, checks amount within balance and cap, atomic transfer, records nonce, returns receipt. Two accounts pre-funded at init.

## Payment flow (decided): two-scan, amount-bound

1. **Merchant (online)** shows a request QR: `{to, amount, request_id, expiry}`.
2. **Payer (offline)** scans it, reviews "Pay $X to <merchant>", approves → signs `Authorization {from, to, amount, nonce=request_id, expiry}` → shows a signed-auth QR.
3. **Merchant** scans the signed-auth QR → submits via relay → canister verifies sig + nonce/expiry/cap/balance, settles atomically → "Paid ✓".

The signature binds the **exact amount + payee + request**, so consent is unambiguous and the merchant-issued `request_id` doubles as the ledger nonce (single-use → no double-charge). Short `expiry` (~2 min) kills stale replays. Rejected: single-scan payer-presented pre-auth (merchant fills the amount) — faster but weaker consent. Deferred: a signed receipt QR back to the payer for offline confirmation.

## Non-negotiable: dpay never holds, swaps, or can move user funds

Hard requirement, **not a preference**. Reject any design that violates it — restructure instead. This is what keeps dpay an *interface*, not a money transmitter / VASP / CASP, and it is why custody, KYC, and licensing stay out of scope.

- **No custody.** The user's key lives on their device. dpay (the company, the relay, any operator) must never hold a user seed, an omnibus account, or funds it can move.
- **No swaps.** dpay does not exchange one asset for another on a user's behalf, and does not quote, route, or take price risk. Ever.
- **No exchange API keys.** dpay must never hold a user's CEX/DEX credentials and must never initiate a trade or withdrawal on a user's account. Holding withdrawal-capable credentials *is* control, and control *is* custody — same liability, plus a credential honeypot. If a third party must move funds, the **user** authorizes it directly with that third party.
- **The canister cannot move funds without a user signature.** No admin transfer, no pause-and-seize, no privileged path. And the controller must not be a company key — blackhole it or hand it to an NNS/SNS-governed controller, or the "we can't touch your funds" claim is a promise rather than a property. Treat "who controls the canister" as a money-critical design question, not ops trivia.

## Funding (on/off-ramp) — the shape, when we get there

Out of scope for the PoC; recorded so no one designs around it wrong. The user always ends up holding a chain-key asset at **their own principal**; dpay is a screen, not a counterparty.

- **Supported asset** → show the user a **native deposit address on that chain** (real BTC/ETH/SOL address). ICP Chain Fusion's ck-minters derive these per-principal via threshold signatures — no bridge, no custodian, and dpay is not in the flow. `ckBTC`'s `get_btc_address(owner, subaccount)` is the model. (ckSOL / per-user Solana deposit addresses: **verify current status before promising it** — the building blocks, t-Ed25519 + the SOL RPC canister, are shipped; a per-principal minter is less certain.) Withdrawal is the mirror: the minter burns and sends to the user's native address.
- **Unsupported asset** → hand off to an **embedded licensed third-party provider** (Onramper/Changelly/Transak-class aggregator) with dpay's deposit address pre-filled as the destination. The provider is the counterparty of record and carries the licensing; dpay supplies an address and shows a status. This is what MetaMask / Phantom / Trust do, and it buys ~the same one-tap UX with none of the liability. A static "go here, then send to X" instruction page is the zero-integration fallback and is equally clean.
- **The user never sees "supported vs unsupported."** One "Add money" screen: pick what you have. Under the hood it's *direct* or *via partner (est. fee + time)*. Same on the way out.

## Monetization — direction

**Full doc: `monetization.md`. Read it before touching anything fee-, handle-, or merchant-account-related.** Summary of what's decided:

- **We monetize the payment rail we built; never movement of funds we don't control.** No cut on swaps, ever. The payer never pays.
- **The free tier is a *mode*, not a dollar amount.** P2P free forever; **merchant mode ~0.5% from dollar one**. (The earlier "$200/mo received free" volume allowance is **superseded** — a mode-based tier deletes the sybil surface instead of tolerating it. A small seller taking payments as a *person* pays nothing; that's the growth engine, and it's fine.)
- **Merchant features are chosen by one test: does the feature lose its value if the merchant splits into five accounts?** Only features that fail-on-split belong in merchant mode — that's what *replaces* sybil resistance. The four: durable merchant handle shown at approval (**never KYC** — claimed handle, not verified identity), multi-device staff terminals, refunds keyed to the original payment, consolidated settlement reports. We're selling *being a business on dpay*, not a feature checklist.
- **Fee collection needs no protocol change.** Payer signs `{from, to, amount, nonce, expiry}` exactly as today; the canister credits merchant `amount - fee` and dpay `fee` per a public fee schedule in canister state. **Do not add a `fee` field to `Authorization`** — it would bind a value the offline payer can't know and wreck the offline path. The offline flow stays untouched.
- **The canister controller is load-bearing.** Whoever can upgrade the canister can set `fee = 100%`, so the revenue model and "we can't touch your funds" are the *same* question: blackhole or SNS/NNS-govern the controller, and make the fee schedule a **governed parameter, not a hardcoded constant**.
- **Open:** keep the relay bypassable/self-hostable (a chokepoint attracts MiCA's "transfer services on behalf of clients" test far more than a convenience does). Settle before the pilot.

None of this is in the PoC.

## Local dev cache & offline (`third_party/`)

Claude and all subagents treat `third_party/` as the canonical local source cache — **look there first; clone any missing repo there (shallow) instead of re-fetching from the network.** Crates are vendored to `vendor/` (`cargo vendor`); the PocketIC **server** binary lives at `third_party/bin/pocket-ic` (v14.0.0) and is referenced via `POCKET_IC_BIN`. The Rust + Node toolchains and a vendored headless browser (`chrome-headless-shell`, because the sandbox's `/usr/bin/chromium-browser` is a non-functional snap stub) install under `.dev/` (kept in-project because the sandbox recycles `$HOME`, so this keeps iteration fast across sessions). `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. Inner-loop builds/tests run fully offline against these.

## What's built (all green offline via `just`; inner loop ~7s)

- **dpay-core** — signing/verify/validate/QR codec, proptests incl. conservation-of-funds + tamper; compiles to wasm with `getrandom` gated out.
  - `nfc` module — pure, panic-free ISO 7816-4/ISO-DEP **transport framing** for the *same* bytes QR carries (request + 196-byte wire): APDU codec, chunking/reassembly, and `CardSession` (payer/HCE) ↔ `ReaderConductor` (merchant) state machines (custom AID, `other` category → no Google Wallet clash; re-tap safe; explicit approve/decline). Exposes a `SessionPhase` + `phase()` on both sides (Idle/Linking/Exchanging/AwaitingApproval/Settling/Complete/Declined) — the live signal a UI status view renders; failures stay typed errors, never a phase. **Full round-trip**: after the wire is served the merchant settles online and hands a `Receipt` (nonce+status: settled/rejected/unreachable) back over the same tap (`PUT_RECEIPT` → card `Confirmed`), so the *offline* payer learns the outcome — the "signed receipt back to payer" that was deferred (unsigned in the PoC; nonce+signature already bind amount/payee, so no over/double-charge). 26 proptests/unit tests incl. a full card↔reader simulation over random payloads/chunk sizes + a real signed wire that survives transit and still `verify()`s + the receipt round-trip (settled/rejected/fragmented) + phase-sequence assertions, all failure paths typed. Transport-only; the radio hop stays a physical device gate.
- **dpay-canister** — ic-cdk ledger; PocketIC tests (happy/nonce/expiry/cap/insufficient).
- **dpay-relay** — axum; idempotency/retries/`/health`/safe-mode over a `Ledger` trait. `FakeLedger` (inner loop) + `AgentLedger` (feature `agent`: real `ic-agent` → live PocketIC HTTP gateway, verified end-to-end).
- **dpay-sim** — narrated, self-checking end-to-end demo (offline sign → canister → Paid ✓ → double-spend refused → expired refused).
- **dpay-ffi** — UniFFI wrapper; a Python roundtrip proves the app calls the *exact* compiled core; Kotlin binding emitted for Android. Now also exports the NFC objects (`FfiCardSession`/`FfiReaderConductor`, `NfcStep` incl. `Confirmed`, `NfcPhase` incl. `Settling`, `phase()`/`is_complete()`/`is_confirmed()`, `provide_receipt`/`receipt`, `nfc_request_bytes`/`nfc_decode_request`/`nfc_receipt_bytes`/`nfc_decode_receipt`/`nfc_receipt_codes`) so the Kotlin HCE service/reader are thin loops over the real core; the Python gate (48 checks) drives the end-to-end card↔reader tap **through the receipt round-trip** (settle→receipt→confirmed, settled + rejected) and asserts the phases the UI shows.
- **e2e/** — the radical harness that drives the **real** `app/App.tsx` (not parallel components) in `react-native-web` + headless chrome against the real test relay (FakeLedger, offline). 15 flows cover every supported path: onboard, faucet, ckBTC deposit (address/instructions/clipboard/**credited via the test-helpers seed**), request-QR decode, scan→pay across two wallets (real ed25519 sig + settle), merchant-settle, double-spend refusal, expired refusal, NFC tap phases (via a `__DPAY_TEST_NFC_SESSION` seam wired to RNW's event bus), settings/reset, graceful offline, and Escape-to-close. The ed25519 signing shim is byte-exact vs the Rust core (`00-cross-val`); the relay + web + browser are shared across tests with a fresh incognito context per test (fresh identity, no cross-test state). Supersedes + **deletes** the old `ui/` parallel-component golden-shot harness (flow screenshots land in `e2e/shots/`).

**Device gate — now built and runnable in-sandbox** (this environment has `/dev/kvm`, the Android SDK/NDK, an x86_64 emulator, and `dfx`; see [[sandbox-can-run-device-gate]]):
- **real dfx deploy** (`just deploy`, `scripts/dfx-deploy.sh`) — a live local replica settles the *exact* offline-signed 196-byte wire via `dfx canister call` (built by `dpay-fixture` from the shared core); funds move, replay refused. `dfx.json` + extracted candid in `dfx/`.
- **NDK build** (`just ndk`, `scripts/ndk-build-ffi.sh`) — `libdpay_ffi.so` for arm64-v8a + x86_64, **16 KB-page-aligned** (Android 15 / Play); auto-detects the newest installed NDK.
- **on-device core** (`just ondevice`) — instrumented tests on the emulator; the phone produces **byte-identical** wire/QR/verify/validate to the host, and drives the full **NFC card↔reader exchange incl. the receipt round-trip** (`FfiCardSession`↔`FfiReaderConductor`, single-frame + 1-byte-fragmented, phase transitions, settle→receipt→confirmed) so the tap protocol runs on real Android (`android/`, 8 tests green).
- **NFC HCE glue** (in `app/android/.../com/dpay/`) — the real tap transport: `DpayHostApduService` (payer/HCE card, AID `F06470617901` under category `other` via `res/xml/apduservice.xml` → **no Google Wallet clash**), `DpayNfc` coordinator + reader-mode `IsoDep` loop (merchant), `DpayNfcModule` RN bridge (arm/approve/decline/startReader/**confirmReceipt**) emitting live `DpayNfcEvent`s (phase/request/done/**receipt**/confirmed/error). **Full loop over one tap**: merchant pushes the request → **payer's phone auto-signs offline (the tap is the consent — no Approve button; contactless tap-to-pay)** → wire returns → merchant settles online (in JS) → merchant hands the receipt back over the held connection → the offline payer's card surfaces the outcome and updates its local status. The amount is shown live ("Paying $X" → "Paid ✓ $X"), just never gated behind a button. Both roles are thin loops over the exact core. Compiles + ships in the release APK (merged manifest registers the service); the radio hop between two phones is the one physical-only step left.
- **RN app** (`just app`, `app/`) — React Native 0.75 Pay/Receive app; a Kotlin native module (`DpayCoreModule`) bridges JS → the UniFFI binding → `libdpay_ffi.so`, so the phone signs offline with the real core. Runs on the emulator; a logcat self-check + tap-driven Pay→Approve→Paid✓ screenshots (`app/shots/`) prove it end to end. (Pragmatic bridge module chosen over `uniffi-bindgen-react-native`; see [[device-gate-shipped]].) Header shows an **NFC status chip** (`NfcPill`) fed by a native `DpayCore.nfcStatus()` reading the real `NfcAdapter` (radio on/off/absent; degrades to hidden 'unknown'); `android.permission.NFC` + optional `uses-feature` added. **NFC + QR run concurrently with no per-payment toggle**: when the radio is ready the Pay screen keeps the HCE card armed *and* the QR scanner live at once (payer taps OR scans), and the Receive screen runs reader mode in the background while the request QR is shown (`NfcTap` renders nothing until a real tap starts, then takes over). The live tap phase (spinner/success/declined/error) comes from `DpayNfcEvent`s.

Recipes: `just verify` (core+canister+relay+e2e), `just test-live` (relay↔live canister via ic-agent), `just ffi` (UniFFI), `just sim` (demo), `just deploy` / `just ndk` / `just ondevice` / `just app` (device gate). (The old `just ui` parallel-component harness is removed — `just e2e` drives the real app + screenshots every flow state.) Pinned: ic-cdk 0.19, pocket-ic 14.0.0, ic-agent 0.48.1, uniffi 0.29.5, dfx 0.32.0, RN 0.75.4, AGP 8.7.3, NDK 27.3.13750724.

Remaining for real-hardware fidelity only: run on two physical arm64 phones for the **NFC radio hop** (HCE↔reader) and the two-phone airplane-mode gesture, and a real camera (the demo fakes the scan). Everything protocol-critical — including the full NFC tap state machines — is verified on the emulator; only antenna coupling / OS AID routing between two devices is unproven.

## Scope

- **In:** Android app (Pay + Receive), on-device key, QR generate/scan, offline signing, relay, canister ledger, two pre-funded demo accounts, single `$` unit, the airplane-mode flow.
- **Out (deferred):** iOS, login/KYC, fiat on/off-ramp, funding flow, secure-element hardening, contacts/P2P discovery, multi-merchant, real onboarding. Software keys are fine for the demo.
- **Out (permanently, by design — not "later"):** custody of user funds, swaps/conversion, holding user exchange credentials, taking price risk. See the non-custodial non-negotiable above.

## Preferences

- Be concise and direct; minimal formatting, no filler.
- Money is shown using the asset's **backing native currency symbol** when known (`$`, `€`, `CHF`, BTC, ETH, SOL); fall back to the wrapper symbol (`ck*`) only when the backing is unknown. Never surface raw internal ledger/token identifiers.
- Demo-critical: the relay must be rock solid (idempotency, retries, health check, safe-mode fallback).
