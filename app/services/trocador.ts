// The Trocador client — the device face of the FIRST AGGREGATOR `cefi` venue row
// (registered 2026-09-20; Trocador fronts 20+ backends with automatic failover and is
// slated to replace SideShift as the primary CeFi rail once the partner key lands).
//
// The SPLIT with SideShift collapses to ONE surface: EVERY Trocador method is key-gated
// (the venue's docs and the live 2026-09-20 probe agree — every api.trocador.app endpoint
// answers 401 {"error":"Missing API key"} without the `API-Key` header), so there is NO
// keyless device-direct read anywhere in this venue. Quote, trade creation AND the status
// poll all ride dpay's relay proxy (crates/dpay-relay/src/trocador.rs), which attaches the
// key server-side — this device never sees a key, holds none, and could not misuse one.
// The record's statusUrl therefore points at THE RELAY's status route; a status poll
// answers the venue's own trade body verbatim (top-level `status`, `amount_to`,
// `details.hashout` — the fields the resume engine reads).
//
// What this module is NOT:
//   - it is not a signer: the user sends the deposit to the VENUE's own deposit address
//     (address_provider) and Trocador's backend executes. This is what kind:'cefi' MEANS.
//   - it is not a quote engine: amount_to is the venue's own figure for its own chosen
//     provider (best_only=True — the aggregator's pick, one quote, attributed to Trocador;
//     dpay never ranks beneath the aggregate), carried verbatim (V8). The relay pins
//     markup=0 (no dpay cut — a nonzero markup would RAISE THE USER'S PRICE) and
//     min_kycrating=A (non-KYC backends only) server-side.
//   - it never ranks or blends: one venue, one quote, attributed and timestamped.
//
// Rate-lock honesty: the venue's docs do NOT document a lock window for a rate id, so this
// surface makes NO floor claim — the figure shown is the venue's own estimate at the
// fetch instant (the fixed=True trade pins the amount at CONFIRM, which is the consent
// point), and the UI copy says the final figure is the venue's own.

import {relayFetch} from './relay';
import type {VenueEntry} from '../config/venues';

/** The quote result the relay wrapped: the venue's own body VERBATIM under `quote`,
 *  plus the relay's attribution envelope (venue_id + the actual read instant). */
export type TrocadorQuoteResult = {
  readonly venueId: string;
  /** The venue's RATE id — required (with the provider) to create the trade it prices. */
  readonly rateId: string;
  /** The backend the aggregator picked — echoed back at trade creation. */
  readonly provider: string;
  /** The venue's own settle figure for the deposit (decimal string, venue units). */
  readonly settleAmount: string;
  /** The venue's own rate-type flag for the quote (the trade pins fixed=True). */
  readonly fixed: boolean | null;
  /** The RELAY's read instant (ms) — every provenance line anchors here, not the phone clock. */
  readonly fetchedAtMs: number;
};

/** The trade the venue issued — the fields the record persists, verbatim. */
export type TrocadorTrade = {
  /** The trade id — the status-read key (and the record's providerRef.orderId). */
  readonly tradeId: string;
  /** The RELAY's own order id for this trade (the `X-Dpay-Order-Id` response header,
   *  2026-09-22 partner agreement): the relay records it next to the venue's trade id in
   *  its order store + compliance log, and keys its webhook push on it. Null when the
   *  header is absent (an older relay) — the record simply persists nothing. */
  readonly relayOrderId: string | null;
  /** The VENUE's own deposit address — what the USER sends to (this is the CeFi fact). */
  readonly depositAddress: string;
  /** Present when the venue's deposit address carries a memo/ExtraID requirement. */
  readonly depositMemo: string | null;
  /** The EXACT deposit the trade prices (decimal string, venue units). */
  readonly depositAmount: string;
  /** The venue's settle figure for this order (decimal string, venue units). */
  readonly settleAmount: string | null;
  /** The venue documents no expiry field on new_trade — always null here, honestly. */
  readonly expiresAt: null;
};

/** The RELAY's key-gated status URL for one trade id — the record's
 *  providerRef.statusUrl. Unlike SideShift there is NO keyless venue host to poll
 *  directly: the relay attaches DPAY_TROCADOR_API_KEY to this read server-side. */
export function trocadorStatusUrl(relayUrl: string, tradeId: string): string {
  const base = relayUrl.replace(/\/+$/, '');
  return `${base}/api/v1/trocador/trade?id=${encodeURIComponent(tradeId)}`;
}

/** Fetch one Trocador rate THROUGH THE RELAY (the key lives there). The device sends
 *  rail ids; the relay maps them to the venue's ticker/network codes, attaches the key,
 *  pins min_kycrating=A + markup=0 + best_only=True, and wraps the venue's answer with
 *  attribution. The attribution check pins the exact registry row this call quoted —
 *  a foreign or cross-row attribution is a shape failure. Fail-closed vocabulary mirrors
 *  the sideshift service: 'unconfigured' (relay has no key — the venue is absent, 503),
 *  'unreachable', 'refused', 'unavailable', 'shape'. NO result is ever defaulted. */
