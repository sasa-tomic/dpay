import {Platform} from 'react-native';
import {bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8} from './base64url';

// --- dpay: deeplink codec (item 6) -----------------------------------------------------------
// A merchant's Request QR carries a raw base64url blob. The deeplink wraps it as `dpay:req/<blob>`
// so it can be shared over a messaging app and opened on the payer's phone to PRE-FILL the pay
// review screen (the payer still taps Approve — a deeplink NEVER auto-signs/auto-approves). The
// symmetric `dpay:pay/<blob>` carries a CANISTER-SIGNED receipt for the NFC-less hand-back: when NFC
// is unavailable the payer (online) settles directly + shares the verified receipt back to the
// merchant, whose request screen verifies the signature + reconciles as Paid.
//
// The two kinds carry DIFFERENT blob payloads:
//   • `req` — the blob is the EXACT raw base64url the request QR carries (the 132-byte wire request,
//     base64url-encoded by DpayCore.encodeRequest). No new codec; handed straight to PayMode's
//     camera-scan decode path.
//   • `pay` — the blob is base64url(JSON.stringify(receipt)), i.e. base64url of the UTF-8 JSON of the
//     canister-signed receipt object the relay's POST /api/v1/pay returns. `decodeReceiptDeeplink`
//     base64url-decodes THEN JSON.parses. (The receipt is JSON, not a fixed-width binary wire — so a
//     JSON codec is the natural shape; the canister signature inside it is still verified byte-exact
//     via verifyOutcomeReceipt before anything is marked Paid.)
//
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

/** Web-only: read a `?pay=<base64url-blob>` query param from the page URL. Returns the raw blob
 *  (base64url of JSON.stringify(receipt)), or null on native / when no `?pay=` is present. The
 *  merchant's ReceiveMode consumes it via `decodeReceiptDeeplink` → `verifyOutcomeReceipt` (the
 *  receipt is NEVER trusted unverified). Mirrors `readRequestDeeplink`. */
export function readPaymentDeeplink(): string | null {
  if (Platform.OS !== 'web') return null;
  const w = globalThis as unknown as {location?: {search?: string}};
  if (!w.location) return null;
  try {
    const v = new URLSearchParams(w.location.search ?? '').get('pay');
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// --- dpay:pay/ receipt-handback codec ---------------------------------------------------------
// `<blob>` = base64url(JSON.stringify(receipt)) — DIFFERENT from `req`'s raw base64url. The receipt
// is the canister-signed JSON object the relay's POST /api/v1/pay returns under `body.receipt`. The
// merchant MUST verify it via `verifyOutcomeReceipt` before reconciling — these codec fns carry the
// blob opaquely; they do NOT validate the signature (that is the consumer's security gate).

/** The base64url blob a `pay` hand-off carries: base64url(JSON.stringify(receipt)). Shared by the
 *  dpay: URI wrapper and the web /wallet?pay= URL so there is ONE receipt-blob codec. Pure + total. */
export function receiptShareBlob(receipt: object): string {
  return bytesToBase64Url(utf8ToBytes(JSON.stringify(receipt)));
}

/** Wrap a receipt object as a `dpay:pay/<base64url(JSON)>` URI for the NFC-less hand-back (payer
 *  shares this over a messaging app; the merchant opens it + verifies the signature). Pure + total. */
export function encodeReceiptDeeplink(receipt: object): string {
  return encodeDeeplink('pay', receiptShareBlob(receipt));
}

// --- share payloads: web links must OPEN, native keeps the dpay: scheme ------------------------
// A browser cannot open a `dpay:` scheme URI, so a web Share carries an OPENABLE
// `<origin>/wallet?req=…` / `?pay=…` URL instead — the wallet's own query-param mirrors
// (readRequestDeeplink / readPaymentDeeplink) consume the EXACT same blob, so the recipient lands
// on the pre-filled pay review (req) or the verified receipt hand-back (pay). On native the
// canonical `dpay:` deeplink stays (the Android app owns the scheme; a URL would just open a
// browser tab that cannot hand off to the app).

/** Share payload for a req/pay hand-off: on web an OPENABLE /wallet?… URL, on native a dpay: URI.
 *  `blob` is the same base64url payload encodeDeeplink wraps. */
export function shareHandoff(kind: DeeplinkKind, blob: string): string {
  if (Platform.OS === 'web') {
    const w = globalThis as unknown as {location?: {origin?: string}};
    const origin = w.location?.origin ?? '';
    return `${origin}/wallet?${kind}=${encodeURIComponent(blob)}`;
  }
  return encodeDeeplink(kind, blob);
}

/** Decode the `<blob>` portion of a `dpay:pay/` URI back into the receipt object. Returns null on a
 *  malformed/empty blob or one that is not valid base64url/JSON — NEVER throws (the merchant's
 *  reconcile path treats null as "not a valid receipt" and surfaces an error, never a silent Paid).
 *  Does NOT verify the signature — the caller MUST run `verifyOutcomeReceipt` on the result. */
export function decodeReceiptDeeplink(blob: string): Record<string, unknown> | null {
  if (typeof blob !== 'string' || blob.length === 0) return null;
  const bytes = base64UrlToBytes(blob);
  if (bytes === null) return null;
  try {
    const json = JSON.parse(bytesToUtf8(bytes));
    // Only a JSON object is a meaningful receipt; a number/string/array is malformed → null.
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
