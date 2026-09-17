// The Jupiter client — the `solana_amm` venue's keyless quotes + swap-tx builds, now through
// dpay's relay (2026-09-16 founder ask: "get live quotes from them … possibly through our
// relay (for caching etc)"). Shape precedent: `services/sideshift.ts` (relayUrl threading,
// relayFetch R1 walk) + the SOL JSON-RPC client's R2 operator-override precedence.
//
// WHAT THE REGISTRY ROW IS NOW: the venue row's `endpoint` (`https://lite-api.jup.ag`) is the
// venue's IDENTITY and attribution — it renders in the pool/attribution line and names who is
// being trusted — but it is NO LONGER a host the device dials. Both calls resolve their dial
// target the R2 way (app/solana/rpc.ts's operator-override semantics):
//   - an operator override (`setJupiterEndpoint`, an https ORIGIN) dials
//     `{origin}/swap/v1/*` directly — the escape hatch (a pinned base, a self-hosted
//     front). Fail-closed: an override that is not an https origin is a 'shape' failure,
//     never a silent fallback to the relay path;
//   - the DEFAULT path is the wallet's own relay: `GET/POST /api/v1/jupiter/*` on the
//     `relayUrl` the caller threads (services/sideshift.ts's discipline), via relayFetch —
//     so the operator's full relay list is walked in order exactly like every other read.
// The relay (crates/dpay-relay/src/jupiter.rs) pipes the venue byte-faithfully: quote GETs
// through a short-TTL canonical-params cache, the swap POST NEVER cached (the device posts
// Jupiter's own quoteResponse back; the swapTransaction must arrive unmodified). An upstream
// error status passes through verbatim (the venue's own refusal shape); relay-originated
// transport death is a 504 carrying the body marker
// `{"dpayRelayError":"jupiter-upstream-unreachable", …}` — mapped to 'unreachable' here.
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
//   GET  /swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=  → quote JSON
//   POST /swap/v1/swap  {quoteResponse, userPublicKey, wrapAndUnwrapSol} → unsigned tx
//
// Fail-closed error vocabulary matches the IC quote path (`convert.ts` getSwapQuote) so the
// screens render the same honesty: network/timeout/relay-unreachable → 'unreachable'; a
// readable 4xx → 'refused' (the venue said no — e.g. no route for this size); anything else
// not-ok → 'unavailable'; a 2xx body that does not parse to the pinned shape → 'shape'. NO
// result is ever defaulted.
import {fetchWithTimeout, relayFetch} from './relay';
import {base64ToBytes} from '../lib/base64';
import type {VenueEntry} from '../config/venues';

/** The relay's quote-proxy path (crates/dpay-relay/src/jupiter.rs; jest pins it). */
export const JUPITER_QUOTE_PATH = '/api/v1/jupiter/quote';
/** The relay's swap-proxy path (never cached relay-side; jest pins it). */
export const JUPITER_SWAP_PATH = '/api/v1/jupiter/swap';

/**
 * The operator's dial-target override (the R2 escape hatch): when set, BOTH calls dial
 * `{origin}/swap/v1/*` directly instead of the relay path. `null` (the default) restores
 * the relay path. Nothing persists it — an operator tool sets it at session start, the
 * same contract as `setIcClockRoutingCanister`.
 */
let operatorEndpoint: string | null = null;

/** Set (or clear with `null`) the device-direct escape hatch. See the module header. */
export function setJupiterEndpoint(url: string | null): void {
  operatorEndpoint = url != null && url.trim() !== '' ? url.trim() : null;
}

/** The current override, if any — `null` means the relay path is the dial target. */
export function jupiterEndpoint(): string | null {
  return operatorEndpoint;
}

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

/**
 * The https-ORIGIN check for whatever base this module actually dials (the operator
 * override). The relay path needs no such check — it dials dpay's own surface (loopback
 * http is legitimate in the offline loop) and relayFetch normalizes the base. An override
 * that lost the https prefix fails closed, exactly the old venue-endpoint discipline.
 */