export async function fetchTrocadorQuote(
  relayUrl: string,
  venue: VenueEntry,
  depositLedger: string,
  settleLedger: string,
  depositAmountDecimal: string,
  timeoutMs = 8000,
): Promise<TrocadorQuoteResult> {
  if (venue.kind !== 'cefi' || venue.testnet) throw new Error('refused');
  let r: Response;
  try {
    r = await relayFetch(relayUrl, '/api/v1/trocador/rate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        depositLedger,
        settleLedger,
        depositAmount: depositAmountDecimal,
      }),
    }, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 422 || r.status === 400) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const j = await r.json().catch(() => null) as
    | {venue_id?: unknown; quote?: Record<string, unknown> | null; fetched_at?: unknown}
    | null;
  const q = j != null ? j.quote : null;
  if (j == null || j.venue_id !== venue.venue_id || q == null
    || typeof q.trade_id !== 'string' || q.trade_id.length === 0
    || typeof q.amount_to !== 'string'
    || typeof q.provider !== 'string' || q.provider.length === 0) {
    throw new Error('shape');
  }
  return {
    venueId: venue.venue_id,
    rateId: q.trade_id,
    provider: q.provider,
    settleAmount: q.amount_to,
    fixed: typeof q.fixed === 'boolean' ? q.fixed : null,
    fetchedAtMs: typeof j.fetched_at === 'number' ? j.fetched_at * 1000 : 0,
  };
}

/** Create the trade THROUGH THE RELAY (key attached server-side). The body carries the
 *  quote's rate id + provider, the user's OWN settle address, and the user's OWN refund
 *  address ON THE DEPOSIT RAIL — where the venue returns the funds if the deposit fails
 *  (a fund-loss class defect without it: the venue would keep them). `depositLedger`
 *  names that rail so the relay can scope the refund-address check; `settleLedger`
 *  re-states the pair so the relay's allowlist gates the whole trade. The relay pins
 *  fixed=True — the venue's documented fixed-rate trade, whose exact amount_from is what
 *  the user was shown and approved. The venue answers with ITS deposit address, which
 *  the record shows to the user verbatim (this screen is the honest CeFi handoff:
 *  nothing is signed, the user sends).
 *
 *  Partner-agreement correlation (2026-09-22): `clientOrderId` is the LOCALLY persisted
 *  conversion record's id, minted by this device BEFORE the order exists — the relay
 *  records it next to its own order id and the venue's trade id, so a support/retention
 *  request about one trade can be answered from our own store. Optional on the wire: an
 *  absent/empty id omits the field rather than sending an empty correlation claim. The
 *  relay answers with ITS order id in `X-Dpay-Order-Id`, read here (absent → null) and
 *  persisted on the record beside the trade id. */
export async function createTrocadorTrade(
  relayUrl: string,
  venue: VenueEntry,
  args: {
    rateId: string;
    provider: string;
    settleAddress: string;
    refundAddress: string;
    depositLedger: string;
    settleLedger: string;
    depositAmount: string;
    clientOrderId?: string;
  },
  timeoutMs = 8000,
): Promise<TrocadorTrade> {
  if (venue.kind !== 'cefi' || venue.testnet) throw new Error('refused');
  if (args.rateId.length === 0 || args.provider.length === 0
    || args.settleAddress.length === 0 || args.refundAddress.length === 0
    || args.depositLedger.length === 0 || args.settleLedger.length === 0
    || args.depositAmount.length === 0) throw new Error('refused');
  const clientOrderId = args.clientOrderId != null && args.clientOrderId.length > 0
    ? args.clientOrderId
    : null;
  let r: Response;
  try {
    r = await relayFetch(relayUrl, '/api/v1/trocador/trade', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        rateId: args.rateId,
        provider: args.provider,
        settleAddress: args.settleAddress,
        refundAddress: args.refundAddress,
        depositLedger: args.depositLedger,
        settleLedger: args.settleLedger,
        depositAmount: args.depositAmount,
        ...(clientOrderId != null ? {clientOrderId} : {}),
      }),
    }, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 400 || r.status === 422) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const relayOrderId = headerValue(r, 'x-dpay-order-id');
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (j == null || typeof j.trade_id !== 'string' || j.trade_id.length === 0
    || typeof j.address_provider !== 'string' || j.address_provider.length === 0
    || typeof j.amount_from !== 'string') {
    throw new Error('shape');
  }
  return {
    tradeId: j.trade_id,
    relayOrderId,
    depositAddress: j.address_provider,
    depositMemo: typeof j.address_provider_memo === 'string' ? j.address_provider_memo : null,
    depositAmount: j.amount_from,
    settleAmount: typeof j.amount_to === 'string' ? j.amount_to : null,
    expiresAt: null, // the venue documents no expiry field — never invented
  };
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
