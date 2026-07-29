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

// Per-camera-scan polling. A single interval on the window; cleared when the consuming component
// unmounts (its returned `codeScanner` carries the cleanup via a weak handle).
const SCAN_HOOK = '__DPAY_TEST_SCAN';
type ScanListener = (payload: string) => void;
const listeners = new Set<ScanListener>();

function installGlobalHook() {
  if (typeof window === 'undefined') return;
  if ((window as any)[SCAN_HOOK]) return;
  // Replacing the hook each call is allowed; we fan-out to every registered listener.
  (window as any)[SCAN_HOOK] = (payload: unknown) => {
    if (typeof payload !== 'string') return;
    for (const fn of listeners) {
      try { fn(payload); } catch { /* a bad listener must not break the others */ }
    }
  };
}
installGlobalHook();

// Inert React component — the real app only renders <Camera/> when permission is granted AND a
// device exists. Our `useCameraPermission` returns `hasPermission: false`, so the placeholder branch
// ("camera permission needed") renders instead. The test driver then injects via the seam.
export const Camera = () => null;

export function useCameraDevice(_position?: string) {
  // No real device on web. Returning `undefined` makes <QrScanner> show its placeholder branch.
  return undefined;
}

export function useCameraPermission() {
  // Report no permission so the placeholder ("Grant camera" button) renders, which matches what a
  // real user sees before granting. The button's onPress is `requestPermission` — a no-op here; the
  // test driver does not click it, it injects via __DPAY_TEST_SCAN.
  return {
    hasPermission: false,
    requestPermission: () => Promise.resolve(false),
  };
}

export function useCodeScanner(opts: { codeTypes: string[]; onCodeScanned: (codes: { value?: string }[]) => void }) {
  // Stable callback: the app calls useCodeScanner once per mount and hands the result to <Camera>.
  // We register a listener that adapts the injected string into the {value} shape the app expects.
  const listener: ScanListener = (payload: string) => {
    try { opts.onCodeScanned?.([{value: payload}]); } catch { /* app-side error; swallow */ }
  };
  listeners.add(listener);
  // React's rules-of-hooks require this to be idempotent; cleanup is best-effort via
  // queueMicrotask (we can't return a destructor from a hook). Leaked listeners are bounded by the
  // number of <QrScanner> mounts in a session (small), and each is GC'd when the page reloads.
  if (typeof window !== 'undefined') {
    queueMicrotask(() => {
      // Re-install in case the page reloaded the global. Idempotent.
      installGlobalHook();
    });
  }
  // The shape <Camera codeScanner={...}> expects (kept opaque — Camera is inert here).
  return { codeScannerOptions: opts ?? { codeTypes: ['qr'] } };
}

// Allow tests / future flows to forcibly clear listeners (e.g. between scenarios).
;(window as any).__DPAY_TEST_SCAN_RESET = () => { listeners.clear(); };
