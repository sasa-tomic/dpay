# 2026-08-14 — Radical e2e improvement: fail-loud injection seams

> Trigger: the SOL QR-scanner bug sailed through review because the e2e camera shim
> **silently dropped** scan payloads when no `<QrScanner>` was mounted (commit `ed43734`
> fixed the camera seam). The user demanded: "we must RADICALLY IMPROVE E2E TESTS to
> catch any even remotely similar classes of bugs."

## The bug class

A test injects a payload/event via a `__DPAY_TEST_*` seam; the target component
(QrScanner / NfcTap / SolNfcTap) is not mounted (or unmounted mid-flow); the payload is
**silently lost**; the flow hangs and times out with an opaque error — OR passes by
re-asserting stale UI. This is the class that must die everywhere.

## Seam inventory (injection seams that target a mount-conditioned component)

| Seam | File | Status |
|------|------|--------|
| `__DPAY_TEST_SCAN` | `e2e/web/camera.ts` | ✅ FIXED (`ed43734`) — throws when listeners=0; `assertScannerMounted`/`waitForScanner` in lib.mjs |
| `__DPAY_TEST_NFC_SESSION` | `e2e/web/dpay-nfc.ts` | ❌ SAME BUG — `nfcBus.emit()` no-listener silently drops; `try/catch` swallows |
| `__DPAY_TEST_SOL_NFC_SESSION` | `e2e/web/dpay-sol-nfc.ts` | ❌ SAME BUG — identical pattern |
| `__DPAY_TEST_DEEPLINK` | prod `app/components/Wallet.tsx:262` | ⚠️ guarded `typeof==='function'` in flow 70 → silent no-op if Wallet not mounted |

## RNW internals (verified — load-bearing for the fix)

- `NativeEventEmitter.js:28-31`: `_nativeModule` set ONLY on iOS → on web the native-module
  `addListener`/`removeListeners` callbacks are NEVER called. **Cannot track via callbacks.**
- `EventEmitter.js:86`: `listenerCount(eventType)` returns `Set.size` — works.
- `EventEmitter.js:59`: `emit()` returns undefined — **cannot use return value.**
- `RCTDeviceEventEmitter` is a module-level singleton; `NativeEventEmitter.listenerCount`
  delegates to it. So `nfcBus.listenerCount('DpayNfcEvent')` = real global listener count.

## Fix design

### Phase A — NFC seam fail-loud (the direct same-class fix)
- `dpay-nfc.ts`: before each emit check `nfcBus.listenerCount('DpayNfcEvent')`; if 0 → throw
  an actionable error. Drop the swallowing `try/catch` around emit. Expose
  `__DPAY_TEST_NFC_COUNT()`.
- `dpay-sol-nfc.ts`: same for `'DpaySolNfcEvent'`. Expose `__DPAY_TEST_SOL_NFC_COUNT()`.

### Phase B — harness helpers (lib.mjs)
- `assertNfcTapMounted(driver, label)` + `waitForNfcTap(driver)` — mirror the camera pair.
- `assertSolNfcTapMounted(driver, label)` + `waitForSolNfcTap(driver)`.
- Unified `__DPAY_TEST_SEAM_HEALTH()` diagnostic returning `{scan, nfc, solNfc}` counts.

### Phase C — RED-first self-test flow (TDD regression guard)
- New flow proving every injection seam THROWS when no listener is mounted. If anyone ever
  weakens a seam back to silent-drop, this flow goes RED.

### Phase D — update existing NFC flows
- Flows 11, 32, 47, 51, 53, 60, 66, 74: call `waitForNfcTap`/`waitForSolNfcTap` before the
  first dispatch (mirrors the camera `waitForScanner` discipline).

### Phase E — deeplink seam fail-loud
- Flow 70: assert `__DPAY_TEST_DEEPLINK` is a function (Wallet mounted) before calling;
  throw if undefined (catches "Wallet didn't mount").

### Phase F — docs
- Regenerate `FLOWS.md`, update `CODEBASE_ANALYSIS.md` (RNW seam section), close out in
  `OPEN_ISSUES.md`.

## Gates
`just verify` (e2e green). No prod code change except the deeplink guard (already test-gated).
