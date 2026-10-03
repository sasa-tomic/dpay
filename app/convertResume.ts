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
 * CONVERT_ENGINE_STUCK_WATCH_MS). Terminal steps stop their record's timer for good — with
 * THREE honest exceptions that keep a SLOW watch: `stuck`, which the engine keeps slow-probing
 * (the submitted update may still have executed) until it resolves done/refunded, the window
 * EXPIRES (an expired unknown is RESOLVABLE — stuckExpiry.ts lands the honest terminal from
 * the input balance: present → failed_refunded/window_closed, gone → failed_leg), or the USER
 * acknowledges the stuck state (`acknowledgeStuckRecord` → `acknowledgedStuckAtMs`; an
 * EXPIRED record resolves even so — the deadline, not the ack, ends it). And a CeFi
 * `quote_expired`, which the engine keeps slow-polling until the venue answers for a
 * LATE deposit (refunded/processing/completed) — an expired quote does not un-see a deposit
 * that lands afterwards. Both are honest unknowns: watchable, not dismissable.
 *
 * Red lines (spec 2026-09-07, unchanged): nothing new is ever signed during recovery — the IC
 * driver only re-submits the record's OWN frozen envelope bytes, and the provider driver is a
 * pure GET. No dpay key in the value path; the relay stays query-only (provider statusUrls are
 * device-direct, https-only, like services/opencryptopay).
 */
import {
  CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS,
  CONVERT_ENGINE_PROVIDER_POLL_MS,
  CONVERT_ENGINE_REARM_MS,
  CONVERT_ENGINE_STUCK_WATCH_MS,
  CONVERT_ENGINE_TEST_OPTS,
} from './config/convert';
import {DpayCore} from './services/native';
import {deriveSolanaAddress} from './solana/identity';
import {
  attachCctpBurnTx as attachCctpBurnTxToRecord,
  convertAborted,
  declineCctpHandoff as declineCctpHandoffOnRecord,
  executeConvert,
  executeCrossRailConvert,
  executeCrossRailSolSwap,
  executeEvmConvert,
  executeSolanaConvert,
  isChainConvertRecord,
  isComposedConvertRecord,
  isTerminalConvertStep,
  loadConvertRecords,
  prepareCrossRailSolLeg,
  probeConvertSettlement,
  probeHopPayout,
  requestConvertAbort,
  isHubConvertRecord,
  saveConvertRecord,
  type ConvertRecord,
  type ConvertStep,
} from './convert';
import {advanceProviderRecord as advanceProviderRecordPersisted} from './convert/providerStatus';
import {
  beginChainPhase2,
  driveChainDeposit,
  resolveChainTerminal,
} from './convert/executeChain';
import {
  clearAllProviderRateLimits,
  clearProviderRateLimit,
  isTrocadorProviderRecord,
  providerRateLimitedUntilMs,
} from './convert/providerStatus';
import {clearStuckProbes, noteStuckProbeDone} from './convert/stuckProbeLog';
import {readLedgerBalance, resolveExpiredStuck, stuckExpiryDue} from './convert/stuckExpiry';
export {stuckLastCheckedAtMs} from './convert/stuckProbeLog';
export {recordLegExpiryMs} from './convert/stuckExpiry';
export type {ProviderStatusReading} from './convert/providerStatus';
export {fetchProviderStatus} from './convert/providerStatus';

/** The provider driver (the implementation lives in ./convert/providerStatus): the public
 *  signature is unchanged, and persistence stays the engine's own scoped save — the LIVE
 *  engine ctx's store (saveConvertRecordFor), exactly as when the body lived here. The
 *  CHAIN widening (2026-09-28): the completion hook rides through (the chain's phase 2
 *  signs on the venue's own completion, never at a falsified done). */
export async function advanceProviderRecord(
  record: ConvertRecord,
  stillMine: () => boolean = () => true,
  relayUrl?: string,
  onCompleted?: (record: ConvertRecord, settled: {amount?: string; tx?: string}) => Promise<ConvertRecord>,
): Promise<ConvertRecord> {
  return advanceProviderRecordPersisted(record, saveConvertRecordFor, stillMine, relayUrl, onCompleted);
}

/** Per-record epoch ms of the engine's LAST completed provider status read — the
 *  "last checked" fact the provider_processing panel shows (2026-09-24). Session-local
 *  by design (a fresh session honestly knows nothing until its own first poll lands)
 *  and never persisted: the persisted record must stay a state machine, not a poll log. */
const PROVIDER_LAST_CHECKED_MS = new Map<string, number>();

