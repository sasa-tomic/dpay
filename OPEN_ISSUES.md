# dpay — open issues & follow-ups

> **Read this before starting work** on dpay, alongside `CLAUDE.md` and `CODEBASE_ANALYSIS.md`.
> This is the authoritative list of known blockers and documented follow-ups after the verified
> fix-set (R1–R4 + ckBTC top-up + minter-arg + production deploy). Do not infer production
> readiness from the currently-green unit/browser counts: the latest audit found a failing app
> self-check, a stale `dpay-sim`, and major non-dollar paths that the browser suite bypasses. Most
> entries below are **deliberate, documented follow-ups**, not regressions — each carries its current mitigation and the concrete
> next step. Structural detail lives in `CODEBASE_ANALYSIS.md`.

## Severity key

- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.

## Immediate next milestone: complete multi-currency wallet (2026-08-01)

The protocol/canister settlement kernel is currency-aware, but the installed product gives users effectively no indication that other currencies exist. The next milestone is therefore **correct end-to-end asset support plus an asset-first navigation rework**, not a cosmetic currency toggle. The merchant selects the settlement asset; the payer cannot substitute another asset because dpay does not swap.

Work in this order:

1. **MC1 — exact amounts and authoritative asset metadata (high).** Replace JavaScript `number`/Android `Double` transport for protocol `u64` values with decimal strings or another exact representation. Parse user amounts without `parseFloat`/rounding. Expand the catalog to distinguish backing asset code/symbol, wrapper name, network, ledger/display decimals, fee, cap, chain ID/token contract, and per-direction ramp capabilities. Unknown families must fail closed, never fall back to Bitcoin.
2. **MC2 — safe currency identity and policy (high).** Prevent a registered currency ID from being reassigned under an already-reviewed authorization, or bind a versioned immutable asset identity. Activate ledger+metadata+minter atomically and validate metadata against the ledger. Replace the one global raw-unit transaction cap with governed per-currency caps; the ledger fee remains outside the payer authorization.
3. **MC3 — authoritative balances (high).** The wallet balance path must observe ckBTC refreshes, asynchronous ckERC20 mints, and direct ICRC transfers. `BAL_CACHE` may remain an optimization but cannot be the only display source without an explicit refresh/freshness contract. Tests must assert facade/relay balance, not only direct ledger balance.
4. **MC4 — trusted receipts and durable reconciliation (high).** The app must verify receipts against an authenticated/pinned canister key, not the public key supplied inside the same untrusted receipt. Initialize signing before accepting payments, make post-transfer receipt recovery durable, and have relay ambiguous-outcome/restart handling query canister-backed receipt state bound to the authorization, currency, and nonce.
5. **MC5 — asset-first wallet and transaction UX (high).** Show every enabled asset, including zero balances and no-ramp assets. Make the demo rail visibly separate. Add asset detail/actions; require merchant asset selection in Request; lock the payer review to that exact asset and matching balance; key offline deductions by currency; reject unknown assets before signing. No cross-asset portfolio total. **Status (2026-08-01): 🟡 PARTIALLY DONE.** Asset-first wallet (all assets always visible, demo rail separated by an ASSETS heading, fail-closed action buttons), merchant asset selection in Request (per-currency chips, runtime currency encoded), and locked-asset payer review (exact-unit display + per-asset balance gate, no payer asset switching) are done and proven by flows 25 + 27. **Remaining:** NFC asset disclosure/validation (→ MC8), currency-keyed offline deduction (the offline QR hand-off still debits the DEMO `offlineSpent` counter regardless of currency), unknown-asset rejection before signing, and a ckUSDC (6-decimal) end-to-end app flow.
6. **MC6 — dedicated Ledger and cleaner navigation (high).** Move transaction history out of the Pay/Receive scroll into a dedicated Ledger page. Preserve currency in the row model, format each row with its asset descriptor, retain successful per-asset history when another asset fails, and add an asset filter. Move Settings from the detached footer into an intuitive header/account/overflow control with a proper touch target; put relay configuration under an advanced section with an explicit Apply action. **Status (2026-08-01): ✅ DONE.** History lives on a dedicated Ledger tab (`tab-ledger`) with per-row currency-correct units and an asset filter (chips appear when 2+ currencies are present); `Txn` carries `currency`; Settings moved from the detached footer to a header gear control; relay URL demoted to an Advanced section with an explicit Apply button. Proven by flows 07/08/24/26 (Ledger) + 12/13/19/20/22 (Apply).
7. **MC7 — remove zombie primary actions (medium).** Remove the prominent `Paste request` button from the main Pay screen. Keep clipboard decode only as a subordinate scan fallback if no-camera/desktop/support usage justifies it; otherwise delete it and update flow coverage. The primary Pay entry remains tap or scan. **Status (2026-08-01): ✅ DONE (demoted).** Paste is now a muted ghost secondary control (`pasteSecondary`) instead of a prominent brand-green primary; `btn-paste` + flow 14 retained pending a founder decision on full deletion.
8. **MC8 — native/NFC parity and honest ramps (high).** Repair Android bridge parity (`toName`, `memo`, full signing arguments, withdrawal signing, exact amounts). NFC must disclose and validate the requested asset. Make ckERC20 parameters token-specific, enforce chain ID, persist transaction state, wait for receipts/reverts, and provide an Android wallet/partner handoff. Do not advertise CkSol or unsupported cash-out paths.
9. **MC9 — release gates and operations (high).** Add request→QR/NFC→settle→receipt→balance/history coverage for 2/6/8/18-decimal assets, FakeLedger/canister conformance, Android bridge tests, declarative atomic asset deployment, per-asset readiness/metrics, and real outer-loop ckBTC+ckUSDC runs before pilot. Make `DPAY_SELFCHECK FAIL` a failing gate and repair `dpay-sim`.

Milestone acceptance: a fresh install visibly exposes configured assets; a merchant can request ckBTC or ckUSDC; a payer sees the exact unit and matching balance; settlement, receipt, Ledger row, and resulting balance all retain that asset; unsupported funding/cash-out paths are explicit and never route through another family.

## Other open issues

### 1. (low) ckBTC live deposit→mint not yet exercised with real BTC

