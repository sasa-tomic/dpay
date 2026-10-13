// The Mt Pelerin cash-out client — the device face of the OFF-RAMP (plan R2 step 2). Quote,
// sell-order registration AND the status fallback poll all ride dpay's relay proxy
// (crates/dpay-relay/src/mtpelerin.rs). Since Mt Pelerin closed dpay's API tier (2026-10-13)
// the sell order itself is created in the USER'S OWN widget session: the relay's creation is
// LOCAL (it mints the `mtp-…` correlation id and answers the record; the id reaches the venue
// on the widget link's `oid` and their completion webhook echoes it back as `external_id`).
// This device never sees a key, holds none, and could not misuse one.
//
// What this module is NOT:
//   - it is not a quote engine: `destAmount` is the venue's own NET figure for the fetch
//     instant, carried verbatim next to the relay's attribution envelope (venue_id +
//     fetched_at). dpay computes nothing, blends nothing (plan §4).
//   - it is not a signer: the ERC-20 transfer to `offRampAddress` is the wallet's own send path
//     (EvmWithdrawSheet). Mt Pelerin's order webhook (the completion signal) terminates at the
//     relay, which verifies the HMAC and stores the payload; the app's status poll answers the
//     stored state with ZERO upstream calls (webhook-first).
//
// Fail-closed vocabulary (the trocador service's precedent): 'unconfigured' (relay has no key —
// 503, the venue is absent), 'unreachable', 'refused', 'unavailable', 'shape'. NO result is
// ever defaulted.

import {relayFetch} from './relay';

/** The venue's documented network spellings (their general-parameters doc, verbatim — the
 *  same values the buy-side builder uses; duplicated here because app/ramp/mtpelerin.ts is
 *  buy-owned and this module stays cash-out-owned). */
const MTP_SELL_NETWORK: Record<number, string> = {
  1: 'mainnet',
  42161: 'arbitrum_mainnet',
};

/** Their network name for a dpay chain id, fail-closed (an unwired chain has none). */
export function mtpSellNetworkOf(chainId: number): string | null {
  return MTP_SELL_NETWORK[chainId] ?? null;
}

/** One quote: the venue's own net fiat figure (their `destAmount` — "the net final amount,
 *  which includes all applicable fees", price-quote doc 2026-10-12) plus the relay's
 *  attribution instant. Numbers stay the venue's own strings — never reformatted. */
export type MtpCashQuote = {
  /** The venue's net fiat figure for the quoted source amount (decimal string). */
  readonly destAmount: string;
  /** The venue's own network-fee line when the body carried one (verbatim decimal string). */
  readonly networkFee: string | null;
  /** The RELAY's read instant (ms) — the provenance line anchors here, not the phone clock. */
  readonly fetchedAtMs: number;
};

/** The sell order dpay registered, normalized to what the record + the send step need. The
 *  relay's creation is LOCAL (the venue's API tier is closed for dpay, 2026-10-13): it
 *  answers OUR record in the status route's shape, and the venue's own facts are null
 *  until the completion webhook names them. The deposit address is still REQUIRED for the
 *  handoff: the wallet's ERC-20 send cannot start without a venue address, so a record
 *  without one fails closed ('shape') instead of inventing a destination. */
