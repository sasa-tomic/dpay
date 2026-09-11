/**
 * convertResume — the app-level record-advancement engine (multi-venue readiness V6).
 *
 * ONE engine, TWO drivers, one state store: a leg-based IC record is driven by the executor
 * (convert.ts `executeConvert` — identical-bytes resubmission while the legs live, ledger watch
 * after), and a providerRef-based CeFi record is driven by the provider-status poller below
 * (`awaiting_deposit → provider_processing → done | quote_expired | provider_refunded`).
 * That is the Wave-1 V2 shape made real: DeFi and CeFi records are the same record type over
 * the same identity-scoped store, advanced by the same engine.
 *
 * WHEN it drives: the engine starts once per wallet session (hooks/useConvertResumeEngine,
 * mounted from Wallet — the wallet-ready seam) and drives EVERY live record whether or not any
 * Convert screen is open. The screen's mounted resume is gone; ConvertMode is a VIEW onto this
 * engine (subscribe + adopt), not a private copy.
 *
 * Idle-safety: at most one in-flight drive per record id; every re-arm is a single timeout
 * (pending ledger watch: CONVERT_ENGINE_REARM_MS; provider poll: one request per
 * CONVERT_ENGINE_PROVIDER_POLL_MS; unacknowledged stuck watch: one probe per
 * CONVERT_ENGINE_STUCK_WATCH_MS). Terminal steps stop their record's timer for good — except
 * `stuck`, which the engine keeps slow-probing (the submitted update may still have executed)
 * until it resolves done/refunded or the USER acknowledges the stuck state
 * (`acknowledgeStuckRecord` → `acknowledgedStuckAtMs`), because an honest unknown is watchable,
 * not dismissable.
 *
 * Red lines (spec 2026-09-07, unchanged): nothing new is ever signed during recovery — the IC
 * driver only re-submits the record's OWN frozen envelope bytes, and the provider driver is a
 * pure GET. No dpay key in the value path; the relay stays query-only (provider statusUrls are
 * device-direct, https-only, like services/opencryptopay).
 */
import {
  CONVERT_ENGINE_PROVIDER_POLL_MS,
  CONVERT_ENGINE_REARM_MS,
  CONVERT_ENGINE_STUCK_WATCH_MS,
  CONVERT_PROVIDER_TIMEOUT_MS,
} from './config/convert';
import {DpayCore} from './services/native';
import {fetchWithTimeout} from './services/relay';
import {
  executeConvert,
  isTerminalConvertStep,
  loadConvertRecords,
  probeConvertSettlement,
  saveConvertRecord,
  type ConvertRecord,
  type ConvertStep,
} from './convert';

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
  deposit_received: 'processing',
  deposit_confirmed: 'processing',
  confirmed: 'processing',
  processing: 'processing',
  swapping: 'processing',
  executing: 'processing',
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

/** Read a provider order status once (device-direct, https-only). Failures are outcomes, not
 *  exceptions — the caller advances nothing on 'unreachable' | 'unknown'. */
export async function fetchProviderStatus(ref: {orderId: string; statusUrl?: string}): Promise<ProviderStatusReading> {
  const url = ref.statusUrl;
  // Same guard as services/opencryptopay: a provider URL that is not https is never fetched.
  if (url == null || !/^https:\/\//i.test(url)) {
    console.warn('convert provider status: no https statusUrl, refusing to poll');
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
      const amount = typeof j.settled_amount === 'string' ? j.settled_amount
        : typeof j.amount_out === 'string' ? j.amount_out
        : typeof j.out_amount === 'string' ? j.out_amount
        : undefined;
      const tx = typeof j.tx_id === 'string' ? j.tx_id
        : typeof j.transaction_id === 'string' ? j.transaction_id
        : typeof j.tx === 'string' ? j.tx
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
 *    from awaiting_user_authorization / awaiting_deposit:
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
  /** The engine passes its drive's liveness guard (`state.ctx === capturedCtx`, D2): a provider
   *  poll that outlived an identity switch persists NOTHING — the stale drive's record must
   *  never land in the new identity's scoped store. Direct callers omit it (always live). */
  stillMine: () => boolean = () => true,
): Promise<ConvertRecord> {
  const ref = record.providerRef;
  if (ref == null) return record; // hydrate guarantees this cannot happen; the guard is for honesty
  const reading = await fetchProviderStatus(ref);
  const from = record.step;
  const inAwaiting = from === 'awaiting_user_authorization' || from === 'awaiting_deposit';
  const apply = async (next: ConvertRecord): Promise<ConvertRecord> => {
    if (!stillMine()) return next; // stale drive (identity switched mid-poll) — persist nothing
    await saveConvertRecordFor(next);
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
        return apply({
          ...record,
          step: 'done',
          outAmountNet: reading.amount ?? record.expectedNet,
          outTx: reading.tx,
        });
      }
      return record;
    case 'expired':
      if (inAwaiting) return apply({...record, step: 'quote_expired'});
      return record;
    case 'refunded':
      if (from === 'awaiting_user_authorization' || from === 'awaiting_deposit' || from === 'provider_processing') {
        return apply({...record, step: 'provider_refunded'});
      }
      return record;
    case 'unreachable':
    case 'unknown':
      return record; // no information → no transition (a late record is not a failed one)
  }
  return record;
}

