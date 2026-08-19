// Master shims installer — runs as the FIRST side-effect import in `entry.tsx`, BEFORE the real
// `app/App.tsx` evaluates. It mutates `react-native-web`'s exported `NativeModules` (a plain object
// singleton) to add `DpayCore` and `DpayNfc`, and replaces `Share.share` with a deterministic
// fallback (the browser's `navigator.share` rejects in headless chrome; the app's share paths
// need the clipboard-write fallback, so the shim resolves `{action:'sharedAction'}` — mirroring
// prod-web's no-Web-Share behavior).
//
// After this file evaluates, the real App.tsx can do:
//   const {DpayCore, DpayNfc} = NativeModules;        // ← our shims
//   await DpayCore.generateKeypair();                  // ← the SHARED wasm core (dpay-core.wasm)
//   await Share.share({message: addr});                // ← clipboard fallback, sharedAction
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

// Share.share in RNW calls navigator.share if defined, else REJECTS. Both shim branches below
// mirror what a browser WITHOUT a usable Web Share target does (headless chrome: navigator.share
// missing or rejected): the payload falls back to a clipboard write and the call resolves
// `{action:'sharedAction'}` — the app's share affordances then flip their labels ('Link copied ✓'),
// exactly the prod-web behavior a user without Web Share sees. No silent error — the call returns
// a deterministic outcome the app already handles. ALSO capture the share payload into
// `window.__DPAY_TEST_SHARE` (mirrors the clipboard seam) so an e2e flow can assert the EXACT
// message handed to Share.share (e.g. the dpay:pay/<base64url> receipt hand-back — flow 59).
//
// The web-PROD build (/wallet) keeps RNW's real Share.share as the FIRST choice (navigator.share →
// OS share sheet on mobile + most desktop browsers) and only falls to the clipboard patch when the
// browser has no Web Share or the call REJECTS without sharing (Firefox/Safari desktop, headless —
// 2026-08-16 parity audit): a clipboard write so the payload still leaves the app — mirroring
// `copyToClipboard`'s Android semantics ("the share sheet includes Copy").
const shareNoop = (opts?: {message?: string; url?: string}) => {
  const msg = opts && typeof opts.message === 'string' ? opts.message : (opts && opts.url) || '';
  if (typeof window !== 'undefined') {
    (window as any).__DPAY_TEST_SHARE = msg;
  }
  // Mirror the prod fallback: no share target → the payload goes to the clipboard (the seam wrap
  // below captures it into __DPAY_TEST_CLIPBOARD; the real write is best-effort headless) and the
  // share resolves sharedAction so the tapped button's feedback label flips.
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
    if (msg && nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
      const p = nav.clipboard.writeText(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch { /* best-effort — the seam captured the payload */ }
  return Promise.resolve({ action: 'sharedAction' } as
    { action: 'sharedAction' | 'dismissedAction' });
};
if (import.meta.env.MODE === 'web-prod') {
  const origShare = (Share as any).share?.bind(Share);
  (Share as any).share = async (opts?: {message?: string; url?: string}) => {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
    const msg = opts && typeof opts.message === 'string' ? opts.message : (opts && opts.url) || '';
    // Real Web Share first — but a rejection (headless chrome's navigator.share needs a user
    // gesture; some browsers expose it with no target) must not dead-end the affordance: fall
    // through to the clipboard write so the user still sees the '…copied ✓' feedback.
    if (nav && typeof nav.share === 'function' && origShare) {
      try {
        return await origShare(opts);
      } catch { /* no usable share target — fall through to the clipboard */ }
    }
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

// IC-rail cutover: route the app's /api/v2 envelope transport at the SAME test relay that serves
// this page (the relay's test-helpers build exposes the fake-IC gateway at /api/v2/canister/*).
// Prod never sets the seam; the icp-api.io default in app/services/icp.ts stands.
try {
  const relay = new URLSearchParams(window.location.search).get('relay');
  (globalThis as unknown as {__DPAY_TEST_IC_GATEWAY?: string}).__DPAY_TEST_IC_GATEWAY =
    relay ?? window.location.origin;
} catch { /* no window (SSR guard) */ }
