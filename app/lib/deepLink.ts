import {Platform} from 'react-native';
import {WALLET_ORIGIN} from '../config/constants';
import {bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8} from './base64url';

// --- the payment link: `https://<origin>/wallet/pay/<recipient>?asset=…&amount=…` --------------
// THE one URL format for "pay me". A merchant (or anyone) shares it over chat/email/a printed QR;
// the recipient opens it and lands on the pay review screen, pre-filled and unsigned. It is
// readable, hand-authorable, and carries no opaque blob — the shape BIP-21 (`bitcoin:<addr>?amount=`)
// and Solana Pay (`solana:<recipient>?amount=&spl-token=`) established, mapped onto https so ONE
// string works as an Android App Link (opens the app) and as a plain web link (opens /wallet).
//
//   https://dpay.kalaj.org/wallet/pay/<recipient>
//       ?asset=<token>&network=<chain>&amount=<decimal>[&label=…][&memo=…][&ref=<32-hex>]
//
//   recipient  the destination account, IN THE PATH (it is the resource):
//              IC assets  → the ICRC-1 owner principal (the same string the wallet shows as
//                           "your address"), CRC-validated by the core before the payer sees it;
//              SOL assets → the base58 Solana address.
//   asset      the LEDGER token name — ckBTC/ckUSDC/ckETH/VCHF/ICP/DEMO/SOL/USDC (case-insensitive),
//              never the backing native symbol: you cannot send native BTC to an IC principal.
//              Resolution is exact against the runtime catalog; unknown or ambiguous ⇒ REFUSE
//              (see resolvePayLink in config/assets.ts) — dpay never guesses which asset to move.
//   network    REQUIRED. The SETTLEMENT chain — where the transfer actually executes
//              (`internet-computer` | `solana`), NOT the backing chain. This is the field that
//              separates "USDC on the Internet Computer" (ckUSDC, an ICRC ledger) from "USDC on
//              Ethereum" or "USDC on Solana": all three are called USDC and only the settlement
//              chain tells them apart. A token name alone is a guess about which chain moves the
//              money, and dpay does not guess. Case-insensitive; spaces normalise to hyphens.
//   amount     decimal in DISPLAY units, converted with the resolved asset's own decimals; an
//              over-precise/overflowing/zero amount is refused, never rounded.
//   label      the payee's CLAIMED display name (shown as claimed — the principal is the identity).
//   memo       a note shown on the review screen. Display only: the ON-CHAIN memo is the nonce.
//   ref        optional 32-hex reconciliation nonce = the on-chain ICRC memo. PRESENT ⇒ one
//              invoice: every payment of this link lands under the SAME memo, so the payee's open
//              request screen can tell which invoice an arriving transfer settles. ABSENT ⇒ a
//              reusable link (tip jar): the payer's app mints a fresh nonce per payment.
//              `ref` DOES NOT stop a second payment — paying an invoice link twice moves the money
//              twice, because dpay sends no `created_at_time` and an ICRC-1 ledger deduplicates
//              nothing without it (the rule and the reasoning: `icp_transfer_arg` in dpay-ffi).
//              Crediting a sale exactly once is the payee's own bookkeeping, not the ledger's.
//
// NO EXPIRY. A request-level expiry protects a QR/NFC hand-off measured in seconds; a link is
// meant to survive a chat thread. The signed envelope still carries its own IC ingress expiry, so
// nothing is signed into the far future.
//
// SECURITY: a link is a ZERO-PRESS entry — it only ever PRE-FILLS the review. It never auto-signs,
// and it cannot name a payee the payer does not see: the destination account is rendered in full.
//
// This module is PURE (no React beyond `Platform`, no catalog, no network) so jest exercises the
// whole grammar on the fast inner loop; asset resolution + amount conversion need the catalog and
// live in `config/assets.ts`.

/** The path a payment link lives at, under the web wallet's own route. */
export const PAY_LINK_PREFIX = '/wallet/pay/';
/** UTF-8 byte cap on `label`/`memo` — the SAME cap the 132-byte wire request applies to
 *  `to_name`/`memo` (dpay_core::NAME_LEN), so a link and a request QR render one payee identically. */
