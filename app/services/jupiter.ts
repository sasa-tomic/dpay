// The Jupiter client — the device-direct, KEYLESS https face of a `solana_amm` venue
// (multi-venue readiness V11, registered 2026-09-15). Shape precedent:
// `services/opencryptopay.ts` (the CeFi device-direct provider): the phone talks to the venue
// itself, dpay's relay is never in the call path, no credential exists anywhere.
//
// What this module is NOT:
//   - it is not a quote engine: inAmount/outAmount/priceImpact/slippageBps are Jupiter's own
//     published figures, carried VERBATIM to the screen (V8 — display what the venue publishes,
//     derive only what it does not);
//   - it is not a signer: the swap transaction comes back UNSIGNED and is verified + signed by
//     the device (app/solana/tx.ts), never here;
//   - it never ranks or blends: one venue, one quote, attributed and timestamped.
//
// The two calls, exactly as measured live 2026-09-14 (docs/specs/2026-09-14-swap-venue-feasibility.md):
//   GET  {endpoint}/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=  → quote JSON
//   POST {endpoint}/swap/v1/swap  {quoteResponse, userPublicKey, wrapAndUnwrapSol} → unsigned tx
//
// Fail-closed error vocabulary matches the IC quote path (`convert.ts` getSwapQuote) so the
// screens render the same honesty: network/timeout → 'unreachable'; a readable 4xx → 'refused'
// (the venue said no — e.g. no route for this size); anything else not-ok → 'unavailable'; a
// 2xx body that does not parse to the pinned shape → 'shape'. NO result is ever defaulted.
import {fetchWithTimeout} from './relay';
import {base64ToBytes} from '../lib/base64';
import type {VenueEntry} from '../config/venues';

/** Jupiter's own quote, verbatim. Raw units are STRINGS (u64-scale integers as decimal text). */
export type JupiterQuote = {
  readonly venueId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  /** Raw in-units — byte-for-byte what Jupiter published. */
  readonly inAmount: string;
  /** Raw out-units — byte-for-byte what Jupiter published (an ESTIMATE, not a floor). */
  readonly outAmount: string;
  /** Jupiter's own min-out for the requested slippage — its figure, not ours. */
  readonly otherAmountThreshold: string;
  /** Jupiter's own price-impact figure ('0.03' = 0.03%) — null when it publishes none. */
  readonly priceImpactPct: string | null;
  /** The slippage WE asked for, echoed by the venue. */
  readonly slippageBps: number;
  /** The venue's integrator-fee tier in bps — null means Jupiter charges nothing through this
   *  integration (measured `platformFee: null`, 2026-09-14; dpay takes no cut either way). */
  readonly platformFeeBps: number | null;
  /** The VERBATIM quote body — the ONLY thing POST /swap accepts as quoteResponse. */
  readonly raw: unknown;
  /** The DEVICE-read instant (Jupiter publishes no timestamp; this is the attribution instant). */
  readonly fetchedAtMs: number;
};

/** Jupiter's built-but-unsigned swap (the POST /swap reply, decoded). */
export type JupiterSwapTx = {
  readonly swapTransaction: Uint8Array;
  readonly lastValidBlockHeight: number;
};

/** The honest-failure union — same codes as the IC quote path, same screens. */
export type JupiterFail = {
  readonly ok: false;
  readonly code: 'refused' | 'unavailable' | 'unreachable' | 'shape';
  readonly status?: number;
};
export type JupiterQuoteResult = {readonly ok: true; readonly quote: JupiterQuote} | JupiterFail;
export type JupiterSwapResult = {readonly ok: true; readonly swap: JupiterSwapTx} | JupiterFail;

