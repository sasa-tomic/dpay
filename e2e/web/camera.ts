// react-native-vision-camera shim for web. The real app imports `Camera`, `useCameraDevice`,
// `useCameraPermission`, `useCodeScanner` from this package and uses them in <QrScanner> to read a
// real camera frame. On web there is no real camera in the headless harness; a scan result is
// INJECTED via the test hook `window.__DPAY_TEST_SCAN(<string>)`.
//
// The seam is the smallest boundary: `useCodeScanner({onCodeScanned})` returns a codeScanner whose
// `onCodeScanned` fires once with `[{value}]` when the test driver pushes a payload. The real app's
// QrScanner already debounces (fires once per mount via `fired.current`), so this matches a real
// camera frame exactly.
//
// Per the rules: this is the ONLY camera-surface fake; everything downstream (decodeRequest,
// signing, submit) is the real app's real logic.

import {useEffect, useRef} from 'react';

// Per-camera-scan polling. A single global hook fans an injected payload out to every registered
// listener. Listeners are added/removed by `useCodeScanner`'s effect (see below) so a mount/unmount
// cycle is balanced — no listener outlives the <QrScanner> that registered it.
const SCAN_HOOK = '__DPAY_TEST_SCAN';
type ScanListener = (payload: string) => void;
const listeners = new Set<ScanListener>();

function installGlobalHook() {
  if (typeof window === 'undefined') return;
  if ((window as any)[SCAN_HOOK]) return;
  // Replacing the hook each call is allowed; we fan-out to every registered listener.
  // FAIL-LOUD: if no <QrScanner> is mounted (listeners.size === 0) the scan payload would be
  // SILENTLY LOST — the flow hangs and times out with an opaque error. Throwing here turns that
  // into an immediate, actionable RED: "no QrScanner mounted — the scanner component failed to
  // render on the scan screen". This catches the class of bug where a conditional/overlay prevents
  // the scanner from mounting (e.g. an NFC status view covering it, a dead nfcActive gate, etc.).
  (window as any)[SCAN_HOOK] = (payload: unknown) => {
    if (typeof payload !== 'string') return;
    if (listeners.size === 0) {
      throw new Error(
        '__DPAY_TEST_SCAN called but no QrScanner is mounted (listeners=0). ' +
        'The scanner component failed to render — check for a conditional/overlay that prevents ' +
        '<QrScanner> from mounting on the scan screen.',
      );
    }
    for (const fn of listeners) {
      try { fn(payload); } catch { /* a bad listener must not break the others */ }
    }
  };
}
installGlobalHook();

// Inert React component — the real app only renders <Camera/> when permission is granted AND a
// device exists. Our `useCameraPermission` returns `hasPermission: false`, so the placeholder branch
// (QrScanner.tsx: "Point your camera at a payment code to pay") renders instead. The test driver then
// injects via the seam.
export const Camera = () => null;

export function useCameraDevice(_position?: string) {
  // No real device on web. Returning `undefined` makes <QrScanner> show its placeholder branch.
  return undefined;
}

export function useCameraPermission() {
  // Report no permission so the placeholder (QrScanner.tsx's "Allow camera scan" button) renders,
  // which matches what a real user sees before granting. The button's onPress is `requestPermission`
  // — a no-op here; the test driver does not click it, it injects via __DPAY_TEST_SCAN.
  return {
    hasPermission: false,
    requestPermission: () => Promise.resolve(false),
  };
}

export function useCodeScanner(opts: { codeTypes: string[]; onCodeScanned: (codes: { value?: string }[]) => void }) {
  // Keep the latest callbacks in a ref so the listener can be registered ONCE (in the effect below)
  // and still invoke the current render's `onCodeScanned`. This avoids both the stale-closure trap
  // (a listener forever calling the first render's callback) AND the per-render add churn (every
  // render used to leak one listener — verified by `17-scan-cleanup`).
  const cb = useRef(opts);
  cb.current = opts;
  useEffect(() => {
    const listener: ScanListener = (payload: string) => {
      try { cb.current.onCodeScanned?.([{value: payload}]); } catch { /* app-side error; swallow */ }
    };
    listeners.add(listener);
    installGlobalHook(); // idempotent — re-installs if the page reloaded the global
    // The cleanup contract: remove THIS listener when <QrScanner> unmounts. Without it every mount
    // (and formerly every render) leaked a listener + its closure for the whole session.
    return () => { listeners.delete(listener); };
  }, []);
  // The shape <Camera codeScanner={...}> expects (kept opaque — Camera is inert here).
  return { codeScannerOptions: opts ?? { codeTypes: ['qr'] } };
}

// Allow tests / future flows to forcibly clear listeners (e.g. between scenarios).
;(window as any).__DPAY_TEST_SCAN_RESET = () => { listeners.clear(); };
// Test observability: the live count of registered scan listeners. A mount/unmount cycle of
// <QrScanner> must return to its prior count (cleanup contract) — `17-scan-cleanup` asserts this.
;(window as any).__DPAY_TEST_SCAN_COUNT = () => listeners.size;