export const PAY_LINK_TEXT_BYTES = 32;

/** Why a URL that IS a payment link cannot be used. Each maps to a specific honest message +
 *  instruction on screen — never a generic "invalid link". */
export type PayLinkErr = 'recipient' | 'asset' | 'network' | 'amount' | 'ref';

/** A payment link's fields exactly as written in the URL — strings, nothing resolved yet
 *  (`asset` is still a token name and `amount` is still decimal display units). */
export interface PayLink {
  recipient: string;
  asset: string;
  network: string;
  amount: string;
  label: string;
  memo: string;
  ref: string | null;
}

/** Parse result: `null` = this URL is not a payment link at all (the caller falls through to its
 *  other handling); `ok:false` = it IS one but is unusable, with the reason to show. */
export type PayLinkParse = {ok: true; link: PayLink} | {ok: false; err: PayLinkErr};

const MAX_RECIPIENT_LEN = 128; // an IC principal is ≤63 chars, a base58 Solana address ≤44
const MAX_ASSET_LEN = 32;
const MAX_NETWORK_LEN = 32;
/** The `ref` grammar: the 16-byte wire nonce as hex. Exported because the SAME field arrives on an
 *  OpenCryptoPay provider's transfer instruction (`parseIcpUri`, `lib/opencryptopay.ts`) and it is
 *  the same fact — the on-chain ICRC memo — so it is read against one rule, not two. */
export const RE_REF = /^[0-9a-fA-F]{32}$/;

/** Canonical spelling of a settlement-chain name: lowercase, spaces as hyphens. So a link written
 *  by hand as `network=Internet%20Computer` and one written by the app as
 *  `network=internet-computer` name the SAME chain — one value, one comparison. */