/** When did the engine last finish ONE status read for this record? Null = no read this
 *  session (nothing is claimed). */
export function providerLastCheckedAtMs(recordId: string): number | null {
  return PROVIDER_LAST_CHECKED_MS.get(recordId) ?? null;
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
  /** The TROCADOR poll floor override (jest pins the mechanics with a small floor; prod
   *  falls to CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS — 60 s, or 0 in a seamed test world). */
  providerPollFloorMs?: number;
  executorOpts?: Parameters<typeof executeConvert>[2];
};

/** The executor budget the engine drives with: enough submit retries to survive a flaky hop,
 *  a settle watch that spans one re-arm window, then the honest pending state — the re-arm
 *  timer, not an inner loop, is what keeps the watch alive. Overridable wholesale via
 *  __DPAY_TEST_CONVERT_ENGINE.executorOpts (the config/convert.ts seam). */
const ENGINE_EXECUTOR_OPTS = {
  submitAttempts: CONVERT_ENGINE_TEST_OPTS?.executorOpts?.submitAttempts ?? 3,
  poll: CONVERT_ENGINE_TEST_OPTS?.executorOpts?.poll ?? {attempts: 20, intervalMs: 500},
  settleAttempts: CONVERT_ENGINE_TEST_OPTS?.executorOpts?.settleAttempts ?? 8,
  settleIntervalMs: CONVERT_ENGINE_TEST_OPTS?.executorOpts?.settleIntervalMs ?? 1000,
};

type EngineState = {
  ctx: EngineCtx | null;
  opts: Required<Pick<EngineOpts, 'rearmMs' | 'stuckWatchMs' | 'providerPollMs' | 'providerPollFloorMs'>> & {executorOpts: NonNullable<EngineOpts['executorOpts']>};
  records: Map<string, ConvertRecord>;
  /** Per-record drive ownership: record id → the engineSession that owns the drive. A drive
   *  owned by a DEAD session is a ghost (its writes are D2-gated); it must never block THIS
   *  session's drives. (Was a bare Set across sessions: the killed session's still-draining
   *  drive silenced the remounted engine's boot sweep forever - the 2026-10-03 P0 strand.) */
  inflight: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  subscribers: Set<(records: Record<string, ConvertRecord>) => void>;
  stopped: boolean;
};

const state: EngineState = {
  ctx: null,
  opts: {rearmMs: CONVERT_ENGINE_REARM_MS, stuckWatchMs: CONVERT_ENGINE_STUCK_WATCH_MS, providerPollMs: CONVERT_ENGINE_PROVIDER_POLL_MS, providerPollFloorMs: CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS, executorOpts: ENGINE_EXECUTOR_OPTS},
  records: new Map(),
  inflight: new Map(),
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
  // The abort guard (2026-09-19): a driver finishing an in-flight await must never overwrite
  // the user's stop — every later transition collapses to 'aborted'.
  const cur = state.records.get(next.id);
  if (cur?.step === 'aborted' && next.step !== 'aborted') {
    next = {...next, step: 'aborted', abortedAtMs: cur.abortedAtMs};
  }
  state.records.set(next.id, next);
  await saveConvertRecordFor(next);
  notify();
  return next;
}

/** One probe of an unacknowledged `stuck` record: the submitted update may STILL have executed
 *  (trichotomy arm (b)) — if the payout or refund is on a ledger now, the record resolves.
 *  `ctx` is the DRIVE's OWN captured context (D2): the probes await, so the engine may have
 *  re-keyed underneath — a stale probe resolves nothing (no map write, no persist, no re-arm).
 *
 *  THE EXPIRY RESOLUTION (2026-10-02 POCO P0): once the record's signed window has passed,
 *  an unknown outcome is RESOLVABLE — the app's own copy says nothing can move past the
 *  deadline. After every probe answers unknown past the deadline, `resolveExpiredStuck`
 *  reads the unknown leg's input balance and lands the honest terminal:
 *  funds verifiably present → failed_refunded/window_closed (nothing left the wallet);
 *  funds gone or unreadable → failed_leg (balance display is the source of truth).
 *  On-chain evidence seen by the probe itself still resolves FIRST (arm (a), unchanged). */
