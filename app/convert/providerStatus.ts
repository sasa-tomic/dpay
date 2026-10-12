import {CONVERT_PROVIDER_TIMEOUT_MS} from '../config/convert';
import {fetchWithTimeout} from '../services/relay';
import {toUnits} from '../lib/format';
import {cefiFamilyOf, venueOfId} from '../config/venues';
import {type ConvertRecord} from './types';
/** What ONE provider status read taught us. 'unreachable' = we learned nothing (transport /
 *  non-2xx / unreadable body / refused non-https URL); 'unknown' = the provider answered a
 *  status this build cannot map. BOTH are no-transition outcomes — never a fabricated one.
 *  'rate_limited' = the relay answered HTTP 429 (the partner agreement's limiter doing its
 *  job): ALSO a no-transition outcome and never a user-facing error — the reading carries
 *  the Retry-After hint (ms from now, null when the header is absent) so the engine's next
 *  tick waits it out instead of hammering. */
export type ProviderStatusReading =
  | {kind: 'awaiting_deposit'}
  | {kind: 'processing'}
  | {kind: 'completed'; amount?: string; tx?: string}
  | {kind: 'expired'}
  | {kind: 'refunded'}
  | {kind: 'rate_limited'; retryAfterMs: number | null}
  | {kind: 'unreachable'}
  | {kind: 'unknown'};

/** The provider status vocabulary this build understands (lowercased before matching). This IS
 *  the contract the first registered CeFi venue adapter must serve; anything else reads as
 *  'unknown' and the record keeps watching — an unmapped word is never a verdict. */
const PROVIDER_STATUS_MAP: Record<string, ProviderStatusReading['kind']> = {
  awaiting_deposit: 'awaiting_deposit',
  waiting_for_deposit: 'awaiting_deposit',
  pending: 'awaiting_deposit',
  pending_deposit: 'awaiting_deposit',
  // SideShift's own words (verified from docs.sideshift.ai 2026-09-15): a fresh shift
  // reads `waiting` — the deposit has not landed yet.
  waiting: 'awaiting_deposit',
  deposit_received: 'processing',
  deposit_confirmed: 'processing',
  confirmed: 'processing',
  processing: 'processing',
  swapping: 'processing',
  executing: 'processing',
  // SideShift's multi-deposit state: the FIRST deposit settles, later ones refund — the
  // shift is mid-flight until those resolve, which is 'processing' (never a verdict).
  multiple: 'processing',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  settled: 'completed',
  success: 'completed',
  expired: 'expired',
  quote_expired: 'expired',
  expired_quote: 'expired',
  timed_out: 'expired',
  refunded: 'refunded',
  refund: 'refunded',
  reversed: 'refunded',
};

/** Retry-After (the 429 discipline): delay-seconds or an HTTP-date → ms from now, clamped
 *  to [0, 10 min] so a hostile/garbage header can neither spin the poll nor silence it for
 *  hours. Absent or unreadable → null (the caller's normal cadence governs). */
const RETRY_AFTER_MAX_MS = 10 * 60_000;
function retryAfterMsOf(r: Response): number | null {
  try {
    const raw = r.headers?.get?.('retry-after') ?? null;
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_MAX_MS);
  } catch {
    // a degenerate Response without headers is just "no hint"
  }
  return null;
}

/** Per-record 429 backoff (the agreement's wait-and-retry): record id → the epoch ms
 *  before which the ENGINE must not poll this trade again. Set by advanceProviderRecord on
 *  a rate_limited reading; CONSUMED (cleared) by the engine when it sizes the next tick —
 *  the same module-level-flag pattern as the abort requests in ./records. */
const RATE_LIMITED_UNTIL_MS = new Map<string, number>();

/** The engine's read: is this record 429-backed-off, and until when? (Expired entries read
 *  as null — a stale hint never delays a poll.) */
export function providerRateLimitedUntilMs(recordId: string): number | null {
  const at = RATE_LIMITED_UNTIL_MS.get(recordId);
  return at != null && at > Date.now() ? at : null;
}

/** Drop one record's 429 backoff (the engine consumes it after sizing one tick; the test
 *  reset uses it for hygiene). */
export function clearProviderRateLimit(recordId: string): void {
  RATE_LIMITED_UNTIL_MS.delete(recordId);
}

/** Drop EVERY 429 backoff — the engine session's hygiene (backoffs die with the session
 *  that earned them). */
