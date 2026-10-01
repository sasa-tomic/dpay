// The one-tap ATA setup planner (2026-09-30) — the DECISION half of the founder gap
// "EUR (EURC) says that a setup is needed -> complete that setup as soon as user adds funds
// to any currency, by swapping + completing the setup".
//
// PURE: no React, no network, no clocks. Deterministic in (targets, solBalance, sources,
// icSources) plus the STATIC venue registry (config/venues - compiled data, no fetch). Entry
// points:
//
//   planAtaSetup   - which of the five verdicts holds:
//                      {kind:'none'}    nothing is absent; there is no setup.
//                      {kind:'create'}  the SOL balance already covers every absent account's
//                                       rent + fee: create them, no swap.
//                      {kind:'fund'}    SOL is short, but a MEASURED, funded SPL token has a
//                                       registered solana_amm venue pairing its mint with the
//                                       wrapped-SOL mint: swap a little of it into native SOL
//                                       first (sized by `sizeAtaFundPlan`), then create.
//                      {kind:'fund-ic'} SOL is short, no usable SPL source, but the wallet
//                                       holds MEASURED IC-side money (founder override
//                                       2026-09-30, retiring the old IC exclusion): the
//                                       executor walks the convert engine's own cross-rail
//                                       route to SOL (a registered CeFi venue behind the IC
//                                       legs) and sizes it with `sizeAtaIcFundPlan`.
//                      {kind:'refuse'}  nothing in the wallet can pay for the setup. The honest
//                                       dead end: the UI shows the needSol copy and the device's
//                                       SOL address. NEVER a forced losing swap.
//
//   sizeAtaFundPlan - the SPL executor's sizing walk over a fund plan, with the Jupiter quotes
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
//   sizeAtaIcFundPlan - the fund-ic twin, same discipline over the IC candidates: per
//                     candidate, quote the full balance into SOL through the caller's seam
//                     (the convert engine's own quote path for that source's cross-rail
//                     route). A venue that answers with its own below-minimum refusal hands
//                     back the minimum input: a wallet that cannot reach it is skipped for
//                     the next candidate; one that can swaps AT the minimum when it already
//                     covers (the smallest honest input), else shrinks to the shortfall -
//                     never below the venue minimum, never past the balance. Null = no
//                     candidate can reach the target: the caller falls through to refuse.
//
// Funding sources are in-wallet money only, and every swap is the USER's own signed
// conversion over a REGISTERED venue - the no-custody/no-cut red lines are inherited from
// the convert engine, never re-stated here.

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

/** An IC-side funding candidate (fund-ic): a funded IC-ledger asset the convert engine's own
 *  cross-rail route can carry into SOL. Pure data - `currencyKey` is the wallet's stable asset
 *  id (`ic:<currency>`); the executor resolves the catalog row and the route against it. */
export type AtaIcFundSource = {currencyKey: string; symbol: string; decimals: number; rawAmount: string};

export type AtaSetupPlan =
  | {kind: 'none'}
  | {kind: 'create'; mints: string[]; costLamports: string}
  | {kind: 'fund'; mints: string[]; costLamports: string; targetLamports: string; candidates: AtaFundSource[]}
  | {kind: 'fund-ic'; mints: string[]; costLamports: string; targetLamports: string; candidates: AtaIcFundSource[]}
  | {kind: 'refuse'};
// HARD RULE for new kinds (2026-09-30 defect, never again): every kind a wallet can receive
// must render an ACTIONABLE next step in AtaSetupCard (a working button, or refuse's two
// escapes). The v1 'refuse' reached the screen as explains-only instructions with no
// affordance. A kind without a wired action is a bug: fix the card and pin it in
// AtaSetupCard.test.tsx / HomeAccounts.test.tsx before shipping.

/** The proven-unfundable flip: the fund-ic sizing or the swap's own floor check answered that
 *  no IC candidate can reach the target. The banner trades the doomed retry button for the
 *  refuse panel - the honest dead end that carries the SOL receive address with its copy
 *  affordance. Only fund-ic flips: a fund plan's SPL source stays retryable (top up the same
 *  asset), and create/none/refuse have no swap to give up on. */
