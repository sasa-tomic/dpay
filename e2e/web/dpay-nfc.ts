// DpayNfc shim — the merchant/payer NFC tap transport (a Kotlin native module on device). Web has
// no NFC radio; the app reads NFC state via DpayCore.nfcStatus (returns 'unknown' here, so the
// NfcPill stays hidden and NfcTap never mounts in the wallet — exactly the right default for web).
//
// The NFC flows themselves (Pay screen's NfcTap card, Receive screen's reader) are a LATER WAVE.
// They are driven by a `window.__DPAY_TEST_NFC_SESSION` seam that emits `DpayNfcEvent`s through the
// NativeEventEmitter. This file installs both halves of that seam:
//   1. The DpayNfc native-module surface (armCard/disarmCard/startReader/stopReader/approveCard/
//      declineCard/buildRequest/confirmReceipt) — all no-op Promises for now (NFC isn't reached on
//      the onboard flow; later waves replace these with seam-driven fakes).
//   2. A `__DPAY_TEST_NFC_SESSION(event)` hook + an EventEmitter the shims install globally, so a
//      future NFC test can fire the same `DpayNfcEvent`s the real Kotlin module emits and the app's
//      `emitter.addListener('DpayNfcEvent', ...)` receives them verbatim.
//
// Per the rules: the NFC radio hop is a physical-device gate; only the JS event plumbing is faked,
// and the seam name (`__DPAY_TEST_NFC_SESSION`) matches the convention used by the parallel
// ui/src/App.jsx so a single driver vocabulary covers both harnesses.

// The NativeEventEmitter shim is a tiny pub/sub keyed by event name. Installed globally so a
// DpayNfc native-module event dispatched via `dispatchDpayNfcEvent(...)` reaches every active
// listener registered via `new NativeEventEmitter(DpayNfc).addListener('DpayNfcEvent', fn)`.
type NfcListener = (event: unknown) => void;
const nfcListeners = new Map<string, Set<NfcListener>>();

function addNfcListener(event: string, fn: NfcListener): { remove: () => void } {
  let set = nfcListeners.get(event);
  if (!set) { set = new Set(); nfcListeners.set(event, set); }
  set.add(fn);
  return { remove: () => { set?.delete(fn); } };
}

function dispatchNfcEvent(event: string, payload: unknown): void {
  const set = nfcListeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch { /* a bad listener must not break the others */ }
  }
}

// The DpayNfc "native module" — surface mirrors app/App.tsx's `DpayNfcApi` type. Methods that would
// move real bytes over the radio are no-op resolves; later NFC-flow waves inject the corresponding
// DpayNfcEvents through `dispatchNfcEvent('DpayNfcEvent', ...)` instead.
export const DpayNfc = {
  armCard: () => Promise.resolve(),
  disarmCard: () => Promise.resolve(),
  approveCard: (_wireHex: string) => Promise.resolve(),
  declineCard: () => Promise.resolve(),
  buildRequest: async (_toHex: string, _amount: number, _nonceHex: string, _expiry: number, _currency: number) =>
    '', // empty hex string — Receive screen's `if (nfcHex)` guard skips reader-mode setup on web
  startReader: (_requestHex: string) => Promise.resolve(),
  stopReader: () => Promise.resolve(),
  confirmReceipt: (_status: number, _nonceHex: string) => Promise.resolve(),
  // The NativeEventEmitter constructor calls these on subscribe/unsubscribe; no-op on web.
  addListener: (_eventName: string) => {},
  removeListeners: (_count: number) => {},
};

// Install the NFC session seam + the global emitter. Idempotent — safe to call from shims.ts every
// boot. The seam accepts either a single event object or an array (mirrors how the parallel
// ui/src/App.jsx drives phases via __DPAY_TEST_NFC_SESSION).
export function installNfcSeam(globalScope: any) {
  globalScope.__DPAY_TEST_NFC_SESSION = (events: unknown) => {
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) dispatchNfcEvent('DpayNfcEvent', e);
  };
  // Exposed for future flows + tests; not used by the onboard flow.
  globalScope.__DPAY_NFC_DISPATCH = dispatchNfcEvent;
  globalScope.__DPAY_NFC_LISTENERS = nfcListeners;
}

export const __nfcEmitter = { addListener: addNfcListener };
