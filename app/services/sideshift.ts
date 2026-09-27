// The SideShift client — the device face of the FIRST `cefi` venue row (registered
// 2026-09-15, founder decision 3: relay-held partner-key infrastructure,
// docs/specs/2026-09-14-swap-venue-feasibility.md §Partner-key infrastructure).
//
// Unlike every venue before it, SideShift has NO keyless quote surface (the feasibility
// sweep's verdict: account + token auth), so the SPLIT is:
//   - QUOTES and FIXED-ORDER CREATION go through dpay's OWN relay proxy
//     (POST /api/v1/sideshift/quotes and /api/v1/sideshift/shifts/fixed,
//     crates/dpay-relay/src/sideshift.rs). The relay attaches the partner account's
//     credentials server-side — this device never sees a key, holds none, and could not
//     misuse one. The relay wraps the venue's quote with attribution + its own
//     fetched_at; order answers pass back VERBATIM.
//   - SHIFT STATUS is SideShift's own KEYLESS GET (verified live 2026-09-15: an unauth'd
//     read of a real shift id answers the full record), so the device polls it DIRECTLY —
//     exactly the opencryptopay.ts device-direct-provider shape, through the resume
//     engine's provider path (app/convertResume.ts fetchProviderStatus). The relay is
//     never in the status path.
//
// What this module is NOT:
//   - it is not a signer: a CeFi shift needs no signature from this wallet at all — the
//     user sends the deposit to the VENUE's own address (the order's depositAddress) and
//     SideShift executes. This is what kind:'cefi' MEANS (the disclosures say it plainly).
//   - it is not a quote engine: settleAmount/rate are SideShift's own published figures,
//     carried verbatim (V8); dpay's commissionRate is pinned "0" RELAY-SIDE, so the
//     figure the user sees is SideShift's rate with no dpay cut and no dpay addition.
//   - it never ranks or blends: one venue, one quote, attributed and timestamped.
//
// Wire shapes as verified live + from docs.sideshift.ai 2026-09-15 (host
// https://sideshift.ai/api/v2 — the old api.sideshift.ai is NXDOMAIN):
//   POST {base}/quotes    {depositCoin, depositNetwork, settleCoin, settleNetwork,
//                          depositAmount, settleAmount: null, affiliateId, commissionRate}
//     → 201 {...echo, id: QUOTE_ID, rate, settleAmount} (quote lives 15 min)
//   POST {base}/shifts/fixed {quoteId, settleAddress, settleMemo?, refundAddress,
//                          affiliateId}
//     → 201 {id, depositAddress, depositMemo?, depositAmount, settleAmount, expiresAt, …}
//     `refundAddress` is the USER'S OWN address on the DEPOSIT rail — where the venue
//     returns the funds when a deposit fails or the order expires. Non-custodial red
//     line: it is derived from the user's own key in the flow that already knows it
//     (IC-side: the wallet's IC principal; SOL-side: the wallet's Solana address), never
//     a dpay-controlled address, and the relay refuses an order without one.
//   GET  {base}/shifts/{id}  — KEYLESS status read: {status: settled|refund|refunded|
//     expired|multiple|…, settleAmount, settleHash, …}
// The device→relay bodies deliberately speak RAIL ids (IC ledger principal / Solana
// mint) — the relay owns the rail-id→venue-code mapping, so a hostile or stale registry
// row cannot make this client send the venue a coin code it never registered.

import {relayFetch} from './relay';
import type {VenueEntry} from '../config/venues';

/** The venue's own status host — device-direct, https-only, keyless (the resume engine's
 *  provider path fetches it with fetchProviderStatus, never relayFetch). */
export const SIDESHIFT_STATUS_BASE = 'https://sideshift.ai/api/v2';

/** The keyless status URL for one shift id (the record's providerRef.statusUrl). */
export function sideShiftStatusUrl(orderId: string): string {
  return `${SIDESHIFT_STATUS_BASE}/shifts/${encodeURIComponent(orderId)}`;
}

/** The relay-wrapped quote: the venue's own body VERBATIM under `quote`, plus the
 *  relay's attribution envelope (venue_id + the actual read instant). */
export type SideShiftQuoteResult = {
  readonly venueId: string;
  /** The venue's QUOTE_ID — required to create the fixed order it prices. */
  readonly quoteId: string;
  /** SideShift's own settle figure for the deposit (decimal string, venue units). */
  readonly settleAmount: string;
  /** SideShift's own rate (decimal string) — displayed verbatim, never blended. */
  readonly rate: string | null;
  /** The RELAY's read instant (ms) — every provenance line anchors here, not the phone clock. */
  readonly fetchedAtMs: number;
};

