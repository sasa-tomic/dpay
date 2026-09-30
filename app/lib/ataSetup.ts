// The one-tap ATA setup planner (2026-09-30) — the DECISION half of the founder gap
// "EUR (EURC) says that a setup is needed -> complete that setup as soon as user adds funds
// to any currency, by swapping + completing the setup".
//
// PURE: no React, no network, no clocks. Deterministic in (targets, solBalance, sources) plus
// the STATIC venue registry (config/venues — compiled data, no fetch). Two entry points:
//
//   planAtaSetup   — which of the four verdicts holds:
//                      {kind:'none'}    nothing is absent; there is no setup.
//                      {kind:'create'}  the SOL balance already covers every absent account's
//                                       rent + fee: create them, no swap.
//                      {kind:'fund'}    SOL is short, but a MEASURED, funded SPL token has a
//                                       registered solana_amm venue pairing its mint with the
//                                       wrapped-SOL mint: swap a little of it into native SOL
//                                       first (sized by `sizeAtaFundPlan`), then create.
//                      {kind:'refuse'}  nothing in the wallet can pay for the setup. The honest
//                                       dead end: the UI shows the needSol copy and the device's
//                                       SOL address. NEVER a forced losing swap.
//
//   sizeAtaFundPlan — the executor's sizing walk over a fund plan, with the Jupiter quotes
//                     INJECTED (the caller owns the network seam, so this stays testable):
//                     per candidate, quote the full balance into wrapped SOL; the venue's own
//                     floor (`otherAmountThreshold`) plus the SOL already held must reach the
//                     plan's target — a smaller input never covers either, so a full-balance
//                     shortfall skips the candidate — otherwise shrink-to-fit the smallest
//                     input whose floor still covers (≤4 re-quotes, +5% margin), exactly the
//                     proven `resolveGasFundRoute` discipline. First deliverable candidate
//                     wins (the candidates are few: every funded token with a wrapped-SOL
//                     venue); null = nothing in the wallet can reach the target.
//
// SCOPE BOUNDARY (deliberate): only in-wallet SPL tokens over registered solana_amm venues
// are funding sources. IC-ledger and CeFi routes are OUT: their venue minimums exceed the
// ~0.002 SOL target by orders of magnitude, so the walk would refuse them anyway — naming
// them as candidates would manufacture a failure the wallet need not have. A wallet that
// holds ONLY IC-side money gets the honest refusal (needSol + the SOL address), the same
// escape the receive/send sheets have always offered.

