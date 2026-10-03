// executeChain — the CHAIN route's drivers (2026-09-28, the any-pair mandate). ONE record,
// TWO phases, the composed flow reversed:
//
//   PHASE 1 — the cefi order exists (created at confirm, order-first); this driver submits
//   the FROZEN Solana deposit bytes (identical-bytes discipline, the chain dedups them),
//   watches the chain's own verdict, and hands the record to the provider poll.
//   PHASE 2 — when the venue's status names the settle, `beginChainPhase2` signs the IC
//   legs from the record's OWN frozen plan (never any other venue, pool, or pair), on a
//   FRESH quote at the recorded slippage — an IC envelope dies at its +300 s ingress
//   expiry, so these legs could never be pre-signed at confirm. The rewritten record then
//   runs through the standard planned executor (approve/swap [/approve/swap], the hub
//   taxonomy), with the 1-leg terminal resolved here (the single swap's payout row is the
//   done evidence — the hub rule only covers the 2-leg shape).
//
// Red lines: nothing is ever signed except from the frozen plan; a phase-2 quote or
// signature failure is a TERMINAL failed_leg, never a retry loop — the mid asset is in the
// wallet and the failure copy names the 2-tap exit; the deposit leg is never re-signed,
// only re-submitted identically.
import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {
  getSolBlockHeight,
  getSolSignatureStatus,
  submitRawSolTx,
} from '../solana';
import {hexToBytes} from '../lib/format';
import {venueDisplayName, venueOfId} from '../config/venues';
import {CONVERT_APPROVE_LIFETIME_S} from '../config/convert';
import {type ConvertRecord, type LegPlan, type SignedLeg} from './types';
import {deriveConvertMath, fetchConvertQuote, type ConvertMath, type ConvertQuote} from './quotes';
import {saveConvertRecord} from './records';
import {probeHopPayout} from './execute';
import {saveTxNote} from '../services/txNotes';

export type ChainDriverDeps = {
  secretHex: string;
  publicHex: string;
  relayUrl: string;
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

// --- phase 1: the frozen Solana deposit bytes -------------------------------------------------------

type SolWatchOutcome =
  | {kind: 'confirmed'}
  | {kind: 'failed'; detail: string}
  | {kind: 'dead'}
  | {kind: 'unknown'};

/** The chain's own verdict on the deposit signature (history-aware, the Solana driver's
 *  read — a late confirmation is still found). */
async function watchDepositTx(
  signature: string,
  lastValidBlockHeight: number,
  attempts: number,
  intervalMs: number,
): Promise<SolWatchOutcome> {
  for (let i = 0; i < attempts; i++) {
    let status = null;
    try {
      status = await getSolSignatureStatus(signature);
    } catch {
      status = null; // an unreadable status proves nothing either way
    }
    if (status != null && status.err != null) {
      return {kind: 'failed', detail: JSON.stringify(status.err).slice(0, 120)};
    }
    if (status != null && status.confirmationStatus != null) {
      return {kind: 'confirmed'};
    }
    let height: number | null = null;
    try {
      height = await getSolBlockHeight();
    } catch {
      height = null;
    }
    if (height != null && height > lastValidBlockHeight) {
      return {kind: 'dead'};
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return {kind: 'unknown'};
}

/** Drive the phase-1 deposit: submit the identical signed bytes (Solana dedups by
 *  signature), then watch. Confirmed → `awaiting_deposit` (the provider poll owns the
 *  wait). Failed/dead → the deposit never left or bounced: `failed_refunded`, every unit
 *  of the source asset still in the wallet. Unknown → `stuck` (the honest unknown, the
 *  engine's slow watch re-reads; NEVER new bytes). */
export async function driveChainDeposit(
  start: ConvertRecord,
  deps: ChainDriverDeps,
  opts: {submitAttempts?: number; confirmAttempts?: number; pollIntervalMs?: number} = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const confirmAttempts = opts.confirmAttempts ?? 12;
  const intervalMs = opts.pollIntervalMs ?? 400;
  let rec = start;
  const leg = rec.solanaLeg;
  const cr = rec.chainRoute;
  if (leg == null || cr == null) return rec; // not a phase-1 chain record — nothing to drive
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };
  const watch = (attempts: number, interval: number) =>
    watchDepositTx(leg.signature, leg.lastValidBlockHeight, attempts, interval);

  // stuck (the slow-watch entry): re-read, never resubmit past a live-bytes verdict.
  if (rec.step === 'stuck') {
    const outcome = await watch(1, 0);
    if (outcome.kind === 'confirmed') {
      return advance({step: 'awaiting_deposit'});
    }
    if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    return rec; // still genuinely unknown — stays stuck until acknowledged or resolved
  }

  if (rec.step !== 'swapping' && rec.step !== 'settling') return rec;
  const raw = hexToBytes(leg.signedTxHex);
  if (raw == null) {
    return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'unreadable-signed-bytes'});
  }
  if (rec.step === 'swapping') {
    void saveTxNote(deps.publicHex, {k: leg.signature, who: venueDisplayName(cr.venueId)}, Date.now());
    let submitted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < submitAttempts && !submitted; i++) {
      try {
        const nodeSig = await submitRawSolTx(raw);
        // The single-signer tx's identity IS the signature we recorded; anything else means
        // we are not looking at our own bytes — park, never guess.
        submitted = nodeSig === leg.signature;
        if (!submitted) return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'signature-mismatch'});
      } catch (e) {
        lastErr = e;
        // A throw is NOT a refusal verdict: ask the chain before retrying — identical
        // bytes only, never a rebuild.
        const probe = await watch(1, 0);
        if (probe.kind === 'confirmed') {
          submitted = true;
        } else if (probe.kind === 'failed') {
          return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: probe.detail});
        } else if (probe.kind === 'dead') {
          return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
        }
      }
    }
    if (!submitted) {
      if (lastErr != null) console.warn('chain deposit submit: no verdict after retries', lastErr);
      return advance({step: 'stuck', failureCode: 'unknown'});
    }
    rec = await advance({step: 'settling'});
  }
  if (rec.step === 'settling') {
    const outcome = await watch(confirmAttempts, intervalMs);
    if (outcome.kind === 'confirmed') {
      return advance({step: 'awaiting_deposit'});
    }
    if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    return advance({step: 'stuck', failureCode: 'unknown'});
  }
  return rec;
}