export function ataPlanAfterFundShort<P extends AtaSetupPlan>(plan: P): P | {kind: 'refuse'} {
  return plan.kind === 'fund-ic' ? {kind: 'refuse'} : plan;
}

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
  /** The wallet's funded IC-side assets (pure data, registry/matrix order). Absent = none. */
  icSources?: AtaIcFundSource[];
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
  if (candidates.length > 0) {
    return {
      kind: 'fund',
      mints,
      costLamports: cost.toString(),
      // The TOTAL SOL the wallet must hold after the funding swap (the shortfall is the
      // sizer's subtraction - the plan states the wallet-level requirement once).
      targetLamports: (cost + ATA_FUND_BUFFER_LAMPORTS).toString(),
      candidates,
    };
  }
  // The fund-ic branch (founder override 2026-09-30): no usable SPL source, but the wallet
  // holds measured IC-side money. The candidates are the caller's registry-ordered list,
  // re-checked defensively here - only a measured positive balance is a candidate, the same
  // bar the SPL walk applies.
  const icCandidates: AtaIcFundSource[] = [];
  for (const c of args.icSources ?? []) {
    const amount = rawDigits(c.rawAmount);
    if (amount == null || amount <= 0n) continue;
    icCandidates.push({...c, rawAmount: amount.toString()});
  }
  if (icCandidates.length === 0) return {kind: 'refuse'};
  return {
    kind: 'fund-ic',
    mints,
    costLamports: cost.toString(),
    targetLamports: (cost + ATA_FUND_BUFFER_LAMPORTS).toString(),
    candidates: icCandidates,
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

/** One IC candidate's quoted sizing: the input to swap and the venue's SOL floor at it. */
export type SizedAtaIcFund = {source: AtaIcFundSource; inAmount: string; outFloor: string};

/** The injected quote seam's answer for one IC candidate. `quote` carries the venue's own
 *  SOL-out figure at the asked input; `belowMin` carries the venue's own published minimum
 *  INPUT (raw candidate units) when it refused the amount. Null = unquotable (no market, no
 *  route, venue unreachable) - the candidate is skipped, never a crash. */
export type AtaIcQuote =
  | {kind: 'quote'; outLamports: string}
  | {kind: 'belowMin'; minInRaw: string};

/**
 * Size a fund-ic plan against (injected) live quotes - the `sizeAtaFundPlan` discipline over
 * the IC candidates. `solKnown` is the wallet's CURRENT SOL: it counts toward the target, so
 * the swap only covers the shortfall + buffer. Per candidate: a below-minimum refusal names
 * the venue's own minimum - a wallet that cannot reach it is skipped for the next candidate;
 * one that can re-quotes at the minimum. A quoted input whose SOL floor covers the target is
 * then shrunk toward the shortfall-equivalent (+5% margin), never below the venue minimum and
 * never past the balance. First deliverable candidate wins; null = no candidate can reach the
 * target - the caller falls through to the honest refusal, never a forced losing swap.
 */
export async function sizeAtaIcFundPlan(args: {
  plan: Extract<AtaSetupPlan, {kind: 'fund-ic'}>;
  solKnown: string | null;
  quote: (source: AtaIcFundSource, inRaw: string) => Promise<AtaIcQuote | null>;
}): Promise<SizedAtaIcFund | null> {
  const {plan, quote} = args;
  const sol = rawDigits(args.solKnown) ?? 0n;
  const target = BigInt(plan.targetLamports);
  const swapNeeded = target > sol ? target - sol : 0n;
  if (swapNeeded === 0n) return null; // nothing to fund - the caller should have re-planned
  for (const source of plan.candidates) {
    const balance = rawDigits(source.rawAmount);
    if (balance == null || balance <= 0n) continue;
    let input = balance; // the walk starts at the whole balance and only ever shrinks
    let venueMin = 0n;
    let best: SizedAtaIcFund | null = null;
    for (let k = 0; k < 6; k += 1) {
      const q = await quote(source, input.toString());
      if (q == null) break; // unquotable at this size - the next candidate's turn
      if (q.kind === 'belowMin') {
        const min = rawDigits(q.minInRaw);
        if (min == null || min <= 0n) break;
        if (balance < min) break; // the wallet cannot reach the venue minimum - next candidate
        venueMin = min;
        input = min;
        continue; // re-quote AT the venue's own minimum
      }
      const floor = rawDigits(q.outLamports);
      if (floor == null) break;
      if (floor + sol < swapNeeded) break; // under target at this input - a smaller one never covers either
      best = {source, inAmount: input.toString(), outFloor: floor.toString()};
      if (venueMin > 0n && input === venueMin) break; // at the venue minimum: the smallest honest input
      const scaled = floor === 0n ? input : (input * swapNeeded * 105n) / (floor * 100n) + 1n;
      const clamped = scaled < venueMin ? venueMin : scaled;
      if (clamped >= input) break; // converged at the floor's own resolution
      input = clamped;
    }
    if (best != null) return best;
  }
  return null;
}

// The latch key for the banner's one-way verdicts (the fundShort refuse flip): a VALUE
// signature of the plan, never the model's object identity. The model is a useMemo over
// polled balances, so its identity churns on every real balance write even when nothing
// about the plan moved - an identity-keyed reset silently wiped a proven verdict on a live
// device (refuse flashed, a poll re-created the model, the banner re-armed its button).
// Equal-value models MUST produce equal signatures; only a plan whose semantics genuinely
// moved may re-ask the question. Pinned by ataSetup.test.ts and flow 214's churn arm.
export function ataPlanSignature(model: {plan: AtaSetupPlan; targets: readonly unknown[]; costLine: string}): string {
  return JSON.stringify({kind: model.plan.kind, plan: model.plan, targets: model.targets, cost: model.costLine});
}
