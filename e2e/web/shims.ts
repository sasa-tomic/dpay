// Master shims installer — runs as the FIRST side-effect import in `entry.tsx`, BEFORE the real
// `app/App.tsx` evaluates. It mutates `react-native-web`'s exported `NativeModules` (a plain object
// singleton) to add `DpayCore` and `DpayNfc`, and replaces `Share.share` with a deterministic noop
// (the browser's `navigator.share` rejects in headless chrome; the app's deposit/copy paths use
// `Share.share` purely as a clipboard affordance, so the noop resolves `{action:'dismissedAction'}`).
//
// After this file evaluates, the real App.tsx can do:
//   const {DpayCore, DpayNfc} = NativeModules;        // ← our shims
//   await DpayCore.generateKeypair();                  // ← real Ed25519 over @noble/ed25519
//   await Share.share({message: addr});                // ← resolves dismissedAction (no crash)
//
// The ed25519 DpayCore shim is the ONLY money-critical shim; it produces a real, verify-compatible
// wire (cross-validated against the Rust core's golden bytes in tests/00-cross-val.mjs).
import { NativeModules, Share } from 'react-native-web';
import { DpayCore } from './dpay-core';
import { DpayNfc, installNfcSeam } from './dpay-nfc';

// The app destructure `const {DpayCore, DpayNfc} = NativeModules` runs after this module's side
// effects (entry.tsx imports `./shims` BEFORE `app/App`), so assigning onto the singleton makes them
// visible to App.tsx. (NativeModules in RNW is a mutable shared object — see
// react-native-web/dist/exports/NativeModules/index.js.)
(NativeModules as any).DpayCore = DpayCore;
(NativeModules as any).DpayNfc = DpayNfc;

// Share.share in RNW calls navigator.share if defined, else REJECTS. In headless chrome neither path
// is useful; the app's deposit "Copy address" and "Share auth code" paths both use it as a clipboard
// affordance, so resolve to dismissedAction (matches RNW's `Share.dismissedAction`). No silent error
// — the call returns a deterministic outcome the app already handles.
const shareNoop = () => Promise.resolve({ action: 'dismissedAction' } as
  { action: 'sharedAction' | 'dismissedAction' });
(Share as any).share = shareNoop;

// Clipboard seam (U4). The real app writes the deposit address via `navigator.clipboard.writeText`
// on web. Wrap it so every write is ALSO captured into `window.__DPAY_TEST_CLIPBOARD` — this proves
// (in the e2e test) that the copy button put the address on the real clipboard rather than the Share
// noop above. The wrapper resolves even if headless chrome rejects the underlying write without a
// gesture, so the app's "Copied ✓" path is deterministic; the seam value is the assertion target.
if (typeof window !== 'undefined') {
  (window as any).__DPAY_TEST_CLIPBOARD = '';
  const nav = (window as any).navigator;
  if (nav) {
    const realClip = nav.clipboard && typeof nav.clipboard.writeText === 'function'
      ? nav.clipboard.writeText.bind(nav.clipboard) : null;
    const writeText = async (text: string) => {
      (window as any).__DPAY_TEST_CLIPBOARD = String(text);
      if (realClip) {
        try { await realClip(text); } catch { /* headless may reject w/o gesture; seam captured it */ }
      }
    };
    if (nav.clipboard) (nav.clipboard as any).writeText = writeText;
    else nav.clipboard = { writeText };
  }
}

// Install the NFC session seam (`window.__DPAY_TEST_NFC_SESSION`) for future NFC-flow waves. No-op
// for the onboard flow (NfcPill stays hidden via DpayCore.nfcStatus? returning undefined → 'unknown').
if (typeof window !== 'undefined') {
  installNfcSeam(window);
}

// Marker the driver waits on (mirrors ui/src/App.jsx's `window.__DPAY_READY = true`). Set AFTER all
// shims are installed so a driver that polls for it sees a fully-bootstrapped app.
if (typeof window !== 'undefined') {
  (window as any).__DPAY_READY = true;
}