export type MtpCashOrder = {
  /** dpay's own order id (the `X-Dpay-Order-Id` creation header): the correlation key the
   *  webhook echoes (`external_id`), the status route's key, and the record's providerRef. */
  readonly orderId: string;
  /** The venue's own order id when the creation record carried one. The born state is
   *  null: dpay creates no venue-side order, so only the webhook can name one. */
  readonly venueOrderId: string | null;
  /** The sell order's deposit address: the wallet's send target. REQUIRED for the
   *  handoff (the venue issues it in the user's own widget session; until a creation
   *  answer carries one, the flow refuses before any send). */
  readonly offRampAddress: string;
  /** The venue's own expiry when the answer carried a parseable one (ms). The local
   *  creation record carries no expiry: always null today, never invented. */
  readonly expiresAtMs: number | null;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Fetch one cash-out quote THROUGH THE RELAY. `sourceAmount` is the crypto amount the user
 *  typed (plain decimal string); `sourceNetwork` is the venue's name for the token's chain. */
export async function fetchMtpCashQuote(
  relayUrl: string,
  args: {sourceCurrency: string; destCurrency: string; sourceAmount: string; sourceNetwork?: string},
  timeoutMs = 8000,
): Promise<MtpCashQuote> {
  const base = relayUrl.replace(/\/+$/, '');
  const q = new URLSearchParams({
    sourceCurrency: args.sourceCurrency,
    destCurrency: args.destCurrency,
    sourceAmount: args.sourceAmount,
  });
  if (args.sourceNetwork != null && args.sourceNetwork.length > 0) q.set('sourceNetwork', args.sourceNetwork);
  let r: Response;
  try {
    r = await relayFetch(base, `/api/v1/mtpelerin/quote?${q.toString()}`, undefined, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 400 || r.status === 422) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const j = await r.json().catch(() => null) as
    | {venue_id?: unknown; quote?: Record<string, unknown> | null; fetched_at?: unknown}
    | null;
  const body = j != null ? j.quote : null;
  const dest = body != null ? body.destAmount : null;
  const destStr = typeof dest === 'string' ? dest : typeof dest === 'number' && Number.isFinite(dest) ? String(dest) : null;
  if (j == null || j.venue_id !== 'mtpelerin' || body == null
    || destStr == null || destStr.length === 0 || !/^\d+(\.\d+)?$/.test(destStr)) {
    throw new Error('shape');
  }
  const fee = body.fees != null && typeof body.fees === 'object'
    ? (body.fees as Record<string, unknown>).networkFee
    : null;
  return {
    destAmount: destStr,
    networkFee: typeof fee === 'string' && fee.length > 0 ? fee : null,
    fetchedAtMs: typeof j.fetched_at === 'number' ? j.fetched_at * 1000 : 0,
  };
}

/** Register the sell order THROUGH THE RELAY (the correlation id is minted server-side;
 *  the registration is local since the venue's API tier closed, 2026-10-13: the order id
 *  reaches Mt Pelerin on the widget link's `oid` and their completion webhook echoes it
 *  back). The answer is the record in the status route's shape, and the BORN state is
 *  pinned honestly: `order_id` must equal the `X-Dpay-Order-Id` header (one correlation
 *  pair), and `terminal`/`payload`/`venue_order_id` must be their born values (a creation
 *  answer claiming venue-side facts would describe an order dpay never created). The send
 *  target is the venue's `offRampAddress`, required and required to be an EVM address
 *  for this rail's assets (fail-closed: a non-EVM deposit address cannot be sent to by
 *  the wallet's ERC-20 path and would strand the order); a record without one is 'shape'
 *  and the flow refuses before any send. `clientOrderId` is the locally minted
 *  convert-record id (the partner-agreement correlation law): the record that persists
 *  locally IS the id the relay logs for this order. */
export async function createMtpCashOrder(
  relayUrl: string,
  args: {
    sourceCurrency: string;
    destCurrency: string;
    sourceAmount: string;
    sourceNetwork?: string;
    iban: string;
    holderName: string;
    clientOrderId?: string;
  },
  timeoutMs = 15000,
): Promise<MtpCashOrder> {
  const base = relayUrl.replace(/\/+$/, '');
  const clientOrderId = args.clientOrderId != null && args.clientOrderId.length > 0
    ? args.clientOrderId
    : null;
  let r: Response;
  try {
    r = await relayFetch(base, '/api/v1/mtpelerin/conversion', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        sourceCurrency: args.sourceCurrency,
        destCurrency: args.destCurrency,
        sourceAmount: args.sourceAmount,
        ...(args.sourceNetwork != null && args.sourceNetwork.length > 0 ? {sourceNetwork: args.sourceNetwork} : {}),
        iban: args.iban,
        holderName: args.holderName,
        ...(clientOrderId != null ? {clientOrderId} : {}),
      }),
    }, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 400 || r.status === 422) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const orderId = headerValue(r, 'x-dpay-order-id');
  if (orderId == null) throw new Error('shape'); // no correlation id — the order cannot be watched
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (j == null || typeof j !== 'object') throw new Error('shape');
  // The record's own id must AGREE with the header: one correlation pair, not two.
  if (j.order_id !== orderId) throw new Error('shape');
  // The BORN state: `terminal`/`payload`/`venue_order_id` carry venue-side facts dpay
  // never created server-side; any other values describe an order this flow cannot have.
  if (j.terminal !== false || j.payload != null || j.venue_order_id != null) throw new Error('shape');
  const offRamp = typeof j.offRampAddress === 'string' ? j.offRampAddress.trim() : null;
  if (offRamp == null || offRamp.length === 0 || !EVM_ADDRESS.test(offRamp)) {
    // No deliverable deposit address in the record: the send cannot start, and nothing
    // is invented (the venue issues the address in the user's own widget session).
    throw new Error('shape');
  }
  return {
    orderId,
    venueOrderId: null,
    offRampAddress: offRamp,
    expiresAtMs: null,
  };
}

/** The RELAY's webhook-first status URL for one dpay order id — the record's providerRef
 *  statusUrl. The store answers with zero upstream calls; the promised poll cap (one read per
 *  order per 60 s, 429 + Retry-After beyond) is the relay's own discipline. */
export function mtpCashStatusUrl(relayUrl: string, orderId: string): string {
  const base = relayUrl.replace(/\/+$/, '');
  return `${base}/api/v1/mtpelerin/conversion?id=${encodeURIComponent(orderId)}`;
}

/** IBAN validity: the ISO 13616 structure check plus the mod-97 checksum, over the
 *  spaces/hyphens-stripped uppercase form. Pure — jest-pinned. */
export function isValidIban(input: string): boolean {
  const v = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  // Rearrange (first four to the end), map letters to 10..35, one pass mod 97.
  const rearranged = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    rem = code >= 65 ? (rem * 100 + (code - 55)) % 97 : (rem * 10 + (code - 48)) % 97;
  }
  return rem === 1;
}

/** One response header's value, trimmed, empty → null (Headers.get is already
 *  case-insensitive; the try guards a mocked/degenerate Response with no headers). */
function headerValue(r: Response, name: string): string | null {
  try {
    const raw = r.headers?.get?.(name) ?? null;
    const trimmed = raw != null ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