// --- phase 2: sign the IC legs from the frozen plan -------------------------------------------------

/** ONE leg's self-funded input (the chain prepare's own rule, mirrored): floor − 2×fee. */
function chainLegInput(floor: string, fromFee: string): string | null {
  const net = BigInt(floor) - 2n * BigInt(fromFee);
  return net > 0n ? net.toString() : null;
}

/**
 * Sign the IC legs — the venue named the settle, so the plan's first leg's source asset is
 * in the wallet. Fresh quotes on the LOCKED settle figure (never the review's estimate),
 * the record's own slippage, the record's OWN frozen venues/pools/pairs/fees, and the
 * standard approve+swap pair per leg (a 2-leg plan is the hub shape, leg 2 sized on leg 1's
 * floor). The record's IC fields rewrite to the phase-2 facts (venueId becomes the IC pool
 * the probes key on); the chainRoute block stays for history + narration.
 *
 * EVERY failure here is the TERMINAL failed_leg: the mid asset is in the wallet, the exit
 * is a normal 2-tap convert of it, and no driver ever re-enters. The phase signs all-or-
 * nothing: a refusal mid-plan persists no partial legs.
 */
export async function beginChainPhase2(rec: ConvertRecord, deps: ChainDriverDeps): Promise<ConvertRecord> {
  const cr = rec.chainRoute;
  const midLedger = rec.hopLedger;
  if (cr == null || midLedger == null || cr.settleAmountRaw == null
    || cr.icLegs.length === 0 || cr.icLegs.length !== cr.icFromFees.length) {
    return failedPhase2(rec, deps, 'chain record carries no complete frozen plan');
  }
  const settleRaw = cr.settleAmountRaw;
  const legs: SignedLeg[] = [];
  const legPlan: LegPlan[] = [];
  const quotes: ConvertQuote[] = [];
  const maths: ConvertMath[] = [];
  try {
    const allowanceExpiryNs = await icStampExpiry(deps.secretHex, CONVERT_APPROVE_LIFETIME_S);
    const envExpiry = await icStampExpiry(deps.secretHex);
    const expiresAtMs = Number(BigInt(envExpiry) / 1_000_000n);
    let floor = settleRaw;
    for (let k = 0; k < cr.icLegs.length; k += 1) {
      const planLeg = cr.icLegs[k]!;
      const fromFee = cr.icFromFees[k]!;
      // The out fee: the NEXT leg's from-ledger fee when a further leg follows (both are
      // that ledger's transfer fee), else the record's own OUT fee (the dest ledger's).
      const outFee = k + 1 < cr.icLegs.length ? cr.icFromFees[k + 1]! : rec.outFee;
      const inRaw = chainLegInput(floor, fromFee);
      if (inRaw == null) throw new Error(`leg ${k + 1} floor cannot fund its own fees`);
      // The plan leg's OWN venue, fail-closed (audit F9): a registry miss is not resolvable by
      // asking a different bundled venue - that answer could only die at the plan-divergence gate.
      const legVenue = venueOfId(planLeg.venueId);
      if (legVenue == null) throw new Error('plan-divergence');
      const q = await fetchConvertQuote(deps.relayUrl, planLeg.fromLedger, planLeg.toLedger, inRaw,
        {venue: legVenue});
      // The venue's echo must BE the plan figure — anything else is a different trade
      // than the plan frozen at confirm (the composed hub's own amount-echo gate).
      if (q.amountIn !== inRaw) throw new Error('amount-echo');
      // The quote must also BE the plan's own trade — the frozen venue, pool, and ordered
      // pair. A relay answer naming anything else is not this plan's leg: refuse, never
      // sign past the freeze.
      if (q.venueId !== planLeg.venueId || q.pool !== planLeg.pool
        || q.tokenInLedger !== planLeg.fromLedger || q.tokenOutLedger !== planLeg.toLedger) {
        throw new Error('plan-divergence');
      }
      if (q.zeroForOne == null) throw new Error('direction');
      const m = await deriveConvertMath(q, fromFee, outFee, rec.slippageBps);
      quotes.push(q);
      maths.push(m);
      const approveAmount = (BigInt(q.amountIn) + BigInt(m.inFee)).toString();
      const approveArgHex = await DpayCore.icpApproveArg(q.pool, '', '', approveAmount, '', allowanceExpiryNs, '', m.inFee);
      const approveSigned = await DpayCore.icpSignUpdate(deps.secretHex, planLeg.fromLedger, 'icrc2_approve', approveArgHex, envExpiry);
      legs.push({canister: planLeg.fromLedger, method: 'icrc2_approve', argHex: approveArgHex, envelopeHex: approveSigned.envelopeHex, requestIdHex: approveSigned.requestIdHex, expiresAtMs});
      legPlan.push({kind: 'approve', canister: planLeg.fromLedger, fee: m.inFee, state: 'pending'});
      const swapArgHex = await DpayCore.icpDepositAndSwapArg(q.amountIn, m.minOut, m.inFee, m.outFee, q.zeroForOne);
      const swapSigned = await DpayCore.icpSignUpdate(deps.secretHex, q.pool, 'depositFromAndSwap', swapArgHex, envExpiry);
      legs.push({canister: q.pool, method: 'depositFromAndSwap', argHex: swapArgHex, envelopeHex: swapSigned.envelopeHex, requestIdHex: swapSigned.requestIdHex, expiresAtMs});
      legPlan.push({kind: 'swap', canister: q.pool, fee: '', state: 'pending'});
      floor = m.minOut;
    }
    // All-or-nothing signing done — NOW the record rewrites to the PHASE-2 facts:
    // venueId becomes the IC pool the settlement probes key on; in* become the mid
    // asset; expected* become leg 1's own quote figures (a 2-leg plan's second quote
    // rides the hub fields the hub taxonomy already reads). Persistence is the CALLER's
    // (the provider hook's `apply`): the phase never double-writes.
    const twoLeg = cr.icLegs.length === 2;
    const q1 = quotes[0]!;
    const m1 = maths[0]!;
    const next: ConvertRecord = {
      ...rec,
      step: 'approving',
      venueId: q1.venueId,
      inLedger: midLedger,
      inSymbol: rec.hopSymbol ?? rec.outSymbol,
      inDecimals: rec.hopDecimals ?? rec.outDecimals,
      inCurrency: rec.hopCurrency,
      amountIn: q1.amountIn,
      expectedGross: q1.amountOutGross,
      expectedNet: m1.netOut,
      inFee: m1.inFee,
      outFee: m1.outFee,
      legs,
      legPlan,
      ...(twoLeg ? {
        expectedGross2: quotes[1]!.amountOutGross,
        expectedNet2: maths[1]!.netOut,
        feeMillionths2: quotes[1]!.feeMillionths,
      } : {}),
    };
    return next;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return failedPhase2(rec, deps, detail);
  }
}

