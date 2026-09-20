/**
 * i18n/domains/en/convert.ts — the copy for the delegated-conversion surface (app/convert.ts +
 * components/ConvertMode.tsx, spec 2026-09-07 §5). The transparency checklist is RENDERED COPY: every
 * counterparty/rate/fee/disclosure/minimum/end-state line below is a line on the one pre-signing
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

  // --- the quote surface (every §5 checklist line) ----------------------------------------------
  amountLabel: (sym: string) => string;
  /** F4: the Max affordance beside the balance line — fills the largest convertible amount. */
  maxAmount: string;
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
  /** The per-venue disclosure sentence for the pre-sign checklist, keyed by the venue
   *  registry's OWN `disclosure_key` (dfx/catalog_truth.json venues[] → app/config/venues).
   *  A key with no entry here renders `generic` — fail closed: a disclosure always renders,
   *  never a blank, never copy that guesses a venue fact. There is deliberately NO
   *  price-impact copy: the venues publish no impact figure, so none is displayed (V8). */
  disclosures: {
    byKey: Record<string, (venue: string) => string>;
    generic: (venue: string) => string;
  };
  slippageLabel: string;
  /** "Minimum you'll receive: 1.91 CHF (1% slippage)" + the refusal outcome on the next line. */
  minReceiveLine: (amount: string, pct: string) => string;
  refusalLine: (sym: string) => string;
  /** The one disclosure control on the quote-ready card: the venue/fee/signing census
   *  collapses behind it, default CLOSED (the 2026-09-16 10x-verbosity pass). */
  detailsLabel: string;
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
  stop: string;
  stopWatching: string;
  abortedTitle: string;
  abortedClean: string;
  abortedFee: string;
  abortedWatching: string;
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

  // --- the Solana convert surface (solana_amm venues — Jupiter, 2026-09-15) -----------------------
  /** The rail-local pair SOL ↔ USDC(Solana), device-signed end to end. Where a fact is the SAME
   *  fact as the IC surface — quote attribution, rate, slippage chips, the stuck discipline, the
   *  zero-fee line — the keys above render verbatim; only genuinely Solana facts get their own
   *  keys here (network fee paid in SOL, Jupiter's own price-impact figure, the no-route
   *  refusal outcome). */
  sol: {
    heading: (inSym: string, outSym: string) => string;
    unavailableTitle: (sym: string) => string;
    unavailableBody: (sym: string, venue: string) => string;
    /** Solana shape of the counterparty sentence: bare venue attribution (there is no pool
     *  here); what the venue IS lives in its own disclosure, not in this line. */
    counterparty: (venue: string) => string;
    /** Who signs: the device signs the transaction the venue built — the Solana shape of
     *  `counterpartySigns` (no pool pulls anything; there is no approval to spend). */
    counterpartySigns: string;
    /** Jupiter publishes a price-impact figure for its route — its own number, verbatim (V8). */
    priceImpactLine: (pct: string, venue: string) => string;
    /** Jupiter's integrator fee tier when it publishes one (measured null = the none line). */
    platformFeeLine: (pct: string, venue: string) => string;
    /** The realized Solana network fee for THIS swap's transaction, quoted by the chain itself
     *  before signing — paid to Solana validators, not to the venue, not to dpay. */
    solFeeLine: (fee: string) => string;
    /** The refusal outcome: a Solana swap fails whole — no partial state exists to unwind. */
    refusalLine: (sym: string) => string;
    /** Submitted-and-watching: the chain is the ledger; the screen resolves itself. */
    pendingBody: string;
    failedBody: (sym: string, venue: string, detail: string) => string;
  };

  // --- multi-hop routes (docs/specs/2026-09-14-multihop-conversion-spec.md §5–§7) ----------------
  multihop: {
    /** Destination picker rows: the direct pair standing default, plus each composed route. */
    destLabel: string;
    destDirect: (sym: string) => string;
    destRoute: (sym: string, network: string) => string;
    /** F1: the collapsed route heading for a same-asset hop (ICP → USDC → USDC on Ethereum) —
     *  the through-route plus the landing place, no duplicated symbol. */
    routeHeadingCollapsed: (inSym: string, hopSym: string, network: string) => string;
    /** Destination rows are ONE per destination ASSET (hub UX guidance D1/D2): an in-wallet
     *  destination with no qualifier of its own (hub-only rows; the mechanism sub-picker
     *  carries the mechanism names). */
    destInWallet: (sym: string) => string;
    /** Mechanism sub-picker rows (D2/D5), revealed only when a destination has more than
     *  one: registry order, direct first (the standing default), never ranked beyond that. */
    mechDirect: string;
    mechViaHub: (hubSym: string) => string;
    mechViaCctp: string;
    mechViaVenue: (venue: string) => string;
    /** Same slot as venueNoneSelected, one level down: confirm waits for an explicit pick. */
    mechNoneSelected: string;
    /** The route chip under the headline (D8): which hub, how many swaps. */
    viaHub: (hubSym: string) => string;
    /** The unpicked-hub mech row's shape line — the row label already names the hub
     *  ("Via USDC"), so this carries ONLY the new fact (the swap count). */
    hubShape: () => string;
    /** Hub-mode promise line (D9): the floor the SECOND swap signs is an in-wallet amount —
     *  routeMinLine's "at your address" would be false here. */
    routeMinWalletLine: (amount: string, pct: string) => string;
    /** The two-venue attribution (D11): both venues named, verbatim, never blended; `at` is
     *  the newer fetch (each hop's own timestamp lives in the Details census). */
    hubQuoteSource: (venue1: string, venue2: string, at: string) => string;
    /** Details census heading (D10): the per-hop fold, one section, no second fold elsewhere. */
    hubCensusHeading: string;
    /** One hop's approve fee (D10): inputFeeLine is ambiguous with two hops — this names the
     *  approval's own cost. */
    approveFeeLine: (amount: string) => string;
    /** The composed per-unit rate label (both swaps combined, net of the dest fee). */
    hubRateLine: (inSym: string, destSym: string) => string;
    /** One surplus note covering both hops (D10): above-floor payouts stay in this wallet. */
    hubSurplusNote: (hubSym: string, destSym: string) => string;
    destAddressLabel: string;
    destAddressInvalid: string;
    /** The confirm-time route summary: ordered legs, fee census per leg (INV-6 style), no dpay cut. */
    routeHeading: (inSym: string, hopSym: string, destSym: string, network: string) => string;
    /** Route-mode headline label: names where the quoted number LANDS (in-wallet hop asset),
     *  so it can never be misread as the at-address amount (that promise is routeMinLine). */
    swapPaysLabel: string;
    legApprovePull: (sym: string) => string;
    legSwap: (venue: string, inSym: string, hopSym: string) => string;
    legApproveBurn: (sym: string) => string;
    legApproveGas: (sym: string) => string;
    legWithdraw: (hopSym: string, destSym: string, network: string) => string;
    legStatePending: string;
    legStateSent: string;
    legStateConfirmed: string;
    legStateFailed: string;
    /** D15: the in-flight top block tracks the CURRENT leg — counter + the leg's own label
     *  (caller joins them with an em dash). */
    legProgress: (n: number, total: number) => string;
    /** The minter's live gas figure at confirm time — its own census line, verbatim. */
    gasFeeLine: (amount: string) => string;
    /** The floor the destination is promised + where any surplus stays (spec §5). */
    routeMinLine: (amount: string, pct: string) => string;
    routeSurplusNote: (hopSym: string) => string;
    /** ckETH-gas preflight (spec §6): a KNOWN-insufficient balance blocks confirm, honestly. */
    gasPreflightTitle: string;
    gasPreflightBody: (needed: string) => string;
    /** Progress copy while legs execute; the hop watch reuses pendingTitle/pendingBody. */
    executingTitle: string;
    doneRouteTitle: string;
    doneRouteBody: (amount: string, address: string) => string;
    doneOnItsWay: string;
    failedLegTitle: string;
    failedLegBody: (sym: string, reason: string) => string;
    failedLegExit: string;
    stuckRouteBody: string;
    /** D18: the hub failed_leg trio — a completed swap is BEHIND you; the funds are the hub
     *  asset, in this wallet; the exit is that asset's own surfaces, never a cash-out. */
    failedHop2Title: string;
    failedHop2Body: (hubSym: string, outSym: string, reason: string) => string;
    failedHop2Exit: (hubSym: string) => string;
    /** D19: one extra line on the hub stuck screen — what is already held. */
    stuckHoldsLine: (hubSym: string) => string;
    /** D21: the hub overhead is THREE fees (two input-ledger, one hub-ledger approve) — the
     *  direct insufficientLine's "two ledger fees" would be a false promise here. */
    insufficientHubLine: (needed: string, balance: string) => string;
  };

  // --- CeFi venues (SideShift widening, 2026-09-15, founder decision 3): the destination
  // rows and the deposit handoff. The honest CeFi facts: the venue holds funds mid-trade,
  // the USER's own deposit is the value movement (nothing is signed by dpay), and every
  // number/address shown is the venue's own, verbatim.
  cefi: {
    /** Destination-picker row: what arrives, on which rail, through which venue. */
    destRow: (sym: string, network: string, venue: string) => string;
    /** The derived payout address line (read-only display — never typed free-hand). */
    settleAddressLabel: string;
    depositAddressLabel: string;
    depositAmountLabel: string;
    depositMemoLabel: string;
    /** The CeFi counterparty line for the pre-confirm checklist — the ic_amm "autonomous
     *  on-chain contract" sentence is FALSE for an exchange service; this one is not. */
    counterparty: (venue: string) => string;
    /** Same slot as counterpartySigns, cefi truth: the phone signs NOTHING — the user sends
     *  the deposit to the venue's own address themselves. */
    checklistSigns: string;
    /** Same slot as the pool trades' refusalLine, cefi truth: the only way this "fails" before
     *  the deposit is sent is expiry — the order lapses, nothing moved, funds never left. */
    refusalLine: (sym: string) => string;
    /** Same slot as insufficientLine, cefi truth: ONE input-ledger fee (the deposit transfer),
     *  not the pool's approve+pull pair. */
    insufficientLine: (needed: string, balance: string) => string;
    /** Where a completed cross-rail payout landed (the user's own address on the other rail). */
    payoutAt: (address: string) => string;
    depositExpiryLine: (at: string) => string;
    shiftId: (id: string) => string;
    /** The CeFi fact itself: the user sends to the VENUE's address; the venue holds mid-trade. */
    depositNote: (venue: string, sym: string) => string;
    /** The awaiting_deposit tail line: watches the DEPOSIT (the payout lines belong to the
     *  states after the venue has the money). */
    stillWaitingDeposit: string;
    /** SOL-side deposit handoff (2026-09-20 SOL-side cefi): the deposit is an SPL transfer
     *  the USER sends — its network fee is paid in SOL from the same wallet. */
    depositSolFeeNote: string;
    /** SOL-side cefi insufficientLine: the deposit moves EXACTLY the amount (its network
     *  fee is SOL-side, named in the handoff note) — the pool's fee arithmetic is false here. */
    solInsufficientLine: (needed: string, balance: string) => string;
  };

  // --- the cross-rail family (Routes B/C, 2026-09-16): the CCTP handoff (the USER's own
  // Ethereum wallet signs; dpay never holds an EVM key), the Circle attestation watch, and
  // Route C's final Jupiter offer. Every dead-end names where the funds sit and the exit.
  crossrail: {
    heading: string;
    handoffIntro: (amount: string) => string;
    stepApproveLabel: string;
    stepBurnLabel: string;
    txToLabel: string;
    txAmountLabel: string;
    txCalldataLabel: string;
    copy: string;
    copied: string;
    approveHint: string;
    burnHint: string;
    timingNote: string;
    externalGasLine: string;
    circleFeeLine: (fee: string) => string;
    mintFloorLine: (floor: string) => string;
    burnTxLabel: string;
    burnTxPlaceholder: string;
    attachButton: string;
    burnTxInvalid: string;
    declineButton: string;
    whatSigning: string;
    crossingTitle: string;
    crossingBody: string;
    viewBurnTx: string;
    viewCircle: string;
    stillCrossing: string;
    solReadyTitle: string;
    solReadyBody: (credit: string, ata: string) => string;
    solQuoteLabel: (venue: string) => string;
    /** Generalized (2026-09-19): the final leg lands ANY registered USDC-pair token —
     *  EURC on the jupiter-usdc-eurc route, SOL on the original. `min` is the BARE
     *  number (the caller passes an empty fmtAsset unit); `sym` is the destination
     *  symbol, standing alone in prose. */
    solMinLine: (min: string, sym: string) => string;
    solConfirmButton: (sym: string) => string;
    solFeeLine: (fee: string) => string;
    solPreflightTitle: string;
    /** Rendered only when the measured SOL balance is exactly zero — plain fact, no figure. */
    solPreflightBody: string;
    doneTitle: string;
    doneBody: (amount: string, sym: string, address: string) => string;
    declinedTitle: string;
    declinedBody: (address: string) => string;
    solFailedTitle: string;
    solFailedBody: (ata: string, venue: string) => string;
    legCctpBurn: (sym: string, network: string) => string;
    legSolSwap: (venue: string, sym: string) => string;
    destAddressCrossNote: string;
    /** Gas-fund offer (2026-09-20): shown only when the wallet's ckETH cannot cover the
     *  route's gas AND the destination address is checksum-verified AND re-typed once.
     *  One number per line; the offer is the engine's composed fund route or self-funding. */
    checksumMismatch: string;
    retypeAddress: string;
    retypeMismatch: string;
    gasFundTitle: string;
    gasFundNeed: (eth: string) => string;
    gasFundHave: (eth: string) => string;
    gasFundWalletButton: string;
    gasFundSelfButton: string;
    gasFundSelfMin: (eth: string) => string;
    gasFundRecheck: string;
    gasFundShort: (short: string) => string;
    gasLegsNote: string;
    /** Abort AFTER the funding pre-legs ran (gas delivered in-wallet) but the conversion
     *  never started — the honest "your gas money is still here" card. */
    abortedGasBody: string;
    /** Decline/abandonment at awaiting_external on a gas-funded record: BOTH the USDC (at
     *  the address) and the gas funding (still in-wallet) get their whereabouts named. */
    declinedWithGasBody: (address: string) => string;
    /** failureCode 'gas_short' failed card: the funding did not deliver, the main
     *  conversion never started, everything sits in-wallet. `needed` is the target. */
    gasShortFailedBody: (needed: string) => string;
  };

  // --- module-thrown errors (app/convert.ts) ----------------------------------------------------
  errors: {
    quoteUnreachable: (venue: string) => string;
    quoteRefused: (venue: string) => string;
    quoteUnavailable: (code: string) => string;
    /** A cefi venue whose relay holds no partner credential — the venue is ABSENT, not broken. */
    quoteUnconfigured: (venue: string) => string;
    gasUnavailable: string;
    cctpFeeUnavailable: string;
  };
};

