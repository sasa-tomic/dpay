// DpaySolNfc shim — the SOL NFC tap transport (a pure-Kotlin native module on device, no Rust core).
// Mirrors dpay-nfc.ts: web has no NFC radio, so the "native module" is a no-op stub and the NFC-flow
// test drives the SOL tap phases through a `window.__DPAY_TEST_SOL_NFC_SESSION(event)` seam that
// emits `DpaySolNfcEvent`s on the SAME global `RCTDeviceEventEmitter` bus the app listens on.
//
// CRITICAL wiring detail (identical to the IC NFC shim): the app subscribes via
// `new NativeEventEmitter(DpaySolNfc).addListener('DpaySolNfcEvent', fn)`, and react-native-web's
// NativeEventEmitter routes ALL events through a GLOBAL `RCTDeviceEventEmitter` singleton (not the
// native module object). So the seam MUST dispatch via that same bus — emitting through a
// NativeEventEmitter instance — or the app's listener never fires.
//
// The money logic (decode/sign/broadcast) stays in JS; the shim's `approveSolCard(solpayUri)` stashes
// the offline-signed solpay: URI on `window.__DPAY_SOL_NFC_LAST` so a single-driver e2e flow can
// capture it (mirrors how the QR shim stashes `window.__DPAY_QR_LAST`). The radio hop stays a
// physical-device gate; only the JS event plumbing is faked.
import { NativeEventEmitter } from 'react-native-web';

// The DpaySolNfc "native module" — surface mirrors app/lib/types.ts's `DpaySolNfcApi`. Methods that
// would move real bytes over the radio are no-op resolves; the NFC-flow test injects the
// corresponding SolNfcEvents through `__DPAY_TEST_SOL_NFC_SESSION` instead (the real bus the app
// listens on). `approveSolCard` stashes its arg so the test can observe the offline-signed payload.
export const DpaySolNfc = {
  armCard: () => Promise.resolve(),
  disarmCard: () => Promise.resolve(),
  approveSolCard: (_solpayUri: string) => {
    if (typeof window !== 'undefined') {
      try { (window as any).__DPAY_SOL_NFC_LAST = _solpayUri; } catch { /* stash is best-effort */ }
    }
    return Promise.resolve();
  },
  declineSolCard: () => Promise.resolve(),
  startSolReader: (_solreqUri: string) => Promise.resolve(),
  stopSolReader: () => Promise.resolve(),
  confirmSolReceipt: (_status: number, _nextNonce: string, _sig: string, _npub: string) => Promise.resolve(),
  // The NativeEventEmitter constructor calls these on subscribe/unsubscribe; no-op on web.
  addListener: (_eventName: string) => {},
  removeListeners: (_count: number) => {},
};

// One emitter bound to the DpaySolNfc module — emitting on it routes through RNW's global
// RCTDeviceEventEmitter, which is the bus the app's `new NativeEventEmitter(DpaySolNfc)` listeners
// are registered on. This is what makes a seam-dispatched event reach the real app.
const solNfcBus = new NativeEventEmitter(DpaySolNfc as any);

// Install the SOL NFC session seam. Idempotent — safe to call from shims.ts every boot. The seam
// accepts either a single event object or an array, and emits each as a `DpaySolNfcEvent` on the
// real bus.
export function installSolNfcSeam(globalScope: any) {
  globalScope.__DPAY_TEST_SOL_NFC_SESSION = (events: unknown) => {
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) {
      try { solNfcBus.emit('DpaySolNfcEvent', e); } catch { /* a bad payload must not break the seam */ }
    }
  };
}
