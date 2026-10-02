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
//                     EVERY candidate is sized (the seam's SOL output is the one comparable
//                     unit - never a raw cross-token balance ranking, the no-FX-quote red
//                     line), and the winner is picked by QUOTE FITNESS: highest SOL floor,
//                     then the smallest input at an equal floor, the caller's registry order
//                     as the final tie-break - the exact policy the convert surface's
//                     computeAutoPick canonizes.
//
//   sizeAtaIcFundPlan - the fund-ic twin, same fitness over the IC candidates: per candidate,
//                     quote the full balance into SOL through the caller's seam (the convert
//                     engine's own quote path for that source's routes to SOL - every cefi
//                     venue and every composed route, resolved by the seam). A venue that
//                     answers with its own below-minimum refusal hands back the minimum input:
//                     a wallet that cannot reach it is skipped for the next candidate; one
//                     that can swaps AT the minimum when it already covers (the smallest
//                     honest input), else shrinks to the shortfall - never below the venue
//                     minimum, never past the balance. Null = no candidate can reach the
//                     target: the caller falls through to refuse.
//
// Funding sources are in-wallet money only, and every swap is the USER's own signed
// conversion over a REGISTERED venue - the no-custody/no-cut red lines are inherited from
// the convert engine, never re-stated here.

import {registeredVenues} from '../config/venues';
import {icpCatalogOf, BUNDLED_NETWORKS} from '../config/catalog';
import {M} from '../i18n';
import {SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {isTerminalConvertStep, type ConvertStep} from '../convert/types';
import {bytesToHex} from '@noble/hashes/utils';
import {utf8ToBytes} from './base64url';

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
 *  id (`ic:<currency>`); the executor resolves every registered route against it. */
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
 * execute time) and never fakes a create. Candidates keep the CALLER's order - it is tie-break
 * data for the fitness pick, never a ranking (quote fitness decides, 2026-10-01).
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
  // holds measured IC-side money. The candidates are the caller's list in the caller's order
  // (tie-break data only - quote fitness decides the winner, never list position), re-checked
  // defensively here: only a measured positive balance is a candidate, the same bar the SPL
  // walk applies.
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
 * it counts toward the target, so the swap only covers the shortfall + buffer. EVERY
 * candidate is sized (the seam's SOL output is the one comparable unit - never a raw
 * cross-token balance ranking, the no-FX-quote red line), and the winner is picked by QUOTE
 * FITNESS: highest SOL floor, then the smallest input at an equal floor, the caller's
 * registry order as the final tie-break - the exact policy the convert surface's
 * computeAutoPick canonizes. Null = no candidate can reach the target (or none quoted): the
 * caller refuses honestly — never a forced swap.
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
  // QUOTE FITNESS (2026-10-01 audit F1-F2): size every candidate, keep the fittest. The walk
  // order is the caller's (the tie-break), never a ranking.
  let best: SizedAtaFund | null = null;
  for (const source of plan.candidates) {
    const balance = rawDigits(source.rawAmount);
    if (balance == null || balance <= 0n) continue;
    let input = balance;
    let sized: SizedAtaFund | null = null;
    for (let k = 0; k < 4; k += 1) {
      const q = await quote(source, input.toString());
      if (q == null) break; // unquotable at this size — the next candidate's turn
      const floor = rawDigits(q.otherAmountThreshold);
      if (floor == null) break;
      if (floor + sol < swapNeeded) break; // under target — a smaller input never covers either
      sized = {source, inAmount: input.toString(), outFloor: floor.toString()};
      const scaled = floor === 0n ? input : (input * swapNeeded * 105n) / (floor * 100n) + 1n;
      if (scaled >= input) break; // converged at the floor's own resolution
      input = scaled;
    }
    if (sized == null) continue;
    if (best == null
      || BigInt(sized.outFloor) > BigInt(best.outFloor)
      || (BigInt(sized.outFloor) === BigInt(best.outFloor) && BigInt(sized.inAmount) < BigInt(best.inAmount))) {
      best = sized;
    }
  }
  return best;
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
 * Size a fund-ic plan against (injected) live quotes - the `sizeAtaFundPlan` fitness over
 * the IC candidates. `solKnown` is the wallet's CURRENT SOL: it counts toward the target, so
 * the swap only covers the shortfall + buffer. EVERY candidate is sized: a below-minimum
 * refusal names the venue's own minimum - a wallet that cannot reach it is skipped for the
 * next candidate; one that can re-quotes at the minimum. A quoted input whose SOL floor
 * covers the target is then shrunk toward the shortfall-equivalent (+5% margin), never below
 * the venue minimum and never past the balance. The winner is picked by QUOTE FITNESS -
 * highest SOL floor, then the smallest input at an equal floor, the caller's registry order
 * as the final tie-break; null = no candidate can reach the target - the caller falls
 * through to the honest refusal, never a forced losing swap.
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
  // QUOTE FITNESS (2026-10-01 audit F1-F2): size every candidate, keep the fittest. The walk
  // order is the caller's (the tie-break), never a ranking; the seam's own SOL output is the
  // one comparable unit across candidates.
  let best: SizedAtaIcFund | null = null;
  for (const source of plan.candidates) {
    const balance = rawDigits(source.rawAmount);
    if (balance == null || balance <= 0n) continue;
    let input = balance; // the walk starts at the whole balance and only ever shrinks
    let venueMin = 0n;
    let sized: SizedAtaIcFund | null = null;
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
      sized = {source, inAmount: input.toString(), outFloor: floor.toString()};
      if (venueMin > 0n && input === venueMin) break; // at the venue minimum: the smallest honest input
      const scaled = floor === 0n ? input : (input * swapNeeded * 105n) / (floor * 100n) + 1n;
      const clamped = scaled < venueMin ? venueMin : scaled;
      if (clamped >= input) break; // converged at the floor's own resolution
      input = clamped;
    }
    if (sized == null) continue;
    if (best == null
      || BigInt(sized.outFloor) > BigInt(best.outFloor)
      || (BigInt(sized.outFloor) === BigInt(best.outFloor) && BigInt(sized.inAmount) < BigInt(best.inAmount))) {
      best = sized;
    }
  }
  return best;
}

