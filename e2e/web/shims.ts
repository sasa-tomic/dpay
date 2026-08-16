// Master shims installer — runs as the FIRST side-effect import in `entry.tsx`, BEFORE the real
// `app/App.tsx` evaluates. It mutates `react-native-web`'s exported `NativeModules` (a plain object
// singleton) to add `DpayCore` and `DpayNfc`, and replaces `Share.share` with a deterministic noop
// (the browser's `navigator.share` rejects in headless chrome; the app's deposit/copy paths use
// `Share.share` purely as a clipboard affordance, so the noop resolves `{action:'dismissedAction'}`).
//
// After this file evaluates, the real App.tsx can do:
//   const {DpayCore, DpayNfc} = NativeModules;        // ← our shims
//   await DpayCore.generateKeypair();                  // ← the SHARED wasm core (dpay-core.wasm)
//   await Share.share({message: addr});                // ← resolves dismissedAction (no crash)
//
// The wasm-backed DpayCore shim is the ONLY money-critical shim; every byte it signs/decodes/
// verifies goes through the same Rust `dpay-core` the Android app and the relay use (its only
// JS-side crypto is verifyWire via @noble/ed25519, cross-validated against the golden bytes).
import { NativeModules, Share } from 'react-native-web';
import { DpayCore } from './dpay-core-wasm';
import { DpayNfc, installNfcSeam } from './dpay-nfc';
import { DpaySolNfc, installSolNfcSeam } from './dpay-sol-nfc';

// The app destructure `const {DpayCore, DpayNfc} = NativeModules` runs after this module's side
// effects (entry.tsx imports `./shims` BEFORE `app/App`), so assigning onto the singleton makes them
// visible to App.tsx. (NativeModules in RNW is a mutable shared object — see
// react-native-web/dist/exports/NativeModules/index.js.)
(NativeModules as any).DpayCore = DpayCore;
(NativeModules as any).DpayNfc = DpayNfc;
(NativeModules as any).DpaySolNfc = DpaySolNfc;

// Share.share in RNW calls navigator.share if defined, else REJECTS. The e2e build (any mode
// except web-prod) replaces it with a deterministic noop: headless chrome has no useful share
// target, the app's deposit "Copy address" and "Share auth code" paths use it as a clipboard
// affordance, so the noop resolves `{action:'dismissedAction'}` (matching RNW's own
// `Share.dismissedAction`). No silent error — the call returns a deterministic outcome the app
// already handles. ALSO capture the share payload into `window.__DPAY_TEST_SHARE` (mirrors the
// clipboard seam) so an e2e flow can assert the EXACT message handed to Share.share (e.g. the
// dpay:pay/<base64url> receipt hand-back — flow 59).
//
// The web-PROD build (/wallet) must NOT install that noop — it would silently kill the wallet's
// 4 share affordances (request link / auth code / receipt link / signed SOL code) in EVERY
// browser (2026-08-16 parity audit). Prod keeps RNW's real Share.share (navigator.share → OS
// share sheet on mobile + most desktop browsers) and only patches the no-Web-Share fallback
// (Firefox/Safari desktop): a clipboard write so the payload still leaves the app — mirroring
// `copyToClipboard`'s Android semantics ("the share sheet includes Copy").
const shareNoop = (opts?: {message?: string; url?: string}) => {
  if (typeof window !== 'undefined') {
    (window as any).__DPAY_TEST_SHARE = opts && typeof opts.message === 'string' ? opts.message : '';
  }
  return Promise.resolve({ action: 'dismissedAction' } as
    { action: 'sharedAction' | 'dismissedAction' });
};
if (import.meta.env.MODE === 'web-prod') {
  const origShare = (Share as any).share?.bind(Share);
  (Share as any).share = async (opts?: {message?: string; url?: string}) => {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
    if (nav && typeof nav.share === 'function' && origShare) return origShare(opts); // real Web Share
    const msg = opts && typeof opts.message === 'string' ? opts.message : (opts && opts.url) || '';
    try {
      if (msg && nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(msg);
      }
    } catch { /* best-effort fallback — the app's call sites treat share as fire-and-forget */ }
    return { action: 'sharedAction' as const };
  };
} else {
  (Share as any).share = shareNoop;
}

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
// for the onboard flow (NFC status stays 'unknown' via DpayCore.nfcStatus? returning undefined, so
// the Pay screen shows the NFC-unavailable row and NfcTap never mounts).
if (typeof window !== 'undefined') {
  installNfcSeam(window);
}

// Install the SOL NFC session seam (`window.__DPAY_TEST_SOL_NFC_SESSION`) — same pattern as the IC
// NFC seam, for the SOL durable-nonce tap transport (flow 47).
if (typeof window !== 'undefined') {
  installSolNfcSeam(window);
}

// Marker the driver waits on (mirrors ui/src/App.jsx's `window.__DPAY_READY = true`). Set AFTER all
// shims are installed so a driver that polls for it sees a fully-bootstrapped app.
if (typeof window !== 'undefined') {
  (window as any).__DPAY_READY = true;
}
