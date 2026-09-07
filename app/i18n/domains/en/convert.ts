/**
 * i18n/domains/en/convert.ts — the copy for the delegated-conversion surface (app/convert.ts +
 * components/ConvertMode.tsx, spec 2026-09-07 §5). The transparency checklist is RENDERED COPY: every
 * counterparty/rate/fee/impact/minimum/end-state line below is a line on the one pre-signing
 * surface, and the e2e flows assert each one.
 *
 * Shape rules inherited from ../keys.ts: interpolation is a typed FUNCTION (never
 * '{{placeholder}}'), no pluralization machinery, and MONEY IS FORMATTED BY THE CALLER — every
 * amount/fee argument is already an fmtAsset display string; the catalog only builds the sentence
 * around it. Locale-invariant facts ("ICPSwap", principal texts, asset symbols) are passed IN as
 * arguments so they cannot drift per locale.
 *
 * Red lines encoded here (spec §0/§8): dpay is never described as a party to the trade, the venue
 * is always attributed by name, and no present-tense product claims about conversion beyond what
 * the PoC does today.
 */

export type ConvertMessages = {
  /** HomeTab action button — the SAME label for every asset (uniform IA). */
  actionConvert: string;
  /** Screen title: "Convert" + the pair, e.g. "Convert ICP → CHF". */
  heading: (inSym: string, outSym: string) => string;
  backToWallet: string;

  // --- fail-closed entry (venue-less assets — uniform entry point, honest copy) ------------------
  unavailableTitle: (sym: string) => string;
  /** What exists today, named honestly. Param is the locale-invariant pair string. */
  unavailableBody: (pair: string) => string;
  /** ckUSDC only (spec §1): the direct VCHF↔USDC pool exists but is saturated — dpay refuses it. */
  unavailableCkusdc: string;

  // --- the quote surface (every §5 checklist line) ----------------------------------------------
  amountLabel: (sym: string) => string;
  balanceLine: (balance: string, sym: string) => string;
  /** Counterparty disclosure, part 1: WHO executes and what it is NOT. */
  counterparty: string;
  /** Counterparty disclosure, part 2: who signs and what the pool may pull. */
  counterpartySigns: string;
  /** "Quote from ICPSwap, fetched 14:32:05" — the venue's own number, attributed + timestamped. */
  quoteSource: (at: string) => string;
  rateLabel: (inSym: string, outSym: string) => string;
  /** The pool's fee tier as a venue fact, shown separately from both ledger fees. */
  poolFeeTier: (tier: string) => string;
  inputFeeLine: (fee: string, sym: string) => string;
  outputFeeLine: (fee: string, sym: string) => string;
  dpayFeeLine: string;
  impactLine: (pct: string) => string;
  impactWarnLine: (pct: string) => string;
  slippageLabel: string;
  /** "Minimum you'll receive: 1.91 CHF (1% slippage)" + the refusal outcome on the next line. */
  minReceiveLine: (amount: string, sym: string, pct: string) => string;
  refusalLine: (sym: string) => string;
  netEndStateLine: (amount: string, sym: string) => string;
  confirmButton: string;
  staleRefreshing: string;
  /** Re-quote at confirm found a different price: name both, ask for a fresh confirm. */
  quoteChanged: (oldAmt: string, newAmt: string) => string;

  // --- in-flight + terminal states (useful practical instructions on every one) ------------------
  approvingTitle: string;
  approvingBody: (amount: string, sym: string, at: string) => string;
  swappingTitle: string;
  swappingBody: string;
  settlingTitle: string;
  settlingBody: (sym: string) => string;
  doneTitle: string;
  doneBody: (amount: string, sym: string) => string;
  doneTx: (tx: string) => string;
  pendingTitle: string;
  pendingBody: (sym: string, pool: string, at: string) => string;
  stillWatching: string;
  failedTitle: string;
  /** Definitive ledger refusal BEFORE anything moved — the user's position is unchanged. */
  failedApproveBody: (sym: string) => string;
  /** The pool's own atomic refusal (e.g. minimum not met) — input never left the wallet. */
  failedSwapBody: (reason: string, sym: string) => string;
  refundedBody: (sym: string) => string;
  stuckTitle: string;
  stuckBody: string;
  stuckSigned: (amount: string, inSym: string, minAmount: string, outSym: string) => string;
  /** "Unused approval expires by 14:42 — after that the pool can pull nothing." */
  expiryLine: (at: string) => string;

  // --- module-thrown errors (app/convert.ts) ----------------------------------------------------
  errors: {
    quoteUnreachable: () => string;
    quoteRefused: () => string;
    quoteUnavailable: (code: string) => string;
    swapReplyShape: () => string;
  };
};

