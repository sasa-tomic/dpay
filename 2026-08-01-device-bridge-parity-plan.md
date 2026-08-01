# Device-bridge parity: make wire/arity regressions impossible to ship

Date: 2026-08-01. Status: APPROVED scope (founder). Authoritative spec for the hardening change.
Companion: `OPEN_ISSUES.md` issue 10, `CODEBASE_ANALYSIS.md` bridge-arity risk.

## Why

The 2026-07-31 wire-format v2 wave (commits b1c67fc…ca2f2b5) grew `signAuthorization` from
**6 → 9** JS params and the wire from 196 → **292** bytes, updated Kotlin + instrumented tests +
the web shim, but left two RN app call sites stale. `just verify` (core+canister+relay+e2e) stayed
**GREEN** and shipped a release that **crashed on launch on a physical device**:

```
FATAL EXCEPTION: mqt_native_modules
com.facebook.react.bridge.NativeArgumentsParseException: DpayCore.signAuthorization got 8 arguments, expected 11
```

A wrong JS→Kotlin argument COUNT throws on the **native modules thread** (not in JS), so the JS
try/catch in `App.tsx`'s mount-time self-check never runs — the arity check fails before a promise is
created and the process dies at startup. This class of bug is invisible to every enforced gate today.

## Why every green gate missed it

| Gate | What it exercises | Why it missed this |
|---|---|---|
| `just verify` → `check` | core/canister/relay (Rust) | Wire + Kotlin updated together; Rust stayed green. |
| `just verify` → `e2e` (26 flows) | REAL `App.tsx` in react-native-web vs a JS **shim** (`e2e/web/dpay-core.ts`) | The shim is a *second hand-written implementation* of the `DpayCoreApi` interface; it was updated independently and tolerates trailing args. It is NOT `libdpay_ffi.so` and NOT the Kotlin `@ReactMethod`. |
| `just ondevice` (8 tests) | UniFFI **directly** (Kotlin→.so) | Calls the binding, NOT the `NativeModules` bridge (`DpayCoreModule`). |
| `just app` (the ONLY real-bridge gate) | RN app → `DpayCoreModule` → `libdpay_ffi.so` | **Not in `just verify`; never re-run after wire-v2.** |
| TypeScript compile | `app/` types | **No `tsc`/`typecheck` step exists** (`package.json` has only `lint`=eslint, `test`=jest; `justfile` has zero tsc refs; e2e builds via Vite/esbuild which STRIPS types without checking). And `signAuthorization`'s name params are `?` optional → a 6-arg call compiles. |

Three independent failures had to line up. The plan below closes each (any one layer alone would have
caught the crash).

## Layers (defense in depth)

### Layer 1 — Strict bridge types + a real typecheck gate  [HIGHEST LEVERAGE]

The optional `?` on the name params is exactly why `App.tsx:68`'s 6-arg call compiled. Make them
required so arity drift becomes a **compile error** at every call site, then add a `tsc --noEmit`
gate to the inner loop.

- `app/lib/types.ts:40` — `signAuthorization(...)…fromName?: string, toName?: string, memo?: string`
  → drop the three `?` → `fromName: string, toName: string, memo: string`.
- `app/lib/types.ts:41` — `encodeRequest(...)…toName?: string, memo?: string` → drop both `?`.
  (Note: `DpayNfcApi.buildRequest` at `types.ts:8` ALREADY requires `toName: string, memo: string`
  — good; only the two `DpayCoreApi` methods are lax. Leave `nfcStatus?()` optional — that
  degradability is intentional for apps built before the method exists.)
- Update the comment at `types.ts:37-39` (the "default to ''" rationale no longer applies; required
  params mean callers pass `''` explicitly, as the hotfix already did).
- `app/package.json` scripts — add `"typecheck": "tsc --noEmit"` (typescript 5.0.4 is already a
  devDependency; `tsconfig.json` exists).
- `justfile` — add recipe + wire into `verify`:
  ```
  # typecheck the RN app (catches bridge arity drift against the TS interfaces, ~2s, no device)
  typecheck:
      cd app && npm run typecheck

  check: test-core test-canister test-relay typecheck
  verify: check e2e
  ```
  This makes arity drift fail the fast inner loop (~2s, fully offline) the moment wire-v2-style
  signature growth isn't mirrored at every call site. **This single change would have prevented the
  launch crash.**

