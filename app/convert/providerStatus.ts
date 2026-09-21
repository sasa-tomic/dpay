import {CONVERT_PROVIDER_TIMEOUT_MS} from '../config/convert';
import {fetchWithTimeout} from '../services/relay';
import {toUnits} from '../lib/format';
import {type ConvertRecord} from './types';
/** What ONE provider status read taught us. 'unreachable' = we learned nothing (transport /
 *  non-2xx / unreadable body / refused non-https URL); 'unknown' = the provider answered a
 *  status this build cannot map. BOTH are no-transition outcomes — never a fabricated one. */
export type ProviderStatusReading =
  | {kind: 'awaiting_deposit'}
  | {kind: 'processing'}
  | {kind: 'completed'; amount?: string; tx?: string}
  | {kind: 'expired'}
  | {kind: 'refunded'}
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
    if (!r.ok) return {kind: 'unreachable'};
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (j == null || typeof j.status !== 'string') return {kind: 'unreachable'};
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
 *      expired → quote_expired (the QUOTE died before value moved — never set by leg expiry)
 *      refunded → provider_refunded
 *    from provider_processing:
 *      completed → done (the provider's own amount, else the record's expected net)
 *      refunded → provider_refunded
 *      anything else → unchanged (an 'expired' after value moved is the provider's refund story
 *      to tell, not ours to guess)
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
): Promise<ConvertRecord> {
  const ref = record.providerRef;
  if (ref == null) return record; // hydrate guarantees this cannot happen; the guard is for honesty
  const reading = await fetchProviderStatus(ref, relayUrl);
  const from = record.step;
  const inAwaiting = from === 'awaiting_deposit';
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
      if (inAwaiting || from === 'provider_processing') return apply({...record, step: 'provider_processing'});
      return record;
    case 'completed':
      if (from === 'provider_processing') {
        // The cefi widening (2026-09-15): SideShift speaks DECIMAL strings in the out
        // asset's own units ("settleAmount": "0.0495…"), while outAmountNet is raw units
        // like every other record money field. Normalize exactly at this boundary and
        // ONLY for the cefi handoff shape (providerDeposit present) — the legacy provider
        // records (OCP) never carried a provider amount, so nothing else moves.
        const rawAmount = reading.amount != null && record.providerDeposit != null
          ? toUnits(reading.amount, record.outDecimals ?? 8)
          : reading.amount;
        return apply({
          ...record,
          step: 'done',
          outAmountNet: rawAmount ?? record.expectedNet,
          outTx: reading.tx,
        });
      }
      return record;
    case 'expired':
      if (inAwaiting) return apply({...record, step: 'quote_expired'});
      return record;
    case 'refunded':
      if (inAwaiting || from === 'provider_processing') {
        return apply({...record, step: 'provider_refunded'});
      }
      return record;
    case 'unreachable':
    case 'unknown':
      return record; // no information → no transition (a late record is not a failed one)
  }
  return record;
}