- **What/why.** No KYC/NNS allowlist is required to mint ckBTC — the mainnet ckBTC minter (`mqygn-kiaaa-aaaar-qaadq-cai`) runs in GeneralAvailability mode with **no KYC checker** (`get_minter_info` returns only `min_confirmations=4`, `kyt_fee=100`, `deposit_btc_min_amount=300`, `retrieve_btc_min_amount=50000`; the `btc_checker_principal` is unset). The minter's `UpdateBalanceError` has no "not allowed"/KYC variant; the only screening is automatic **KYT (Know-Your-Transaction)** that flags tainted *UTXOs*, not principals. A previous version of this issue incorrectly claimed a hard KYC/NNS blocker — that was an **unverified assumption**, disproven by the live minter config and by the facade's own `get_btc_address`/`update_balance` calls succeeding against mainnet.
- **Current state.** The full mint/spend path is proven **offline end-to-end** (PocketIC + `dpay-mock-minter` + `FakeLedger`). Live, the wiring is proven reachable: `GET /deposit/address?currency=1` → 200 real `bc1...` address; `POST /deposit/refresh` → 200 `NoNewUtxos`; `GET /deposit/info` → 200. A clean, real BTC deposit (≥300 sats, 4 confirmations) should mint currency 1 to `Account{owner: facade, subaccount: pubkey}`, which `pay()` reads authoritatively. The current `balance_of` display query can remain stale because `refresh_deposit` does not refresh `BAL_CACHE`; that separate product blocker is MC3.
- **Next step.** After MC3 defines the authoritative display path, send a small on-chain deposit, wait 4 confirmations, trigger `refresh_deposit`, and verify the direct ledger balance, relay/app balance, payment spend, and Ledger history all agree. This costs real BTC and is a final outer-loop gate before pilot.

### 8. (low) ckBTC live withdrawal not yet exercised with real BTC

