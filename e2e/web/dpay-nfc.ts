// DpayNfc shim — the merchant/payer NFC tap transport (a Kotlin native module on device). Web has
// no NFC radio; the app reads NFC state via DpayCore.nfcStatus (returns 'unknown' here by default,
// so the Pay screen shows the NFC-unavailable row and NfcTap never mounts — exactly the right web default). A test can
// flip it to 'ready' via `window.__DPAY_TEST_NFC_STATUS` (see dpay-core-wasm.ts) so flow 11 can arm the
// NFC tap view and drive its phases.
//
// The NFC flows themselves (Pay screen's NfcTap card, Receive screen's reader) are driven by a
// `window.__DPAY_TEST_NFC_SESSION(event)` seam that emits `DpayNfcEvent`s. CRITICAL wiring detail:
// the app subscribes via `new NativeEventEmitter(DpayNfc).addListener('DpayNfcEvent', fn)`, and
// react-native-web's NativeEventEmitter routes ALL events through a GLOBAL `RCTDeviceEventEmitter`
// singleton (not the native module object). So the seam MUST dispatch via that same bus — emitting
// through a NativeEventEmitter instance — or the app's listener never fires. (An earlier scaffold
// used a private registry, which never reached the app; this wires the real bus.)
//
// Per the rules: the NFC radio hop is a physical-device gate; only the JS event plumbing is faked,
// and the seam name (`__DPAY_TEST_NFC_SESSION`) matches the convention so a single driver vocabulary
// covers the harness.
import { NativeEventEmitter } from 'react-native-web';

// The DpayNfc "native module" — surface mirrors app/App.tsx's `DpayNfcApi` type. Methods that would
// move real bytes over the radio are no-op resolves; the NFC-flow test injects the corresponding
// DpayNfcEvents through `__DPAY_TEST_NFC_SESSION` instead (the real bus the app listens on).
export const DpayNfc = {
  armCard: () => Promise.resolve(),
  disarmCard: () => Promise.resolve(),
  approveCard: (_wireHex: string) => Promise.resolve(),
  declineCard: () => Promise.resolve(),
  buildRequest: async (_toHex: string, _amount: string, _nonceHex: string, _expiry: number, _currency: number, _toName: string, _memo: string) =>
    '', // empty hex string — Receive screen's `if (nfcHex)` guard skips reader-mode setup on web
  startReader: (_requestHex: string) => Promise.resolve(),
  stopReader: () => Promise.resolve(),
  confirmReceipt: (_status: number, _nonceHex: string) => Promise.resolve(),
  // The NativeEventEmitter constructor calls these on subscribe/unsubscribe; no-op on web.
  addListener: (_eventName: string) => {},
  removeListeners: (_count: number) => {},
};

// One emitter bound to the DpayNfc module — emitting on it routes through RNW's global
// RCTDeviceEventEmitter, which is the bus the app's `new NativeEventEmitter(DpayNfc)` listeners
// are registered on. This is what makes a seam-dispatched event reach the real app.
const nfcBus = new NativeEventEmitter(DpayNfc as any);

const NFC_EVENT = 'DpayNfcEvent';

// Install the NFC session seam. Idempotent — safe to call from shims.ts every boot. The seam accepts
// either a single event object or an array, and emits each as a `DpayNfcEvent` on the real bus.
//
// FAIL-LOUD: if no listener is attached (no <NfcTap>/reader mounted), the emit would be SILENTLY
// LOST — the flow hangs and times out with an opaque error. Throwing here turns that into an
// immediate, actionable RED: "no DpayNfcEvent listener — the NFC tap component failed to mount".
// This is the same class of bug the camera shim guards against (`__DPAY_TEST_SCAN` listeners=0).
//
// listenerCount is the ONLY reliable signal on web: RNW never sets `_nativeModule` outside iOS
// (NativeEventEmitter.js constructor is iOS-gated), so the native-module addListener/removeListeners
// callbacks are never invoked on web. But `nfcBus.listenerCount` delegates to the global
// RCTDeviceEventEmitter singleton, which the app's `new NativeEventEmitter(DpayNfc).addListener`
// registers on — so the count is the real, live listener count.
export function installNfcSeam(globalScope: any) {
  globalScope.__DPAY_TEST_NFC_SESSION = (events: unknown) => {
    const count = nfcBus.listenerCount(NFC_EVENT);
    if (count === 0) {
      throw new Error(
        '__DPAY_TEST_NFC_SESSION called but no DpayNfcEvent listener is attached (listeners=0). ' +
        'The NFC tap component (NfcTap / reader) failed to mount — check that nfcStatus is set to ' +
        '\'ready\' and the Pay/Receive screen arms the NFC view before dispatching.',
      );
    }
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) {
      nfcBus.emit(NFC_EVENT, e);
    }
  };
  // Test observability: the live count of DpayNfcEvent listeners (mirrors the camera seam's
  // __DPAY_TEST_SCAN_COUNT). A mount/unmount cycle of the NFC component must return to its prior
  // count.
  globalScope.__DPAY_TEST_NFC_COUNT = () => nfcBus.listenerCount(NFC_EVENT);
}