function httpsOriginOfBase(base: string): string | null {
  try {
    const u = new URL(base);
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
 * The relay-path !ok mapping: the relay pipes upstream statuses VERBATIM, so a 4xx/5xx is
 * normally the VENUE's own refusal (failOf). The one relay-owned exception is the 504
 * transport-death marker `jupiter-upstream-unreachable` — that is not the venue refusing,
 * it is the path being down → 'unreachable'. The marker parse is best-effort: an unreadable
 * body falls back to the status mapping (the venue's own answer keeps its own meaning).
 */
async function failOfRelay(res: Response): Promise<JupiterFail> {
  if (res.status >= 400 && res.status < 500) {
    return {ok: false, code: 'refused', status: res.status};
  }
  try {
    const text = await res.text();
    const v = JSON.parse(text) as Record<string, unknown> | null;
    if (v != null && v.dpayRelayError === 'jupiter-upstream-unreachable') {
      return {ok: false, code: 'unreachable', status: res.status};
    }
  } catch {
    // Not JSON (or unreadable): the status mapping below is the honest answer.
  }
  return {ok: false, code: 'unavailable', status: res.status};
}

/** The canonical upstream query — the same bytes on both the override and the relay path. */
function quoteQueryString(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): string {
  return (
    `inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}` +
    `&slippageBps=${slippageBps}`
  );
}

/**
 * Fetch one quote. `relayUrl` is the wallet's active relay (threaded by the caller — the
 * services/sideshift.ts discipline); the venue row is the quote's IDENTITY (its venue_id is
 * attributed onto the result; its endpoint is no longer a dial target). `amount` is raw
 * in-units (lamports for SOL). The reply's inAmount/outAmount/priceImpact are carried
 * verbatim; `fetchedAtMs` is when the DEVICE read it.
 */
export async function fetchJupiterQuote(
  relayUrl: string,
  venue: VenueEntry,
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  opts?: {timeoutMs?: number},
): Promise<JupiterQuoteResult> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const qs = quoteQueryString(inputMint, outputMint, amount, slippageBps);
  const override = jupiterEndpoint();
  let res: Response;
  if (override != null) {
    // The escape hatch: device-direct to the operator's https origin. Fail closed on a
    // bad shape — never a silent fallback onto the relay path.
    const origin = httpsOriginOfBase(override);
    if (origin == null) {
      return {ok: false, code: 'shape'};
    }
    try {
      res = await fetchWithTimeout(`${origin}/swap/v1/quote?${qs}`, undefined, timeoutMs);
    } catch {
      return {ok: false, code: 'unreachable'};
    }
  } else {
    // The default: dpay's relay proxy (R1 walk over the operator's relay list). The relay
    // short-TTL-caches identical canonical queries; its answers are byte-faithful.
    if (relayUrl.trim() === '') {
      return {ok: false, code: 'shape'};
    }
    try {
      res = await relayFetch(relayUrl, `${JUPITER_QUOTE_PATH}?${qs}`, undefined, timeoutMs);
    } catch {
      return {ok: false, code: 'unreachable'};
    }
  }
  if (!res.ok) {
    return override != null ? failOf(res) : failOfRelay(res);
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
 * The POST is NEVER cached relay-side — the venue rebuilds it fresh every time. `wrapAndUnwrapSol:
 * true` is the venue's own native-SOL handling (wrap in, unwrap out — the wallet's SOL balance
 * moves net, never a wrapped balance). `asLegacyTransaction: true` asks for every account key IN
 * the bytes: the device's beneficiary verification (app/solana/tx.ts
 * verifyVenueSwapTxBeneficiaries) reads the static keys, and a v0 tx whose destination lives in
 * an address lookup table is something this wallet refuses to sign blind — asking for legacy is
 * asking for the verifiable shape.
 */
export async function fetchJupiterSwapTx(
  relayUrl: string,
  quote: JupiterQuote,
  userPublicKey: string,
  opts?: {timeoutMs?: number},
): Promise<JupiterSwapResult> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const init: RequestInit = {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
    }),
  };
  const override = jupiterEndpoint();
  let res: Response;
  if (override != null) {
    const origin = httpsOriginOfBase(override);
    if (origin == null) {
      return {ok: false, code: 'shape'};
    }
    try {
      res = await fetchWithTimeout(`${origin}/swap/v1/swap`, init, timeoutMs);
    } catch {
      return {ok: false, code: 'unreachable'};
    }
  } else {
    if (relayUrl.trim() === '') {
      return {ok: false, code: 'shape'};
    }
    try {
      res = await relayFetch(relayUrl, JUPITER_SWAP_PATH, init, timeoutMs);
    } catch {
      return {ok: false, code: 'unreachable'};
    }
  }
  if (!res.ok) {
    return override != null ? failOf(res) : failOfRelay(res);
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
