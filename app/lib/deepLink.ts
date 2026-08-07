import {Platform} from 'react-native';

// --- dpay: deeplink codec (item 6) -----------------------------------------------------------
// A merchant's Request QR carries a raw base64url blob. The deeplink wraps it as `dpay:req/<blob>`
// so it can be shared over a messaging app and opened on the payer's phone to PRE-FILL the pay
// review screen (the payer still taps Approve — a deeplink NEVER auto-signs/auto-approves). The
// symmetric `dpay:pay/<blob>` carries a signed receipt for a future NFC-less hand-back (codec only
// this session; wiring deferred).
//
// The `<blob>` is the EXACT same base64url string the QR already carries — no new wire format, no
// new codec for the bytes. Version lives INSIDE the blob (the wire already has a version byte).
// Slash-not-query (`/` not `?`) keeps the blob opaque to URL-parsing libs so they don't mangle
// `+`/`%`. The codec is PURE (no React/native deps beyond the file's existing Platform import) so
// jest can exercise it on the fast inner loop.

/** Which kind of payload a dpay: deeplink carries. */
export type DeeplinkKind = 'req' | 'pay';
/** A parsed dpay: deeplink — `kind` routes it, `blob` is the base64url handed to the existing
 *  QR decode path (parseRequestQR → DpayCore.decodeRequest). */
export interface Deeplink { kind: DeeplinkKind; blob: string; }

const DPAY_SCHEME = 'dpay:';
const DPAY_KINDS = new Set<DeeplinkKind>(['req', 'pay']);

/** Wrap a base64url blob into a `dpay:<kind>/<blob>` URI for sharing over a messaging app. */
export function encodeDeeplink(kind: DeeplinkKind, blob: string): string {
  return `${DPAY_SCHEME}${kind}/${blob}`;
}

/** Parse a `dpay:req/<blob>` or `dpay:pay/<blob>` URI into `{kind, blob}`, or null if the string is
 *  not a well-formed dpay deeplink (wrong scheme, unknown kind, missing slash, empty blob). null is
 *  the documented "not a dpay link" signal — callers fall through to other handling (e.g. the web
 *  ?req= query-param reader, or no-op). Does NOT validate the blob's bytes — that is the job of the
 *  downstream decode (parseRequestQR + DpayCore.decodeRequest), which throws on a malformed blob. */
export function decodeDeeplink(uri: string): Deeplink | null {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith(DPAY_SCHEME)) return null;
  const rest = uri.slice(DPAY_SCHEME.length); // `<kind>/<blob>`
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // -1 = no slash; 0 = empty kind (`dpay:/blob`)
  const kind = rest.slice(0, slash);
  if (!DPAY_KINDS.has(kind as DeeplinkKind)) return null;
  const blob = rest.slice(slash + 1);
  if (blob.length === 0) return null;
  return {kind: kind as DeeplinkKind, blob};
}

// --- web query-param readers (mirror readDepositDeepLink) ------------------------------------
// On web there is no OS-level scheme handler; instead the same blob rides as a query param so a
// `dpay.kalaj.org/?req=<blob>` link is bookmarkable/shareable. Returns the RAW blob (the caller
// passes it to PayMode unchanged — NOT wrapped in a dpay: URI). Mirrors `readDepositDeepLink`.

/** Web-only: read a `?req=<base64url-blob>` query param from the page URL. Returns the raw blob, or
 *  null on native / when no `?req=` is present. The blob is the EXACT base64url the request QR
 *  carries — it goes straight into PayMode's prefill path (no new codec). */
export function readRequestDeeplink(): string | null {
  if (Platform.OS !== 'web') return null;
  const w = globalThis as unknown as {location?: {search?: string}};
  if (!w.location) return null;
  try {
    const v = new URLSearchParams(w.location.search ?? '').get('req');
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// NOTE: a `readPaymentDeeplink()` (?pay= reader) is intentionally NOT defined yet — it will be
// added together with the deferred `dpay:pay/` receipt-handback wiring (see OPEN_ISSUES). Defining
// an unwired reader now would be dead code (the repo carries no unused exports).

// --- existing web deposit deep link ----------------------------------------------------------

/**
 * Web-only deep link: `?screen=deposit` auto-opens the deposit sheet on load (so the page is
 * bookmarkable/shareable to top-up, and the e2e harness can deep-link straight in). Harmless on
 * native — there's no URL bar, and Platform.OS !== 'web' short-circuits before reading location.
 */
export function readDepositDeepLink(): boolean {
  if (Platform.OS !== 'web') {
    return false;
  }
  const w = globalThis as unknown as {location?: {search?: string}};
  if (!w.location) {
    return false;
  }
  try {
    return new URLSearchParams(w.location.search ?? '').get('screen') === 'deposit';
  } catch {
    return false;
  }
}