/** One route's FRESH answer at the confirmed input, reduced for the confirm-time verdict. */
export type AtaRouteAnswer =
  | {kind: 'quoted'; settleRaw: string}
  | {kind: 'belowMin'; minInRaw: string}
  | {kind: 'dead'};

/** What the confirm press does next, decided ONLY from the confirmed candidate's fresh
 *  answers (2026-10-02 live-trip fix): sign the best covering route; RE-CONFIRM when every
 *  route refused below-minimum but the balance still covers the most permissive fresh
 *  minimum (a fresh sized plan is shown, the user confirms again); refuse honestly
 *  otherwise. There is no verdict that names a symbol - the caller's message carries the
 *  CONFIRMED source, never a foreign candidate. */
export type AtaConfirmVerdict =
  | {kind: 'sign'; routeIndex: number}
  | {kind: 'reconfirm'; minInRaw: string}
  | {kind: 'refuse'; reason: 'cannot-cover' | 'below-min' | 'no-route'};

/**
 * Reduce the confirmed candidate's fresh route answers to the confirm-time verdict. `sign`
 * picks the highest settle with the answers' order as the tie-break (the caller enumerates
 * routes in registry order - the computeAutoPick canon). A best settle that cannot cover
 * the target (plus SOL already held) refuses `cannot-cover` - never a doomed order. Every
 * route answering below-minimum reduces to the MOST PERMISSIVE minimum: the balance covers
 * it → `reconfirm` (the fresh sizing re-walks all candidates with the sizer's skip
 * semantics); it cannot → `refuse below-min`. No live answer at all → `refuse no-route`.
 */