export function normaliseNetwork(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Characters that are REMOVED outright from display text: they render as nothing, so their only
 *  effect on a review screen is to hide or reorder what is around them. Zero-width space and BOM
 *  (pure invisible padding), the bidi marks/embeddings/overrides/isolates (which can display
 *  "evil.example" as "elpmaxe.live" beside a name the payer is asked to trust), the invisible math
 *  operators and the deprecated format controls. ZWNJ/ZWJ (U+200C/U+200D) are deliberately KEPT —
 *  they join, they do not hide, and they are load-bearing in Persian/Indic names and emoji. */
const RE_INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
/** Characters that become a SPACE: the C0/C1 controls and the Unicode line/paragraph separators.
 *  A newline is the dangerous one — React Native `Text` renders it, so a crafted name can push the
 *  lines BELOW it (the host, the countdown, the destination account) off the visible screen, which
 *  deletes exactly the evidence that makes a hostile name answerable. Mapped to a space rather than
 *  dropped so "Cafe\nKalaj" stays two words instead of becoming "CafeKalaj". */
const RE_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Make text a STRANGER supplied safe to render on a review screen: invisibles stripped, controls
 *  neutralised, whitespace runs collapsed, trimmed. It never rejects — a name is display text and
 *  must not block a payment — and it never re-orders or invents characters, so what is shown is
 *  still what was sent, minus what could only have been sent to hide something. Pure + total.
 *
 *  ONE rule for every such string, wherever it came from: the `label`/`memo` of a payment link
 *  (below) and the merchant name an OpenCryptoPay provider claims (`lib/opencryptopay.ts`) are the
 *  same kind of text with the same threat, so they get the same treatment rather than two. */
export function sanitiseDisplayText(s: string): string {
  return s.replace(RE_INVISIBLE, '').replace(RE_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** Sanitise (above), then truncate to at most `PAY_LINK_TEXT_BYTES` UTF-8 bytes on a character
 *  boundary. The wire applies the same byte cap to `to_name`/`memo`, so the link and the QR built
 *  from one merchant input carry the same string. Pure + total.
 *
 *  `sanitiseDisplayText` is IDEMPOTENT (a sanitised string has no invisibles, no controls, no
 *  whitespace run and no edge whitespace left to change), so a caller that needs to know whether
 *  the cap cut anything may sanitise first and compare — which is what the OpenCryptoPay merchant
 *  name does to mark a truncated name with an ellipsis. */
export function clampLinkText(s: string): string {
  return clampBytes(sanitiseDisplayText(s));
}

/** The byte cap alone. Private: display text must never be clamped without being sanitised first,
 *  and one exported door is what keeps that true. */
function clampBytes(s: string): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8ToBytes(ch).length;
    if (bytes + n > PAY_LINK_TEXT_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Parse a payment link from a full URL (`https://…/wallet/pay/…`, what an Android App Link hands
 *  the app) or from a path+query (`/wallet/pay/…?asset=…`, what the web wallet reads off its own
 *  location). The HOST is deliberately NOT checked: on native the OS only delivers links for the
 *  verified host, and on web the app reads its own origin — a host gate here would only break a
 *  self-hosted relay. Never throws. */
export function parsePayLink(url: string): PayLinkParse | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let u: URL;
  try {
    // The base is only consulted for a path-relative input; an absolute URL ignores it.
    u = new URL(url, 'https://dpay.invalid');
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(PAY_LINK_PREFIX)) return null;
  const rest = u.pathname.slice(PAY_LINK_PREFIX.length).replace(/\/+$/, '');
  if (rest.length === 0 || rest.includes('/')) return {ok: false, err: 'recipient'};
  let recipient: string;
  try {
    recipient = decodeURIComponent(rest).trim();
  } catch {
    return {ok: false, err: 'recipient'}; // a broken %-escape is a corrupted link, not "no link"
  }
  if (recipient.length === 0 || recipient.length > MAX_RECIPIENT_LEN) return {ok: false, err: 'recipient'};

  const q = u.searchParams;
  const asset = (q.get('asset') ?? '').trim();
  if (asset.length === 0 || asset.length > MAX_ASSET_LEN) return {ok: false, err: 'asset'};
  // The settlement chain is REQUIRED, not a tie-breaker: without it "USDC" names three different
  // assets on three different chains and paying the wrong one is unrecoverable.
  const network = normaliseNetwork(q.get('network') ?? '');
  if (network.length === 0 || network.length > MAX_NETWORK_LEN) return {ok: false, err: 'network'};
  const amount = (q.get('amount') ?? '').trim();
  if (amount.length === 0) return {ok: false, err: 'amount'};
  const ref = q.get('ref');
  if (ref !== null && !RE_REF.test(ref)) return {ok: false, err: 'ref'};
  const label = q.get('label') ?? '';
  const memo = q.get('memo') ?? '';
  // Cosmetic fields never block a payment: they carry the wire's own byte cap.
  return {
    ok: true,
    link: {
      recipient,
      asset,
      network,
      amount,
      label: clampLinkText(label),
      memo: clampLinkText(memo),
      ref: ref === null ? null : ref.toLowerCase(),
    },
  };
}

/** Build the shareable URL for a payment link. `origin` is the web wallet's origin — the page's own
 *  on web, the canonical WALLET_ORIGIN on native (there is no location to read, and a link built
 *  from a private relay override would not open for the recipient). Empty/absent fields are
 *  omitted rather than sent empty, so the shortest useful URL is the one shared. */
export function encodePayLink(origin: string, link: PayLink): string {
  const q = new URLSearchParams();
  q.set('asset', link.asset);
  q.set('network', normaliseNetwork(link.network));
  q.set('amount', link.amount);
  const label = clampLinkText(link.label);
  if (label.length > 0) q.set('label', label);
  const memo = clampLinkText(link.memo);
  if (memo.length > 0) q.set('memo', memo);
  if (link.ref) q.set('ref', link.ref);
  return `${origin}${PAY_LINK_PREFIX}${encodeURIComponent(link.recipient)}?${q.toString()}`;
}

/** The origin a link SHARED from this device should carry: the page's own origin on web (so a
 *  self-hosted wallet shares itself), the canonical public wallet on native. */
export function shareOrigin(): string {
  if (Platform.OS === 'web') {
    const w = globalThis as unknown as {location?: {origin?: string}};
    const origin = w.location?.origin;
    if (origin && origin.length > 0) return origin;
  }
  return WALLET_ORIGIN;
}

/** Web-only: the payment link the page was opened with, read off `location`. Native gets the same
 *  link through `Linking` (App Link) and parses it with `parsePayLink` directly. */
export function readPayLink(): PayLinkParse | null {
  if (Platform.OS !== 'web') return null;
  const w = globalThis as unknown as {location?: {pathname?: string; search?: string}};
  if (!w.location) return null;
  return parsePayLink(`${w.location.pathname ?? ''}${w.location.search ?? ''}`);
}

// --- the till code: `https://<origin>/pl/?lightning=<LNURL…>` -----------------------------------
// The OTHER https URL this wallet mints: the QR a dpay till (OpenCryptoPay) prints for a rung-up
// sale — `{origin}/pl/?lightning=<LNURL of the charge>`. The path itself serves a static landing
// page for a GENERIC camera (a stranger without the app still learns whose till it is), while the
// Android App Link claim on the same path (AndroidManifest, `pathPrefix="/pl/"`) opens the app on
// a phone that has it — the same dual life a payment link has. An inbound URL recognised here is
// routed by Wallet into the OpenCryptoPay payer pipeline (PayMode/SolPayMode `onNotARequest`), the
// SAME machinery a camera scan of the same QR takes: one classification, one set of honest
// refusals, one never-auto-signs rule. No web reader exists for it because the web wallet is never
// served at /pl/ — the landing page is the whole response there.

/** The path a till code lives at. The relay's `TILL_CODE_PATH` (`crates/dpay-relay/src/till.rs`)
 *  is the authority; this is the app-side mirror of it. */
export const TILL_CODE_PATH = '/pl/';

/** Is this URL a till code (exactly the path the relay's till QR prints)? Returns the ORIGINAL
 *  string when it is — the OpenCryptoPay parser (`parseOcpScan`, lib/opencryptopay.ts) owns the
 *  payload grammar, including the honest refusal for a code that carries no usable `lightning`
 *  param — or null when it is not (the caller falls through to its other handling). Like
 *  parsePayLink, the HOST is deliberately not checked: on native the OS only delivers App Links
 *  for the verified host, and a host gate here would only break a self-hosted relay's till.
 *  Never throws. */
export function parseTillCode(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url, 'https://dpay.invalid');
    return u.pathname === TILL_CODE_PATH ? url : null;
  } catch {
    return null;
  }
}

// --- dpay: receipt hand-back deeplink ---------------------------------------------------------
// `dpay:pay/<blob>` carries the rail proof for the NFC-less hand-back: when NFC is unavailable the
// payer (online) settles directly on the IC ledger + shares the rail proof back to the merchant,
// whose request screen format-checks it and confirms the exact open request in durable ledger
// history before reconciling as Paid (never trusts the blob alone).
//
// The blob is base64url(JSON.stringify(proof)) — the rail proof `{ledger, block_index, request_id}`.
// `decodeReceiptDeeplink` base64url-decodes THEN JSON.parses. (The proof is JSON, not a fixed-width
// binary wire — so a JSON codec is the natural shape; the proof is only a trigger —
// recipient/currency/amount/memo must match ledger history before anything is marked Paid.)
//
// Slash-not-query (`/` not `?`) keeps the blob opaque to URL-parsing libs so they don't mangle
// `+`/`%`. Unlike a payment link this is NOT a human-facing artifact: it is machine state handed
// back between two phones, so it stays an opaque blob.

/** A parsed `dpay:pay/` deeplink — `blob` is the base64url rail-proof payload. */
export interface Deeplink { blob: string; }

const DPAY_RECEIPT_SCHEME = 'dpay:pay/';

/** Parse a `dpay:pay/<blob>` URI, or null when the string is not one (wrong scheme/empty blob).
 *  null is the documented "not a receipt hand-back" signal — callers fall through to their other
 *  handling (the payment-link parser, or no-op). Does NOT validate the blob (that is
 *  decodeReceiptDeeplink + parseRailProof, and ultimately the on-chain confirmation). */
export function decodeDeeplink(uri: string): Deeplink | null {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith(DPAY_RECEIPT_SCHEME)) return null;
  const blob = uri.slice(DPAY_RECEIPT_SCHEME.length);
  if (blob.length === 0) return null;
  return {blob};
}