- **What/why.** The withdrawal path (facade `withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`) is built and proven **offline end-to-end** (PocketIC through the real facade + `dpay-mock-minter` mirroring the real minter's exact candid; the relay's `FakeLedger`/route; the app's on-device-signed `WithdrawSheet`; e2e flow 15). It has NOT been exercised with real ckBTC against mainnet — there is no real ckBTC held at a facade subaccount to withdraw yet (issue 1's live deposit is the prerequisite). The wiring is proven reachable up to the minter (same as deposit); the live ceiling is "reaches `retrieve_btc_with_approval`".
- **Current mitigation.** Non-custodial by construction: `withdraw` moves nothing without a verified user Ed25519 signature over the canonical `WithdrawAuth` (single-use nonce in `WITHDRAW_NONCES`, MemoryId 12 → no double-burn). `RETRIEVE_BTC_MIN_AMOUNT = 50_000` mirrors the live minter's floor.
- **Next step.** (Optional, costs real ckBTC/BTC) Fund a facade subaccount with real ckBTC (via issue 1's live deposit), then withdraw ≥50_000 sats to a real BTC address and confirm the burn + on-chain BTC send. A final real-money confidence check, not a blocker.

### 9. (medium) Withdrawal approve→retrieve front-running residual (inherent to ckBTC)

- **What/why.** The facade's `withdraw` calls `icrc2_approve` then `retrieve_btc_with_approval` across an `await`. In principle a separate caller could invoke the minter's permissionless `retrieve_btc_with_approval` with the same subaccount + an attacker address in the gap, consuming the single-use allowance first. See CODEBASE_ANALYSIS risk 8.
- **Current mitigation.** Blast radius is bounded to the EXACT authorized `amount` (the approval is for that amount, consumed once) — never the user's whole balance. The facade's own retrieve follows immediately. This is the documented residual every `retrieve_btc_with_approval` client (incl. the NNS reference clients) carries; the minter offers no signature-binding-the-destination path, so no code fix is possible without a minter change. It is a known, bounded property, not a dpay-specific gap.
- **Next step.** Track ckBTC minter upgrades for a destination-bound retrieve variant; none exists today.

### 2. (high) Receipt signing exists, but the app does not authenticate the signer

- **What/why.** R2 added a canonical Ed25519-signed receipt and the canister exposes `receipt_pubkey()`, but the app currently verifies each receipt against the public key carried inside that same untrusted receipt. A malicious relay can therefore create its own key, claim, and signature that pass this self-consistency check. Separately, the real canister key is generated from `raw_rand` and stored in stable memory (`RECEIPT_SECRET`, MemoryId 10), so a malicious upgrade could exfiltrate it.
- **Current mitigation.** The canonical claim and canister signing/storage path are implemented and tested; tampering with a receipt under a known expected key fails. This is useful protocol plumbing, but it is not an authenticated client trust anchor until the expected key is obtained independently.
- **Next step.** Complete MC4: authenticate or pin the expected canister signer independently of the receipt, close the post-transfer receipt/recovery gap, and migrate to **IC chain-key** (`sign_with_schnorr` / `sign_with_ecdsa`) before pilot so no exportable secret lives in canister state.

### 3. (high) R4 external governance hand-off pending

- **What/why.** The IC-level *code controller* of the facade canister has not yet been handed to an SNS root or a blackhole. The code now fully supports a governed controller end-to-end (R1/R4: admin methods denied when `controller == null`, `InitArg.controller` seeds a governed principal at deploy, `set_controller` is two-step rotation) and `docs/GOVERNANCE.md` documents the exact operator steps. But until the external IC-level transfer actually lands, "we can't touch your funds" is a **promise, not an enforced property** — whoever holds the deploy key can still upgrade the wasm.
- **Current mitigation.** Controller currently locked to the `dpay` deploy identity; in-canister admin surface is closed (issue-context). Two distinct layers documented in `docs/GOVERNANCE.md` (in-canister `CONTROLLER` gates admin *methods*; IC-level code controller gates *upgrades* — both must be governed).
- **Next step.** Operator performs the SNS/blackhole transfer per the `docs/GOVERNANCE.md` pre-pilot checklist **before any pilot**.

### 4. (medium) `ADMIN_CALLERS` operator allowlist is the fixed deploy identity

- **What/why.** Cycles/admin operations (`provision_ledger_canister`, `transfer_cycles`) are gated to a hardcoded `ADMIN_CALLERS` operator allowlist — the fixed deploy identity, not a governed/rotatable principal.
- **Current mitigation.** These are ops/cycles functions only (not money-movement of user funds); bounded blast radius. Documented in `docs/GOVERNANCE.md`.
- **Next step.** Rotate `ADMIN_CALLERS` to a governed principal before pilot (`docs/GOVERNANCE.md` checklist).

### 5. (medium) R3 reconcile is bounded

- **What/why.** `reconcile(currency)` — which closes the cross-canister `pay()` trap window (R3) — is single-currency, walks recent in-canister blocks (`RECONCILE_MAX_BLOCKS` = 10k window), and is admin-triggered (not a heartbeat). Archived-block paging and automatic heartbeat triggering are deferred.
- **Current mitigation.** This is a **cycle-cost/operations tradeoff, NOT a correctness gap.** The trap window is already narrowed by the quantized `created_at_time` dedup (same-bucket retry → ledger `Duplicate`); reconcile is idempotent and admin-gated, so an operator can run it after any suspected trap or on a schedule. Proven on PocketIC via a reinstall-based trap simulation.
- **Next step.** Add a heartbeat auto-trigger + archived-range paging as scale/cycle-cost demands.

### 6. (high) App does not expose functional multi-currency payments

- **What/why.** 🟡 **PARTIALLY RESOLVED (MC5 Slice 7a + 7b, 2026-08-01).** `ReceiveMode` no longer hardcodes currency 0 — it exposes a per-currency chip row (`request-asset-<key>`) and encodes the runtime-selected currency into the request via the new `toUnits(amount, decimals)` parser. `PayMode`'s review + Paid + QR hand-off paths format amounts with the new shared `fmtCurrencyAmount(catalog, currency, raw)` (no `usd()` for non-DEMO amounts), and the balance check uses ONLY the requested asset's balance (`assetBalances[req.currency]`), so a 50000-sat ckBTC request is no longer compared against the 10000-cent DEMO balance. Proven end-to-end by flows `25-asset-request` (currency 1 encoded + "0.00050000 BTC" readout, no `$`) and `27-asset-pay` (locked-asset review + per-asset balance gate + correct settlement on currency 1's ledger). **Still single-currency / open:** NFC (`NfcTap` still formats amounts as `$` on the card-auto-sign path; flow 11 injects phase events only), the offline `markOfflinePaid` reducer still adds to the DEMO `offlineSpent` counter regardless of currency (the offline QR hand-off path's deduction is wrong for non-DEMO currencies — a known partial), unknown-asset rejection before signing, and currency-keyed offline state (MC5 remainder). The protocol can route ckBTC; the app now safely requests, reviews, validates, and presents it ONLINE end to end.
- **Current mitigation.** The canister routes ledgers independently and rejects cross-currency funding, so the settlement kernel does not silently swap. The ONLINE app payment path (request → scan → review → settle) is now multi-currency; the OFFLINE optimistic deduction path is still single-currency (documented partial).
- **Next step.** Implement the MC5 remainder: NFC asset disclosure + currency-keyed offline state + unknown-asset rejection. Make `NfcTap` currency-aware (display + balance gate). Add the resulting Ledger row's exact-units assertion post-settle, and a ckUSDC (currency 2, 6-decimal) end-to-end app flow.

### 7. (high) Runtime catalog foundation exists, but config-only asset addition is not safe

- **What/why.** M0 removed the original hardcoded deposit currency and shipped `currencies()`, but the descriptor is too weak for arbitrary assets. Token-specific facts are incorrectly attached to minter families, every `CkEthErc20` displays as USDC, unknown/`CkSol` families can fall back to BTC, and another ckERC20 still requires relay/app code. Registration is three non-atomic mutable writes and metadata is not validated against the ledger. The AsyncStorage cache is global rather than relay/network scoped and has no revision/TTL.
- **Current mitigation.** The live 0/1/2 catalog works for its narrow known configuration. It is a discovery foundation, not proof that adding a currency is config-only.
- **Next step.** Complete MC1/MC2: richer asset/capability metadata, source-scoped versioned cache, strict validation, immutable ID semantics, and atomic activation. Remove “config-only” claims until an additional ckERC20 and a no-minter ICRC asset pass the same app/relay/canister conformance suite without code changes.

### 10. (high) Wire/arity regressions ship to the device because no enforced gate exercises the real RN bridge

- **What/why.** The 2026-07-31 wire-format v2 wave grew `signAuthorization` (6→9 JS params) and the wire (196→292 B). `just verify` (core+canister+relay+e2e) stayed GREEN and shipped a release that **crashed on launch on a physical device** (`NativeArgumentsParseException: DpayCore.signAuthorization got 8 arguments, expected 11`). Three failures lined up: (a) the TS `signAuthorization`/`encodeRequest` name params were declared **optional** (`fromName?/toName?/memo?` in `app/lib/types.ts:40-41`), so `App.tsx:68`'s stale 6-arg call compiled; (b) **no `tsc` typecheck exists anywhere** (`app/package.json` has only eslint/jest; `justfile` has zero tsc refs; the e2e builds via Vite/esbuild which strips types without checking); (c) the e2e suite drives a JS **shim** (`e2e/web/dpay-core.ts`), not `libdpay_ffi.so` or the Kotlin `@ReactMethod` — `just app` (the ONLY gate exercising the real bridge) is not in `just verify` and was never re-run after wire-v2. A wrong JS→Kotlin argument count throws on the native-modules thread, bypassing the JS self-check's try/catch, so it is a hard process kill at startup, not a caught error. Separately, `App.tsx:69` had a hardcoded magic `392` (rotted from the pre-v2 wire hex; real value is `584`=292×2), and `signWithdrawal` has **no** Kotlin `@ReactMethod` (declared at `types.ts:48`, called at `WithdrawSheet.tsx:60`) → withdrawal is silently broken on Android (a pre-existing MC8 instance).
- **Current mitigation.** The launch crash is FIXED and verified on the physical device (see changelog below): `App.tsx` + `NfcTap.tsx` call sites pass the full 9 args. **Static hardening Layers 1, 2, 4, 5 are now SHIPPED** (2026-08-01) and enforced in `just check`/`verify`:
  - **L1 — strict types + typecheck gate (DONE).** `signAuthorization`/`encodeRequest` name params are now REQUIRED in `app/lib/types.ts`; `app/package.json` has `"typecheck": "tsc --noEmit"`; `just typecheck` runs in `check`. Arity drift is now a compile error in the ~2s offline inner loop.
  - **L2 — bridge-parity assertion (DONE).** `scripts/bridge-parity.mjs` parses `@ReactMethod` arity from both Kotlin modules and asserts it equals the `DpayCoreApi`/`DpayNfcApi` TS-interface arity (both directions); `just bridge-parity` runs in `check` (<1s). It also surfaced + closed a latent gap: `validate` was a `@ReactMethod` with no TS-interface declaration (now declared).
  - **L4 — magic-number-free self-check (DONE, static + runtime-confirmed).** `wire_len()`/`signing_len()`/`request_len()` exposed from the FFI; `App.tsx` derives `expectedHexLen = (await DpayCore.wireLen()) * 2` — the `584` literal is gone. Kotlin `wireLen`/`signingLen`/`requestLen` `@ReactMethod`s + the e2e shim's `wireLen` added. **Runtime-confirmed (2026-08-01, Wave B):** `just app` → `DPAY_SELFCHECK PASS` on the emulator drives `wireLen()` through the real `DpayCoreModule`→`libdpay_ffi.so` bridge (was previously proven statically + via the e2e shim only).
  - **L5 — `signWithdrawal` `@ReactMethod` (DONE, static + runtime-confirmed).** Added to `DpayCoreModule.kt`; withdrawal is no longer silently `undefined` on Android. L2 keeps it in parity automatically. **Runtime-confirmed (2026-08-01, Wave B):** `just app` → `DPAY_SELFCHECK PASS` exercises the full `DpayCoreModule` bridge surface; `signWithdrawal` is now in the runtime-confirmed set alongside `signAuthorization`/`wireLen`.
  - **L3 — emulator bridge gate (ALIVE + GREEN; CI wiring open).** The gate itself (`just ondevice`, 8 instrumented tests driving the real UniFFI binding on the emulator) was **DEAD** — `scripts/android-ondevice.sh` hardcoded a stale cached `gradle-8.9-bin` lookup, but only gradle `8.8-all` + `8.12-all` are cached here, so the script failed at `set -euo pipefail` (exit 2) before ever running a test. **FIXED (2026-08-01):** the script now auto-selects the newest cached gradle distribution with an explicit `>= 8.9` floor check (AGP 8.7.3 requirement), so the gate actually runs. With it alive it surfaced **2 pre-existing NFC instrumented failures** the dead gate had been hiding — both wire-v2 chunking rot, now fixed (see Wave B note below). `just ondevice` is **8/8 GREEN** and `just app` is **`DPAY_SELFCHECK PASS`**. The only piece still OPEN is the **ops/CI step**: wire a path-filtered pre-merge trigger for changes touching `app/android/**`, `crates/dpay-ffi/**`, `app/lib/types.ts`, or the core wire consts (off the hot `verify` path for unrelated changes). The gate code path itself is proven and green.
- **Next step (authoritative spec: `2026-08-01-device-bridge-parity-plan.md`).** Ship the 5 defense-in-depth layers, any one of which would have caught this crash:
  1. ✅ **DONE — Strict types + typecheck gate.** Required params + `just typecheck` in `check`.
  2. ✅ **DONE — Bridge-parity assertion.** `scripts/bridge-parity.mjs` + `just bridge-parity` in `check`.
  3. **🟡 ALIVE + GREEN — CI wiring open (Wave B).** The emulator gate (`just ondevice`, 8 instrumented tests) was **dead** due to a stale hardcoded gradle version in `scripts/android-ondevice.sh`; now fixed (auto-selects newest cached gradle with a `>=8.9` floor). With the gate running, 2 NFC instrumented tests with wire-v2 chunking rot were surfaced and fixed (see the Wave B note below); `just ondevice` is **8/8 GREEN** and `just app` is **`DPAY_SELFCHECK PASS`**, which re-confirms L4 (`wireLen` runtime) + L5 (`signWithdrawal` runtime) through the real bridge. **Only the ops/CI piece remains:** wire a path-filtered pre-merge trigger for `app/android/**`, `crates/dpay-ffi/**`, `app/lib/types.ts`, or core wire-const changes (off the hot `verify` path for unrelated changes).
  4. ✅ **DONE — Magic-number-free self-check.** FFI `wire_len()`; `App.tsx` derives the hex length from `wireLen()` (no literal).
  5. ✅ **DONE — `signWithdrawal` `@ReactMethod`.** Added to `DpayCoreModule.kt`.

### Wave B note (2026-08-01) — emulator gate resurrected; 2 NFC wire-v2 failures root-caused + fixed

`just ondevice` had been **silently dead**: `scripts/android-ondevice.sh` hardcoded a lookup for a cached `gradle-8.9-bin` distribution, but only `gradle-8.8-all` + `gradle-8.12-all` are cached in this environment, so the script exited 2 at `set -euo pipefail` before running any test — the gate reported nothing and gave zero coverage. **Fixed:** the script now auto-selects the newest cached gradle with an explicit `>= 8.9` floor check (AGP 8.7.3 requirement).

With the gate alive it surfaced **2 pre-existing NFC instrumented-test failures** the dead gate had been hiding (both in `DpayNfcInstrumentedTest.kt`, a consequence of the 2026-07-31 wire-format v2 growth 196→292 B). Root cause of each (decided by RED-first host coverage, not assumption):

- **`phaseSequenceOnDevice` — STALE TEST (not a core bug).** It asserted one `reader.handleResponse(card.process(reader.nextCommand()))` yielded `DONE`, but a 292-byte wire at `DEFAULT_MAX_CHUNK=240` spans `⌈292/240⌉ = 2` frames, so the first pull returns `CONTINUE`. The host Python (`test_ffi.py` wire-pull loop) and core Rust (`phase_tracks_the_exchange`) already loop `CONTINUE→DONE`; the instrumented test was a stale single-command assumption. **Fix:** loop `CONTINUE→DONE` (host parity).
- **`signedWireSurvivesExchangeAndVerifies` — impossible test config (not a core bug).** It looped `mc ∈ {240, 1}`, but `mc=1` on a 292-byte wire needs 292 frames > `MAX_FRAMES=256` (the NFC frame `seq` is a single byte). **RED-first proof:** adding `mc=1` to the core `signed_wire_survives_nfc_and_verifies` test fails *identically* with `Frame(TooManyFrames)` at `provide_wire`; this is a correct, documented protocol limit (nfc.rs:1623), not a fixable core bug — widening it would require a frame-header format change (out of scope). **Fix:** aligned the instrumented chunk floor to `mc=2` (146 frames ≤ 256), matching the host Python `(MAX_CHUNK, 2)` and core `[240, 64, 7, 2]` floors; added an `mc=1 → TooManyFrames` rejection pin to BOTH host tests (core Rust + Python) so the boundary is now explicitly asserted rather than just commented, and replaced the instrumented test's hardcoded `292` with the FFI-exposed `wireLen()` (no magic numbers).

Gates (all GREEN): `just ondevice` 8/8; `just app` `DPAY_SELFCHECK PASS` (runtime-confirms L4 `wireLen` + L5 `signWithdrawal` through the real `NativeModules` bridge); `just test-core` 38/38; `crates/dpay-ffi/verify.sh` 65/65; `just verify` (core + canister + relay + typecheck + bridge-parity + e2e 28/28). **Remaining ops piece:** the path-filtered CI trigger that *runs* `just app`/`just ondevice` on bridge/wire/types changes (the gate code path itself is proven and green).

## Resolved this session (changelog)

The following previously-open risks are now **CLOSED** (see `CODEBASE_ANALYSIS.md` for detail):

- ✅ **Open `mint()` / admin surface** → closed (R1): admin ops denied when `controller == null`; self-service `faucet` (fixed amount, rate-limited) is the demo on-ramp; relay `Ledger::mint` removed.
- 🟡 **Unsigned receipt primitive** → signing shipped (R2), but signer authentication and durable recovery are reopened under MC4. The embedded receipt public key is not itself a trust anchor.
- ✅ **`pay()` cross-canister trap window** → closed/bounded (R3): admin-gated `icrc3` `reconcile(currency)` repairs trap-orphan debits; idempotent; PocketIC-proven.
- ✅ **ckBTC deposit unreachable in prod** → closed: the ckBTC minter call is now encoded as ONE record argument (was a 2-positional trap); proven LIVE — `GET /deposit/address?currency=1` returns a real `bc1...` address and the mint path is open (no KYC blocker; see issue 1).
- ✅ **minter-arg trap** → closed: facade encodes a single candid record arg to the ckBTC minter; mock aligned; an honesty-guard test fails if either reverts to the 2-tuple shape.
- 🟡 **ckBTC card discoverability** → the wallet can fetch currency 1 and render a separate Bitcoin card, but authoritative post-deposit display freshness is reopened under MC3 because production credits can bypass `BAL_CACHE` refresh.
- ✅ **e2e harness** → 15/15 flows driving the REAL app; relay isolated into `.dev/target-e2e` (clobber-proof) with a latent stale-binary build gate fixed (always invokes `cargo build`); parallel flow pool (~60s → ~13s, concurrency-safe, no assertions weakened). Old `ui/` parallel-component harness deleted.
- ✅ **NFC seam** → audited true: rides RNW's real `RCTDeviceEventEmitter` singleton (not a private registry).
- ✅ **Device launch crash (wire-v2 arity)** → FIXED + verified on a physical device (Redmi/POCO duchamp, arm64). Root cause: `signAuthorization` grew to 9 params in wire-v2 but `App.tsx:68` (self-check) and `NfcTap.tsx:186` (autoSign) still called with 6 → `NativeArgumentsParseException` killed the process on the native-modules thread before the JS self-check could catch it. Fix: both call sites pass the full 9 args (empty names where the NFC request event carries none); `App.tsx:69` literal corrected `392`→`584` (WIRE_LEN 292 × 2). Verified: `just app` → `DPAY_SELFCHECK PASS` in logcat, process alive, onboarding screen renders. The **structural gap** (no gate catches this) remains as issue 10 + the `2026-08-01-device-bridge-parity-plan.md` hardening plan.

## Resolved this wave (W2/W3/W4)

- ✅ **Withdrawal one-way valve** → closed (W2): the facade can now move ckBTC OUT to a native BTC address on a verified user Ed25519 signature (`withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`; new `WithdrawAuth` wire type in dpay-core, `WITHDRAW_NONCES` MemoryId 12). Proven offline on PocketIC + the real app/relay/e2e (flow 15). Live real-money withdrawal is a documented follow-up (issue 8), not a blocker.
- ✅ **FakeLedger-vs-canister audit** → closed (W3): `FakeLedger.pay` now mirrors the canister's self-transfer + pay-to-mint-sentinel rejects (the two divergences found; both fixed + pinned by tests). The fee divergence is a documented accepted simplification (FakeLedger is the fee-less demo ledger).
- ✅ **Relay deploy-fidelity** → closed (W4): `build.rs` bakes the git commit; `GET /api/v1/version` exposes it; `just verify-relay` compares the live commit to HEAD (MATCH / BEHIND-N / MISMATCH). Feature-unconditional (in the prod image). The residual front-running risk of approve→retrieve is documented (issue 9 / risk 8) — inherent to ckBTC, not a dpay gap.

## Wire-format v2 (2026-07-31) — closed N6 + H3

- ✅ **N6 (counterparties as raw hex) → RESOLVED**, and ✅ **H3 (history hex) → RESOLVED**, by wire-format v2
  (commits b1c67fc…6bcc754). `from_name`/`to_name`/`memo` (32 B each, UTF-8 NUL-padded) were folded INTO the
  signed `Authorization::signing_bytes` (SIGNING_LEN 100→**196**); `to_name`/`memo` also ride the
  `PaymentRequest` (REQUEST_LEN 68→**132**); the wire is now WIRE_LEN=**292**. The signature binds the names
  so a relay/merchant can't swap them post-sign; they thread through the canister `TxnRecord` (196 B fixed) +
  relay `/history` so both wallets render friendly counterparties + memo instead of raw hex. The out-of-band
  `|name` QR suffix is deleted (the name is now in the request bytes — single source of truth). N6 was
  previously "deferred (core wire change)" and H3 "mitigated" via `short()` — that change has now shipped, so
  both are fully RESOLVED (not just mitigated). `short()` stays only as the empty-name fallback. Mint-sentinel
  history rows use empty names; the app special-cases `MINT_HEX`. `ReceiptClaim` (108 B) and `WithdrawAuth`
  are unchanged. Proven end-to-end by e2e flow `26-names-memo` (suite now 28/28 GREEN).

## UX review findings (2026-07-30)

> **Status (F-wave, commit bb315ba):** N2/N4/N5/N7/N8/N9/N10 + UX-V2/V3 are **FIXED** (SettingsSheet
> with reset-confirm; faucet moved off header + label/amount corrected + real cooldown surfaced; mint
> sentinel labeled "Demo funds"/"Withdrawal"; deposit error distinguishes no-minter vs transient;
> onboarding testID + Enter-to-create; header right-padding; paste-request affordance). N3 deploy
> blocker fixed (`scripts/dfx-deploy.sh` sets controller before `register_ledger`). **Deferred:** N1
> (FakeLedger has no rate-limit — accepted simplification; real cooldown is surfaced in the UI); ~~N6
> (counterparties are raw hex — needs the username carried in the signed payload, overlaps with a core
> wire change)~~ ✅ **N6 RESOLVED 2026-07-31 (wire-format v2)** — names + memo now ride the signed
> `Authorization` + canister `TxnRecord` + relay history (see N6/H3 below); UX-V5 full single-key
> shortcuts (only Enter-to-create shipped; polish). ✅ **UX-V5
> FIXED (1b):** full keyboard surface shipped — `useHotkeys` (single source of truth; `useEscapeToClose`
> delegates to it) wires P=Pay / R=Receive / T=Top-up / A=Add money on the Wallet main view (input +
> sheet-open guarded; web-only), with always-visible-but-subtle on-UI hint badges on each target.
>
> From a NO-MOCK UX review: the REAL web app (`app/App.tsx`, react-native-web) driven through
> chrome-cli against the REAL canister (facade + ic-icrc1-ledger on a local dfx/PocketIC replica) via
> the relay's `AgentLedger` (`--features agent`). Every money path (onboard/faucet, two-wallet
> Pay→settle→Receive, history, offline, reset) ran against the real ledger — only the camera scan is
> shimmed (the sanctioned smallest-boundary seam; decode/sign/verify/settle are all real). Screenshots
> in `e2e/shots/` + this session's `/tmp/ux/`. The e2e harness uses `FakeLedger`, which **masks** two
> of the divergences below (N1/N2) — those are invisible to `just e2e`.