export function ataConfirmPlan(args: {
  answers: AtaRouteAnswer[];
  targetLamports: string;
  solKnown: string | null;
  balanceRaw: string;
}): AtaConfirmVerdict {
  const sol = rawDigits(args.solKnown) ?? 0n;
  const target = rawDigits(args.targetLamports) ?? 0n;
  let best = -1;
  let bestSettle = -1n;
  let minMin: bigint | null = null;
  for (let i = 0; i < args.answers.length; i += 1) {
    const a = args.answers[i]!;
    if (a.kind === 'dead') continue;
    if (a.kind === 'belowMin') {
      const min = rawDigits(a.minInRaw);
      if (min != null && min > 0n && (minMin == null || min < minMin)) minMin = min;
      continue;
    }
    const settle = rawDigits(a.settleRaw);
    if (settle == null || settle <= bestSettle) continue;
    bestSettle = settle;
    best = i;
  }
  if (best >= 0) {
    if (bestSettle + sol < target) return {kind: 'refuse', reason: 'cannot-cover'};
    return {kind: 'sign', routeIndex: best};
  }
  if (minMin != null) {
    const balance = rawDigits(args.balanceRaw) ?? 0n;
    return balance >= minMin ? {kind: 'reconfirm', minInRaw: minMin.toString()} : {kind: 'refuse', reason: 'below-min'};
  }
  return {kind: 'refuse', reason: 'no-route'};
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

/**
 * The setup card's error line for a TERMINAL engine record (2026-10-01 founder directive:
 * errors are REAL): the record's own failureDetail is the line - the venue's or chain's
 * actual cause, verbatim. Only when the engine recorded no cause does a generic copy speak:
 * 'stuck' (outcome unknown) maps to swapUnknown, everything else to swapFailed. One line,
 * never a bare "you can try again".
 */
export function ataRecordErrLine(rec: {step: string; failureDetail?: string}): string {
  const detail = typeof rec.failureDetail === 'string' ? rec.failureDetail.trim() : '';
  if (detail.length > 0) return detail;
  return rec.step === 'stuck' ? M.deposit.ata.swapUnknown : M.deposit.ata.swapFailed;
}

/** The direct-cefi fund-ic deposit (2026-10-02 live-trip fix). A legless provider record lands at
 *  `awaiting_deposit` by design - the venue holds the funds mid-trade and the resume engine's
 *  provider driver ONLY polls the venue; the IC-side deposit transfer is the value movement. The
 *  one-tap runner must therefore send that deposit ITSELF with the device key (an order nobody
 *  funds just expires). Wallet-side seam injection keeps this pure and jest-drivable.
 *
 *  Outcomes:
 *    sent          - the ledger accepted the deposit (blockIndex = evidence); the provider poll
 *                    owns the wait from here.
 *    not-applicable - the record takes a non-IC input or names no deposit target: the caller
 *                    moves on (other record kinds have their own drivers).
 *    unknown       - the envelope's fate is unproven: the record STANDS at awaiting_deposit (the
 *                    venue is the source of truth; identical-byte resubmit is the only safe
 *                    retry and it is NOT attempted here).
 *  A definitive ledger/destination refusal THROWS tagged {ataDepositRefused: reason} - the real
 *  words reach the card, the record stays at awaiting_deposit (expired unused, no money moved),
 *  and a retry means a fresh confirm with a fresh order. */
export type CefiDepositOutcome =
  | {kind: 'sent'; blockIndex: string}
  | {kind: 'not-applicable'}
  | {kind: 'unknown'};

export type CefiDepositRecord = {
  // `undefined` rides the store's absent-field hydration (ConvertRecord stores another-rail
  // inputs as absent); `null` is the explicit other-rail spelling. Both mean not-applicable.
  inCurrency?: number | null;
  amountIn: string;
  providerDeposit?: {depositAddress?: string; depositMemo?: string} | null;
};

/**
 * The record-lifecycle deposit predicate (2026-10-02 P0). TRUE exactly when a convert record
 * sits NON-TERMINAL at `awaiting_deposit` with an IC-source deposit nobody has taken yet: the
 * record names an IC catalog currency it was funded from (`inCurrency`), the venue issued a
 * deposit target (`providerDeposit.depositAddress`), and the once-only marker
 * (`depositSentAtMs`) is absent. This is the watcher's test for "this record's cefi deposit
 * still needs sending" — the gate that recovers the direct-cefi AND composed record families
 * from unknown polls, resume handoffs, and app restarts. A taken deposit is never outstanding
 * again (the persisted marker survives restarts); `provider_processing` and every terminal
 * step belong to the venue poll, never the deposit sender.
 */
export function cefiDepositOutstanding(rec: CefiDepositRecord & {step: ConvertStep; depositSentAtMs?: number}): boolean {
  if (rec.step !== 'awaiting_deposit' || isTerminalConvertStep(rec.step)) return false;
  if (rec.depositSentAtMs != null) return false;
  if (rec.inCurrency == null) return false;
  const to = rec.providerDeposit?.depositAddress;
  return typeof to === 'string' && to.length > 0;
}

export type CefiDepositDeps = {
  catalog: {currencies: Array<{currency: number; ledger: string; fee: string | null}>};
  secretHex: string;
  prepareTransfer: (secretHex: string, catalog: {currencies: Array<{currency: number; ledger: string; fee: string | null}>}, req: {toAccount: string; amount: string; currency: number; nonceHex: string}) => Promise<{ledger: string; envelopeHex: string; requestIdHex: string}>;
  prepareLegacyTransfer: (secretHex: string, req: {ledger: string; toAccountId: string; amountE8s: string; feeE8s: string}) => Promise<{ledger: string; envelopeHex: string; requestIdHex: string}>;
  // The legacy `transfer` reply carries the LEGACY tag set (TxDuplicate, TxTooOld, ...) - the
  // ICRC-1 default decoder throws 'DIDL decode error' on it (live 2026-10-02: the transfer
  // landed, the decode threw, the run aborted with a red line over money that had moved).
  decodeLegacyReply: (replyArgHex: string) => Promise<{ok: boolean; blockIndex?: string | null; errVariant?: string | null; errDetail?: string | null}>;
  submitTransfer: (prepared: {ledger: string; envelopeHex: string; requestIdHex: string}, pollerSecret: string, opts: {attempts: number; intervalMs: number}, decodeReply?: (replyArgHex: string) => Promise<{ok: boolean; blockIndex?: string | null; errVariant?: string | null; errDetail?: string | null}>) => Promise<{kind: 'settled'; blockIndex: string} | {kind: 'rejected'; reason: string; variant?: string} | {kind: 'unknown'}>;
};

// The legacy `transfer` (64-hex account identifiers) is ICP-mainnet-only - the same
// single-truth derivation prepare.ts uses for its deposit leg.
const ICP_MAINNET_LEDGER = icpCatalogOf(BUNDLED_NETWORKS).find(c => c.currency === 8 && !c.testnet)?.ledger ?? '';
const LEGACY_ACCOUNT_ID = /^[0-9a-fA-F]{64}$/;

export async function sendCefiDepositForRecord(rec: CefiDepositRecord, deps: CefiDepositDeps): Promise<CefiDepositOutcome> {
  const to = rec.providerDeposit?.depositAddress;
  if (rec.inCurrency == null || to == null || to.length === 0) return {kind: 'not-applicable'};
  const memo = typeof rec.providerDeposit?.depositMemo === 'string' ? rec.providerDeposit.depositMemo : '';
  // The deposit memo MUST ride the transfer (types.ts: it routes the venue's crediting); an
  // empty memo is the no-memo case, never a dropped one.
  const nonceHex = memo.length > 0 ? bytesToHex(utf8ToBytes(memo)) : '';
  // Venue deposit addresses come in BOTH ICP shapes: ICRC-1 account text and the legacy
  // 64-hex account identifier (SideShift's ICP deposits are legacy, observed live
  // 2026-10-02). Dispatch on shape; the rail validators still verify deeper.
  const prepared = LEGACY_ACCOUNT_ID.test(to)
    ? await prepareLegacy(deps, rec, to, memo)
    : await deps.prepareTransfer(deps.secretHex, deps.catalog, {
      toAccount: to,
      amount: rec.amountIn,
      currency: rec.inCurrency,
      nonceHex,
    });
  // The legacy reply decodes through the LEGACY tag set; the ICRC-1 path keeps the rail's
  // default decoder (prod-proven).
  const outcome = await deps.submitTransfer(prepared, deps.secretHex, {attempts: 6, intervalMs: 2500}, LEGACY_ACCOUNT_ID.test(to) ? deps.decodeLegacyReply : undefined);
  if (outcome.kind === 'settled') return {kind: 'sent', blockIndex: outcome.blockIndex};
  if (outcome.kind === 'unknown') return {kind: 'unknown'};
  throw Object.assign(new Error(outcome.reason), {ataDepositRefused: outcome.reason});
}

async function prepareLegacy(
  deps: CefiDepositDeps,
  rec: CefiDepositRecord,
  to: string,
  memo: string,
): Promise<{ledger: string; envelopeHex: string; requestIdHex: string}> {
  // The legacy ledger form carries NO memo field - a venue order that needs one can never
  // be paid this way; refuse honestly instead of dropping the memo on the floor.
  if (memo.length > 0) {
    throw Object.assign(new Error('venue deposit needs a memo, which the legacy ICP transfer cannot carry'), {ataDepositRefused: 'memo on legacy'});
  }
  const row = deps.catalog.currencies.find(r => r.currency === rec.inCurrency);
  if (row == null || row.ledger !== ICP_MAINNET_LEDGER) {
    throw Object.assign(new Error('legacy venue deposit is ICP-mainnet-only'), {ataDepositRefused: 'legacy ledger'});
  }
  if (row.fee == null) {
    throw Object.assign(new Error('catalog carries no fee for the legacy deposit ledger'), {ataDepositRefused: 'no fee'});
  }
  return deps.prepareLegacyTransfer(deps.secretHex, {
    ledger: row.ledger,
    toAccountId: to,
    amountE8s: rec.amountIn,
    feeE8s: row.fee,
  });
}