// --- the engine singleton -------------------------------------------------------------------------

type EngineCtx = {
  secretHex: string;
  publicHex: string; // the identity-scoped store scope (V6)
  relayUrl: string;
  /** Fired once when any record reaches a terminal step this session (Wallet wires it to the
   *  ledger refresh — a conversion landing IS account activity). */
  onTerminal?: () => void;
};

type EngineOpts = {
  rearmMs?: number;
  stuckWatchMs?: number;
  providerPollMs?: number;
  executorOpts?: Parameters<typeof executeConvert>[2];
};

/** The executor budget the engine drives with: enough submit retries to survive a flaky hop,
 *  a settle watch that spans one re-arm window, then the honest pending state — the re-arm
 *  timer, not an inner loop, is what keeps the watch alive. */
const ENGINE_EXECUTOR_OPTS = {submitAttempts: 3, poll: {attempts: 20, intervalMs: 500}, settleAttempts: 8, settleIntervalMs: 1000};

type EngineState = {
  ctx: EngineCtx | null;
  opts: Required<Pick<EngineOpts, 'rearmMs' | 'stuckWatchMs' | 'providerPollMs'>> & {executorOpts: NonNullable<EngineOpts['executorOpts']>};
  records: Map<string, ConvertRecord>;
  inflight: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  subscribers: Set<(records: Record<string, ConvertRecord>) => void>;
  stopped: boolean;
};

const state: EngineState = {
  ctx: null,
  opts: {rearmMs: CONVERT_ENGINE_REARM_MS, stuckWatchMs: CONVERT_ENGINE_STUCK_WATCH_MS, providerPollMs: CONVERT_ENGINE_PROVIDER_POLL_MS, executorOpts: ENGINE_EXECUTOR_OPTS},
  records: new Map(),
  inflight: new Set(),
  timers: new Map(),
  subscribers: new Set(),
  stopped: true,
};

function notify(): void {
  if (state.subscribers.size === 0) return;
  const snapshot = convertResumeSnapshot();
  for (const cb of state.subscribers) cb(snapshot);
}

/** Row identities other records already claim as their payout — the dedupe set the probe and
 *  the executor both honor (one ledger row settles exactly one record). */
function claimedOutTxFor(id: string): Set<string> {
  const s = new Set<string>();
  for (const [rid, r] of state.records) {
    if (rid !== id && r.outTx != null) s.add(r.outTx);
  }
  return s;
}

/** Row identities other records already claim as their REFUND — the refund-side twin of
 *  `claimedOutTxFor`: a refund row one record already consumed as its failed_refunded evidence
 *  is never another record's refund too (one ledger row settles exactly one record). */
function claimedRefundTxFor(id: string): Set<string> {
  const s = new Set<string>();
  for (const [rid, r] of state.records) {
    if (rid !== id && r.refundTx != null) s.add(r.refundTx);
  }
  return s;
}

async function saveConvertRecordFor(record: ConvertRecord): Promise<void> {
  const pub = state.ctx?.publicHex;
  if (pub == null) return;
  await saveConvertRecord(pub, record);
}

/** Fire-and-forget persistence + notify for engine-local transitions (probe-stuck resolution,
 *  provider steps). Everything executeConvert touches persists inside it. */
async function commit(next: ConvertRecord): Promise<ConvertRecord> {
  state.records.set(next.id, next);
  await saveConvertRecordFor(next);
  notify();
  return next;
}

/** One probe of an unacknowledged `stuck` record: the submitted update may STILL have executed
 *  (trichotomy arm (b)) — if the payout or refund is on a ledger now, the record resolves.
 *  `ctx` is the DRIVE's OWN captured context (D2): the probes await, so the engine may have
 *  re-keyed underneath — a stale probe resolves nothing (no map write, no persist, no re-arm). */