### CONFIRMED already-known seed items (from `2026-07-30-ux-e2e-radical.md`)
- **UX-V2 CONFIRMED** — a `LEDGER` settings bar (the `settings-relay` TextInput seeded with the relay
  URL, e.g. `http://127.0.0.1:8787`) + a bare red `reset` link sit on the MAIN wallet screen. Dev-facing.
- **UX-V3 CONFIRMED** — `reset` wipes the on-device identity with **NO confirmation**: one tap →
  `AsyncStorage.removeItem` → straight back to onboarding (verified: identity gone, onboarding shown,
  no dialog). A user loses access to the funds at that pubkey irreversibly.
- **UX-V4 CONFIRMED → ✅ RESOLVED (2026-08-01)** — the crowded header (`$balance` + `+$50` outline pill +
  filled `＋ Add money` sharing one right-aligned row, Add-money edge viewport-kissing at 389/390 px) is gone.
  The main-screen `Add money` button + asset rail are removed; the header now shows ONE current-currency
  balance (tap → Balances sheet to switch currency / fund / cash out). Funding consolidated into the
  Balances sheet. Also closes N9 (Add-money glow clip — the button no longer exists).
  share one right-aligned row; the `Add money` right edge lands at 389/390 px (viewport-kissing).
- **UX-V5 CONFIRMED → ✅ FIXED (1b)** — only `Escape` was wired (`useEscapeToClose`, sheets only); no
  global shortcuts (no Enter-to-submit on onboarding/amount, no T/A/R action keys), and the only
  on-UI hint was "Press Esc to close" inside the deposit/withdraw sheets. **Now resolved:** the
  wallet is fully keyboard-driveable (P/R/T/A + Esc) via `useHotkeys`, with on-UI hint badges.
  *(2026-08-01: **A** now opens the Balances sheet — the sole funding/balance surface — instead of the
  old asset-picker/Add-money; see UX-V4.)*