/** Web-only: read a `?pay=<base64url-blob>` query param from the page URL. Returns the raw blob
 *  (base64url of JSON.stringify(receipt)), or null on native / when no `?pay=` is present. The
 *  merchant's ReceiveMode consumes it via the shared rail-proof payload (the
 *  receipt is NEVER trusted unverified). */
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

/** The base64url blob a receipt hand-off carries: base64url(JSON.stringify(receipt)). Shared by the
 *  `dpay:pay/` URI wrapper and the web `/wallet?pay=` URL so there is ONE receipt-blob codec. */
export function receiptShareBlob(receipt: object): string {
  return bytesToBase64Url(utf8ToBytes(JSON.stringify(receipt)));
}

/** Share payload for the receipt hand-back: on web an OPENABLE `/wallet?pay=…` URL (a browser
 *  cannot open a `dpay:` scheme URI), on native the `dpay:pay/` URI the app's own intent-filter
 *  owns. Both carry the identical blob, so the merchant lands on the same verify path either way. */
export function shareReceipt(receipt: object): string {
  const blob = receiptShareBlob(receipt);
  if (Platform.OS === 'web') {
    return `${shareOrigin()}/wallet?pay=${encodeURIComponent(blob)}`;
  }
  return `${DPAY_RECEIPT_SCHEME}${blob}`;
}