function httpsOriginOf(venue: VenueEntry): string | null {
  // The endpoint is an https ORIGIN by registry rule (truth-file _doc; the Rust drift test pins
  // the https:// prefix). Enforced here too — the last point before a request leaves the phone,
  // exactly the opencryptopay `httpsUrl` discipline: a hostile or corrupt registry row that lost
  // the https prefix fails closed, it never downgrades to plain http.
  try {
    const u = new URL(venue.endpoint);
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search !== '' || u.hash !== '') {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

async function readJsonBody(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Map a failed https answer onto the honest-failure vocabulary. */
async function failOf(res: Response): Promise<JupiterFail> {
  if (res.status >= 400 && res.status < 500) {
    return {ok: false, code: 'refused', status: res.status};
  }
  return {ok: false, code: 'unavailable', status: res.status};
}

/**
 * Fetch one quote, device-direct. `amount` is raw in-units (lamports for SOL). The reply's
 * inAmount/outAmount/priceImpact are carried verbatim; `fetchedAtMs` is when the DEVICE read it.
 */
export async function fetchJupiterQuote(
  venue: VenueEntry,
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  opts?: {timeoutMs?: number},
): Promise<JupiterQuoteResult> {
  const origin = httpsOriginOf(venue);
  if (origin == null) {
    return {ok: false, code: 'shape'};
  }
  const url =
    `${origin}/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}` +
    `&slippageBps=${slippageBps}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, undefined, opts?.timeoutMs ?? 8000);
  } catch {
    return {ok: false, code: 'unreachable'};
  }
  if (!res.ok) {
    return failOf(res);
  }
  const body = await readJsonBody(res);
  const q = body as Record<string, unknown> | null;
  if (
    q == null ||
    typeof q.inAmount !== 'string' ||
    typeof q.outAmount !== 'string' ||
    typeof q.otherAmountThreshold !== 'string' ||
    !/^\d+$/.test(q.inAmount) ||
    !/^\d+$/.test(q.outAmount) ||
    !/^\d+$/.test(q.otherAmountThreshold) ||
    typeof q.slippageBps !== 'number' ||
    (q.priceImpact != null && typeof q.priceImpact !== 'string')
  ) {
    return {ok: false, code: 'shape', status: res.status};
  }
  const pf = q.platformFee as Record<string, unknown> | null | undefined;
  if (pf != null && typeof pf.bps !== 'number') {
    return {ok: false, code: 'shape', status: res.status};
  }
  const platformFeeBps = pf != null ? (pf.bps as number) : null;
  return {
    ok: true,
    quote: {
      venueId: venue.venue_id,
      inputMint,
      outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      otherAmountThreshold: q.otherAmountThreshold,
      priceImpactPct: (q.priceImpact as string | null | undefined) ?? null,
      slippageBps: q.slippageBps,
      platformFeeBps,
      raw: body,
      fetchedAtMs: Date.now(),
    },
  };
}

/**
 * Ask Jupiter to BUILD the swap transaction for a quote the device just read. The `quote` must
 * be the same object `fetchJupiterQuote` returned — its `raw` body is echoed verbatim (Jupiter
 * signs nothing; the tx comes back base64-encoded and UNSIGNED, for the device to verify + sign).
 * `wrapAndUnwrapSol: true` is the venue's own native-SOL handling (wrap in, unwrap out — the
 * wallet's SOL balance moves net, never a wrapped balance). `asLegacyTransaction: true` asks
 * for every account key IN the bytes: the device's beneficiary verification (app/solana/tx.ts
 * verifyVenueSwapTxBeneficiaries) reads the static keys, and a v0 tx whose destination lives in
 * an address lookup table is something this wallet refuses to sign blind — asking for legacy is
 * asking for the verifiable shape.
 */
export async function fetchJupiterSwapTx(
  venue: VenueEntry,
  quote: JupiterQuote,
  userPublicKey: string,
  opts?: {timeoutMs?: number},
): Promise<JupiterSwapResult> {
  const origin = httpsOriginOf(venue);
  if (origin == null) {
    return {ok: false, code: 'shape'};
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${origin}/swap/v1/swap`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        asLegacyTransaction: true,
      }),
    }, opts?.timeoutMs ?? 8000);
  } catch {
    return {ok: false, code: 'unreachable'};
  }
  if (!res.ok) {
    return failOf(res);
  }
  const body = await readJsonBody(res);
  const s = body as Record<string, unknown> | null;
  if (
    s == null ||
    typeof s.swapTransaction !== 'string' ||
    typeof s.lastValidBlockHeight !== 'number' ||
    !Number.isSafeInteger(s.lastValidBlockHeight) ||
    s.lastValidBlockHeight <= 0
  ) {
    return {ok: false, code: 'shape', status: res.status};
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(s.swapTransaction);
  } catch {
    return {ok: false, code: 'shape', status: res.status};
  }
  if (bytes.length === 0) {
    return {ok: false, code: 'shape', status: res.status};
  }
  return {ok: true, swap: {swapTransaction: bytes, lastValidBlockHeight: s.lastValidBlockHeight}};
}