- **UX-V1 REJECTED** — the `＋ Add money` button text is **NOT truncated** at standard balances
  (`scrollWidth == clientWidth == 111`; full "＋ Add money" renders). The original "+ Add mo" claim is
  not reproducible. Reframed as the edge-kissing/glow-clip issue N9 (P3).

### NEW findings
- **N1 (high) | functional | wallet header | The `+$50` faucet top-up button is BROKEN against the real
  canister for ~1 hour after onboarding.** Onboarding consumes the canister faucet's once-per-hour
  slot (`FAUCET_COOLDOWN_SECS = 3600`); the `+$50` button calls `/api/v1/faucet` again and the canister
  rejects it (`"faucet cooldown: try again in ~58 min"` → 422). The app then shows "Faucet unavailable"
  and the balance is unchanged. Reproduced live. The e2e harness (`FakeLedger`) has **no rate limit**,
  so flow 02-faucet passes while the real path fails — a false-confidence divergence.
  *Fix:* surface the cooldown (the canister already returns the retry time) and either disable the
  button while cooling down, or make the demo top-up a separate non-rate-limited path. Reconcile
  FakeLedger's faucet with the canister's (rate-limit + fixed-amount) so e2e catches this.
- **N2 (medium) | functional | wallet header | The `+$50` button would mint `$100`, not `$50`, even when
  it works.** The canister `faucet(blob, nat32)` has **no amount parameter** and mints the fixed
  `FAUCET_AMOUNT` ($100); `AgentLedger::faucet` takes `_amount` and discards it. `FakeLedger` honors the
  requested 5000 ($50). So the button's label is wrong against the real ledger.
  *Fix:* either let the canister faucet honor a capped requested amount, or relabel the button to the
  fixed amount and stop sending `amount`.
