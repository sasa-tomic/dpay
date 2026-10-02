/** stuckExpiry — the deadline resolution for stuck convert records (2026-10-02 POCO P0).
 *
 *  THE BUG: a record parked on `stuck` (outcome unknown) slow-probed forever, even after its
 *  signed leg window had expired — the screen claimed "nothing can move after the expiry"
 *  while the engine kept watching a window that could never produce anything, and the record
 *  never resolved. The founder's own copy states the truth: past the expiry NOTHING can move.
 *  Therefore an expired unknown is RESOLVABLE, and the engine must resolve it.
 *
 *  Money-safety first, conservative by construction:
 *  - Rule (a) an on-chain payout/refund row the probe SEES resolves as today (done /
 *    failed_refunded) — evidence outranks the deadline. Lives in the probe, unchanged.
 *  - Rule (b) expiry passed + still unknown + the unknown leg's input asset is VERIFIABLY
 *    still in the wallet (a ledger balance read) → `failed_refunded` + `window_closed`:
 *    the swap could not be confirmed before its window closed; nothing left the wallet.
 *  - Rule (c) expiry passed + still unknown + the input NOT verifiably present (moved
 *    elsewhere, or the balance is unreadable) → `failed_leg`: unconfirmed before the
 *    deadline; the wallet's balance display is the source of truth. NEVER a claim about
 *    WHERE the funds went — facts only.
 *  - No wall-clock expiry (a Solana leg dies at a block height, not at a clock) or an
 *    incomputable input target → NO resolution: the record keeps its honest watch.
 */
import type {ConvertRecord, LegKind} from './types';
import {railBalanceOf} from '../services/rail';

/** The wall-clock expiry the state panels already render (the `convert-expiry` line):
 *  the first signed leg's own ingress death; a chain phase-1 record's venue order window;
 *  else the record's creation. One owner so the engine and every panel agree. */
export function recordLegExpiryMs(rec: ConvertRecord): number {
  return rec.legs[0]?.expiresAtMs ?? rec.chainRoute?.expiresAtMs ?? rec.createdAtMs;
}

/** True when the record's signed window has PASSED and the expiry resolution therefore
 *  applies (IC envelopes only — a Solana leg's death is a block height, never a clock).
 *  This is the "keep slow-probing ONLY while the window is open" gate, shared by the
 *  engine's drive arm, its re-arm and the acknowledge path. */
export function stuckExpiryDue(rec: ConvertRecord, nowMs: number = Date.now()): boolean {
  if (rec.legs.length === 0 || rec.solanaLeg != null) return false;
  return nowMs > recordLegExpiryMs(rec);
}

const digits = (s: string | undefined): string | null =>
  s != null && /^\d+$/.test(s) ? s : null;

/** Which asset the unknown leg would have pulled, and how much of it proves "nothing left
 *  the wallet": the ledger to read and the raw-unit threshold the balance must still cover.
 *  Thresholds err HIGH (an over-estimate of the pull biases toward the more cautious
 *  failed_leg, never toward a false "nothing left"). Null = the record does not carry the
 *  facts to name the input — no resolution, keep watching (never guess about money). */
export function stuckInputTarget(rec: ConvertRecord): {ledger: string; thresholdRaw: string} | null {
  // Direct shape (no leg plan): stuck is parked from an approve or swap unknown — the
  // approve moves nothing and the swap pulls exactly amountIn off the input ledger.
  if (rec.legPlan == null) {
    const amountIn = digits(rec.amountIn);
    return rec.inLedger !== '' && amountIn != null ? {ledger: rec.inLedger, thresholdRaw: amountIn} : null;
  }
  const i = rec.legPlan.findIndex(l => l.state !== 'confirmed');
  if (i < 0) return null;
  const lp = rec.legPlan[i]!;
  const kind: LegKind = lp.kind;
  const leg = rec.legs[i];
  const preLegCount = rec.gasPre != null ? rec.gasPre.legs.length * 2 : 0;
  if (kind === 'approve' || kind === 'approve_gas') {
    // An approval never moves funds — any readable balance proves the input stayed.
    if (leg == null || leg.canister === '') return null;
    return {ledger: leg.canister, thresholdRaw: '0'};
  }
  if (kind === 'swap') {
    if (i < preLegCount) {
      const p = rec.gasPre?.legs[Math.floor(i / 2)];
      const inAmount = digits(p?.inAmount);
      return p != null && p.fromLedger !== '' && inAmount != null ? {ledger: p.fromLedger, thresholdRaw: inAmount} : null;
    }
    const ordinal = rec.legPlan.slice(preLegCount, i).filter(l => l.kind === 'swap').length;
    if (ordinal === 0) {
      const amountIn = digits(rec.amountIn);
      return rec.inLedger !== '' && amountIn != null ? {ledger: rec.inLedger, thresholdRaw: amountIn} : null;
    }
    // A second (hub) swap pulls the HOP asset — at most the gross swap-1 paid out.
    const ledger = rec.hopLedger ?? rec.outLedger;
    const gross = digits(rec.expectedGross);
    return ledger != null && ledger !== '' && gross != null ? {ledger, thresholdRaw: gross} : null;
  }
  if (kind === 'deposit_transfer') {
    const cd = rec.composedDeposit;
    const amountRaw = digits(cd?.amountRaw);
    const fee = digits(cd?.fee ?? '0');
    if (leg == null || leg.canister === '' || amountRaw == null || fee == null) return null;
    return {ledger: leg.canister, thresholdRaw: (BigInt(amountRaw) + BigInt(fee)).toString()};
  }
  // Burn-side legs (withdraw_erc20, cctp_burn, sol_swap) pull the HOP asset — at most the
  // gross the swap paid. A missing fact means no resolution, never a guess.
  const ledger = rec.hopLedger ?? rec.outLedger;
  const gross = digits(rec.expectedGross);
  return ledger != null && ledger !== '' && gross != null ? {ledger, thresholdRaw: gross} : null;
}

/** The failureDetail facts the two resolutions freeze onto the record. Machine facts in
 *  English (the executor's own failureDetail convention); the panels render them verbatim
 *  — never hidden — and the localized bodies carry the user-facing copy. */
export const STUCK_WINDOW_DETAIL_HELD = 'swap unconfirmed when its signed window expired - nothing left the wallet';
export const STUCK_WINDOW_DETAIL_MOVED = 'swap unconfirmed when its signed window expired - your balance is the source of truth';

/** The expiry resolution itself (engine call): null = not resolvable now (window open, no
 *  wall-clock window, or the input cannot be named) — the record keeps its watch. */
export async function resolveExpiredStuck(
  rec: ConvertRecord,
  nowMs: number,
  readBalance: (ledger: string) => Promise<string | null>,
): Promise<ConvertRecord | null> {
  if (!stuckExpiryDue(rec, nowMs)) return null;
  const target = stuckInputTarget(rec);
  if (target == null) return null;
  const bal = await readBalance(target.ledger).catch(() => null);
  if (bal != null && /^\d+$/.test(bal) && BigInt(bal) >= BigInt(target.thresholdRaw)) {
    return {...rec, step: 'failed_refunded', failureCode: 'window_closed', failureDetail: STUCK_WINDOW_DETAIL_HELD};
  }
  return {...rec, step: 'failed_leg', failureCode: 'unknown', failureDetail: STUCK_WINDOW_DETAIL_MOVED};
}

/** Test/live seam default: the real signed ledger balance read. */
export function readLedgerBalance(secretHex: string): (ledger: string) => Promise<string | null> {
  return (ledger: string) => railBalanceOf(secretHex, ledger);
}
