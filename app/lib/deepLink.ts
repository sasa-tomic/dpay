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
//   ref        optional 32-hex reconciliation nonce = the on-chain ICRC memo. PRESENT ⇒ a single
//              invoice: the ledger's own duplicate check makes a second payment of the identical
//              transfer a no-op ("already paid"), and the payee's open request screen matches it.
//              ABSENT ⇒ a reusable link (tip jar): the payer's app mints a fresh nonce per payment.
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
const RE_REF = /^[0-9a-fA-F]{32}$/; // the 16-byte wire nonce, hex

/** Canonical spelling of a settlement-chain name: lowercase, spaces as hyphens. So a link written
 *  by hand as `network=Internet%20Computer` and one written by the app as
 *  `network=internet-computer` name the SAME chain — one value, one comparison. */
export function normaliseNetwork(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Truncate to at most `PAY_LINK_TEXT_BYTES` UTF-8 bytes on a character boundary. The wire applies
 *  the same byte cap to `to_name`/`memo`, so the link and the QR built from one merchant input
 *  carry the same string. Pure + total. */
export function clampLinkText(s: string): string {
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