- **N3 (high) | functional/deploy | canister | `register_ledger` is DENIED in open-demo mode
  (`controller == null`)**, returning `"admin ops disabled: no controller set"`. This **breaks the
  documented `scripts/dfx-deploy.sh`**, which installs the facade with `ledgers = vec {}` then relies on
  an open `register_ledger` call. It also contradicts `CODEBASE_ANALYSIS.md` and the `.did` comment
  ("open only when controller is unset, i.e. the demo") — R1 actually locks down ALL admin ops when the
  controller is null. Verified live (register_ledger → Err until a controller was set via `set_controller`).
  *Fix:* either seed the ledger at `init` (correct for `dfx-deploy.sh`), or fix `dfx-deploy.sh`/docs to
  set a controller first. Correct the `.did` + `CODEBASE_ANALYSIS.md` comments.
- **N4 (medium) | visual | history + receipt | The faucet mint surfaces as a transaction `from ffffffff…`
  (the raw `MINT_ACCOUNT` 0xFF sentinel).** Internal protocol data leaks to end users as a
  counterparty. *Fix:* label mint/burn rows as "Faucet"/"Demo funds" (or hide them) instead of the hex
  sentinel.
- **N5 (medium) | flow | wallet header | "Faucet unavailable" discards the helpful reason.** The canister
  returns `"faucet cooldown: try again in ~58 min"`; the app maps any non-OK to the generic "Faucet
  unavailable" (App.tsx `topUp`). The user gets no clue why or when to retry. *Fix:* surface the relay's
  error body (or parse "cooldown … ~N min").
