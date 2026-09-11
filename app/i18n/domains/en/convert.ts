/**
 * i18n/domains/en/convert.ts — the copy for the delegated-conversion surface (app/convert.ts +
 * components/ConvertMode.tsx, spec 2026-09-07 §5). The transparency checklist is RENDERED COPY: every
 * counterparty/rate/fee/impact/minimum/end-state line below is a line on the one pre-signing
 * surface, and the e2e flows assert each one.
 *
 * Shape rules inherited from ../keys.ts: interpolation is a typed FUNCTION (never
 * '{{placeholder}}'), no pluralization machinery, and MONEY IS FORMATTED BY THE CALLER — every
 * amount/fee argument is already an fmtAsset display string; the catalog only builds the sentence
 * around it. Locale-invariant facts (the venue's registry display name, asset symbols, UI labels
 * quoted from their own keys) are passed IN as arguments so they cannot drift per locale.
 *
 * THE UNIT HAS ONE OWNER: `fmtAsset` (app/lib/format.ts), which already suffixes it — "0 ICP",
 * "0.00010000 VCHF". No template below may take a bare symbol beside an amount and append it
 * again; that is what shipped "Balance: 0 ICP ICP" onto the production money screen (2026-09-08).
 * A symbol argument survives ONLY where the symbol stands alone in prose ("your ICP stays in your
 * wallet") — never adjacent to a formatted number. Pinned by __tests__/convertMode.test.tsx.
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
  /** What exists today, named honestly. Params are the locale-invariant pair string and the
   *  venue's registry display name. */
  unavailableBody: (pair: string, venue: string) => string;
  /** ckUSDC only (spec §1): the direct VCHF↔USDC pool exists but is saturated — dpay refuses
   *  it. `venue` names whose pool it is (registry display name) — the line never leaves the
   *  venue unnamed (Wave-2 fix). */
  unavailableCkusdc: (venue: string) => string;

  // --- the quote surface (every §5 checklist line) ----------------------------------------------
  amountLabel: (sym: string) => string;
  balanceLine: (balance: string) => string;
  /** The one number the decision turns on, as the screen's headline: what lands in the wallet. */
  receiveHeadline: string;
  /** Counterparty disclosure, part 1: WHO executes and what it is NOT. `venue` is the registry
   *  display name (venue facts are looked up, never hardcoded — V1). The pool's principal is NOT
   *  spelled here — the screen renders it on its own line (a 27-character hyphenated principal
   *  inside a paragraph wraps mid-token). */
  counterparty: (venue: string) => string;
  /** Counterparty disclosure, part 2: who signs and what the pool may pull. */
  counterpartySigns: string;
  /** "Quote from ICPSwap, fetched 14:32:05" — the venue's own number, attributed + timestamped.
   *  `at` is the VENUE-READ instant (the quote's relay `fetched_at`), never the device clock. */
  quoteSource: (at: string, venue: string) => string;
  /** The displayed rate is DERIVED — amount_out ÷ amount_in of this quote; the venue publishes
   *  amounts, not a rate (V8). The copy must never present it as a venue-published figure. */
  rateLabel: (inSym: string, outSym: string) => string;
  /** The pool's fee tier as a venue fact, shown separately from both ledger fees. */
  poolFeeTier: (tier: string, venue: string) => string;
  inputFeeLine: (fee: string) => string;
  outputFeeLine: (fee: string) => string;
  dpayFeeLine: string;
  impactLine: (pct: string) => string;
  impactWarnLine: (pct: string) => string;
  /** The venue answered the reference trade with zero, so there is no rate to compare this quote
   *  against — the ONLY state that leaves impact unmeasured (see `fetchConvertQuote`). Never a
   *  bare "—": the line says what is missing AND which number still bounds the trade (founder rule
   *  2026-08-29). */
  impactUnavailable: (venue: string) => string;
  slippageLabel: string;
  /** "Minimum you'll receive: 1.91 CHF (1% slippage)" + the refusal outcome on the next line. */
  minReceiveLine: (amount: string, pct: string) => string;
  refusalLine: (sym: string) => string;
  netEndStateLine: (amount: string) => string;
  confirmButton: string;
  staleRefreshing: string;
  /** Re-quote at confirm found a different price: name both, ask for a fresh confirm. */
  quoteChanged: (oldAmt: string, newAmt: string) => string;

  // --- the venue chooser (multi-venue readiness V5 — N venues on one pair, the USER picks) -------
  /** Section label above the venue rows. */
  venueChooserLabel: string;
  /** Shown while NO venue is selected — the only initial state: nothing is preselected, and
   *  the checklist + confirm stay withheld until the user picks a row (V5 red line). */
  venueNoneSelected: string;
  /** One row's own quote line. `amount` is THAT venue's formatted output for the entered
   *  input — each row shows its own number; rows never rank or compare each other. */
  venueRowQuote: (amount: string) => string;

  // --- fail closed BEFORE the confirm (a swap that can only fail is never offered) ---------------
  /** Zero balance: the Pay tab's fund-gate shape, routed at the surface that can actually fund an
   *  IC asset. `receiveTab`/`myAddress` are the live labels of those controls, passed in from
   *  their own keys so this sentence can never name a button that was renamed elsewhere. */
  fundBody: (sym: string, receiveTab: string, myAddress: string) => string;
  /**
   * The funded-account pointer on that same gate. It is offerable HONESTLY here — and only here —
   * because the PoC venue trades exactly ONE unordered pair (the venue registry's pair), so the set
   * of accounts that could ever help is two, and the other one is already resolved as this
   * screen's output leg. `held` is the other leg's formatted balance, `toSym` the asset it would
   * be converted into (the empty account the user is standing on). Rendered only when that other
   * leg actually holds something — never as a guess at a pair the venue may not serve.
   */
  fundOtherHolds: (held: string, toSym: string) => string;
  fundOtherSwitch: (sym: string) => string;
  /** Entered more than the wallet can spend: both numbers, and the two ways out. */
  insufficientLine: (needed: string, balance: string) => string;

  // --- in-flight + terminal states (useful practical instructions on every one) ------------------
  approvingTitle: string;
  approvingBody: (amount: string, at: string) => string;
  swappingTitle: string;
  swappingBody: (venue: string) => string;
  settlingTitle: string;
  settlingBody: (sym: string) => string;
  doneTitle: string;
  doneBody: (amount: string) => string;
  doneTx: (tx: string) => string;
  pendingTitle: string;
  pendingBody: (sym: string, pool: string, at: string) => string;
  stillWatching: string;
  failedTitle: string;
  /** Definitive ledger refusal BEFORE anything moved — the user's position is unchanged. */
  failedApproveBody: (sym: string) => string;
  /** The pool's own atomic refusal (e.g. minimum not met) — input never left the wallet. */
  failedSwapBody: (reason: string, sym: string, venue: string) => string;
  refundedBody: (sym: string) => string;
  stuckTitle: string;
  stuckBody: string;
  stuckSigned: (amount: string, minAmount: string, venue: string) => string;
  /** "Unused approval expires by 14:42 — after that the pool can pull nothing." */
  expiryLine: (at: string) => string;

  // --- V6: the provider-held states (convertResume.ts drivers) + the extended stuck watch -----
  /** A provider order exists and waits on the USER (no providerRef-only driver touches funds). */
  awaitingAuthTitle: string;
  awaitingAuthBody: (venue: string) => string;
  awaitingDepositTitle: string;
  awaitingDepositBody: (sym: string, venue: string) => string;
  providerProcessingTitle: string;
  providerProcessingBody: (sym: string, venue: string) => string;
  /** The provider's own quote/deposit window died BEFORE any value moved — distinct from any leg
   *  expiry; the venue refused nothing, it simply stopped waiting. */
  quoteExpiredTitle: string;
  quoteExpiredBody: (sym: string, venue: string) => string;
  providerRefundedTitle: string;
  providerRefundedBody: (sym: string, venue: string) => string;
  /** The stuck record is still probed in the background — resolution flips the screen itself. */
  stuckWatching: string;
  /** The user's acknowledgement of a stuck record: instructions read, watch may stop. */
  stuckAcknowledge: string;
  stuckAcknowledged: string;

  // --- module-thrown errors (app/convert.ts) ----------------------------------------------------
  errors: {
    quoteUnreachable: (venue: string) => string;
    quoteRefused: (venue: string) => string;
    quoteUnavailable: (code: string) => string;
  };
};