async function probeStuckOnce(rec: ConvertRecord, ctx: EngineCtx): Promise<ConvertRecord> {
  // A stuck PLANNED (multi-hop) record resolves differently (2026-09-14 spec §8): the probe
  // that can resolve it is the HOP payout, and a seen hop row means the swap ran while the
  // burn legs' bytes are dead or unknown — the hop asset is in-wallet, so the resolution is
  // failed_leg (exit: standalone Withdraw), NEVER done. The engine cannot complete a route
  // it cannot re-sign; it can only name where the funds stand.
  // The HUB record's slow watch (2026-09-18, spec §11) resolves by the same trichotomy as
  // its expiry arm: DEST payout seen → done (the final swap executed — the dest asset IS in
  // the wallet, the SEEN amount); else HUB payout seen → failed_leg (swap1 ran, swap2's
  // bytes are dead); else it stays stuck, still unknown — until the window closes (below).
  const readBal = readLedgerBalance(ctx.secretHex);
  if (rec.legPlan != null) {
    const myPrincipal = (await DpayCore.icpPrincipalFromPubkey(ctx.publicHex)).toLowerCase();
    const probe = (swapLeg: 1 | 2) => probeHopPayout({
      relayUrl: ctx.relayUrl,
      publicHex: ctx.publicHex,
      myPrincipalLower: myPrincipal,
      record: rec,
      excludeOutTx: claimedOutTxFor(rec.id),
      swapLeg,
    });
    if (isHubConvertRecord(rec)) {
      const dest = await probe(2);
      if (state.ctx !== ctx) return rec; // stale drive — resolve nothing under the new identity
      if (dest != null) {
        return commit({...rec, step: 'done', outAmountNet: dest.amount, outTx: dest.tx, destTx: dest.tx});
      }
      const hub = await probe(1);
      if (state.ctx !== ctx) return rec; // stale drive — resolve nothing under the new identity
      noteStuckProbeDone(rec.id, Date.now());
      if (hub != null) {
        return commit({...rec, step: 'failed_leg', failureCode: 'unknown', hopTx: hub.tx});
      }
    } else {
      const seen = await probe(1);
      if (state.ctx !== ctx) return rec; // stale drive — resolve nothing under the new identity
      noteStuckProbeDone(rec.id, Date.now());
      if (seen != null) {
        return commit({...rec, step: 'failed_leg', failureCode: 'unknown', hopTx: seen.tx});
      }
    }
  } else {
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
    noteStuckProbeDone(rec.id, Date.now());
    if (seen?.kind === 'output') {
      return commit({...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx});
    }
    if (seen?.kind === 'refund') {
      return commit({...rec, step: 'failed_refunded', failureCode: 'refunded', refundTx: seen.tx});
    }
  }
  // Still unknown past the deadline: the honest terminal resolution (money-safety rules in
  // stuckExpiry.ts). A stale drive resolves nothing.
  const resolved = await resolveExpiredStuck(rec, Date.now(), readBal);
  if (resolved != null && state.ctx === ctx) {
    return commit(resolved);
  }
  return rec;
}

function fireOnTerminalIfEnteredListed(before: ConvertStep | undefined, after: ConvertRecord): void {
  if (before != null && !isTerminalConvertStep(before) && isTerminalConvertStep(after.step)) {
    state.ctx?.onTerminal?.();
  }
}

/** The single driver entry. Single-flight per record id WITHIN the live session (a drive is
 *  ONE executor run or ONE provider poll or ONE stuck probe, never a loop - loops live in the
 *  re-arm timers); a drive owned by a PREVIOUS session is a ghost and blocks nothing.
 *
 *  A drive BELONGS to the ctx it started under (D2 identity-switch race): if the engine re-keys
 *  to identity B mid-drive, the stale drive still finishes its work, but every write, persist,
 *  and re-arm below is gated on `state.ctx === capturedCtx` - A's record never lands in B's
 *  in-memory records map, B's timers are never armed for it, and B's engine never drives (and
 *  thereby never persists) A's record into `dpay.convert.v3.<B>`. Stale drives finish silently.
 *
 *  THE GHOST RULE (2026-10-03 P0): the killed session's drive can outlive the session itself
 *  (its bounded awaits drain long after the wallet unmounted). Its ownership entry is keyed by
 *  ITS session, so the remounted engine's boot sweep drives the record anyway - under the old
 *  session-global flag the ghost silenced the new session's drive AND its own D2 guard refused
 *  the re-arm, leaving the record live in the map with no driver and no timer at all. */