/** The 1-leg phase-2 terminal: the planned executor's hub rule only resolves a SECOND
 *  swap's payout row; a single-swap plan parks at pending_withdrawal/all-confirmed. This
 *  hook probes the swap's own payout row and lands done (the SEEN amount) — or leaves the
 *  record for the engine's next re-arm. */
export async function resolveChainTerminal(rec: ConvertRecord, deps: ChainDriverDeps): Promise<ConvertRecord | null> {
  const cr = rec.chainRoute;
  if (cr == null || rec.legPlan == null || rec.legPlan.length === 0) return null;
  if (cr.icLegs.length !== 1) return null; // the 2-leg shape resolves through the hub rule
  if (!rec.legPlan.every(l => l.state === 'confirmed')) return null;
  if (rec.step === 'done' || rec.step === 'failed_leg' || rec.step === 'failed_refunded') return null;
  const myPrincipal = await DpayCore.icpPrincipalFromPubkey(deps.publicHex);
  const seen = await probeHopPayout({
    relayUrl: deps.relayUrl,
    publicHex: deps.publicHex,
    myPrincipalLower: myPrincipal.toLowerCase(),
    record: rec,
    swapLeg: 1,
  });
  if (seen == null) return null;
  return {...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx, destTx: seen.tx};
}

function failedPhase2(rec: ConvertRecord, _deps: ChainDriverDeps, detail: string): ConvertRecord {
  // Terminal, all-or-nothing: no partial legs persist, persistence is the caller's.
  return {
    ...rec,
    step: 'failed_leg',
    failureCode: 'unknown',
    failureDetail: `phase-2: ${detail}`.slice(0, 160),
  };
}