/** The fixed shift the venue issued — the fields the record persists, verbatim. */
export type SideShiftFixedShift = {
  /** The shift id — the status-read key (and the record's providerRef.orderId). */
  readonly id: string;
  /** The VENUE's own deposit address — what the USER sends to (this is the CeFi fact). */
  readonly depositAddress: string;
  /** Required by the venue's own wire when present: a memo/tag the deposit MUST carry. */
  readonly depositMemo: string | null;
  /** The EXACT deposit the fixed shift prices (decimal string, venue units). */
  readonly depositAmount: string;
  /** The venue's settle figure for this order (decimal string, venue units). */
  readonly settleAmount: string | null;
  /** When the fixed order dies if the deposit never lands (ISO string, venue's own). */
  readonly expiresAt: string | null;
};

/** Fetch one SideShift quote THROUGH THE RELAY (the partner key lives there). The device
 *  sends rail ids; the relay maps them to the venue's coin/network codes, attaches the
 *  credentials, pins commissionRate "0", and wraps the venue's answer with attribution.
 *  The attribution is the REGISTRY ROW that answered — the venue family is several rows
 *  (sideshift, sideshift-usdc, sideshift-eurc, …) — so the check pins it to the exact row
 *  this call quoted; a foreign or cross-row attribution is a shape failure. Fail-closed
 *  vocabulary mirrors the IC quote path: 'unconfigured' (relay has no partner credential —
 *  the venue is absent, 503), 'unreachable', 'refused', 'unavailable', 'shape'. NO result
 *  is ever defaulted. */
export async function fetchSideShiftQuote(
  relayUrl: string,
  venue: VenueEntry,
  depositLedger: string,
  settleLedger: string,
  depositAmountDecimal: string,
  timeoutMs = 8000,
): Promise<SideShiftQuoteResult> {
  if (venue.kind !== 'cefi' || venue.testnet) throw new Error('refused');
  let r: Response;
  try {
    r = await relayFetch(relayUrl, '/api/v1/sideshift/quotes', {
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
    || typeof q.id !== 'string' || q.id.length === 0
    || typeof q.settleAmount !== 'string') {
    throw new Error('shape');
  }
  return {
    venueId: venue.venue_id,
    quoteId: q.id,
    settleAmount: q.settleAmount,
    rate: typeof q.rate === 'string' ? q.rate : null,
    fetchedAtMs: typeof j.fetched_at === 'number' ? j.fetched_at * 1000 : 0,
  };
}

/** Create the fixed order THROUGH THE RELAY (credential attached server-side). The body
 *  carries the quote the user approved, the user's OWN settle address, and the user's
 *  OWN refund address ON THE DEPOSIT RAIL — where the venue returns the funds if the
 *  deposit fails or the order expires (a fund-loss class defect without it: the venue
 *  would keep them). `depositLedger` names that rail (the device's rail id — never
 *  forwarded to the venue) so the relay can scope the refund-address check; `settleLedger`
 *  (2026-09-27, the EVM-native widening) names the SETTLE rail so the relay can gate the
 *  settle address on the rail the quote actually named — an ICP deposit may settle on
 *  `ethereum` now, which the old icp↔solana complement could not express. The venue
 *  answers with ITS deposit address, which the record shows to the user verbatim (this
 *  screen is the honest CeFi handoff: nothing is signed, the user sends). The relay
 *  re-validates both addresses and refuses an order whose refund address is missing or
 *  malformed for the deposit rail. */
export async function createSideShiftFixedShift(
  relayUrl: string,
  venue: VenueEntry,
  args: {quoteId: string; settleAddress: string; refundAddress: string; depositLedger: string; settleLedger?: string; settleMemo?: string},
  timeoutMs = 8000,
): Promise<SideShiftFixedShift> {
  if (venue.kind !== 'cefi' || venue.testnet) throw new Error('refused');
  if (args.settleAddress.length === 0 || args.refundAddress.length === 0
    || args.depositLedger.length === 0) throw new Error('refused');
  let r: Response;
  try {
    r = await relayFetch(relayUrl, '/api/v1/sideshift/shifts/fixed', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        quoteId: args.quoteId,
        settleAddress: args.settleAddress,
        refundAddress: args.refundAddress,
        depositLedger: args.depositLedger,
        ...(args.settleLedger != null && args.settleLedger.length > 0 ? {settleLedger: args.settleLedger} : {}),
        ...(args.settleMemo != null ? {settleMemo: args.settleMemo} : {}),
      }),
    }, timeoutMs);
  } catch {
    throw new Error('unreachable');
  }
  if (r.status === 503) throw new Error('unconfigured');
  if (r.status === 400 || r.status === 422) throw new Error('refused');
  if (!r.ok) throw new Error('unavailable');
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (j == null || typeof j.id !== 'string' || j.id.length === 0
    || typeof j.depositAddress !== 'string' || j.depositAddress.length === 0
    || typeof j.depositAmount !== 'string') {
    throw new Error('shape');
  }
  return {
    id: j.id,
    depositAddress: j.depositAddress,
    depositMemo: typeof j.depositMemo === 'string' ? j.depositMemo : null,
    depositAmount: j.depositAmount,
    settleAmount: typeof j.settleAmount === 'string' ? j.settleAmount : null,
    expiresAt: typeof j.expiresAt === 'string' ? j.expiresAt : null,
  };
}