async function driveOne(id: string): Promise<void> {
  const ctx = state.ctx;
  if (ctx == null || state.stopped) return;
  if (state.inflight.get(id) === engineSession) return;
  const session = engineSession;
  const rec = state.records.get(id);
  if (rec == null) return;
  state.inflight.set(id, session);
  const mine = () => state.ctx === ctx;
  try {
    let next = rec;
    if (!isTerminalConvertStep(rec.step)) {
      if (isChainConvertRecord(rec) && rec.legs.length === 0) {
        // The CHAIN driver, PHASE 1 (2026-09-28): the cefi order exists, the Solana deposit
        // bytes are frozen — submit + watch them, then hand the wait to the venue poll.
        // The poll's COMPLETED reading is phase 2's trigger: the hook freezes the settle
        // evidence onto the chain block and signs the IC legs from the frozen plan (the
        // hook's apply persists the returned record — a phase-2 failure lands terminal).
        const chainDeps = {
          secretHex: ctx.secretHex,
          publicHex: ctx.publicHex,
          relayUrl: ctx.relayUrl,
          onUpdate: (r: ConvertRecord) => {
            if (!mine()) return;
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
        };
        if (rec.step === 'awaiting_deposit' || rec.step === 'provider_processing') {
          next = await advanceProviderRecord(rec, mine, ctx.relayUrl, async (r, settled) => {
            const cr = r.chainRoute;
            if (cr == null) return r;
            const withSettle: ConvertRecord = {
              ...r,
              step: 'provider_processing',
              chainRoute: {
                ...cr,
                ...(settled.tx != null ? {settleTx: settled.tx} : {}),
                ...(settled.amount != null && cr.settleAmountDecimal == null ? {settleAmountDecimal: settled.amount} : {}),
              },
            };
            return beginChainPhase2(withSettle, chainDeps);
          });
          if (!mine()) return; // stale drive — no post-run write, no re-arm
          PROVIDER_LAST_CHECKED_MS.set(id, Date.now()); // one read completed — the panel's "last checked"
          if (next !== rec) {
            const before = state.records.get(id)?.step;
            state.records.set(id, next);
            fireOnTerminalIfEnteredListed(before, next);
            notify();
          }
        } else if (rec.step === 'swapping' || rec.step === 'settling' || rec.step === 'stuck') {
          next = await driveChainDeposit(rec, chainDeps);
          if (!mine()) return; // stale drive — no post-run write, no re-arm
          if (next !== rec) {
            const before = state.records.get(id)?.step;
            state.records.set(id, next);
            fireOnTerminalIfEnteredListed(before, next);
            notify();
          }
        }
        // quote_expired (the venue's dead window) and provider_refunded are terminal: the
        // outer arms own them (the late-deposit watch below covers a chain's expired
        // order). A phase-2 record (legs signed) falls through to the generic IC-legs
        // arm, whose post-run hook below resolves the 1-leg terminal.
      } else if (rec.crossRail != null) {
        // Cross-rail dispatch (convert.ts, Routes B/C 2026-09-16) — keyed on the phase:
        //  - `crossing`: Circle's mint watch + the ATA credit verification (the record moves
        //    itself to done/sol_ready when Circle completes; a stall parks pending, NEVER
        //    a false failure — the re-arm keeps the watch alive).
        //  - `solanaLeg` set (`swapping`/`settling` after sol_ready): the cross-rail Jupiter
        //    driver — NOT executeSolanaConvert, whose payout reads key on the standalone
        //    record shape.
        //  - `awaiting_external` / `sol_ready`: USER-paced. The handoff panel owns the first
        //    (dpay never signs EVM); the fresh-quote offer owns the second. The engine still
        //    re-arms so a reload picks the record up the moment it moves.
        //  - the IC phases (`approving`/`pending_withdrawal`) fall through to the legs
        //    driver below, exactly as Route A — the executor hands off to `awaiting_external`
        //    when the IC route's withdraw lands.
        if (rec.step === 'crossing') {
          next = await executeCrossRailConvert(rec, {
            secretHex: ctx.secretHex,
            publicHex: ctx.publicHex,
            onUpdate: (r) => {
              if (!mine()) return;
              fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
              state.records.set(r.id, r);
              notify();
            },
          });
          if (!mine()) return;
          if (next !== rec) {
            const before = state.records.get(id)?.step;
            state.records.set(id, next);
            fireOnTerminalIfEnteredListed(before, next);
            notify();
          }
        } else if (rec.solanaLeg != null) {
          next = await executeCrossRailSolSwap(rec, {
            secretHex: ctx.secretHex,
            publicHex: ctx.publicHex,
            onUpdate: (r) => {
              if (!mine()) return;
              fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
              state.records.set(r.id, r);
              notify();
            },
          });
          if (!mine()) return;
          if (next !== rec) {
            const before = state.records.get(id)?.step;
            state.records.set(id, next);
            fireOnTerminalIfEnteredListed(before, next);
            notify();
          }
        }
        // awaiting_external / sol_ready: USER-paced, nothing to drive this tick — the
        // re-arm below picks the record up the moment it moves (attach/decline/confirm).
        // The IC phases (approving / pending_withdrawal) reach the legs driver here,
        // exactly as Route A — the executor hands off to `awaiting_external` when the IC
        // route's withdraw lands.
        else if (rec.step !== 'awaiting_external' && rec.step !== 'sol_ready') {
          next = await executeConvert(rec, {
            secretHex: ctx.secretHex,
            publicHex: ctx.publicHex,
            relayUrl: ctx.relayUrl,
            onUpdate: (r) => {
              if (!mine()) return;
              fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
              state.records.set(r.id, r);
              notify();
            },
            claimedOutTx: claimedOutTxFor(id),
            claimedRefundTx: claimedRefundTxFor(id),
          }, state.opts.executorOpts);
          if (!mine()) return;
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      } else if (isComposedConvertRecord(rec)) {
        // The COMPOSED IC→CeFi driver (2026-09-26, brief §5.4 item 2). Two phases, ONE
        // record: the IC legs + the deposit transfer are a planned record the IC executor
        // drives (the deposit leg's gate lives there); once the deposit transfer is sent
        // the record parks at a provider step and THIS driver polls the venue's order
        // status to a terminal state — the same provider driver every legless CeFi record
        // uses, keyed on the composed record's own providerRef.
        if (rec.step === 'awaiting_deposit' || rec.step === 'provider_processing') {
          next = await advanceProviderRecord(rec, mine, ctx.relayUrl);
          if (!mine()) return; // stale drive — no post-run write, no re-arm
          PROVIDER_LAST_CHECKED_MS.set(id, Date.now()); // one read completed — the panel's "last checked"
          if (next !== rec) {
            const before = state.records.get(id)?.step;
            state.records.set(id, next);
            fireOnTerminalIfEnteredListed(before, next);
            notify();
          }
        } else {
          next = await executeConvert(rec, {
            secretHex: ctx.secretHex,
            publicHex: ctx.publicHex,
            relayUrl: ctx.relayUrl,
            onUpdate: (r) => {
              if (!mine()) return;
              fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
              state.records.set(r.id, r);
              notify();
            },
            claimedOutTx: claimedOutTxFor(id),
            claimedRefundTx: claimedRefundTxFor(id),
          }, state.opts.executorOpts);
          if (!mine()) return;
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      } else if (rec.legs.length > 0) {
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
        // The CHAIN 1-leg terminal (2026-09-28): the planned executor's hub rule only
        // resolves a SECOND swap's payout row; a chain's single-swap plan parks
        // all-confirmed. Probe the swap's own payout row here and land done on the SEEN
        // amount — or leave the record for the next re-arm.
        if (isChainConvertRecord(next)) {
          const resolved = await resolveChainTerminal(next, {
            secretHex: ctx.secretHex,
            publicHex: ctx.publicHex,
            relayUrl: ctx.relayUrl,
            onUpdate: () => {},
          });
          if (resolved != null && resolved !== next && mine()) {
            await saveConvertRecordFor(resolved);
            state.records.set(id, resolved);
            fireOnTerminalIfEnteredListed(before, resolved);
            notify();
          }
        }
      } else if (rec.solanaLeg != null) {
        // Solana driver (convert.ts, Jupiter 2026-09-15): the signed tx bytes are frozen in the
        // record — the drive submits identical bytes or reads the chain's own verdict, nothing
        // else. The user's SOL address (owner filter for realized-credit reads) derives from
        // the SAME device secret, exactly the way the payment rail does.
        next = await executeSolanaConvert(rec, {
          publicHex: ctx.publicHex,
          solAddress: deriveSolanaAddress(ctx.secretHex),
          onUpdate: (r) => {
            if (!mine()) return; // stale drive — B's map never receives A's record
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
        });
        if (!mine()) return; // stale drive — no post-run write, no re-arm
        if (next !== rec) {
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      } else if (rec.evmSwap != null) {
        // EVM driver (2026-09-28, the any-pair mandate): the legs are SIGNED here at drive
        // time from the record's frozen facts (nonces move), every broadcast hash persisted
        // as durable identity, receipts watched to the done line. Never re-signs past a
        // broadcast; the aggregate gas gate refuses before any signature.
        next = await executeEvmConvert(rec, {
          publicHex: ctx.publicHex,
          secretHex: ctx.secretHex,
          onUpdate: (r) => {
            if (!mine()) return;
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
        });
        if (!mine()) return;
        if (next !== rec) {
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      } else if (rec.providerRef != null) {
        next = await advanceProviderRecord(rec, mine, ctx.relayUrl);
        if (!mine()) return; // stale drive — no post-run write, no re-arm
        PROVIDER_LAST_CHECKED_MS.set(id, Date.now()); // one read completed — the panel's "last checked"
        if (next !== rec) {
          const before = state.records.get(id)?.step;
          state.records.set(id, next);
          fireOnTerminalIfEnteredListed(before, next);
          notify();
        }
      }
    } else if (
      rec.step === 'quote_expired'
      && rec.providerRef != null
      && ((rec.legs.length === 0 && rec.solanaLeg == null) || isComposedConvertRecord(rec) || isChainConvertRecord(rec))
    ) {
      // The LATE-DEPOSIT watch (2026-09-24): `expired` from awaiting_deposit is the VENUE
      // giving up on its quote window, but a deposit that lands late is still refunded (or
      // even honored) by the venue — a dead record must observe that, not assert it never
      // happens. One SLOW poll per stuck-watch window (a record that cannot be advanced any
      // faster must not be polled any faster) until the venue answers refunded/processing/
      // completed — or the user's abort flag retires the watch (the flag, not a step rewrite:
      // quote_expired is terminal, and abort must not un-terminal a record). The COMPOSED
      // widening (2026-09-26): a composed record reaches the same terminal the same way
      // (its deposit leg sent, the venue expired the window) — the same slow watch applies.
      if (convertAborted(id)) return; // the watch was retired — never re-armed below
      next = await advanceProviderRecord(rec, mine, ctx.relayUrl);
      if (!mine()) return; // stale drive — no post-run write, no re-arm
      PROVIDER_LAST_CHECKED_MS.set(id, Date.now());
      if (next !== rec) {
        const before = state.records.get(id)?.step;
        state.records.set(id, next);
        fireOnTerminalIfEnteredListed(before, next);
        notify();
      }
    } else if (
      rec.step === 'stuck'
      && (rec.legs.length > 0 || rec.solanaLeg != null)
      // The watch stops when the user acknowledges it — EXCEPT once the signed window has
      // passed: an expired unknown is resolvable (stuckExpiry.ts), acknowledged or not,
      // and the next drive lands the honest terminal (2026-10-02 POCO P0).
      && (rec.acknowledgedStuckAtMs == null || stuckExpiryDue(rec))
    ) {
      // The honest unknown stays watchable until the user reads it: one slow probe per window.
      // (A Solana stuck record re-reads its signature status the same way — inside the
      // executor's stuck entry, since the chain IS the ledger watch on that rail. A
      // cross-rail record's Solana leg goes to the cross-rail driver, whose payout reads
      // key on the cross-rail facts.)
      if (rec.crossRail != null && rec.solanaLeg != null) {
        next = await executeCrossRailSolSwap(rec, {
          secretHex: ctx.secretHex,
          publicHex: ctx.publicHex,
          onUpdate: (r) => {
            if (!mine()) return;
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
        });
      } else if (rec.solanaLeg != null) {
        next = await executeSolanaConvert(rec, {
          publicHex: ctx.publicHex,
          solAddress: deriveSolanaAddress(ctx.secretHex),
          onUpdate: (r) => {
            if (!mine()) return;
            fireOnTerminalIfEnteredListed(state.records.get(r.id)?.step, r);
            state.records.set(r.id, r);
            notify();
          },
        });
      } else {
        next = await probeStuckOnce(rec, ctx);
      }
    }
    if (!mine()) return; // stale drive — B's timers are never armed for A's record
    scheduleNext(id, next);
  } catch (e) {
    console.warn('convert resume drive failed for', id, e instanceof Error ? e.message : String(e));
    if (mine()) scheduleNext(id, state.records.get(id) ?? rec);
  } finally {
    // The ghost's cleanup never deletes a live session's ownership (a restart re-keyed the
    // entry); only the owner removes its own flag.
    if (state.inflight.get(id) === session) state.inflight.delete(id);
  }
}

/** Arm (or retire) a record's timer based on what it now is. Every branch is a bounded, slow
 *  cadence; terminal-and-settled records retire their timer for good. */
function scheduleNext(id: string, rec: ConvertRecord): void {
  clearTimer(id);
  if (state.ctx == null || state.stopped) return;
  let delay: number | null = null;
  if (!isTerminalConvertStep(rec.step)) {
    // A provider-phase record re-arms on the provider cadence: a legless CeFi record, or a
    // COMPOSED record once its deposit transfer is sent (its own legs are confirmed — the
    // venue poll is the only thing left to drive).
    const providerPhase = rec.legs.length === 0 && rec.solanaLeg == null
      || (isComposedConvertRecord(rec)
        && (rec.step === 'awaiting_deposit' || rec.step === 'provider_processing'));
    if (providerPhase) {
      // CeFi provider record. Two bounds stack on the engine cadence (partner agreement,
      // 2026-09-22 spec term 4): the TROCADOR family's 60 s FLOOR (one status request per
      // trade id per minute, never faster — the sideshift family polls its own keyless
      // venue host and is not party to the agreement), and a 429's Retry-After hint,
      // consumed here: the next tick waits it out (wait-and-retry, never an error).
      const base = Math.max(
        state.opts.providerPollMs,
        isTrocadorProviderRecord(rec) ? state.opts.providerPollFloorMs : 0,
      );
      const limitedUntil = providerRateLimitedUntilMs(id);
      clearProviderRateLimit(id);
      delay = limitedUntil != null ? Math.max(base, limitedUntil - Date.now()) : base;
    } else {
      // IC-legs and Solana records re-arm on the fast cadence (their drivers own their own
      // bounded waits; the re-arm is the outer safety net).
      delay = state.opts.rearmMs;
    }
  } else if (
    rec.step === 'stuck'
    && (rec.legs.length > 0 || rec.solanaLeg != null)
    // Acknowledged records retire the watch — unless the window has passed, where the next
    // drive is the expiry resolution itself and must still be armed (2026-10-02 POCO P0).
    && (rec.acknowledgedStuckAtMs == null || stuckExpiryDue(rec))
  ) {
    delay = state.opts.stuckWatchMs;
  } else if (
    rec.step === 'quote_expired'
    && rec.providerRef != null
    && ((rec.legs.length === 0 && rec.solanaLeg == null) || isComposedConvertRecord(rec))
    && !convertAborted(id)
  ) {
    // The late-deposit watch (2026-09-24): the quote_expired step keeps ONE SLOW poll per
    // stuck-watch window — the same cadence as the stuck probe (a record that cannot be
    // advanced any faster must not be polled any faster) — until the venue resolves the
    // late deposit or the user's abort flag retires the watch.
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
  // The 429 backoffs die with the session that earned them: a new identity's engine sizes
  // its ticks from its own drives, never a predecessor's hints. The last-checked fact is
  // the same shape of honesty — the next session reports only its own reads.
  clearAllProviderRateLimits();
  PROVIDER_LAST_CHECKED_MS.clear();
  clearStuckProbes(); // the stuck probes' "last checked" facts die with the same session
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
  // A fresh session owns nothing: ghost ownership entries from dead sessions never block the
  // boot sweep (the driveOne guard keys on the session), and their cleanup is a no-op here.
  state.inflight.clear();
  state.opts = {
    rearmMs: opts.rearmMs ?? CONVERT_ENGINE_REARM_MS,
    stuckWatchMs: opts.stuckWatchMs ?? CONVERT_ENGINE_STUCK_WATCH_MS,
    providerPollMs: opts.providerPollMs ?? CONVERT_ENGINE_PROVIDER_POLL_MS,
    providerPollFloorMs: opts.providerPollFloorMs ?? CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS,
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

/** Take the cefi-deposit handoff for ONE record (2026-10-02 P0): persist the deposit-sent
 *  marker on the engine's copy AND the scoped store BEFORE any transfer envelope leaves, so
 *  the watcher's once-only gate survives a kill mid-send (a rebuilt envelope after a restart
 *  would be a fresh transfer — a second spend). Idempotent: the FIRST taker's marker stands;
 *  `false` = nothing was marked (already taken, or the record is unknown to this engine). */
export async function markConvertDepositSent(id: string, atMs: number): Promise<boolean> {
  const rec = state.records.get(id);
  if (rec == null || rec.depositSentAtMs != null) return false;
  await commit({...rec, depositSentAtMs: atMs});
  return true;
}

/** The user's acknowledge of a `stuck` record: the instructions were read, the background watch
 *  may stop. Idempotent; refuses non-stuck records. ONE exception (2026-10-02 POCO P0): a
 *  record whose signed window has already passed is resolvable — the ack drives the expiry
 *  resolution immediately instead of retiring the watch, so the record lands its honest
 *  terminal even though the user has read it. */
export async function acknowledgeStuckRecord(id: string): Promise<void> {
  const rec = state.records.get(id);
  if (rec == null || rec.step !== 'stuck' || rec.acknowledgedStuckAtMs != null) return;
  const acked = {...rec, step: 'stuck' as const, acknowledgedStuckAtMs: Date.now()};
  await commit(acked);
  if (stuckExpiryDue(acked)) {
    void driveOne(id); // the deadline, not the ack, ends this record
  } else {
    clearTimer(id); // the honest unknown has been read; nothing advances it but the user now
  }
}

/** The user's Stop tap on a live record (2026-09-19): set the shared flag (the confirm-flow
 *  executor honors it at its next checkpoint even when this engine never adopted the record),
 *  freeze the engine copy at 'aborted' when it has one, and stop its timers. */
export async function abortConvertRecord(id: string): Promise<void> {
  const rec = state.records.get(id);
  requestConvertAbort(id);
  if (rec == null || isTerminalConvertStep(rec.step)) return;
  await commit({...rec, step: 'aborted', abortedFromStep: rec.step, abortedAtMs: Date.now()});
  clearTimer(id);
}

/** The handoff's return path (Routes B/C): the user's own EVM wallet signed the burn, and the
 *  burn tx hash is in. Attaches it (convert.ts validates the hash shape and freezes it),
 *  parks the record on `crossing`, and immediately drives the Circle watch. This is the ONLY
 *  way an `awaiting_external` record advances — dpay never signs, so it never guesses. */
export async function attachCctpBurnTx(id: string, burnTxHash: string): Promise<void> {
  const rec = state.records.get(id);
  if (rec == null || rec.step !== 'awaiting_external') return;
  const next = attachCctpBurnTxToRecord(rec, burnTxHash);
  await commit(next);
  void driveOne(id);
}

/** The handoff's honest exit: the user is NOT signing in their wallet (declined, wrong wallet,
 *  changed their mind). The record ends `failed_leg`/`external_declined` — funds sit as USDC
 *  at the user's OWN EVM address, exactly where Route A would have delivered them; the dead-end
 *  copy names it. Refuses non-awaiting records. */
export async function declineCctpHandoff(id: string): Promise<void> {
  const rec = state.records.get(id);
  if (rec == null || rec.step !== 'awaiting_external') return;
  await commit(declineCctpHandoffOnRecord(rec));
}

/** Route C's final confirm: build + verify + sign the Jupiter leg from the VERIFIED mint
 *  credit (convert.ts `prepareCrossRailSolLeg` owns every red line) and hand the signed
 *  record to the executor. The screen's own confirm button is the only caller. */
export async function confirmCrossRailSolLeg(id: string): Promise<ConvertRecord | null> {
  const rec = state.records.get(id);
  const ctx = state.ctx;
  if (rec == null || ctx == null || rec.step !== 'sol_ready') return null;
  const next = await prepareCrossRailSolLeg(ctx.secretHex, rec, ctx.relayUrl);
  await commit(next);
  void driveOne(id);
  return next;
}

/** TEMP DIAG (killarm investigation): one synchronous look at the engine singleton's live
 *  state - the ctx liveness, the armed timer count, the in-flight drive set, and every held
 *  record's (step, legPlan states, dispatch-shape flags). Read-only, test-only; remove with
 *  the investigation. */
export function convertResumeDebugSnapshot(): {
  hasCtx: boolean; stopped: boolean; timers: number; inflight: string[];
  records: Array<{id: string; step: string; legs: Array<string | null>; composed: boolean; providerRef: boolean; solanaLeg: boolean}>;
} {
  return {
    hasCtx: state.ctx != null,
    stopped: state.stopped,
    timers: state.timers.size,
    inflight: [...state.inflight.keys()],
    records: [...state.records.values()].map((r) => ({
      id: r.id,
      step: r.step,
      legs: (r.legPlan ?? []).map((l) => l.state),
      composed: r.composedDeposit != null,
      providerRef: r.providerRef != null,
      solanaLeg: r.solanaLeg != null,
    })),
  };
}

/** Test-only: full teardown between suites (jest module state persists across files). */
export function __resetConvertResumeEngineForTest(): void {
  stopEngine();
  state.subscribers.clear();
  state.records.clear();
  clearStuckProbes();
  state.opts = {rearmMs: CONVERT_ENGINE_REARM_MS, stuckWatchMs: CONVERT_ENGINE_STUCK_WATCH_MS, providerPollMs: CONVERT_ENGINE_PROVIDER_POLL_MS, providerPollFloorMs: CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS, executorOpts: ENGINE_EXECUTOR_OPTS};
}