import {registeredVenues} from '../config/venues';
import {SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

/** One wallet SPL-token fact the planner reads. Structurally the balance hook's per-mint state
 *  (`useSolanaBalances`'s token shape) without any import of it — this module stays pure. */
export type AtaSetupTokenInput = {
  mint: string;
  symbol: string;
  decimals?: number;
  /** Raw smallest-unit amount, when one was measured. Null = never read / unreadable. */
  amount?: string | null;
  status: 'loading' | 'absent' | 'balance' | 'unavailable' | 'error';
};

/** A funding candidate: a funded SPL token a registered venue can swap into native SOL. */
export type AtaFundSource = {mint: string; symbol: string; decimals: number; rawAmount: string};

export type AtaSetupPlan =
  | {kind: 'none'}
  | {kind: 'create'; mints: string[]; costLamports: string}
  | {kind: 'fund'; mints: string[]; costLamports: string; targetLamports: string; candidates: AtaFundSource[]}
  | {kind: 'refuse'};

/** The swap's own fee buffer: the funding transaction's signature fee plus one signature of
 *  margin, so the wallet lands ABOVE the setup floor, never exactly on it. The create fees
 *  themselves are already inside `costLamports` (per-mint rent + fee). */
export const ATA_FUND_BUFFER_LAMPORTS = 2n * SOL_FEE_LAMPORTS;

/** Registered solana_amm venues pairing `mint` with wrapped SOL, registry order (never ranked). */
function wrappedSolVenuesFor(mint: string): boolean {
  return registeredVenues().some(v =>
    v.kind === 'solana_amm' && !v.testnet
    && v.pair_ledgers.includes(mint) && v.pair_ledgers.includes(WRAPPED_SOL_MINT_ADDRESS),
  );
}

const rawDigits = (v: string | null | undefined): bigint | null =>
  v != null && /^\d+$/.test(v) ? BigInt(v) : null;

/**
 * The plan, total: every input answers, nothing throws. `targets` are the wallet's SPL rails
 * (their known states), `sources` the funded SPL tokens (status 'balance', positive amount —
 * the caller applies that filter; the planner re-checks defensively). An UNMEASURED SOL
 * balance is treated as zero: it never blocks the fund branch (the sizing re-checks live at
 * execute time) and never fakes a create.
 */
export function planAtaSetup(args: {
  targets: AtaSetupTokenInput[];
  solBalance: string | null;
  sources: AtaSetupTokenInput[];
}): AtaSetupPlan {
  const {solBalance} = args;
  const mints = args.targets.filter(t => t.status === 'absent').map(t => t.mint);
  if (mints.length === 0) return {kind: 'none'};
  const cost = BigInt(mints.length) * SOL_ATA_SETUP_MIN_LAMPORTS;
  const sol = rawDigits(solBalance);
  if (sol != null && sol >= cost) return {kind: 'create', mints, costLamports: cost.toString()};
  const candidates: AtaFundSource[] = [];
  for (const s of args.sources) {
    if (s.status !== 'balance') continue;
    const amount = rawDigits(s.amount ?? null);
    if (amount == null || amount <= 0n) continue;
    if (!wrappedSolVenuesFor(s.mint)) continue; // no venue can swap it into SOL — not a candidate
    candidates.push({mint: s.mint, symbol: s.symbol, decimals: s.decimals ?? 0, rawAmount: amount.toString()});
  }
  if (candidates.length === 0) return {kind: 'refuse'};
  return {
    kind: 'fund',
    mints,
    costLamports: cost.toString(),
    // The TOTAL SOL the wallet must hold after the funding swap (the shortfall is the
    // sizer's subtraction — the plan states the wallet-level requirement once).
    targetLamports: (cost + ATA_FUND_BUFFER_LAMPORTS).toString(),
    candidates,
  };
}

/** One candidate's quoted sizing: the input to swap and the venue floor it guarantees. */
export type SizedAtaFund = {source: AtaFundSource; inAmount: string; outFloor: string};

/**
 * Size a fund plan against (injected) live quotes. `solKnown` is the wallet's CURRENT SOL —
 * it counts toward the target, so the swap only covers the shortfall + buffer. Walks the
 * plan's candidates in order; the first candidate whose full balance can reach the target is
 * shrunk to the smallest input whose venue floor still covers it. Null = no candidate can
 * reach the target (or none quoted): the caller refuses honestly — never a forced swap.
 */
export async function sizeAtaFundPlan(args: {
  plan: Extract<AtaSetupPlan, {kind: 'fund'}>;
  solKnown: string | null;
  /** The live quote seam. Null return = unquotable (venue refused / minimum too small /
   *  unreachable) — the candidate is skipped, not a crash. */
  quote: (source: AtaFundSource, inRaw: string) => Promise<{outAmount: string; otherAmountThreshold: string} | null>;
}): Promise<SizedAtaFund | null> {
  const {plan, quote} = args;
  const sol = rawDigits(args.solKnown) ?? 0n;
  const target = BigInt(plan.targetLamports);
  const swapNeeded = target > sol ? target - sol : 0n;
  if (swapNeeded === 0n) return null; // nothing to fund — the caller should have re-planned
  for (const source of plan.candidates) {
    const balance = rawDigits(source.rawAmount);
    if (balance == null || balance <= 0n) continue;
    let input = balance;
    let best: SizedAtaFund | null = null;
    for (let k = 0; k < 4; k += 1) {
      const q = await quote(source, input.toString());
      if (q == null) break; // unquotable at this size — the next candidate's turn
      const floor = rawDigits(q.otherAmountThreshold);
      if (floor == null) break;
      if (floor + sol < swapNeeded) break; // under target — a smaller input never covers either
      best = {source, inAmount: input.toString(), outFloor: floor.toString()};
      const scaled = floor === 0n ? input : (input * swapNeeded * 105n) / (floor * 100n) + 1n;
      if (scaled >= input) break; // converged at the floor's own resolution
      input = scaled;
    }
    if (best != null) return best;
  }
  return null;
}