- **N6 (medium) | flow/a11y | pay/receive success + history | Counterparties are shown as raw truncated
  hex pubkeys** ("from d082b3af…", "to d7011269…"). The request QR carried the username out-of-band,
  but the *signed payload* only carried the from-pubkey, so the merchant/recipient never learned the
  payer's name (Alice saw "Received $25.00 from d082b3af…" for Bob). ✅ **RESOLVED (2026-07-31,
  wire-format v2)** — `from_name`/`to_name`/`memo` (32 B each, UTF-8 NUL-padded) now live INSIDE the
  signed `Authorization::signing_bytes`; `to_name`/`memo` ride the `PaymentRequest`. The signature
  binds them (a relay/merchant cannot swap a name post-sign), and they thread through the canister
  `TxnRecord` + relay history so both sides render friendly counterparties. The old out-of-band
  `|name` QR suffix is deleted (name is now in the request bytes — single source of truth). Proven
  end-to-end by flow `26-names-memo`.
- **N7 (low) | flow | deposit sheet | The deposit error misleads.** With no ck-minter registered for
  currency 1, the sheet shows "Could not reach the ledger for a deposit address / Check the relay is
  reachable, then reopen the sheet" — but the real cause is "currency 1 has no ck minter" (a deploy
  invariant), not relay reachability. *Fix:* distinguish 503-transient from "no minter" and message it.
- **N8 (low) | flow | onboarding | Empty username defaults to "me".** A generic placeholder identity;
  the plan already flagged "username default" as a harness/UX gap. The username `TextInput` also has no
  `testID` (only a placeholder), so it is harder to target for a11y/harness. *Fix:* require a name or
  pick a less generic default; add a testID.
- **N9 (low) | visual | wallet header | The `＋ Add money` button's drop shadow/glow is clipped at the
  viewport right edge** (right edge 389/390 px; `shadowRadius: 12` overflows). Reads as cramped.
  *Fix:* give the header row right padding / move `Add money` out of the balance row.
- **N10 (low) | flow | pay screen | No manual "paste request" fallback.** The payer can ONLY acquire a
  request via the camera (or NFC). On web/desktop (and when a camera is absent/unreliable) there is no
  paste-a-request-string path, so Pay is unreachable without a working camera. *Fix:* add a "Paste
  request" affordance (the decode path already accepts a string).

## Onramp/offramp + multi-currency findings (2026-07-30)

> From two orchestrated investigation subagents. Full plan + citations: `2026-07-30-ckusdc-onramp-offramp.md`.
> **Linchpin:** ckUSDC is NOT a ckBTC-style chain-key token — it is a ckERC-20 handled by the **ckETH
> minter** (`sv3dd-oaaaa-aaaar-qacoa-cai`) via an Ethereum helper-contract deposit + heartbeat log
> scraping. The existing ckBTC deposit/withdraw proxy does NOT generalize. There are ≥3 ck-minter
> families (UTXO-minter=ckBTC; ckETH/ckERC20=ckUSDC; ckSOL). The ICRC ledger layer (balance/pay/history)
> already works for ckUSDC with a `register_ledger` call — only the *ramp* is ckBTC-shaped.

- **O1 (high) | architecture | canister/relay/app | The deposit+withdraw ramp is hard-wired to the
  ckBTC minter family.** ✅ **RESOLVED for onramp (M0+M2)** — `MinterFamily` is now the per-family
  dispatch key (canister `currencies()` + `register_currency_meta`, M0); the ckUSDC onramp is built
  CLIENT-SIDE (no canister ramp dispatch needed — the onramp bypasses the canister: the user does 2 ETH
  txs, the mint lands at `Account{owner:facade, subaccount:pubkey}`, dpay just polls the ledger balance).
  Shipped: `app/cketh.ts` byte-exact calldata builder, `app/wallet.ts` EIP-1193 seam, `CkErc20DepositSheet`
  wallet-connect flow (connect→approve→deposit→watch), relay `GET /api/v1/onramp/ckerc20`, ckUSDC registered
  on mainnet. The ckERC20 **offramp** (canister `withdraw_erc20` dual-ledger dispatch) is NOT built —
  deferred per Fork-C (no ckETH gas source; offramp via third-party, never dpay). So the onramp is
  multi-family; the direct offramp remains ckBTC-only.
- **O2 (high) | architecture | core wire | `WithdrawAuth` binds a BTC-address field** ✅ **RESOLVED (M3,
  commit 4a98c89)** — renamed `WithdrawAuth.btc_address` → `destination` across 14 files. **Wire-safe**:
  `signing_bytes()` was already chain-agnostic (the address is a u32-length-prefixed UTF-8 string — the
  field NAME never touched the bytes). Proven: the regenerated `wire_layout.json` withdraw.golden
  `signing_hex`/`sig_hex` are byte-identical before/after. The signed-withdrawal now reads as chain-agnostic
  without a FROZEN-wire version bump.
- **O3 (high) | dependency | ckUSDC offramp | The user MUST hold ckETH to pay Ethereum gas** 🟡 **DEFERRED
  (Fork-C)** — the ckERC20 direct offramp (`withdraw_erc20`, dual-ledger approve) is NOT built. Per the
  locked founder decision, gas is provided via a THIRD-PARTY (user authorizes a 3rd-party ckUSDC→ckETH
  conversion directly; dpay is a screen only — preserves no-swap). The ckUSDC asset card has NO cash-out
  button (honest deferral); ckBTC cash-out works (with saved-address reuse, M3).