export const convertEn: ConvertMessages = {
  actionConvert: 'Convert',
  heading: (inSym, outSym) => `Convert ${inSym} → ${outSym}`,
  backToWallet: 'Back to wallet',

  unavailableTitle: sym => `Convert is not available for ${sym} yet`,
  unavailableBody: (pair, venue) => `Today dpay converts ${pair} through ${venue} — and nothing else.`,

  amountLabel: sym => `Amount (${sym})`,
  maxAmount: 'Max',
  balanceLine: balance => `Balance: ${balance}`,
  receiveHeadline: "You'll receive",
  counterparty: venue => `Executed by the ${venue} pool.`,
  counterpartySigns: 'Your phone signs; the pool pulls exactly the approved amount.',
  quoteSource: (at, venue) => `Quote from ${venue}, fetched ${at}`,
  rateLabel: (inSym, outSym) => `Rate for this quote (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool fee: ${tier} (${venue} fee tier)`,
  inputFeeLine: fee => `Input fee: ${fee}`,
  outputFeeLine: fee => `Output fee: ${fee}`,
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (the registry's key for the ICPSwap pools): the venue-specific
      // fact is WHERE the swap runs — the venue's own pool contract. One sentence; the signing
      // fact lives in counterpartySigns (verbosity pass 2026-09-16).
      icpswap: venue => `The swap runs on ${venue}'s own pool contract.`,
      // disclosure_key 'jupiter' (the registry's key for the Solana venue row): the venue-specific
      // facts are WHAT Jupiter is — an autonomous on-chain aggregator — and that the quote is its
      // own, rendered verbatim, while dpay stays outside the trade entirely. Mirrors the icpswap
      // tone: attribute, name the signer, deny party-hood.
      jupiter: venue =>
        `${venue} is an autonomous on-chain aggregator on Solana — it picks the route and the route executes it. This wallet signs the transaction ${venue} builds, and the quote is ${venue}'s own, shown exactly as it publishes it. dpay is not a party to it.`,
      // disclosure_key 'sideshift' (the registry's key for the first CeFi venue, 2026-09-15):
      // the CeFi facts the founder set — an automated exchange service holding funds
      // mid-trade, not a licensed provider; KYC per ITS policy is ITS to disclose (its own
      // published terms are named); dpay is not a party and is paid nothing (the relay pins
      // commissionRate "0"). The venue row detail renders this in full.
      sideshift: venue =>
        `${venue} is an automated exchange service — not a licensed provider and not a bank. It holds your funds mid-trade, then pays out to your own address; its terms, including any identity checks under its policy, are published at sideshift.ai/terms. This wallet shows you ${venue}'s own quote and deposit address and nothing is signed by dpay. dpay is not a party to the trade and is paid nothing.`,
    },
    generic: venue => `This conversion is executed by ${venue}.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum you'll receive: ${amount} (${pct} slippage)`,
  refusalLine: sym =>
    `If the pool's price moves past your minimum, the swap fails, your ${sym} stays in your wallet, and the approval expires unused.`,
  detailsLabel: 'Details',
  confirmButton: 'Re-quote and confirm',
  staleRefreshing: 'Quote stale — refreshing…',
  quoteChanged: (oldAmt, newAmt) => `Quote changed: ${oldAmt} → ${newAmt}. Review and confirm again.`,
  venueChooserLabel: 'Venue',
  venueNoneSelected: 'Select a venue to see its full quote and continue.',

  sol: {
    heading: (inSym, outSym) => `Convert ${inSym} to ${outSym} (Solana)`,
    unavailableTitle: sym => `${sym} cannot be converted yet`,
    unavailableBody: (sym, venue) =>
      `Conversions for Solana assets run through a registered Solana venue (${venue} today). No venue serves ${sym} right now — nothing was offered, nothing moved.`,
    counterparty: venue => `Executed by ${venue}.`,
    counterpartySigns: 'Your phone signs the transaction the venue built — nobody else signs anything.',
    priceImpactLine: (pct, venue) => `Price impact: ${pct} (${venue}'s own figure)`,
    platformFeeLine: (pct, venue) => `${venue} integrator fee: ${pct}`,
    solFeeLine: fee => `Solana network fee: ${fee} (paid to the network, not the venue, not dpay)`,
    refusalLine: sym =>
      `If the price moves past the minimum, the transaction fails on-chain, your ${sym} stays in your wallet, and nothing else was signed.`,
    pendingBody:
      'The swap transaction is on the Solana network. This screen is watching the chain itself and resolves on its own — no reload, no retry needed.',
    failedBody: (sym, venue, detail) =>
      `${venue}'s swap transaction failed${detail ? ` (${detail})` : ''}. On Solana a failed transaction never moves funds — your ${sym} is where it was.`,
  },

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
    `The pool accepted the swap, but the ${sym} payout has not reached your wallet yet. This screen keeps watching — no action is needed right now. If it never arrives, quote this to support: pool ${pool}, swap submitted at ${at}.`,
  stillWatching: 'Still watching for the payout…',
  failedTitle: 'Swap not executed',
  failedApproveBody: sym =>
    `The ${sym} ledger refused the approval, so nothing moved — you still hold every unit of your ${sym}. No allowance was created; nothing needs refunding or reversing.`,
  failedSwapBody: (reason, sym, venue) =>
    `The ${venue} pool refused the swap (${reason}). Your ${sym} never left your wallet — nothing further is needed.`,
  refundedBody: sym =>
    `The swap failed and the pool returned your ${sym} — your balance is whole again.`,
  stuckTitle: 'Unknown outcome',
  // The user's Stop (2026-09-19): the button and the frozen-record panel. Short on purpose.
  stop: 'Stop',
  stopWatching: 'Stop watching',
  abortedTitle: 'Stopped',
  abortedClean: 'Nothing left your wallet.',
  abortedFee: 'You already paid a tiny approval fee.',
  abortedWatching: 'The swap may still go through. Check Balances later.',
  stuckBody:
    'The swap was submitted, but the pool\u2019s answer did not arrive. Do not start a second swap with the same funds. If the payout arrives, this screen flips to done on its own.',
  stuckSigned: (amount, minAmount, venue) =>
    `What was signed: approve ${amount} to the ${venue} pool; swap for a minimum of ${minAmount}.`,
  expiryLine: at => `The signed instructions expire by ${at} — after that, nothing can move.`,

  awaitingAuthTitle: 'Authorization needed',
  awaitingAuthBody: venue =>
    `This order is open at ${venue} and waits for your authorization. Nothing has moved and nothing will until you approve it — dpay watches the provider's status meanwhile.`,
  awaitingDepositTitle: 'Waiting for the deposit',
  awaitingDepositBody: (sym, venue) =>
    `${venue} issued this order and is waiting for its ${sym} deposit. The swap runs when the provider sees the deposit; dpay keeps watching its status. If no deposit arrives in time, the quote expires and nothing moves.`,
  providerProcessingTitle: 'Processing at the provider',
  providerProcessingBody: (sym, venue) =>
    `${venue} holds the deposit and is executing the order. Your ${sym} arrives when the provider completes it — dpay keeps watching until it resolves.`,
  quoteExpiredTitle: 'Quote expired',
  quoteExpiredBody: (sym, venue) =>
    `The quote died before any value moved: ${venue} never received the deposit, so nothing was swapped and nothing needs reversing. Your ${sym} stayed where it was — start a new conversion if you still want one.`,
  providerRefundedTitle: 'Refunded by the provider',
  providerRefundedBody: (sym, venue) =>
    `${venue} cancelled this order and returned the deposit. Watch for your ${sym} to arrive back.`,
  stuckWatching: 'dpay keeps watching this in the background. If the payout or refund arrives, this screen flips on its own.',
  stuckAcknowledge: 'I understand — stop watching',
  stuckAcknowledged: 'You acknowledged this and the background watch has stopped. If funds move later, they still land at this wallet\u2019s address.',

  multihop: {
    destLabel: 'Destination',
    destDirect: sym => `${sym} — in this wallet`,
    destRoute: (sym, network) => `${sym} — to your ${network} address`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route: ${inSym} → ${hopSym} (to ${network})`,
    destAddressLabel: 'Your own address on the destination network',
    destAddressInvalid: 'Not a valid destination address — expected 0x followed by 40 hex characters.',
    routeHeading: (inSym, hopSym, destSym, network) => `Route: ${inSym} → ${hopSym} → ${destSym} on ${network}`,
    swapPaysLabel: 'The swap pays into this wallet',
    legApprovePull: sym => `Approve the pool to pull your ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Swap ${inSym} → ${hopSym} on ${venue}`,
    legApproveBurn: sym => `Approve the ${sym} burn (the cash-out amount)`,
    legApproveGas: sym => `Approve ${sym} to pay the cash-out gas`,
    legWithdraw: (hopSym, destSym, network) => `Burn ${hopSym} — ${destSym} arrives on ${network}`,
    legStatePending: 'Waiting',
    legStateSent: 'Sent',
    legStateConfirmed: 'Confirmed',
    legStateFailed: 'Refused',
    legProgress: (n, total) => `Step ${n} of ${total}`,
    destInWallet: sym => `${sym} — in this wallet`,
    mechDirect: 'Direct pool',
    mechViaHub: hubSym => `Via ${hubSym}`,
    mechViaCctp: 'Via Circle CCTP',
    mechViaVenue: venue => `Via ${venue}`,
    mechNoneSelected: 'Pick a mechanism above to see the quote.',
    viaHub: hubSym => `via ${hubSym} · 2 swaps`,
    hubShape: () => '2 swaps',
    routeMinWalletLine: (amount, pct) => `At least ${amount} stays in this wallet (slippage floor ${pct})`,
    hubQuoteSource: (venue1, venue2, at) => `Quotes from ${venue1} and ${venue2}, fetched ${at}`,
    hubCensusHeading: 'Two swaps, itemized',
    approveFeeLine: amount => `Approving the next pool costs ${amount} (the ledger\u2019s own transfer fee)`,
    hubRateLine: (inSym, destSym) => `Combined rate, ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `If a swap pays above its floor, the surplus stays in this wallet as ${hubSym} or ${destSym}.`,
    gasFeeLine: amount => `Cash-out gas (the minter\u2019s live quote): ${amount}`,
    routeMinLine: (amount, pct) => `At least ${amount} at your address (slippage floor ${pct})`,
    routeSurplusNote: hopSym => `If the swap pays above the floor, the surplus stays in this wallet as ${hopSym}.`,
    gasPreflightTitle: 'Cash-out needs gas first',
    gasPreflightBody: needed =>
      `Burning to Ethereum costs gas paid in ckETH, and this wallet does not hold enough. About ${needed} is needed (the minter\u2019s live gas quote plus its approve fee). Get ckETH into this wallet first, then come back — buying a gas slice here is future work, and dpay will not hide this cost.`,
    executingTitle: 'Running the route',
    doneRouteTitle: 'Cash-out under way',
    doneRouteBody: (amount, address) => `At least ${amount} is on its way to ${address}.`,
    doneOnItsWay: 'Delivery happens on Ethereum and can take a while — dpay cannot watch that network. Nothing further is needed from you.',
    failedLegTitle: 'The cash-out leg refused',
    failedLegBody: (sym, reason) =>
      `The swap went through — your funds are ${sym} in this wallet, nothing lost and nothing stuck. The cash-out refused${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'To cash out, open Pay, choose Send to address, and paste any destination address — the withdrawal step runs from there.',
    stuckRouteBody: 'A leg was sent but its outcome is unknown yet. dpay keeps watching the ledgers in the background — when the payout or refund lands, this screen flips on its own.',
    failedHop2Title: 'The second swap was refused',
    failedHop2Body: (hubSym, outSym, reason) =>
      `The first swap went through — you hold ${hubSym} in this wallet, nothing lost and nothing stuck. The ${hubSym} → ${outSym} swap was refused${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Your ${hubSym} is spendable as-is: keep it, convert it later from its own account, or send it. Nothing needs reversing.`,
    stuckHoldsLine: hubSym => `Completed so far: you hold ${hubSym} in this wallet.`,
    insufficientHubLine: (needed, balance) =>
      `This conversion needs ${needed} — the amount plus three ledger fees — and this wallet holds ${balance}. Lower the amount, or receive more first.`,
  },

  /** CeFi venues (SideShift widening, 2026-09-15): the deposit handoff screen. The venue
   *  holds the funds mid-trade; the user's own deposit IS the value movement — nothing is
   *  signed by dpay. Every address/amount shown is the venue's own, verbatim. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} on ${network} — via ${venue} (exchange service)`,
    settleAddressLabel: 'Payout lands at your own address on the destination network',
    depositAddressLabel: 'Deposit address',
    depositAmountLabel: 'Exact deposit amount',
    depositMemoLabel: 'Memo (required)',
    counterparty: venue =>
      `Executed by ${venue} — an automated exchange service, not a licensed provider and not dpay.`,
    checklistSigns:
      'Nothing is signed on this phone — after you confirm, you send the deposit to the venue\'s own address yourself.',
    refusalLine: sym =>
      `If the deposit never arrives, the order expires — nothing moves, and your ${sym} stays in your wallet.`,
    insufficientLine: (needed, balance) =>
      `This deposit needs ${needed} — the amount plus one transfer fee — and this wallet holds ${balance}. Lower the amount, or receive more first.`,
    payoutAt: address => `Paid out to your own address: ${address}`,
    depositExpiryLine: at => `Order expires ${at}`,
    shiftId: id => `Shift ${id}`,
    depositNote: (venue, sym) =>
      `Send ${sym} from your wallet to ${venue}\u2019s deposit address above — exactly the deposit amount. ${venue} is an automated exchange service: it holds your ${sym} mid-trade, then pays out to your address. dpay is not a party to this trade and is paid nothing.`,
    stillWaitingDeposit: 'Still watching for your deposit — this page updates on its own.',
    depositSolFeeNote: 'Sending the deposit also pays a small network fee in SOL — keep a little SOL in this wallet.',
    solInsufficientLine: (needed, balance) =>
      `This deposit sends exactly ${needed} and this wallet holds ${balance}. Lower the amount, or receive more first.`,
  },

  /** The cross-rail family (Routes B/C, 2026-09-16): everything past the five IC legs —
   *  the CCTP handoff (dpay renders the exact transactions, the USER's own Ethereum wallet
   *  signs; dpay never holds an EVM key), the Circle attestation watch, and Route C's
   *  final Jupiter offer. Every dead-end names where the funds sit and the exit. */
  crossrail: {
    heading: 'Sign in your Ethereum wallet',
    handoffIntro: (amount) =>
      `The Internet Computer part is done: ${amount} is at your Ethereum address. Your wallet now sends it across — dpay never touches your Ethereum keys.`,
    stepApproveLabel: 'Step 1 — let Circle\u2019s contract move the USDC',
    stepBurnLabel: 'Step 2 — burn the USDC for the Solana transfer',
    txToLabel: 'To',
    txAmountLabel: 'Amount',
    txCalldataLabel: 'Transaction data',
    copy: 'Copy',
    copied: 'Copied',
    approveHint: 'This lets Circle\u2019s TokenMessenger move exactly the USDC being sent — nothing more.',
    burnHint: 'This locks the USDC on Ethereum. Circle\u2019s bridge then mints the same USDC to your Solana address — no wrapped token, Circle runs the arrival for you.',
    timingNote: 'On the fast path the arrival typically takes seconds to a few minutes (measured ~20 s in our live check). If Ethereum is busy it can take longer — this screen updates on its own.',
    externalGasLine: 'Ethereum gas for these two transactions is paid by your wallet\u2019s own ETH. dpay cannot pay it or quote it exactly.',
    circleFeeLine: fee => `Circle\u2019s bridge fee (its own number, taken from the amount): at most ${fee}`,
    mintFloorLine: floor => `At least ${floor} arrives at your Solana address`,
    burnTxLabel: 'Burn transaction hash (from your wallet, after signing)',
    burnTxPlaceholder: '0x…',
    attachButton: 'I signed it — watch the crossing',
    burnTxInvalid: 'That does not look like an Ethereum transaction hash.',
    declineButton: 'I am not signing this',
    whatSigning: 'You are signing two ordinary Ethereum transactions in your own wallet: an approval, then the burn. Nothing is signed on dpay\u2019s side for this step.',
    crossingTitle: 'Crossing to Solana',
    crossingBody: 'Circle is attesting the burn and will mint the USDC at your Solana address. dpay is watching Circle\u2019s own status feed — this page flips by itself.',
    viewBurnTx: 'View the burn transaction',
    viewCircle: 'Circle\u2019s status page',
    stillCrossing: 'Attestation is not finished yet. This stays pending — it is not failed. On the fast path it is seconds to minutes; if Ethereum is congested, longer.',
    solReadyTitle: 'USDC landed on Solana',
    solReadyBody: (credit, ata) => `${credit} is at ${ata}, verified on-chain. Finish the route, or leave the USDC there — it is yours either way.`,
    solQuoteLabel: venue => `${venue} quote (fresh)`,
    solMinLine: (min, sym) => `At least ${min} ${sym} at your address`,
    solConfirmButton: sym => `Swap to ${sym}`,
    solFeeLine: fee => `Solana transaction fee: ${fee}`,
    solPreflightTitle: 'A little SOL is needed for the fee',
    solPreflightBody:
      'The swap\u2019s network fee is paid in SOL and this wallet holds no SOL. Get a little SOL into this wallet first — the USDC stays put meanwhile.',
    doneTitle: 'Converted',
    doneBody: (amount, sym, address) => `${amount} ${sym} is at your Solana address ${address} — verified on-chain.`,
    declinedTitle: 'Handoff cancelled',
    declinedBody: address =>
      `Nothing crossed. Your USDC sits at your own Ethereum address ${address} — send it anywhere from your wallet, or run this route again later.`,
    solFailedTitle: 'The Solana swap did not go through',
    solFailedBody: (ata, venue) =>
      `The USDC already crossed safely and is at your Solana address ${ata}. ${venue} declined the final swap — try again here in a moment, or keep the USDC.`,
    legCctpBurn: (sym, network) => `Cross ${sym} to ${network} via Circle (you sign this in your wallet)`,
    legSolSwap: (venue, sym) => `Swap for ${sym} on ${venue}`,
    destAddressCrossNote: 'This Ethereum address is also the wallet that signs the crossing — paste an address you control.',
    checksumMismatch: 'Checksum mismatch',
    retypeAddress: 'Re-type the address',
    retypeMismatch: 'Does not match',
    gasFundTitle: 'This conversion needs ETH gas you don\u2019t have',
    gasFundNeed: eth => `Need \u2248 ${eth}`,
    gasFundHave: eth => `Your wallet: ${eth}`,
    gasFundWalletButton: 'Fund from this wallet',
    gasFundSelfButton: 'I\u2019ll fund it myself',
    gasFundSelfMin: eth => `Send \u2265 ${eth} to:`,
    gasFundRecheck: 'Check again',
    gasFundShort: short => `Still ${short} short`,
    gasLegsNote: 'The first legs fund the gas.',
    abortedGasBody: 'The gas funding completed — it is still in this wallet. The conversion itself never ran.',
    declinedWithGasBody: address => `Nothing crossed. Your USDC is at your Ethereum address ${address}; the gas funding is still in this wallet.`,
    gasShortFailedBody: needed => `The gas funding came up short of ${needed}. Nothing left this wallet — the conversion never started.`,
  },

  errors: {
    quoteUnreachable: venue => `Could not reach ${venue} for a quote. Check your connection and try again.`,
    quoteRefused: venue => `${venue} declined to quote this pair right now.`,
    quoteUnavailable: code => `A quote could not be shown (code ${code}).`,
    quoteUnconfigured: venue =>
      `${venue} is not set up on this relay yet — no partner credential is configured, so no quote can be asked for. Nothing is wrong with your wallet.`,
    gasUnavailable: 'The cash-out minter could not be asked for its gas price — nothing was signed. Try again.',
    cctpFeeUnavailable: 'Circle\u2019s bridge fee could not be fetched — nothing was signed. Check your connection and try again.',
  },
};