export const convertEn: ConvertMessages = {
  actionConvert: 'Convert',
  heading: (inSym, outSym) => `Convert ${inSym} → ${outSym}`,
  backToWallet: 'Back to wallet',

  unavailableTitle: sym => `Convert is not available for ${sym} yet`,
  unavailableBody: pair => `Today dpay converts ${pair} through ICPSwap — and nothing else.`,
  unavailableCkusdc:
    'A direct VCHF ↔ USDC pool exists, but its depth is saturated (about CHF 315), so dpay refuses it rather than quote you a stale price.',

  amountLabel: sym => `Amount (${sym})`,
  balanceLine: (balance, sym) => `Balance: ${balance} ${sym}`,
  counterparty:
    'Executed by the ICPSwap pool 65mrh-fqaaa-aaaar-qapoa-cai — an autonomous on-chain contract, not a licensed provider and not dpay.',
  counterpartySigns: 'Your phone signs; the pool pulls exactly the approved amount.',
  quoteSource: at => `Quote from ICPSwap, fetched ${at}`,
  rateLabel: (inSym, outSym) => `Rate (${inSym} → ${outSym})`,
  poolFeeTier: tier => `Pool fee: ${tier} (ICPSwap fee tier)`,
  inputFeeLine: (fee, sym) => `Input fee: ${fee} ${sym}`,
  outputFeeLine: (fee, sym) => `Output fee: ${fee} ${sym}`,
  dpayFeeLine: 'dpay charges nothing and is paid nothing for this.',
  impactLine: pct => `Price impact: ${pct}`,
  impactWarnLine: pct => `High price impact: ${pct} — the quote above already includes it.`,
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, sym, pct) => `Minimum you'll receive: ${amount} ${sym} (${pct} slippage)`,
  refusalLine: sym =>
    `If the pool's price moves past your minimum, the swap fails, your ${sym} stays in your wallet, and the approval expires unused.`,
  netEndStateLine: (amount, sym) => `End state: ${amount} ${sym} expected in your wallet, net of all fees.`,
  confirmButton: 'Re-quote and confirm',
  staleRefreshing: 'Quote stale — refreshing…',
  quoteChanged: (oldAmt, newAmt) => `Quote changed: ${oldAmt} → ${newAmt}. Review and confirm again.`,

  approvingTitle: 'Approving',
  approvingBody: (amount, sym, at) =>
    `Your phone is approving the pool to pull exactly ${amount} ${sym}. The approval expires at ${at} if unused.`,
  swappingTitle: 'Swapping',
  swappingBody: 'Submitting the swap to the ICPSwap pool. It can pull only the approved amount.',
  settlingTitle: 'Settling',
  settlingBody: sym => `The pool accepted the swap. Waiting for your ${sym} to appear at your wallet…`,
  doneTitle: 'Converted',
  doneBody: (amount, sym) => `${amount} ${sym} received in your wallet.`,
  doneTx: tx => `Payout record: ${tx}`,
  pendingTitle: 'Payout pending',
  pendingBody: (sym, pool, at) =>
    `The pool accepted the swap, but the ${sym} payout has not reached your wallet yet. This screen keeps watching — no action is needed right now. dpay cannot reverse or speed up the payout. If it never arrives, quote this to support: pool ${pool}, swap submitted at ${at}.`,
  stillWatching: 'Still watching for the payout…',
  failedTitle: 'Swap not executed',
  failedApproveBody: sym =>
    `The ${sym} ledger refused the approval, so nothing moved — you still hold every unit of your ${sym}. No allowance was created; nothing needs refunding or reversing.`,
  failedSwapBody: (reason, sym) =>
    `The ICPSwap pool refused the swap (${reason}). Your ${sym} never left your wallet. dpay cannot reverse or retry it for you; nothing further is needed.`,
  refundedBody: sym =>
    `The swap failed and the pool returned your ${sym} — your balance is whole again. dpay cannot reverse anything here.`,
  stuckTitle: 'Unknown outcome',
  stuckBody:
    'The swap was submitted, but the pool\u2019s answer did not arrive. Do not start a second swap with the same funds. If the payout arrives, this screen flips to done on its own.',
  stuckSigned: (amount, inSym, minAmount, outSym) =>
    `What was signed: approve ${amount} ${inSym} to the ICPSwap pool; swap for a minimum of ${minAmount} ${outSym}.`,
  expiryLine: at => `Unused approval expires by ${at} — after that, the pool can pull nothing.`,

  errors: {
    quoteUnreachable: () => 'Could not reach the ICPSwap quote — the relay is unreachable. Check your connection and try again.',
    quoteRefused: () => 'ICPSwap refused to quote this pair right now.',
    quoteUnavailable: code => `Quote unavailable (${code}).`,
    swapReplyShape: () => 'The pool reply could not be read.',
  },
};