export function clearAllProviderRateLimits(): void {
  RATE_LIMITED_UNTIL_MS.clear();
}

/** Is this a TROCADOR-family provider record? The partner agreement's poll floor keys on
 *  the FAMILY, not the whole provider vocabulary — the sideshift family's status read is
 *  the venue's own keyless host and is not party to the agreement. The COMPOSED widening
 *  (2026-09-26): a composed record's legs no longer exclude it — the cefi venue lives on
 *  the deposit block for that shape (the record's own venueId is the IC pool). */
export function isTrocadorProviderRecord(record: ConvertRecord): boolean {
  if (record.providerRef == null && record.composedDeposit == null) return false;
  const v = venueOfId(record.composedDeposit?.venueId ?? record.venueId);
  return v != null && cefiFamilyOf(v) === 'trocador';
}

/** Is this a Mt Pelerin cash-out record (plan R2 step 2)? Same family shape as the
 *  trocador check: the status read is the relay's webhook-first store, not a keyless venue
 *  host, so the same floor discipline applies. */
export function isMtpelerinProviderRecord(record: ConvertRecord): boolean {
  if (record.providerRef == null && record.composedDeposit == null) return false;
  const v = venueOfId(record.composedDeposit?.venueId ?? record.venueId);
  return v != null && cefiFamilyOf(v) === 'mtpelerin';
}

/** Do provider polls for this record owe the relay-floor cadence (one status request per
 *  order per minute)? The TROCADOR partner agreement's floor (2026-09-22 spec term 4) plus
 *  the Mt Pelerin relay's own 60 s per-order read cap (plan R2 step 1): both relays 429
 *  faster polls, so the engine mirrors the cap client-side instead of harvesting the 429s. */
export function providerPollFloorApplies(record: ConvertRecord): boolean {
  return isTrocadorProviderRecord(record) || isMtpelerinProviderRecord(record);
}

/** The Mt Pelerin status read's own mapping (the relay's webhook-first store — NO `status`
 *  word): the route answers `{"order_id","venue_order_id","offRampAddress","terminal",
 *  "created_at","status_ts","payload"}` where `payload` is the last verified webhook
 *  delivery (`{"id","amount","currency","external_id"}`, the completion event) or null.
 *  The store cannot distinguish "deposit not yet arrived" from "deposit arrived, converting"
 *  — the venue's only word before completion is the completion itself — so:
 *    terminal:true  → completed (the venue's own amount when the payload carries one)
 *    terminal:false → awaiting_deposit (a no-transition from the step the record holds:
 *                     "no completion word yet" is the ONLY fact, and never a verdict)
 *  Anything unreadable → 'unreachable' (we learned nothing), never a fabricated step. */
function mtpelerinReadingOf(j: Record<string, unknown>): ProviderStatusReading {
  if (j.terminal === true) {
    const payload = j.payload != null && typeof j.payload === 'object'
      ? j.payload as Record<string, unknown>
      : null;
    const amount = payload != null && typeof payload.amount === 'string' && payload.amount.length > 0
      ? payload.amount
      : payload != null && typeof payload.amount === 'number' && Number.isFinite(payload.amount)
        ? String(payload.amount)
        : undefined;
    return {kind: 'completed', amount};
  }
  if (j.terminal === false) return {kind: 'awaiting_deposit'};
  return {kind: 'unreachable'};
}

/** Read a provider order status once (device-direct). Failures are outcomes, not
 *  exceptions — the caller advances nothing on 'unreachable' | 'unknown'.
 *
 *  The URL gate: https always; a NON-https URL is refused UNLESS it is this session's own
 *  relay origin — the one honest exception, added with the Trocador family (2026-09-20):
 *  Trocador has NO keyless venue surface, so its status read is the relay's key-gated
 *  proxy and the offline loop runs that relay on plain http. A hostile record cannot
 *  smuggle an arbitrary http host past this: the origin must equal the relay's. */