/** Decode the `<blob>` portion of a `dpay:pay/` URI back into the receipt object. Returns null on a
 *  malformed/empty blob or one that is not valid base64url/JSON — NEVER throws (the merchant's
 *  reconcile path treats null as "not a valid receipt" and surfaces an error, never a silent Paid).
 *  Carries the blob opaquely — the caller owns binding the rail proof to the open request. */
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

// --- rail-proof FORMAT check (the deeplink trust model) ----------------------------------------
// DEEPLINK TRUST MODEL (2026-08-20, review F2/F6): the `dpay:pay/` blob is an UNTRUSTED, FORGEABLE
// string — a well-formed blob proves NOTHING by itself. The merchant's screen must (1) format-check
// the proof (below — pure, jest-covered), (2) bind it to the OPEN request (watch that request_id on
// the settlement poll), and (3) let the ON-CHAIN read_state confirmation — never the blob — flip
// the UI to Received. Previously the handler trusted a format-valid blob outright (instant
// "Received" on a forged 64-hex request_id); this pure fn is the format gate of that fixed flow.

/** A format-valid rail proof: `request_id` is a 32-byte hex string (the payer envelope's request_id
 *  for THIS payment — unique per signing, so it IS the nonce binding) and `block_index` is a
 *  non-negative decimal string. */
export interface RailProof {
  request_id: string;
  block_index: string;
  ledger?: unknown;
}

/** Format-check a decoded `dpay:pay/` payload as a rail proof. Returns the proof's
 *  `{request_id, block_index}` when well-formed, else null. Pure + total; NEVER throws. This is a
 *  FORMAT gate only — a `null` return means "malformed", a non-null return means "well-formed,
 *  still unverified" (the consumer must confirm settlement on-chain before trusting it). */
export function parseRailProof(proof: Record<string, unknown> | null): RailProof | null {
  if (proof === null || typeof proof !== 'object') return null;
  const rid = proof.request_id;
  const blk = proof.block_index;
  if (typeof rid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rid)) return null;
  if (typeof blk !== 'string' || !/^\d+$/.test(blk)) return null;
  return {request_id: rid, block_index: blk, ledger: proof.ledger};
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