### Layer 2 — Bridge-parity assertion  [no drift possible]

`DpayCoreApi`/`DpayNfcApi` (TS) and `DpayCoreModule`/`DpayNfcModule` `@ReactMethod`s (Kotlin) are two
hand-written surfaces against the same UniFFI IDL. Layer 1 makes the *call sites* strict against the
TS interface; Layer 2 makes the TS interface accountable to the Kotlin. Nothing checks that today.

- **Static parity check (ship now):** a small node script `scripts/bridge-parity.mjs` that:
  1. Parses `@ReactMethod`-annotated methods from
     `app/android/app/src/main/java/com/dpay/DpayCoreModule.kt` + `DpayNfcModule.kt` (regex on
     `@ReactMethod` + the following `fun name(...)` signature; JS-arity = count of non-`Promise`
     params).
  2. Parses the `DpayCoreApi`/`DpayNfcApi` method signatures from `app/lib/types.ts` (count required
     params; the optional `?` ones count toward the Kotlin max but are allowed absent — after Layer 1
     they're required, so the counts must match exactly).
  3. Asserts the two maps (`name → arity`) are equal; exits 1 with a diff on mismatch.
  - Wire as `just bridge-parity` and add to `check` (runs in <1s, no device). Fails the build the
    instant a `@ReactMethod` signature and the TS interface disagree.
- **Ultimate form (track as follow-up, NOT this change):** codegen the TS `DpayCoreApi`/`DpayNfcApi`
  from the UniFFI IDL (`crates/dpay-ffi/`) that already generates the Kotlin `dpay_ffi.kt`, so there
  is one source of truth and zero hand-written duplication. This is larger (touches the FFI build);
  the static check captures 90% of the value now.

### Layer 3 — Emulator bridge gate in the enforced loop

The sandbox has `/dev/kvm`. The launch crash reproduces **identically on the emulator** (same
`DpayCoreModule` + `libdpay_ffi.so`). `just app` already asserts `DPAY_SELFCHECK PASS` in logcat
(`scripts/rn-run.sh:74`) — it just isn't in `just verify` and wasn't re-run after wire-v2.

- Add a path-filtered pre-merge gate: run `just app` (emulator target) automatically when a change
  touches `app/android/**`, `crates/dpay-ffi/**`, `app/lib/types.ts`, `app/services/**`, or the core
  wire format (`crates/dpay-core/src/lib.rs` `WIRE_LEN`/`SIGNING_LEN`/`REQUEST_LEN`).
- At minimum, until CI path-filtering exists: make "ran `just app`" a documented **required** item on
  the pre-merge checklist in `AGENTS.md` for any change in those paths.
- Keep it OFF the hot `verify` path for unrelated changes so iteration stays fast (full APK build is
  ~44s; the static Layers 1+2 are the sub-second inner-loop guard).

### Layer 4 — Magic-number-free self-check

`App.tsx:69` hardcoded `392` (rotted from the pre-v2 196-byte wire hex) and shipped broken. The
hotfix bumped it to `584` (= 292×2). Both are magic numbers that rot on every wire resize.

- Expose `wire_len()` (and ideally `signing_len()`, `request_len()`) from the FFI:
  - `crates/dpay-ffi/src/lib.rs` (or the UniFFI-exposed surface) — add `pub fn wire_len() -> u64 {
    WIRE_LEN as u64 }` re-exporting the core const.
  - `app/android/.../DpayCoreModule.kt` — add `@ReactMethod fun wireLen(promise: Promise)` returning it.
  - `app/lib/types.ts` — add `wireLen(): Promise<number>` to `DpayCoreApi`.
- `App.tsx:69` — assert `wire.length === (await DpayCore.wireLen()) * 2` instead of any literal.
  No future wire resize can silently rot the check, and the `584` literal the hotfix added goes away.

### Layer 5 — Close the documented MC8 gap surfaced by the audit

`signWithdrawal` is declared in `types.ts:48` and called at `app/components/WithdrawSheet.tsx:60`,
but has **NO** Kotlin `@ReactMethod` (zero grep matches in `app/android/*.kt`). On Android
`DpayCore.signWithdrawal` is `undefined` → caught TypeError → **withdrawal is silently broken on
Android** (pre-existing MC8 gap, not the launch crash).

- `app/android/.../DpayCoreModule.kt` — add `@ReactMethod fun signWithdrawal(secretHex: String,
  destination: String, amount: Double, nonceHex: String, expiry: Double, currency: Int, promise:
  Promise)` mirroring the existing `signAuthorization` (call the UniFFI `sign_withdrawal` binding;
  return the 64-byte sig as lowercase hex).
- Layer 2's parity check will flag this automatically once `signWithdrawal` is in the TS interface
  but not Kotlin — i.e. it becomes impossible to ship again.

## Cascade

| Layer | File(s) | Change |
|---|---|---|
| 1 | `app/lib/types.ts:40-41` | drop `?` on `signAuthorization`/`encodeRequest` name params; fix L37-39 comment |
| 1 | `app/package.json` | add `"typecheck": "tsc --noEmit"` |
| 1 | `justfile` | add `typecheck` recipe; add it to `check` |
| 2 | `scripts/bridge-parity.mjs` (NEW) | parse `@ReactMethod` arity vs TS interface arity; assert equal |
| 2 | `justfile` | add `bridge-parity` recipe; add to `check` |
| 3 | `AGENTS.md` / CI | path-filtered `just app` pre-merge gate for bridge/wire/types changes |
| 4 | `crates/dpay-ffi/src/lib.rs` | expose `wire_len()` |
| 4 | `app/android/.../DpayCoreModule.kt` | add `@ReactMethod wireLen` |
| 4 | `app/lib/types.ts` | add `wireLen(): Promise<number>` |
| 4 | `app/App.tsx:69` | assert `wire.length === (await wireLen())*2` (drop literal) |
| 5 | `app/android/.../DpayCoreModule.kt` | add `@ReactMethod signWithdrawal` |
| docs | `OPEN_ISSUES.md`, `CODEBASE_ANALYSIS.md` | close issue 10 items as each layer ships |

## Order + gates

1. **Wave 1 (one subagent): Layer 1** — strict types + typecheck gate. Verify existing call sites
   still typecheck (the hotfix already made `App.tsx`/`NfcTap.tsx` pass the required args; confirm
   `PayMode.tsx:73` already passes 9). Gate: `just typecheck` GREEN + `just e2e` still 26/26 (the web
   shim implements the interface; required params just mean it must accept all — confirm). **Commit.**
2. **Wave 2 (one subagent): Layer 2** — bridge-parity script + gate. Gate: `just bridge-parity` GREEN
   against current source (it must pass today; it's a regression net for the future). **Commit.**
3. **Wave 3 (one subagent): Layer 4** — `wireLen` end to end + remove the `584` literal. Gates:
   `just ffi` + `just typecheck` + `just app` (self-check PASS on device/emulator). **Commit.**
4. **Wave 4 (one subagent): Layer 5** — `signWithdrawal` Kotlin method. Gates: `just bridge-parity`
   (now passes with the method present) + `just ondevice` (instrumented) + `just app`. **Commit.**
5. **Wave 5 (ops): Layer 3** — wire the path-filtered `just app` pre-merge gate + AGENTS.md note.
   **Commit.**
6. **Final:** `just verify` GREEN (now incl. typecheck + bridge-parity); `just app` GREEN on emulator;
   working tree clean; strike issue 10 in `OPEN_ISSUES.md` + the CODEBASE_ANALYSIS risk.

Waves 1–2 are independent of device/emulator and land in seconds; do them first and they protect all
future wire changes immediately. Waves 3–5 need the emulator and can follow.

## Acceptance

- `just verify` includes a `tsc --noEmit` typecheck and a bridge-parity assertion, both sub-second.
- The TS bridge interfaces have NO optional params where Kotlin requires them (except the
  intentionally-degradable `nfcStatus?`).
- `App.tsx` self-check derives the wire length from the FFI — no magic number literal anywhere.
- `signWithdrawal` is callable on Android (parity with iOS/web).
- A path-filtered `just app` runs automatically on bridge/wire/types changes; a wire-signature
  change that isn't mirrored at every call site fails the build before it can reach a device.

## Rules honored

- Single source of truth: the UniFFI IDL → core consts → every layer by name; no magic numbers.
- The static layers (1+2) run in the fast, fully-offline inner loop; only the inherently-device
  layers (3, and the device-confirmation of 4/5) need the emulator.
- No silent degradation: required params surface a missing arg as a compile error, not a runtime
  native crash on a user's phone.
