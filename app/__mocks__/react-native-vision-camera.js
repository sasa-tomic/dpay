// Jest mock for react-native-vision-camera — the native module isn't available under node/jsdom,
// so the real package throws "camera-module-not-found" on import. The flow tier (jest.flow-setup
// mount order) needs the ONE capability the e2e web camera shim (e2e/web/camera.ts — the drift
// twin; keep the seam names + fail-loud contract identical) provides: SCAN INJECTION.
//
// `useCodeScanner` registers the app's onCodeScanned in a module registry, and the exact e2e seam
// names are exposed on globalThis:
//   __DPAY_TEST_SCAN(value)     inject a scan — FAILS LOUD when 0 listeners (same message
//                               contract as the web shim: a silently-lost payload hangs a flow)
//   __DPAY_TEST_SCAN_COUNT()    live listener count (mount/unmount balance — flow 17's contract)
//   __DPAY_TEST_SCAN_RESET()    clear listeners (between scenarios)
//   __DPAY_TEST_SCAN_GEN()      monotonic registration count (the remount witness, flow 36)
// The inert stubs below stay byte-compatible with the old mock: no permission, no device, so
// <QrScanner> renders its placeholder branch exactly as before.
const React = require('react');

const listeners = new Set();
let generation = 0;

function installGlobalHook() {
  const g = globalThis;
  if (g.__DPAY_TEST_SCAN) return;
  g.__DPAY_TEST_SCAN = (payload) => {
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
  g.__DPAY_TEST_SCAN_COUNT = () => listeners.size;
  g.__DPAY_TEST_SCAN_RESET = () => { listeners.clear(); };
  g.__DPAY_TEST_SCAN_GEN = () => generation;
}
installGlobalHook();

module.exports = {
  Camera: () => null,
  useCameraDevice: () => ({id: 'back', position: 'back', devices: []}),
  useCameraPermission: () => ({hasPermission: false, requestPermission: () => Promise.resolve(false)}),
  useCodeScanner: (opts) => {
    // Keep the latest callbacks in a ref-shaped holder so the listener registers ONCE per mount
    // (no per-render churn) and still calls the current render's onCodeScanned — same shape as
    // the e2e web shim (the 17-scan-cleanup contract).
    const cb = React.useRef(opts);
    cb.current = opts;
    React.useEffect(() => {
      const listener = (payload) => {
        try { cb.current.onCodeScanned?.([{value: payload}]); } catch { /* app-side error; swallow */ }
      };
      listeners.add(listener);
      generation += 1;
      installGlobalHook();
      return () => { listeners.delete(listener); };
    }, []);
    return {codeScannerOptions: opts ?? {codeTypes: ['qr']}};
  },
};