async function probeStuckOnce(rec: ConvertRecord, ctx: EngineCtx): Promise<ConvertRecord> {
  const myPrincipal = (await DpayCore.icpPrincipalFromPubkey(ctx.publicHex)).toLowerCase();
  const seen = await probeConvertSettlement({
    relayUrl: ctx.relayUrl,
    publicHex: ctx.publicHex,
    myPrincipalLower: myPrincipal,
    record: rec,
    excludeOutTx: claimedOutTxFor(rec.id),
    excludeRefundTx: claimedRefundTxFor(rec.id),
  });
  if (state.ctx !== ctx) return rec; // stale drive — resolve nothing under the new identity
  if (seen?.kind === 'output') {
    return commit({...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx});
  }
  if (seen?.kind === 'refund') {
    return commit({...rec, step: 'failed_refunded', failureCode: 'refunded', refundTx: seen.tx});
  }
  return rec;
}

function fireOnTerminalIfEnteredListed(before: ConvertStep | undefined, after: ConvertRecord): void {
  if (before != null && !isTerminalConvertStep(before) && isTerminalConvertStep(after.step)) {
    state.ctx?.onTerminal?.();
  }
}

/** The single driver entry. Single-flight per record id; a drive is ONE executor run (IC legs)
 *  or ONE provider poll or ONE stuck probe, never a loop — loops live in the re-arm timers.
 *
 *  A drive BELONGS to the ctx it started under (D2 identity-switch race): if the engine re-keys
 *  to identity B mid-drive, the stale drive still finishes its work, but every write, persist,
 *  and re-arm below is gated on `state.ctx === capturedCtx` — A's record never lands in B's
 *  in-memory records map, B's timers are never armed for it, and B's engine never drives (and
 *  thereby never persists) A's record into `dpay.convert.v2.<B>`. Stale drives finish silently. */