- **O4 (medium) | risk | ckERC20 offramp front-running (extends #9/risk 8)** 🟡 **DEFERRED** — applies
  only when the ckERC20 offramp lands (see O3). The dual-approve + partial-failure (`CkErc20LedgerError`
  after `CkEthLedgerError` → reimbursement) residual is documented; inherent to the ckETH minter, not
  dpay-specific.
- **O5 (high) | UX/config | single-sourcing** — 🟡 **FOUNDATION SHIPPED, REOPENED by MC1/MC2.**
  Canister `currencies()` + relay `GET /api/v1/currencies` + app runtime catalog shipped and
  `DEPOSIT_CURRENCY` was deleted. The audit found that metadata, activation, cache scoping, and
  token-specific ramp dispatch are still insufficient for config-only asset addition; see issue 7.
- **O6 (low) | verification | live ckUSDC params** — ✅ **VERIFIED 2026-07-31** via mainnet query
  (`dfx canister --network ic call sv3dd-oaaaa-aaaar-qacoa-cai get_minter_info`) + authoritative source
  (`dfinity/ic` `DepositHelperWithSubaccount.sol`, `templates/principal_to_bytes.js`, `tests/principal_to_bytes_test.js`).
  Findings (all to be READ AT RUNTIME via `get_minter_info`, never hardcoded):
  - `deposit_with_subaccount_helper_contract_address` = `0x18901044688D3756C35Ed2b36D93e6a5B8e00E68` ✓
  - `minimum_withdrawal_amount` = `5_000_000_000_000_000` (5e15 wei; minter-wide gas floor, shared by ckETH+ckERC20)
  - ckUSDC in `supported_ckerc20_tokens`: ERC-20 `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, ledger
    `xevnm-gaaaa-aaaar-qafnq-cai`, symbol `ckUSDC` ✓. **11 ckERC20 tokens live**: ckUSDC, ckUSDT, ckEURC,
    ckWBTC, ckLINK, ckUNI, ckWSTETH, ckPEPE, ckOCT, ckSHIB, ckXAUT.
  - ckUSDC ledger: `icrc1_symbol`="ckUSDC", `icrc1_decimals`=6, `icrc1_fee`=10_000 (0.01 USDC),
    `icrc1_name`="ckUSDC" ✓.
  - `minter_address`=`0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80`, `cketh_ledger_id`=`ss2fx-dyaaa-aaaar-qacoq-cai`,
    `evm_rpc_id`=`7hfb6-caaaa-aaaar-qadga-cai`.
  - **`depositErc20` ABI (LIVE helper `CkDeposit`):** `depositErc20(address erc20Address, uint256 amount,
    bytes32 principal, bytes32 subaccount)` — **first arg is the ERC-20 contract address, NOT a token_id**
    (corrects the investigation's "token_id" framing). Emits `ReceivedEthOrErc20(erc20Addr indexed, owner
    indexed, amount, principal indexed, bytes32 subaccount)`; calls `erc20.safeTransferFrom(msg.sender,
    minterAddress, amount)` so user must `approve(helper, amount)` on the ERC-20 first.
  - **principal→bytes32 encoding (authoritative):** base32-decode (incl 4-byte CRC32 prefix) → `slice(4)`
    strips CRC → length-prefix into 32 bytes: `[1-byte N=len][N principal-bytes][31-N zero pad]`. Golden
    vectors: `k2t6j-...-6ae`→`0x1db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000`;
    `opspt-...-vqe`→`0x1dca62f9ef706b80db8a5293779a08cbe067e69206ac4eee9d27931d2b020000`;
    `2chl6-4hpzw-vqaaa-aaaaa-c`→`0x09efcdab00000000000100000000000000000000000000000000000000000000`.
  - **No pending-deposit IC query exists** — `get_minter_info` has no per-account pending field; minting is
    heartbeat-scraped (~3min). The ONLY onramp signal is the ckUSDC ledger balance growing. (Answers Q3.)
- **🚩 Founder decisions (plan §6 Q1–Q6,14):** direct-vs-partner sequencing at launch; partner aggregator
  choice + mode; KYC-surfacing posture; ckUSDC chains at launch (Ethereum only?); ramp fees = partner's
  only (zero dpay cut); keep the demo faucet once real ckUSDC exists; wrong-network recourse messaging.

## Prior UX audit (2026-07-31) — historical closure record

> Source: `UX_AUDIT_FINDINGS.md` (code-review + zai-vision visual audit). All 23 issues addressed;
> independent verifier confirmed 21 fully resolved + 2 mitigated. Visual re-audit (zai-vision on live
> screenshots) confirmed no regressions. Suite reached 28/28 GREEN. The 2026-08-01 installed-app review
> supersedes this as the current product direction via MC5-MC7; in particular, making Paste request more
> prominent is no longer desired, and inline history/settings placement must be redesigned.

**Critical (3) — RESOLVED:**
- ✅ C1: Approve button disabled on expired request (error moved above button; greyed out).
- ✅ C2: Approve button disabled on insufficient balance (online gate; warning above button).
- ✅ C3: Deposit fee/min shows "—" instead of "0.00000000" when zero (FakeLedger returns 0).

**High (5) — RESOLVED:**
- ✅ H1: ckUSDC labeled by its symbol ("ckUSDC"), not the chain ("Ethereum"). `displayName()` in catalog.ts.
- ✅ H2: Transaction history fans out per catalog currency (was hardcoded currency=0).
- ✅ H3: Counterparties show `short(pubkey)` (8 hex chars), not a 64-char dump. ✅ **NOW FULLY RESOLVED
  (2026-07-31, wire-format v2)** — names (`from_name`/`to_name`) + `memo` are now in the signed
  `Authorization::signing_bytes` and threaded through canister `TxnRecord` + relay history, so the app
  renders friendly counterparties ("from Alice" / "to Bob") directly. `short()` remains only as the
  fallback when a name is empty (e.g. a row whose counterparty never set one). Closes N6/H3 together;
  proven by flow `26-names-memo`.
- ✅ H4: Header shows username only (hex removed; testID `header-who`).
- ✅ H5: Deposit errors use plain language (transient vs no-minter, no "relay" jargon).

**Medium (9) — RESOLVED:**
- ✅ M1: ARIA roles/labels on all interactive Pressables (accessibilityRole + accessibilityLabel + state).
- ✅ M2: All touch targets ≥ 44pt (minHeight:44 on interactive style keys).
- ✅ M3: Keyboard hint badges redesigned (24×24 bordered box, 14px text — visible + legible).
- ✅ M4: "Press Esc to close" gated behind `Platform.OS === 'web'` in all sheets.
- ✅ M5: Responsive at desktop width (maxWidth:480 + screenFrame centering).
- ✅ M6: Empty username defaults to 'me' (was "Name"); testID added.
- ✅ M7: Onboarding subtext is user-benefit ("Creates your wallet and adds $100 in demo funds").
- ✅ M8: ckUSDC deposit sheet shows ETH gas-fee warning.
- ✅ M9: ckUSDC processing state simplified (single "Waiting for confirmation — ~20min", no jargon).

**Low (6) — RESOLVED:**
- ✅ L1: Add-money shadow no longer clipped (shadowRadius 12→8).
- ↩ L2: "Paste request" received a proper touch target in this wave, but MC7 now removes it from the primary Pay surface or demotes it to a subordinate scanner fallback.
- ✅ L3: Withdraw success has a Copy-destination button + selectable address.
- ✅ L4: "Payer paid offline? Scan to settle." (was ambiguous; shortened 2026-08-01 for simplicity).
- ✅ L5: Raw hex request nonce removed from review screen.
- ✅ L6: Payment confirmation shows recipient name ("to Bob"), not "merchant". (Receive-side name = H3/N6.)