export const convertEn: ConvertMessages = {
  actionConvert: 'Convert',
  heading: (inSym, outSym) => `Convert ${inSym} → ${outSym}`,
  backToWallet: 'Back to wallet',

  unavailableTitle: sym => `Convert is not available for ${sym} yet`,
  unavailableBody: (pair, venue) => `Today dpay converts ${pair} through ${venue} — and nothing else.`,
  unavailableCkusdc: venue =>
    `A direct VCHF ↔ USDC pool exists at ${venue}, but its depth is saturated (about CHF 315), so dpay refuses it rather than quote you a stale price.`,

  amountLabel: sym => `Amount (${sym})`,
  balanceLine: balance => `Balance: ${balance}`,
  receiveHeadline: "You'll receive",
  counterparty: venue =>
    `Executed by the ${venue} pool — an autonomous on-chain contract, not a licensed provider and not dpay.`,
  counterpartySigns: 'Your phone signs; the pool pulls exactly the approved amount.',
  quoteSource: (at, venue) => `Quote from ${venue}, fetched ${at}`,
  rateLabel: (inSym, outSym) => `Rate for this quote (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool fee: ${tier} (${venue} fee tier)`,
  inputFeeLine: fee => `Input fee: ${fee}`,
  outputFeeLine: fee => `Output fee: ${fee}`,
  dpayFeeLine: 'dpay charges nothing and is paid nothing for this.',
  impactLine: pct => `Price impact: ${pct}`,
  impactWarnLine: pct => `High price impact: ${pct} — the quote above already includes it.`,
  impactUnavailable: venue =>
    `Price impact: not measurable right now — ${venue} quoted nothing for the reference trade, so there is no rate to compare this quote against. The minimum you'll receive below still bounds what this trade can cost you.`,
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum you'll receive: ${amount} (${pct} slippage)`,
  refusalLine: sym =>
    `If the pool's price moves past your minimum, the swap fails, your ${sym} stays in your wallet, and the approval expires unused.`,
  netEndStateLine: amount => `End state: ${amount} expected in your wallet, net of all fees.`,
  confirmButton: 'Re-quote and confirm',
  staleRefreshing: 'Quote stale — refreshing…',
  quoteChanged: (oldAmt, newAmt) => `Quote changed: ${oldAmt} → ${newAmt}. Review and confirm again.`,
  venueChooserLabel: 'Venue',
  venueNoneSelected: 'Select a venue to see its full quote and continue.',
  venueRowQuote: amount => `Quote: ${amount}`,

  fundBody: (sym, receiveTab, myAddress) =>
    `This wallet has no ${sym}. To convert ${sym}, first receive ${sym} at your address: open ${receiveTab} below and choose “${myAddress}”.`,
  fundOtherHolds: (held, toSym) => `You hold ${held} — you can convert that into ${toSym} instead.`,
  fundOtherSwitch: sym => `Convert from ${sym} instead`,
  insufficientLine: (needed, balance) =>
    `Converting this needs ${needed} — the amount plus two ledger fees — and this wallet holds ${balance}. Lower the amount, or receive more first.`,

  approvingTitle: 'Approving',
  approvingBody: (amount, at) =>
    `Your phone is approving the pool to pull exactly ${amount}. The approval expires at ${at} if unused.`,
  swappingTitle: 'Swapping',
  swappingBody: venue => `Submitting the swap to the ${venue} pool. It can pull only the approved amount.`,
  settlingTitle: 'Settling',
  settlingBody: sym => `The pool accepted the swap. Waiting for your ${sym} to appear at your wallet…`,
  doneTitle: 'Converted',
  doneBody: amount => `${amount} received in your wallet.`,
  doneTx: tx => `Payout record: ${tx}`,
  pendingTitle: 'Payout pending',
  pendingBody: (sym, pool, at) =>
    `The pool accepted the swap, but the ${sym} payout has not reached your wallet yet. This screen keeps watching — no action is needed right now. dpay cannot reverse or speed up the payout. If it never arrives, quote this to support: pool ${pool}, swap submitted at ${at}.`,
  stillWatching: 'Still watching for the payout…',
  failedTitle: 'Swap not executed',
  failedApproveBody: sym =>
    `The ${sym} ledger refused the approval, so nothing moved — you still hold every unit of your ${sym}. No allowance was created; nothing needs refunding or reversing.`,
  failedSwapBody: (reason, sym, venue) =>
    `The ${venue} pool refused the swap (${reason}). Your ${sym} never left your wallet. dpay cannot reverse or retry it for you; nothing further is needed.`,
  refundedBody: sym =>
    `The swap failed and the pool returned your ${sym} — your balance is whole again. dpay cannot reverse anything here.`,
  stuckTitle: 'Unknown outcome',
  stuckBody:
    'The swap was submitted, but the pool\u2019s answer did not arrive. Do not start a second swap with the same funds. If the payout arrives, this screen flips to done on its own.',
  stuckSigned: (amount, minAmount, venue) =>
    `What was signed: approve ${amount} to the ${venue} pool; swap for a minimum of ${minAmount}.`,
  expiryLine: at => `Unused approval expires by ${at} — after that, the pool can pull nothing.`,

  awaitingAuthTitle: 'Authorization needed',
  awaitingAuthBody: venue =>
    `This order is open at ${venue} and waits for your authorization. Nothing has moved and nothing will until you approve it — dpay watches the provider's status meanwhile.`,
  awaitingDepositTitle: 'Waiting for the deposit',
  awaitingDepositBody: (sym, venue) =>
    `${venue} issued this order and is waiting for its ${sym} deposit. The swap runs when the provider sees the deposit; dpay keeps watching its status. If no deposit arrives in time, the quote expires and nothing moves.`,
  providerProcessingTitle: 'Processing at the provider',
  providerProcessingBody: (sym, venue) =>
    `${venue} holds the deposit and is executing the order. Your ${sym} arrives when the provider completes it — dpay cannot reverse or speed it up, and keeps watching until it resolves.`,
  quoteExpiredTitle: 'Quote expired',
  quoteExpiredBody: (sym, venue) =>
    `The quote died before any value moved: ${venue} never received the deposit, so nothing was swapped and nothing needs reversing. Your ${sym} stayed where it was — start a new conversion if you still want one.`,
  providerRefundedTitle: 'Refunded by the provider',
  providerRefundedBody: (sym, venue) =>
    `${venue} cancelled this order and returned the deposit. Watch for your ${sym} to arrive back — dpay cannot reverse or speed up the provider's refund.`,
  stuckWatching: 'dpay keeps watching this in the background. If the payout or refund arrives, this screen flips on its own.',
  stuckAcknowledge: 'I understand — stop watching',
  stuckAcknowledged: 'You acknowledged this and the background watch has stopped. If funds move later, they still land at this wallet\u2019s address.',

  errors: {
    quoteUnreachable: venue => `Could not reach ${venue} for a quote. Check your connection and try again.`,
    quoteRefused: venue => `${venue} declined to quote this pair right now.`,
    quoteUnavailable: code => `A quote could not be shown (code ${code}).`,
  },
};
