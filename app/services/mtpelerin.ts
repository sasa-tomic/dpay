// The Mt Pelerin cash-out client — the device face of the OFF-RAMP (plan R2 step 2). Quote,
// sell-order registration, the status fallback poll AND the widget-embed token injection all
// ride dpay's relay proxy (crates/dpay-relay/src/mtpelerin.rs). Since Mt Pelerin closed dpay's
// API tier (2026-10-13) the sell order itself is created in the USER'S OWN widget session: the
// relay's creation is LOCAL (it mints the `mtp-…` correlation id and answers the record), and
// the sheet hands off to the venue's sell widget. The bank details and the deposit address live
// ONLY in that widget session - dpay never collects or learns them. This device never sees a
// key, holds none, and could not misuse one (the widget token is injected SERVER-side and
// reaches the device only inside the tokenized URL, never as a value it stores).
//
// What this module is NOT:
//   - it is not a quote engine: `destAmount` is the venue's own NET figure for the fetch
//     instant, carried verbatim next to the relay's attribution envelope (venue_id +
//     fetched_at). dpay computes nothing, blends nothing (plan §4).
//   - it is not a signer and moves no funds: the sale (and the user's deposit to the
//     venue's own address) happens entirely in the widget session. Mt Pelerin's order
//     webhook (the completion signal) terminates at the relay, which verifies the HMAC and
//     stores the payload; the app's status poll answers the stored state with ZERO
//     upstream calls (webhook-first).
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

/** The sell order dpay registered, normalized to what the record + the lifecycle watch
 *  need. The relay's creation is LOCAL (the venue's API tier is closed for dpay,
 *  2026-10-13): it answers OUR record in the status route's shape, and the venue's own
 *  facts are null until the completion webhook names them. The deposit address is
 *  informational only now (it can be null at creation and there is no dpay send step: the
 *  sale completes in the user's own Mt Pelerin widget session). */
export type MtpCashOrder = {
  /** dpay's own order id (the `X-Dpay-Order-Id` creation header): the correlation key the
   *  webhook echoes (`external_id`), the status route's key, and the record's providerRef. */
  readonly orderId: string;
  /** The venue's own order id when the creation record carried one. The born state is
   *  null: dpay creates no venue-side order, so only the webhook can name one. */
  readonly venueOrderId: string | null;
  /** The venue's deposit address when the record carried one (null at creation, the born
   *  state). Informational: no dpay flow sends to it - the widget session holds the real
   *  one. */
  readonly offRampAddress: string | null;
  /** The venue's own expiry when the answer carried a parseable one (ms). The local
   *  creation record carries no expiry - always null today, never invented. */
  readonly expiresAtMs: number | null;
};

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
 *  the registration is local since the venue's API tier closed, 2026-10-13). The answer
 *  is the record in the status route's shape, and the BORN state is pinned honestly:
 *  `order_id` must equal the `X-Dpay-Order-Id` header (one correlation pair), and
 *  `terminal`/`payload`/`venue_order_id` must be their born values (a creation answer
 *  claiming venue-side facts would describe an order dpay never created). The record's
 *  `offRampAddress` parses verbatim when present (null at creation is the born state and
 *  is fine: no dpay flow sends to it - the sale completes in the user's own widget
 *  session). `clientOrderId` is the locally minted convert-record id (the
 *  partner-agreement correlation law): the record that persists locally IS the id the
 *  relay logs for this order. */
export async function createMtpCashOrder(
  relayUrl: string,
  args: {
    sourceCurrency: string;
    destCurrency: string;
    sourceAmount: string;
    sourceNetwork?: string;
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
  // The deposit address parses verbatim when present; absent/empty is the born state.
  const rawAddress = typeof j.offRampAddress === 'string' ? j.offRampAddress.trim() : null;
  const offRamp = rawAddress != null && rawAddress.length > 0 ? rawAddress : null;
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

/** The documented widget origin, prefix form (the ramp builder's `MTP_WIDGET_BASE`; duplicated
 *  here because app/ramp/mtpelerin.ts is buy-owned and this module stays venue-client-owned). */
const MTP_WIDGET_PREFIX = 'https://widget.mtpelerin.com/';

/** Ask the relay to inject the widget integration key SERVER-side (POST
 *  /api/v1/mtpelerin/widget-token, 2026-10-15): the device posts the widget URL it built
 *  WITHOUT `_ctkn` — the reviewed buy prefill, or the sell widget's bare base — and the relay
 *  validates the shape fail-closed (https, the documented host, the parameter whitelist, an
 *  incoming `_ctkn` refused) and answers `{"url": …}` with the token appended from its own
 *  config. THE CLIENT NEVER HOLDS THE TOKEN: it arrives only inside this answer and rides
 *  straight into the in-app webview (the embed), so it can never ship in the bundle.
 *
 *  Fail-closed like the quote/order clients (the house vocabulary, plus the limiter word):
 *  'unconfigured' (relay has no key — 503), 'refused' (400/422 — the URL failed the relay's
 *  validation), 'limited' (429 — the per-client window), 'unreachable' (transport),
 *  'unavailable' (other non-2xx), 'shape' (unreadable answer — including an answer that does
 *  not point at the documented widget origin WITH a token, which the embed must never load). */
export async function widgetTokenOf(relayUrl: string, widgetUrl: string, timeoutMs = 8000): Promise<string> {
  const base = relayUrl.replace(/\/+$/, '');
  let r: Response;
  try {
    r = await relayFetch(base, '/api/v1/mtpelerin/widget-token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: widgetUrl}),
    }, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 429) throw new Error('limited');
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 400 || r.status === 422) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const j = await r.json().catch(() => null) as {url?: unknown} | null;
  const url = typeof j?.url === 'string' ? j.url : '';
  if (!url.startsWith(MTP_WIDGET_PREFIX)) throw new Error('shape');
  if (!/[?&]_ctkn=/.test(url)) throw new Error('shape'); // no token, no embed: the route's whole point
  return url;
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