async function driveOne(id: string): Promise<void> {
  const ctx = state.ctx;
  if (ctx == null || state.stopped || state.inflight.has(id)) return;
  const rec = state.records.get(id);
  if (rec == null) return;
  state.inflight.add(id);
  const mine = () => state.ctx === ctx;
  try {
    let next = rec;
    if (!isTerminalConvertStep(rec.step)) {
      if (rec.legs.length > 0) {
        // IC-legs driver (convert.ts): the V6 trichotomy lives inside — resubmit only unexpired
        // signed bytes, watch everything else, never sign anything new.
        next = await executeConvert(rec, {
          secretHex: ctx.secretHex,
          publicHex: ctx.publicHex,
          relayUrl: ctx.relayUrl,
          onUpdate: (r) => {
            if (!mine()) return; // stale drive — B's map never receives A's record
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
          claimedOutTx: claimedOutTxFor(id),
          claimedRefundTx: claimedRefundTxFor(id),
        }, state.opts.executorOpts);
        if (!mine()) return; // stale drive — no post-run write, no re-arm
        const before = state.records.get(id)?.step;
        state.records.set(id, next);
        fireOnTerminalIfEnteredListed(before, next);
        notify();
      } else if (rec.providerRef != null) {
        next = await advanceProviderRecord(rec, mine);
        if (!mine()) return; // stale drive — no post-run write, no re-arm
        if (next !== rec) {
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      }
    } else if (rec.step === 'stuck' && rec.legs.length > 0 && rec.acknowledgedStuckAtMs == null) {
      // The honest unknown stays watchable until the user reads it: one slow probe per window.
      next = await probeStuckOnce(rec, ctx);
    }
    if (!mine()) return; // stale drive — B's timers are never armed for A's record
    scheduleNext(id, next);
  } catch (e) {
    console.warn('convert resume drive failed for', id, e instanceof Error ? e.message : String(e));
    if (mine()) scheduleNext(id, state.records.get(id) ?? rec);
  } finally {
    state.inflight.delete(id);
  }
}

/** Arm (or retire) a record's timer based on what it now is. Every branch is a bounded, slow
 *  cadence; terminal-and-settled records retire their timer for good. */
function scheduleNext(id: string, rec: ConvertRecord): void {
  clearTimer(id);
  if (state.ctx == null || state.stopped) return;
  let delay: number | null = null;
  if (!isTerminalConvertStep(rec.step)) {
    delay = rec.legs.length === 0 ? state.opts.providerPollMs : state.opts.rearmMs;
  } else if (rec.step === 'stuck' && rec.legs.length > 0 && rec.acknowledgedStuckAtMs == null) {
    delay = state.opts.stuckWatchMs;
  }
  if (delay == null) return;
  state.timers.set(id, setTimeout(() => {
    state.timers.delete(id);
    void driveOne(id);
  }, delay));
}

function clearTimer(id: string): void {
  const t = state.timers.get(id);
  if (t != null) {
    clearTimeout(t);
    state.timers.delete(id);
  }
}

function stopEngine(): void {
  state.stopped = true;
  for (const id of [...state.timers.keys()]) clearTimer(id);
  state.ctx = null;
  // subscribers survive a stop: a still-mounted screen keeps reading the last snapshot until a
  // new engine starts (identity switch / wallet reload).
}

/**
 * Start (or re-start on identity/relay switch) the engine and drive every live record. Safe to
 * call repeatedly with the SAME context — the second call is a no-op (the hook's effect deps can
 * re-fire). Returns the stop function the hook must call on unmount; a stop only acts if this
 * start's session still owns the engine (an identity switch in between must survive it).
 */
let engineSession = 0;
export function startConvertResumeEngine(ctx: EngineCtx, opts: EngineOpts = {}): () => void {
  const sameCtx = state.ctx != null
    && state.ctx.publicHex === ctx.publicHex
    && state.ctx.secretHex === ctx.secretHex
    && state.ctx.relayUrl === ctx.relayUrl;
  if (state.ctx != null) {
    if (sameCtx) return () => {}; // already running for this wallet — one engine, ever
    stopEngine();
  }
  const session = ++engineSession;
  state.ctx = ctx;
  state.stopped = false;
  state.records = new Map();
  state.opts = {
    rearmMs: opts.rearmMs ?? CONVERT_ENGINE_REARM_MS,
    stuckWatchMs: opts.stuckWatchMs ?? CONVERT_ENGINE_STUCK_WATCH_MS,
    providerPollMs: opts.providerPollMs ?? CONVERT_ENGINE_PROVIDER_POLL_MS,
    executorOpts: opts.executorOpts ?? ENGINE_EXECUTOR_OPTS,
  };
  void (async () => {
    const loaded = await loadConvertRecords(ctx.publicHex);
    if (state.ctx !== ctx) return; // stopped/switched mid-load
    for (const [id, rec] of Object.entries(loaded)) state.records.set(id, rec);
    notify();
    for (const id of state.records.keys()) void driveOne(id);
  })();
  return () => {
    if (session === engineSession) stopEngine();
  };
}

/** A fresh snapshot object of every record this engine holds (the screen's read model). */
export function convertResumeSnapshot(): Record<string, ConvertRecord> {
  return Object.fromEntries(state.records);
}

/** Subscribe to record changes; returns unsubscribe. The callback receives a fresh snapshot. */
export function subscribeConvertRecords(cb: (records: Record<string, ConvertRecord>) => void): () => void {
  state.subscribers.add(cb);
  return () => {
    state.subscribers.delete(cb);
  };
}

/** Hand a freshly-prepared record (convert.ts `prepareConvertRecord`) to the engine: persist it,
 *  surface it, and drive it. The screen that built it keeps rendering FROM the engine. */
export async function adoptConvertRecord(record: ConvertRecord): Promise<void> {
  if (state.ctx == null) return;
  state.records.set(record.id, record);
  await saveConvertRecordFor(record);
  notify();
  void driveOne(record.id);
}

/** The user's acknowledge of a `stuck` record: the instructions were read, the background watch
 *  may stop. Idempotent; refuses non-stuck records. */
export async function acknowledgeStuckRecord(id: string): Promise<void> {
  const rec = state.records.get(id);
  if (rec == null || rec.step !== 'stuck' || rec.acknowledgedStuckAtMs != null) return;
  await commit({...rec, step: 'stuck', acknowledgedStuckAtMs: Date.now()});
  clearTimer(id); // the honest unknown has been read; nothing advances it but the user now
}

/** Test-only: full teardown between suites (jest module state persists across files). */
export function __resetConvertResumeEngineForTest(): void {
  stopEngine();
  state.subscribers.clear();
  state.records.clear();
  state.opts = {rearmMs: CONVERT_ENGINE_REARM_MS, stuckWatchMs: CONVERT_ENGINE_STUCK_WATCH_MS, providerPollMs: CONVERT_ENGINE_PROVIDER_POLL_MS, executorOpts: ENGINE_EXECUTOR_OPTS};
}