export async function fetchProviderStatus(
  ref: {orderId: string; statusUrl?: string},
  relayUrl?: string,
): Promise<ProviderStatusReading> {
  const url = ref.statusUrl;
  const isHttp = url != null && /^http:\/\//i.test(url);
  const isRelayOrigin = isHttp && relayUrl != null && url.length > 0
    && new URL(url).origin === new URL(relayUrl).origin;
  if (url == null || (!/^https:\/\//i.test(url) && !isRelayOrigin)) {
    console.warn('convert provider status: no https (or relay-origin) statusUrl, refusing to poll');
    return {kind: 'unreachable'};
  }
  try {
    const r = await fetchWithTimeout(url, undefined, CONVERT_PROVIDER_TIMEOUT_MS);
    // HTTP 429 (the relay's upstream limiter): wait-and-retry on a LATER tick, never a
    // user-facing error and never a verdict — the trade's state is simply not known yet.
    if (r.status === 429) return {kind: 'rate_limited', retryAfterMs: retryAfterMsOf(r)};
    if (!r.ok) return {kind: 'unreachable'};
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (j == null) return {kind: 'unreachable'};
    // The Mt Pelerin cash-out family (plan R2 step 2): the relay's webhook-first store
    // speaks `terminal`/`payload`, not the generic `status` word — its own mapping runs
    // BEFORE the generic parse (the URL is the relay route the record was born with).
    if (typeof j.terminal === 'boolean') return mtpelerinReadingOf(j);
    if (typeof j.status !== 'string') return {kind: 'unreachable'};
    const kind = PROVIDER_STATUS_MAP[j.status.trim().toLowerCase()];
    if (kind == null) return {kind: 'unknown'};
    if (kind === 'completed') {
      // SideShift's camelCase fields (settleAmount/settleHash) join the snake_case
      // precedents — the FIRST adapter's vocabulary, added additively.
      // Trocador's `amount_to` (2026-09-20) joins additively — the SECOND adapter's
      // settle-figure field, same rule: named off the venue's own documented body.
      const amount = typeof j.settled_amount === 'string' ? j.settled_amount
        : typeof j.amount_out === 'string' ? j.amount_out
        : typeof j.out_amount === 'string' ? j.out_amount
        : typeof j.settleAmount === 'string' ? j.settleAmount
        : typeof j.amount_to === 'string' ? j.amount_to
        : undefined;
      // Trocador carries its payout hash NESTED (details.hashout) — read defensively,
      // never assuming the wrapper exists.
      const details = (j as {details?: unknown}).details;
      const hashout = details != null && typeof details === 'object'
        && typeof (details as {hashout?: unknown}).hashout === 'string'
        ? (details as {hashout: string}).hashout
        : undefined;
      const tx = typeof j.tx_id === 'string' ? j.tx_id
        : typeof j.transaction_id === 'string' ? j.transaction_id
        : typeof j.tx === 'string' ? j.tx
        : typeof j.settleHash === 'string' ? j.settleHash
        : hashout !== undefined ? hashout
        : undefined;
      return {kind: 'completed', amount, tx};
    }
    return {kind} as ProviderStatusReading;
  } catch {
    return {kind: 'unreachable'};
  }
}

/** ONE provider-poll drive: apply the provider's own verdict to the record, or none. The
 *  transition matrix is deliberately small and never backwards:
 *
 *    from awaiting_deposit:
 *      deposit-family → awaiting_deposit · processing-family → provider_processing
 *      completed → done (the FIRST terminal word a poll observes lands the record — under
 *        the agreement's webhook-first status the relay-side state can already be settled
 *        the first time the fallback poll looks, and a terminal word must never be polled
 *        past)
 *      expired → quote_expired (the QUOTE died before value moved — never set by leg expiry;
 *        NOT the end: a LATE deposit can still land and be refunded, so the ENGINE keeps a
 *        slow watch on this step — see the quote_expired arm)
 *      refunded → provider_refunded
 *    from provider_processing:
 *      completed → done (the provider's own amount, else the record's expected net)
 *      refunded → provider_refunded
 *      anything else → unchanged (an 'expired' after value moved is the provider's refund story
 *      to tell, not ours to guess)
 *    from quote_expired (the late-deposit watch, 2026-09-24): the venue said the quote died,
 *      but only the venue knows whether a late deposit landed afterwards — so the venue's own
 *      later words stay true here:
 *      refunded → provider_refunded (the late deposit came and was sent back)
 *      processing-family → provider_processing (the venue honored the late deposit — the
 *        record is live again and re-enters the matrix above)
 *      completed → done (the first terminal word lands, same rule as every other state)
 *      everything else → unchanged (an 'expired' repeat or an awaiting status never
 *        resurrects the expired quote)
 */
export async function advanceProviderRecord(
  record: ConvertRecord,
  /** The engine's persistence seam (convertResume's own `saveConvertRecordFor`): records
   *  persist through the LIVE engine ctx exactly as before — no ctx, no write. */
  persist: (next: ConvertRecord) => Promise<void>,
  /** The engine passes its drive's liveness guard (`state.ctx === capturedCtx`, D2): a provider
   *  poll that outlived an identity switch persists NOTHING — the stale drive's record must
   *  never land in the new identity's scoped store. Direct callers omit it (always live). */
  stillMine: () => boolean = () => true,
  /** The session's relay URL — the fetchProviderStatus http-exception's origin anchor
   *  (the Trocador family's status read rides the relay's key-gated proxy). */
  relayUrl?: string,
  /** The CHAIN widening (2026-09-28): the completion hook. When the venue names the
   *  settle on a record the caller owns the next phase of, the hook returns the record to
   *  persist INSTEAD of the default done-block — the chain's phase 2 signs the IC legs
   *  here, so the record NEVER lands at `done` carrying the settle asset's units in the
   *  dest asset's fields. A thrown hook is the caller's failure: it propagates. */
  onCompleted?: (record: ConvertRecord, settled: {amount?: string; tx?: string}) => Promise<ConvertRecord>,
): Promise<ConvertRecord> {
  const ref = record.providerRef;
  if (ref == null) return record; // hydrate guarantees this cannot happen; the guard is for honesty
  const reading = await fetchProviderStatus(ref, relayUrl);
  const from = record.step;
  const inAwaiting = from === 'awaiting_deposit';
  const inExpired = from === 'quote_expired';
  const apply = async (next: ConvertRecord): Promise<ConvertRecord> => {
    if (!stillMine()) return next; // stale drive (identity switched mid-poll) — persist nothing
    await persist(next);
    return next;
  };
  switch (reading.kind) {
    case 'awaiting_deposit':
      if (inAwaiting) return apply({...record, step: 'awaiting_deposit'});
      return record;
    case 'processing':
      if (inAwaiting || inExpired || from === 'provider_processing') {
        return apply({...record, step: 'provider_processing'});
      }
      return record;
    case 'completed':
      // The FIRST observed terminal word lands the record from any held state (see the
      // matrix note): a settled trade is never polled again (agreement term 4).
      if (inAwaiting || inExpired || from === 'provider_processing') {
        if (onCompleted != null) {
          return apply(await onCompleted(record, {amount: reading.amount, tx: reading.tx}));
        }
        // The cefi widening (2026-09-15): SideShift speaks DECIMAL strings in the out
        // asset's own units ("settleAmount": "0.0495…"), while outAmountNet is raw units
        // like every other record money field. Normalize exactly at this boundary and
        // ONLY for the cefi handoff shapes (a providerDeposit or a composed deposit
        // block) — the legacy provider records (OCP) never carried a provider amount, so
        // nothing else moves. The COMPOSED record's outDecimals is already the settle
        // asset's (frozen at prepare), so the same conversion serves both.
        const usesDecimal = record.providerDeposit != null || record.composedDeposit != null;
        const rawAmount = reading.amount != null && usesDecimal
          ? toUnits(reading.amount, record.outDecimals ?? 8)
          : reading.amount;
        return apply({
          ...record,
          step: 'done',
          // The composed record falls back to its own frozen order figure (the venue's
          // locked settle, already raw) — never the IC hub's figure, which is a different
          // asset in different units.
          outAmountNet: rawAmount ?? record.composedDeposit?.settleAmountRaw ?? record.expectedNet,
          outTx: reading.tx,
        });
      }
      return record;
    case 'expired':
      if (inAwaiting) return apply({...record, step: 'quote_expired'});
      return record;
    case 'refunded':
      if (inAwaiting || inExpired || from === 'provider_processing') {
        return apply({...record, step: 'provider_refunded'});
      }
      return record;
    case 'rate_limited':
      // Wait-and-retry on a LATER tick: register the Retry-After hint for the engine's
      // next-tick sizing and advance NOTHING (no transition, no error surface).
      if (reading.retryAfterMs != null && reading.retryAfterMs > 0) {
        RATE_LIMITED_UNTIL_MS.set(record.id, Date.now() + reading.retryAfterMs);
      }
      return record;
    case 'unreachable':
    case 'unknown':
      return record; // no information → no transition (a late record is not a failed one)
  }
  return record;
}
