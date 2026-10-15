/**
 * i18n/domains/en/convert.ts - the copy for the delegated-conversion surface (app/convert.ts +
 * components/ConvertMode.tsx, spec 2026-09-07 §5). The transparency checklist is RENDERED COPY: every
 * counterparty/rate/fee/disclosure/minimum/end-state line below is a line on the one pre-signing
 * surface, and the e2e flows assert each one.
 *
 * Second verbosity pass (founder 2026-09-29): every word costs attention. A line survives only if
 * the user must KNOW it or DO something because of it; the census lives behind the ONE Details
 * control; state bodies are fragments that keep (what happened / where the funds sit / the way out).
 *
 * Shape rules inherited from ../keys.ts: interpolation is a typed FUNCTION (never
 * '{{placeholder}}'), no pluralization machinery, and MONEY IS FORMATTED BY THE CALLER - every
 * amount/fee argument is already an fmtAsset display string; the catalog only builds the sentence
 * around it. Locale-invariant facts (the venue's registry display name, asset symbols, UI labels
 * quoted from their own keys) are passed IN as arguments so they cannot drift per locale.
 *
 * THE UNIT HAS ONE OWNER: `fmtAsset` (app/lib/format.ts), which already suffixes it - "0 ICP",
 * "0.00010000 VCHF". No template below may take a bare symbol beside an amount and append it
 * again; that is what shipped "Balance: 0 ICP ICP" onto the production money screen (2026-09-08).
 * A symbol argument survives ONLY where the symbol stands alone in prose - never adjacent to a
 * formatted number. Pinned by __tests__/convertMode.test.tsx.
 *
 * Red lines encoded here (spec §0/§8): dpay is never described as a party to the trade, the venue
 * is always attributed by name (+ timestamp on every quote line), and no present-tense product
 * claims about conversion beyond what the PoC does today.
 */

export type ConvertMessages = {
  /** HomeTab action button - the SAME label for every asset (uniform IA). */
  actionConvert: string;
  /** Screen title: "Convert" + the pair, e.g. "Convert ICP → CHF". */
  heading: (inSym: string, outSym: string) => string;
  backToWallet: string;

  // --- fail-closed entry (venue-less assets - uniform entry point, honest copy) ------------------
  // noPathTitle/noPathBody/noPathAction (below, brief 5.7) are THE no-route render.

  // --- the quote surface (every §5 checklist line) ----------------------------------------------
  /** The amount field's label: the unit alone - the field IS the amount. */
  amountLabel: (sym: string) => string;
  /** F4: the Max affordance beside the balance line - fills the largest convertible amount. */
  maxAmount: string;
  balanceLine: (balance: string) => string;
  /** Counterparty disclosure, part 1: WHO executes. `venue` is the registry display name (venue
   *  facts are looked up, never hardcoded - V1). The pool's principal is NOT spelled here - the
   *  screen renders it on its own line (a 27-character hyphenated principal inside a paragraph
   *  wraps mid-token). */
  counterparty: (venue: string) => string;
  /** Counterparty disclosure, part 2: who signs and what the pool may pull. */
  counterpartySigns: string;
  /** "ICPSwap · 14:32" - the venue's own number, attributed + timestamped. `at` is the
   *  VENUE-READ instant (the quote's relay `fetched_at`), never the device clock. */
  quoteSource: (at: string, venue: string) => string;
  /** The venue's verbatim figure behind the receive hero, in Details: the hero renders at
   *  standard display precision; THIS line carries the venue's published figure unchanged.
   *  `amt` is the caller's fmtAsset string, `venue` the registry name. */
  quoteVerbatim: (venue: string, amt: string) => string;
  /** The displayed rate is DERIVED - amount_out ÷ amount_in of this quote; the venue publishes
   *  amounts, not a rate (V8). The copy must never present it as a venue-published figure. */
  rateLabel: (inSym: string, outSym: string) => string;
  /** The pool's fee tier as a venue fact, shown separately from both ledger fees. */
  poolFeeTier: (tier: string, venue: string) => string;
  inputFeeLine: (fee: string) => string;
  outputFeeLine: (fee: string) => string;
  /** The per-venue disclosure sentence for the pre-sign checklist, keyed by the venue
   *  registry's OWN `disclosure_key` (dfx/catalog_truth.json venues[] → app/config/venues).
   *  A key with no entry here renders `generic` - fail closed: a disclosure always renders,
   *  never a blank, never copy that guesses a venue fact. There is deliberately NO
   *  price-impact copy beyond what a venue itself publishes (V8). */
  disclosures: {
    byKey: Record<string, (venue: string) => string>;
    generic: (venue: string) => string;
  };
  slippageLabel: string;
  refusalLine: (sym: string) => string;
  /** S1's recommendation line (spec 2026-10-04 §2): rendered under the receive hero the
   *  moment a quote stands - the arrival fact, plus the route's known fee in its own
   *  asset when one exists. No venue, no id, no rail. */
  arrives: string;
  feeAbout: (fee: string) => string;
  /** The quiet exchanges-involved line: rendered only when the route involves more than
   *  one exchange (composed/hub/chain/crossrail), or the auto pick compared venues. */
  exchangesInvolved: (n: number) => string;
  /** The one disclosure control on the quote-ready card: the venue/fee/signing census
   *  collapses behind it, default CLOSED (the 2026-09-16 10x-verbosity pass). */
  detailsLabel: string;
  staleRefreshing: string;
  /** Shown on a venue row whose last measured settlement blew the SLA (2026-09-20 gate):
   *  the relay demoted the row to the tail - this line is the honest why, nothing more. */
  venueSlow: string;

  // --- the intent sheet (brief Part V, 2026-09-26): dpay pre-computes everything ------------------
  // Tap 1 opens this sheet fully computed; tap 2 (the CTA) confirms. One default target, one
  // amount, one venue pick: each disclosed mechanically, each still overridable in one tap.
  /** The sheet's title: the action plus the currency the user came from. */
  sheetTitle: (inSym: string) => string;
  /** The review card's receive hero. The receive figure is the venue's own estimate - the ≈ is
   *  part of the copy, the amount is the caller's string. (The sell half has no row: the input
   *  above IS the sell figure and the CTA names the amount.) */
  youReceive: (amt: string) => string;
  /** The quoting state's line: whose rate is being fetched right now. */
  /** The fetching state's line - venue-less (the attribution renders in Details). */
  quoteFetching: string;
  /** The merged quote line when the AUTO pick compared venues: venue + read instant + the
   *  mechanical count. Never an endorsement; the word "best" is a designed-out failure mode.
   *  `n >= 2` by the caller's contract (a one-venue pair renders the plain quoteSource). */
  autoVenueLine: (venue: string, at: string, n: number) => string;
  /** The Other-venues expander: every other row, registry order, one tap each. */
  otherVenues: (n: number) => string;
  /** The floor line on the review card: the minimum the signed instructions accept. The
   *  slippage figure behind it lives in Details. */
  atLeast: (amt: string) => string;
  /** The one bottom CTA. The action names the amount ("Convert 4.54 CHF"). */
  ctaConvert: (amt: string) => string;
  /** The ONE material-move interrupt (S2): the fresh figure inline, the same button re-arms.
   *  Noise within the tolerance never reaches this line (the confirm absorbs it silently). */
  rateMoved: (newAmt: string) => string;
  /** The amount is above what the wallet can spend on this route: need vs have; the preset
   *  chips + the line below are the named way out. */
  neededVsHave: (need: string, have: string) => string;
  smallerAmount: string;
  /** No executable route from this currency: what exists today, plus the one way forward. */
  noPathTitle: (inSym: string) => string;
  noPathBody: (pairs: string) => string;
  /** HONEST UNAVAILABILITY (2026-09-28): the named target refuses with its reason - visible, never hidden. */
  noVenueBody: (inSym: string, outSym: string) => string;
  /** The no-path panel's one action: the deposit surface for the currency the user holds. */
  noPathAction: string;
  /** The CCTP exception, disclosed at tap 1: one step is signed in the user's OWN wallet. */
  externalSignTitle: string;
  externalSignBody: string;
  /** Settlement Field states (brief 5.5): the device signing, the swap in flight, the pool
   *  payout watch, the resolved receipt, and the composed route's automatic deposit leg. */
  signing: string;
  awaitingPool: string;
  receivedDone: (amt: string) => string;
  /** The composed IC+CeFi route's deposit leg: dpay creates the venue order first, then the
   *  device signs the deposit transfer as a leg of the SAME intent (no second handoff).
   *  Plain lines - the venue's name lives in the order block under Details, never here. */
  depositLegSent: (amt: string) => string;
  depositLegPending: (amt: string) => string;
  /** The composed tracker's order-creation line (the ONE consent's live narration): the
   *  venue and the payout figure its order locked, verbatim. Details-class. */
  composedOrderLine: (venue: string, amt: string) => string;
  /** The composed deposit transfer was refused at a gate or by the ledger (terminal, never
   *  retried): the swap went through, the hub asset is still in the wallet, the exit is named. */
  depositRefusedBody: (hopSym: string) => string;

  // --- fail closed BEFORE the confirm (a swap that can only fail is never offered) ---------------
  /** Zero balance: the Pay tab's fund-gate shape, routed at the surface that can actually fund an
   *  IC asset. `receiveTab`/`myAddress` are the live labels of those controls, passed in from
   *  their own keys so this sentence can never name a button that was renamed elsewhere. */
  fundBody: (sym: string, receiveTab: string, myAddress: string) => string;
  /**
   * The funded-account pointer on that same gate. It is offerable HONESTLY here - and only here -
   * because the PoC venue trades exactly ONE unordered pair (the venue registry's pair), so the set
   * of accounts that could ever help is two, and the other one is already resolved as this
   * screen's output leg. `held` is the other leg's formatted balance, `toSym` the asset it would
   * be converted into (the empty account the user is standing on). Rendered only when that other
   * leg actually holds something - never as a guess at a pair the venue may not serve.
   */
  fundOtherHolds: (held: string, toSym: string) => string;
  fundOtherSwitch: (sym: string) => string;
  /** Entered more than the wallet can spend on a Solana venue swap: need vs have. */
  insufficientLine: (needed: string, balance: string) => string;

  // --- in-flight + terminal states (useful practical instructions on every one) ------------------
  approvingTitle: string;
  approvingBody: (amount: string, at: string) => string;
  swappingTitle: string;
  swappingBody: string;
  settlingTitle: string;
  settlingBody: (sym: string) => string;
  doneTitle: string;
  doneBody: (amount: string) => string;
  doneTx: (tx: string) => string;
  pendingTitle: string;
  /** The pool-payout watch: the asset only - the support reference is the ACTIVE leg's own,
   *  on its own line (pendingSupport), never a pool id smuggled into the body. */
  pendingBody: (sym: string) => string;
  /** The support recipe, pending only: the ACTIVE step's own reference, nothing else. */
  pendingSupport: (ref: string) => string;
  stillWatching: string;
  failedTitle: string;
  /** Definitive ledger refusal BEFORE anything moved - the user's position is unchanged. */
  failedApproveBody: (sym: string) => string;
  /** The exchange's own atomic refusal (e.g. minimum not met) - input never left the wallet. */
  failedSwapBody: (reason: string, sym: string) => string;
  /** The pool returned the funds: the refund is the status word. */
  refundedTitle: string;
  refundedBody: (sym: string) => string;
  stuckTitle: string;
  /** The CHAIN record's phase-1 stuck state (D32): the pool's copy would name a swap that
   *  never ran - the unknown outcome is the venue DEPOSIT transfer's own. */
  chainStuckTitle: string;
  chainStuckBody: string;
  stop: string;
  stopWatching: string;
  /** The provider-held stop (2026-09-24): the venue order keeps its own life at the venue -
   *  dpay only ever watched its status. Its own key so locales can carry that nuance. */
  stopProvider: string;
  abortedTitle: string;
  abortedClean: string;
  abortedFee: string;
  abortedWatching: string;
  /** The provider-held abort body (2026-09-24): BOTH halves of the truth - no deposit sent
   *  -> the trade never started and the order dies unfunded at the venue; deposit already
   *  sent -> the trade may still settle (check Balances + the venue's own status page). */
  abortedProvider: string;
  stuckBody: string;
  /** The stuck screen's one restating line: what was signed, amount for amount. The pool's
   *  identity lives in the receipts block (Details evidence), never in this line. */
  stuckSigned: (amount: string, minAmount: string) => string;
  /** "Expires by 14:42." */
  expiryLine: (at: string) => string;

  // --- V6: the provider-held states (convertResume.ts drivers) + the extended stuck watch -----
  awaitingDepositTitle: string;
  awaitingDepositBody: (sym: string) => string;
  providerProcessingTitle: string;
  providerProcessingBody: (sym: string) => string;
  /** The provider's own quote/deposit window died BEFORE the deposit arrived - but a LATE
   *  deposit can still land and be refunded (the engine keeps a slow watch for exactly
   *  that, 2026-09-24), so this copy names the watch instead of claiming the story is over. */
  quoteExpiredTitle: string;
  quoteExpiredBody: (sym: string) => string;
  providerRefundedTitle: string;
  providerRefundedBody: (sym: string) => string;
  /** The stuck record is still probed in the background - resolution flips the screen itself. */
  stuckWatching: string;
  /** The user's acknowledgement of a stuck record: instructions read, watch may stop. */
  stuckAcknowledge: string;
  stuckAcknowledged: string;

  // --- stuck evidence + expiry honesty (2026-10-02 POCO P0: the founder's screen showed no
  // --- error, no per-step facts, and a "keeps watching" claim on a dead window) ------------
  /** The stuck receipts block: per-leg what happened + the record's own tx evidence. */
  stuckReceiptsTitle: string;
  /** A record-carried failure cause, rendered verbatim - never hidden (founder hard rule). */
  stuckErrorLine: (d: string) => string;
  /** The window is CLOSED: the honest flip of expiryLine - the clock is spent, and the
   *  outcome now comes from the evidence, not from watching. */
  stuckExpiredLine: (at: string) => string;
  /** What the closed window means for the money: resolution comes from the evidence. */
  stuckExpiredBody: string;
  /** The engine's last completed probe of this record - the "keeps watching" claim, verifiable. */
  stuckLastCheckedLine: (at: string) => string;
  /** failed_refunded + window_closed: the swap could not be confirmed in its window and
   *  nothing left the wallet - the honest body, never a phantom "the pool returned it". */
  failedWindowClosedBody: (sym: string) => string;

  // --- the Solana convert surface (solana_amm venues - Jupiter, 2026-09-15) -----------------------
  /** The rail-local pair SOL ↔ USDC(Solana), device-signed end to end. Where a fact is the SAME
   *  fact as the IC surface - quote attribution, rate, slippage chips, the stuck discipline, the
   *  zero-fee line - the keys above render verbatim; only genuinely Solana facts get their own
   *  keys here (network fee paid in SOL, Jupiter's own price-impact figure, the no-route
   *  refusal outcome). */
  sol: {
    heading: (inSym: string, outSym: string) => string;
    /** Solana shape of the counterparty sentence: bare venue attribution (there is no pool
     *  here); what the venue IS lives in its own disclosure, not in this line. */
    counterparty: (venue: string) => string;
    /** Who signs: the device signs the transaction the venue built - the Solana shape of
     *  `counterpartySigns` (no pool pulls anything; there is no approval to spend). */
    counterpartySigns: string;
    /** Jupiter publishes a price-impact figure for its route - its own number, verbatim (V8). */
    priceImpactLine: (pct: string, venue: string) => string;
    /** The realized Solana network fee for THIS swap's transaction, quoted by the chain itself
     *  before signing - paid to Solana validators, not to the venue, not to dpay. */
    solFeeLine: (fee: string) => string;
    /** The refusal outcome: a Solana swap fails whole - no partial state exists to unwind. */
    refusalLine: (sym: string) => string;
    /** Submitted-and-watching: the chain is the ledger; the screen resolves itself. */
    pendingBody: string;
    failedBody: (sym: string, detail: string) => string;
  };

  // --- the EVM rail's Uniswap V3 venue (2026-09-28, the any-pair mandate) ------------------------
  evm: {
    heading: (inSym: string, outSym: string, chain: string) => string;
    /** The chain's own arithmetic over the planned legs (estimate attribution, D15.2). */
    feeLabel: (unit: string) => string;
    /** Broadcast-and-watching: the receipts are the ledger; the screen resolves itself. */
    pendingBody: string;
    /** The nothing-broadcast failure body: names what still sits in the wallet. Legal only
     *  when no leg was ever broadcast (the panel reads the persisted hashes, not the text). */
    failedBody: (inSym: string) => string;
    /** The sent-but-stopped failure body: a leg is on-chain, so the fee is spent and no
     *  balance claim is made; the transaction record below carries the hashes. */
    sentFailedBody: string;
    /** A receipt never landed: the honest unknown, the hashes stay watchable. */
    stuckBody: (outSym: string) => string;
  };

  // --- the EVM rail's CoW Swap venue (2026-10-03, the second EVM venue) -------------------------
  cow: {
    /** The venue's own fee estimate, carried verbatim on the review card: never hidden,
     *  never signed (the venue prices the trade and names its cost; dpay adds nothing). */
    feeLine: (fee: string) => string;
    /** The volume-fee policy note when the venue names one (bps, its own figure). */
    protocolFeeLine: (bps: string) => string;
    /** Submitted-and-watching: the solvers settle off-chain, seconds to minutes. */
    settlingBody: string;
    /** The failure body: the order was OFF-CHAIN - nothing left the wallet but the
     *  exact-amount approval the copy names. `detail` is the venue's own status/errorType. */
    failedBody: (inSym: string, detail: string) => string;
  };

  // --- multi-hop routes (docs/specs/2026-09-14-multihop-conversion-spec.md §5-§7) ----------------
  multihop: {
    /** Destination picker rows: the direct pair standing default, plus each composed route. */
    destLabel: string;
    destDirect: (sym: string) => string;
    destRoute: (sym: string, network: string) => string;
    /** The Route-C shape of destRow: names the FINAL leg's venue in the row itself, so a
     *  Jupiter-tailed route reads as Jupiter-tailed at the picker (founder clarity fix
     *  2026-09-22 - the venue chain was invisible until after confirm). */
    destRouteSol: (sym: string, network: string, venue: string) => string;
    /** F1: the collapsed route heading for a same-asset hop (ICP → USDC → USDC on Ethereum) -
     *  the through-route plus the landing place, no duplicated symbol. */
    routeHeadingCollapsed: (inSym: string, hopSym: string, network: string) => string;
    /** Destination rows are ONE per destination ASSET (hub UX guidance D1/D2): an in-wallet
     *  destination with no qualifier of its own (hub-only rows; the mechanism sub-picker
     *  carries the mechanism names). */
    destInWallet: (sym: string) => string;
    /** The destination picker's tail section header (multi-currency build-out): every
     *  destination that settles no home currency - other in-wallet assets and external-address
     *  payouts. A label, never a total. */
    destGroupOther: string;
    /** Mechanism sub-picker rows (D2/D5), revealed only when a destination has more than
     *  one: registry order, direct first (the standing default), never ranked beyond that. */
    mechDirect: string;
    mechViaHub: (hubSym: string) => string;
    mechViaCctp: string;
    mechViaVenue: (venue: string) => string;
    /** Confirm waits for an explicit pick (one level below the venue auto line). */
    mechNoneSelected: string;
    /** The route chip under the headline (D8): which hub, how many swaps. */
    viaHub: (hubSym: string) => string;
    /** The unpicked-hub mech row's shape line - the row label already names the hub
     *  ("Via USDC"), so this carries ONLY the new fact (the swap count). */
    hubShape: () => string;
    /** Hub-mode promise line (D9): the floor the SECOND swap signs is an in-wallet amount -
     *  routeMinLine's "at your address" would be false here. The slippage figure behind the
     *  floor lives in Details. */
    routeMinWalletLine: (amount: string) => string;
    /** The two-venue attribution (D11): both venues named, verbatim, never blended; `at` is
     *  the newer fetch (each hop's own timestamp lives in the Details census). */
    hubQuoteSource: (venue1: string, venue2: string, at: string) => string;
    /** Details census heading (D10): the per-hop fold, one section, no second fold elsewhere. */
    hubCensusHeading: string;
    /** One hop's approve fee (D10): inputFeeLine is ambiguous with two hops - this names the
     *  approval's own cost. */
    approveFeeLine: (amount: string) => string;
    /** The composed per-unit rate label (both swaps combined, net of the dest fee). */
    hubRateLine: (inSym: string, destSym: string) => string;
    /** One surplus note covering both hops (D10): above-floor payouts stay in this wallet. */
    hubSurplusNote: (hubSym: string, destSym: string) => string;
    destAddressLabel: string;
    destAddressInvalid: string;
    /** The standing payout line (founder directive 2026-09-30): a route without a crossing
     *  states where the funds land. The crossing rows keep crossrail.destAddressCrossNote. */
    destPayoutNote: string;
    /** The advanced control that reveals the typed destination field (power users). */
    destChange: string;
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
    /** D15: the in-flight top block tracks the CURRENT leg - counter + the leg's own label
     *  (caller joins them with an em dash). */
    legProgress: (n: number, total: number) => string;
    /** The minter's live gas figure at confirm time - its own census line, verbatim. */
    gasFeeLine: (amount: string) => string;
    /** The floor the destination is promised + where any surplus stays (spec §5). */
    routeMinLine: (amount: string) => string;
    routeSurplusNote: (hopSym: string) => string;
    /** Route C's review-time estimate of what LANDS at the destination after the final
     *  Jupiter leg (founder clarity fix 2026-09-22): the headline numbers describe the
     *  USDC hop, this line names the destination asset. Rendered only when the estimate
     *  actually fetched - it is an estimate, never a promise, and never a gate. */
    routeDestEstimate: (amount: string, symbol: string) => string;
    /** The full venue chain of a Route-C intent, one line inside the Details census. */
    routeVenues: (icVenue: string, solVenue: string) => string;
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
    /** The expired arm of the stuck body (2026-10-04 founder fix): past the window nothing
     *  can move, so the live arm's watching claim would be false - this arm names the
     *  closed window and the evidence settlement instead. Plain hyphen, never an em-dash. */
    stuckRouteBodyExpired: string;
    /** D18: the hub failed_leg trio - a completed swap is BEHIND you; the funds are the hub
     *  asset, in this wallet; the exit is that asset's own surfaces, never a cash-out. */
    failedHop2Title: string;
    failedHop2Body: (hubSym: string, outSym: string, reason: string) => string;
    failedHop2Exit: (hubSym: string) => string;
    /** D19: one extra line on the hub stuck screen - what is already held. */
    stuckHoldsLine: (hubSym: string) => string;
    /** D21: the hub overhead is THREE fees (two input-ledger, one hub-ledger approve) - the
     *  direct insufficientLine's arithmetic would be a false promise here. */
    insufficientHubLine: (needed: string, balance: string) => string;
  };

  // --- the progress STORY (S3, spec 2026-10-04): one plain line per leg, stateful. Plain
  // verbs, no venue brands, no ids - the venue/fee census lives behind Details. These are
  // the lines the leg list renders; the audit block may reuse them verbatim.
  story: {
    /** The approve legs' plain verb (never "approve"). */
    letPoolUse: (sym: string) => string;
    letPoolUseGas: (sym: string) => string;
    /** A pool swap leg: asset for asset. */
    swap: (inSym: string, outSym: string) => string;
    /** The final Jupiter leg of a crossing: the destination asset only. */
    swapFor: (sym: string) => string;
    /** The CCTP crossing leg. */
    cross: (sym: string, network: string) => string;
    /** The cash-out burn leg: what leaves, what arrives, where. */
    withdraw: (hopSym: string, destSym: string, network: string) => string;
    /** The composed route's device-signed deposit leg (the venue's name is in Details). */
    depositSend: (amt: string) => string;
    depositSent: (amt: string) => string;
  };

  // --- CeFi venues (SideShift widening, 2026-09-15, founder decision 3): the destination
  // rows and the deposit handoff. The honest CeFi facts: the venue holds funds mid-trade,
  // the USER's own deposit is the value movement (nothing is signed by dpay), and every
  // number/address shown is the venue's own, verbatim.
  cefi: {
    /** Destination-picker row: what arrives, on which rail, through which venue. */
    destRow: (sym: string, network: string, venue: string) => string;
    destRowMulti: (sym: string, network: string) => string;
    /** The derived payout address line (read-only display - never typed free-hand). */
    settleAddressLabel: string;
    /** The EVM-native settle rail's own line (2026-09-27): names NATIVE ETH on Ethereum
     *  mainnet as what the payout delivers - the one line that separates the SideShift
     *  row's native-ETH payout from the IC pool's ckETH payout inside the ETH target. */
    settleRailEthereum: string;
    depositAddressLabel: string;
    depositAmountLabel: string;
    depositMemoLabel: string;
    /** The CeFi counterparty line for the pre-confirm checklist - the ic_amm "autonomous
     *  on-chain contract" sentence is FALSE for an exchange service; this one is not. */
    counterparty: (venue: string) => string;
    /** Same slot as counterpartySigns, cefi truth: the phone signs NOTHING - the user sends
     *  the deposit to the venue's own address themselves. The another-rail-source arm; an
     *  IC-source row rides checklistSignsAuto (the wallet sends the deposit itself). */
    checklistSigns: string;
    /** The IC-source arm (2026-10-04): the record-lifecycle watcher sends the deposit from
     *  this wallet once the order exists - nothing for the user to send by hand. */
    checklistSignsAuto: string;
    /** Same slot as the pool trades' refusalLine, cefi truth: the only way this "fails" before
     *  the deposit is sent is expiry - the order lapses, nothing moved, funds never left. */
    refusalLine: (sym: string) => string;
    /** Same slot as insufficientLine, cefi truth: ONE input-ledger fee (the deposit transfer),
     *  not the pool's approve+pull pair. */
    insufficientLine: (needed: string, balance: string) => string;
    /** Where a completed cross-rail payout landed (the user's own address on the other rail). */
    payoutAt: (address: string) => string;
    depositExpiryLine: (at: string) => string;
    /** Rendered when the venue published NO expiry (e.g. Trocador orders): the honest fact
     *  that keeps an unfunded order from reading as quietly abandoned. Sits beside the
     *  shift-id line - the id is already named there, so this line carries ONLY the fact. */
    noExpiryLine: string;
    /** The provider_processing tail line: when the engine last completed a status read.
     *  A timestamp, nothing more - no SLA is claimed and no verdict is implied (2026-09-24). */
    lastCheckedLine: (at: string) => string;
    /** The venue order's id handle, family-aware (2026-10-15): SideShift/Trocador trades keep
     *  SideShift's own "shift" noun, Mt Pelerin records read as orders. The panel picks by the
     *  record's venue family (providerStatus), never a fixed label. */
    shiftId: (id: string) => string;
    orderId: (id: string) => string;
    /** Shown while the venue holds/settles the deposit: dpay owns the escalation, not the user.
     *  A calming, commitment-bearing PAIR - what is already true (funds in, payout locked),
     *  then what dpay is doing (watching every shift, stepping in) and the zero-action close. */
    settlingFundsLine: string;
    settlingWatchLine: string;
    /** The CeFi fact itself: the user sends to the VENUE's address; the venue holds mid-trade. */
    depositNote: (venue: string, sym: string) => string;
    /** The IC-source body (2026-10-04): the wallet sends the deposit itself; the venue
     *  truths stay, the manual-send instruction is gone. */
    depositAutoNote: (venue: string, sym: string) => string;
    /** The awaiting_deposit tail line: watches the DEPOSIT (the payout lines belong to the
     *  states after the venue has the money). */
    stillWaitingDeposit: string;
    /** The IC-source tail: the deposit is the wallet's job, the wait is the venue's word. */
    stillWaitingAuto: string;
    /** SOL-side deposit handoff (2026-09-20 SOL-side cefi): the deposit is an SPL transfer
     *  the USER sends - its network fee is paid in SOL from the same wallet. */
    depositSolFeeNote: string;
    /** SOL-side cefi insufficientLine: the deposit moves EXACTLY the amount (its network
     *  fee is SOL-side, named in the handoff note) - the pool's fee arithmetic is false here. */
    solInsufficientLine: (needed: string, balance: string) => string;
    /** The honest listed-but-unquoted state (Trocador, 2026-09-22 probe): the venue carries
     *  the pair but no provider is quoting it right now. NOT an error - nothing moved, and
     *  the line says so and names the way out. */
    noQuoteTitle: string;
    noQuoteBody: string;
    /** The venue's own BELOW-MINIMUM verdict (SideShift, 2026-09-29 probe: a too-small
     *  amount answers HTTP 500 QUOTE_UNAVAILABLE with the published figure in the body).
     *  The venue's own message rides verbatim; the frame attributes it, states nothing
     *  moved, and names the way out. */
    minDepositBody: (venueMessage: string, min: string) => string;
  };

  // --- the chain family (2026-09-28, the any-pair mandate): a SOL-rail source rides a cefi
  // venue's order into a mid IC ledger, then registered pools finish the route. One review,
  // one consent, one CTA; the second phase signs itself from the frozen plan when the venue
  // settles. Every dead-end names where the funds sit and the exit. The order's machine
  // facts (venue, order id, deposit address) live under Details; the story stays plain.
  chain: {
    /** The deposit transfer's flight title (the tracker's spinner line): the device-signed
     *  transfer to the venue's own address, not a swap. */
    depositSending: string;
    /** The order line: the venue, the exact deposit, and what arrives (the mid asset). */
    orderLine: (venue: string, depositAmt: string, midSym: string) => string;
    /** The awaiting-payout body: the deposit went out automatically (never a manual send). */
    depositSent: (depositAmt: string, midSym: string) => string;
    /** The review card's phase-2 note (the consent covers the whole chain). */
    phase2Note: string;
    /** The phase-2 leg line in the live narration (mid → dest via the IC venue). */
    phase2Leg: (midSym: string, outSym: string, venue: string) => string;
    /** The unpicked row's mechanism line (which mid the route lands on). */
    rowShape: (midSym: string) => string;
    /** The failed second leg: the mid asset is in-wallet; the exit is a normal convert. */
    phase2Failed: (midSym: string) => string;
    /** The failed FIRST phase: the deposit never landed on-chain; nothing ever left. */
    depositFailed: (sym: string) => string;
  };

  // --- the cross-rail family (Routes B/C, 2026-09-16): the CCTP handoff (the USER's own
  // Ethereum wallet signs; dpay never holds an EVM key), the Circle attestation watch, and
  // Route C's final Jupiter offer. Every dead-end names where the funds sit and the exit.
  crossrail: {
    heading: string;
    handoffIntro: (amount: string) => string;
    stepApproveLabel: string;
    stepBurnLabel: string;
    txAmountLabel: string;
    copy: string;
    copied: string;
    approveHint: string;
    burnHint: string;
    timingNote: string;
    externalGasLine: string;
    circleFeeLine: (fee: string) => string;
    /** Route C's floor line: the USDC reads as the MID-STOP, not the outcome (founder
     *  clarity fix 2026-09-22) - it crosses to Solana and the final step swaps it onward.
     *  `floor` is the BARE number; `symbol` renders USDC (locale-invariant). */
    mintFloorLine: (floor: string, symbol: string) => string;
    /** Route B's floor line (no final leg exists - the USDC IS the outcome at the address). */
    mintFloorDestLine: (floor: string, symbol: string) => string;
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
    /** The Stop during `crossing` (2026-09-24): the burn already happened, so Circle may
     *  still complete the mint. NEVER claims nothing moved - the USDC lands at the user's
     *  own ATA either way; `ata` names where. */
    abortedCrossing: (ata: string) => string;
    /** The Stop at `sol_ready` (2026-09-24): the final Jupiter leg was UNSIGNED - nothing
     *  was in flight. Names where the USDC sits and the exit (convert it on Solana). */
    abortedSolReady: (ata: string) => string;
    solQuoteLabel: (venue: string) => string;
    /** Generalized (2026-09-19): the final leg lands ANY registered USDC-pair token -
     *  EURC on the jupiter-usdc-eurc route, SOL on the original. `min` is the BARE
     *  number (the caller passes an empty fmtAsset unit); `sym` is the destination
     *  symbol, standing alone in prose. */
    solMinLine: (min: string, sym: string) => string;
    solConfirmButton: (sym: string) => string;
    solFeeLine: (fee: string) => string;
    solPreflightTitle: string;
    /** Rendered only when the measured SOL balance is exactly zero - plain fact, no figure. */
    solPreflightBody: string;
    doneTitle: string;
    doneBody: (amount: string, sym: string, address: string) => string;
    /** The done receipt's venue attribution (Route C): who executed the conversion, named
     *  in one line - the receipt used to name nobody (founder clarity fix 2026-09-22). */
    doneVia: (icVenue: string, solVenue: string) => string;
    declinedTitle: string;
    declinedBody: (address: string) => string;
    solFailedTitle: string;
    solFailedBody: (ata: string) => string;
    legCctpBurn: (sym: string, network: string) => string;
    legSolSwap: (venue: string, sym: string) => string;
    destAddressCrossNote: string;
    /** Swap-typing stage 2 (2026-10-03): the destination IS the device's own address - the
     *  device signs the crossing itself, so the disclosure forks to this pair and the
     *  address note drops the paste ask. The WalletConnect handoff stays behind the
     *  "Change destination" control (an edited external address restores the old copy). */
    deviceSignTitle: string;
    deviceSignBody: string;
    destAddressDeviceNote: string;
    /** Stage 2's dead end: the device burn refused at its own gate AFTER the IC legs ran -
     *  the USDC is at the record's EVM address, never "in this wallet". */
    burnFailedBody: (address: string, reason: string) => string;
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
     *  never started - the honest "your gas money is still here" card. */
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
    quoteUnreachable: string;
    quoteRefused: string;
    /** The venue refused to BUILD the signed exchange for a quote it had just priced. Nothing has moved. */
    buildRefused: string;
    quoteUnavailable: (code: string) => string;
    /** A cefi venue whose relay holds no partner credential - the venue is ABSENT, not broken. */
    quoteUnconfigured: string;
    gasUnavailable: string;
    cctpFeeUnavailable: string;
    /** The chain deposit leg's fail-closed refusals (2026-09-28). */
    chainDepositUnreadable: string;
    chainSenderEmpty: (sym: string) => string;
    chainSenderShort: (sym: string) => string;
    chainRentShort: (sym: string) => string;
  };
};

export const convertEn: ConvertMessages = {
  actionConvert: 'Convert',
  heading: (inSym, outSym) => `Convert ${inSym} → ${outSym}`,
  backToWallet: 'Back to wallet',

  amountLabel: sym => `${sym}`,
  maxAmount: 'Max',
  balanceLine: balance => `Balance ${balance}`,
  counterparty: venue => `Executed by the ${venue} pool.`,
  counterpartySigns: 'Your phone signs; the pool can use only the agreed amount.',
  quoteSource: (at, venue) => `${venue} · ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} quoted: ${amt}`,
  rateLabel: (inSym, outSym) => `Rate (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool fee: ${tier} (${venue} fee tier)`,
  inputFeeLine: fee => `Input fee: ${fee}`,
  outputFeeLine: fee => `Output fee: ${fee}`,
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (the registry's key for the ICPSwap pools): the venue-specific
      // fact is WHERE the swap runs - the venue's own pool contract. One sentence; the signing
      // fact lives in counterpartySigns (verbosity pass 2026-09-16).
      icpswap: venue => `Runs on ${venue}'s own pool contract.`,
      // disclosure_key 'jupiter': WHAT Jupiter is, that the quote is its own verbatim number,
      // and that dpay stays outside the trade.
      jupiter: venue =>
        `${venue} is an autonomous on-chain aggregator on Solana - it picks the route; the route executes it. This wallet signs the transaction ${venue} builds, and the quote is ${venue}'s own, shown verbatim. dpay is not a party.`,
      // disclosure_key 'sideshift': an automated exchange service holding funds mid-trade,
      // terms named (KYC is ITS to disclose), dpay a non-party paid nothing.
      sideshift: venue =>
        `${venue} is an automated exchange service - not a licensed provider or bank. It holds your funds mid-trade, then pays out to your address; its terms, including any identity checks under its policy, are at sideshift.ai/terms. The quote and deposit address are ${venue}'s own, shown verbatim - your funds go straight from your wallet to the venue; dpay is not a party and is paid nothing.`,

      // disclosure_key 'trocador': the sideshift truths plus the aggregate fact - the venue
      // picks among its own backends (dpay never ranks beneath that pick), and dpay asks it
      // for non-KYC backends only.
      trocador: venue =>
        `${venue} is an automated exchange aggregator - it routes your trade to one of its own backends and holds your funds mid-trade, then pays to your address; its terms, including any backend identity checks, are at trocador.app/terms. dpay asks ${venue} for no-KYC backends only. The quote and deposit address are ${venue}'s own, shown verbatim - your funds go straight from your wallet to the venue; dpay is not a party and is paid nothing.`,
      // disclosure_key 'cowswap': the second EVM venue - the intent/settlement fact is
      // WHAT happens after the signature (off-chain solvers, no gas for the trader), and
      // the same no-party/no-cut truths.
      cowswap: venue =>
        `${venue} fills signed off-chain orders with competing solvers, usually in seconds to minutes. The review shows ${venue}'s own fee. dpay signs your order, is not a party, and is paid nothing.`,
    },
    generic: venue => `Executed by ${venue}.`,
  },
  slippageLabel: 'Slippage',
  refusalLine: sym =>
    `Past your minimum the swap fails - your ${sym} stays in your wallet, the approval expires unused.`,
  arrives: 'Arrives in a few minutes.',
  feeAbout: fee => `Fee about ${fee}.`,
  exchangesInvolved: n => `${n} exchanges involved.`,
  detailsLabel: 'Details',
  staleRefreshing: 'Quote stale - refreshing…',
  venueSlow: 'Recently slow to settle.',

  // The intent sheet (brief Part V): the copy the two-tap flow renders.
  sheetTitle: inSym => `Convert ${inSym}`,
  youReceive: amt => `You receive ≈ ${amt}`,
  quoteFetching: 'Fetching the rate…',
  autoVenueLine: (venue, at, n) => `${venue} · ${at} · ${n} venues`,
  otherVenues: n => `Options (${n})`,
  atLeast: amt => `Min ${amt}`,
  ctaConvert: amt => `Convert ${amt}`,
  rateMoved: newAmt => `Price changed: now about ${newAmt}. Confirm again.`,
  neededVsHave: (need, have) => `${need} needed, you have ${have}`,
  smallerAmount: 'Convert a smaller amount',
  noPathTitle: inSym => `No route from ${inSym}`,
  noPathBody: pairs => `Routes today: ${pairs}`,
  noVenueBody: (inSym, outSym) => `No venue converts ${inSym} to ${outSym} yet. The pair stays listed; new venues appear as they are added.`,
  noPathAction: 'Add money',
  externalSignTitle: 'One step needs your Ethereum wallet',
  externalSignBody: 'You sign the crossing in your wallet; dpay never holds its keys. Everything else stays in this sheet.',
  signing: 'Signing…',
  awaitingPool: 'Waiting for the pool payout',
  receivedDone: amt => `You received ${amt}`,
  depositLegSent: amt => `${amt} sent to the exchange`,
  depositLegPending: amt => `Sending ${amt} to the exchange`,
  composedOrderLine: (venue, amt) => `Order at ${venue}, payout locked ${amt}`,
  depositRefusedBody: hopSym =>
    `The deposit was refused - the swap went through and your ${hopSym} is untouched. Nothing more will be signed: convert or send the ${hopSym} from its own account.`,

  story: {
    letPoolUse: sym => `Let the pool use your ${sym}`,
    letPoolUseGas: sym => `Let the pool use your ${sym} for gas`,
    swap: (inSym, outSym) => `Exchange ${inSym} for ${outSym}`,
    swapFor: sym => `Exchange for ${sym}`,
    cross: (sym, network) => `Move ${sym} across to ${network}`,
    withdraw: (hopSym, destSym, network) => `Send ${hopSym} out - ${destSym} arrives on ${network}`,
    depositSend: amt => `Send ${amt} to the exchange`,
    depositSent: amt => `${amt} sent to the exchange`,
  },

  sol: {
    heading: (inSym, outSym) => `Convert ${inSym} to ${outSym} (Solana)`,
    counterparty: venue => `Executed by ${venue}.`,
    counterpartySigns: 'Your phone signs the venue\u2019s transaction - nobody else signs anything.',
    priceImpactLine: (pct, venue) => `Price impact: ${pct} (${venue}'s own figure)`,
    solFeeLine: fee => `Solana network fee: ${fee} (to the network, not the venue, not dpay)`,
    refusalLine: sym =>
      `Past the minimum the swap fails whole on-chain - your ${sym} stays in your wallet.`,
    pendingBody: 'The swap is on Solana - this screen resolves on its own.',
    failedBody: (sym, detail) =>
      `The swap failed${detail ? ` (${detail})` : ''} - on Solana nothing moved; your ${sym} is where it was.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `No ${sym}. To convert, receive ${sym} first: open ${receiveTab} below and choose \u201C${myAddress}\u201D.`,
  fundOtherHolds: (held, toSym) => `You hold ${held} - convert that to ${toSym} instead.`,
  fundOtherSwitch: sym => `Convert from ${sym} instead`,
  insufficientLine: (needed, balance) => `${needed} needed, you have ${balance}`,

  approvingTitle: 'Signing',
  approvingBody: (amount, at) =>
    `Letting the pool use only ${amount}. Unused, it expires at ${at}.`,
  swappingTitle: 'Converting',
  swappingBody: 'Your exchange is running - this usually takes a few minutes.',
  settlingTitle: 'Settling',
  settlingBody: sym => `Almost there - waiting for your ${sym}\u2026`,
  doneTitle: 'Done',
  doneBody: amount => `${amount} is in your wallet.`,
  doneTx: tx => `Payout record: ${tx}`,
  pendingTitle: 'Payout pending',
  pendingBody: sym => `The swap was accepted - your ${sym} payout has not arrived yet.`,
  pendingSupport: ref => `If it never arrives, quote this reference to support: ${ref}`,
  stillWatching: 'Still watching for the payout…',
  failedTitle: 'Failed',
  failedApproveBody: sym =>
    `The ledger refused the first signature - nothing moved, nothing to undo. Your ${sym} never left your wallet.`,
  failedSwapBody: (reason, sym) =>
    `The exchange refused the swap (${reason}) - your ${sym} never left your wallet.`,
  refundedTitle: 'Refunded',
  refundedBody: sym =>
    `The pool returned your ${sym} - your balance is whole again.`,
  stuckTitle: 'Unknown outcome',
  // The CHAIN record's phase-1 stuck state (D32): the pool's copy would name a swap that
  // never ran - at this point only the venue DEPOSIT transfer's outcome is unknown.
  chainStuckTitle: 'Deposit outcome unknown',
  chainStuckBody:
    'The deposit was sent but never confirmed. It lands on its own, or it expires - never send it a second time.',
  // The user's Stop (2026-09-19): the button and the frozen-record panel. Short on purpose.
  stop: 'Stop',
  stopWatching: 'Stop watching',
  stopProvider: 'Stop watching',
  abortedTitle: 'Stopped',
  abortedClean: 'Nothing left your wallet.',
  abortedFee: 'You paid a small approval fee.',
  abortedWatching: 'The swap may still go through. Check Balances later.',
  abortedProvider:
    'Watching stopped. No deposit sent \u2192 the trade never started; sent \u2192 the trade may still settle. Check Balances and the venue\u2019s status page - shift id below.',
  stuckBody:
    'Swap submitted - the pool\u2019s answer never arrived. Do not start a second swap.',
  stuckSigned: (amount, minAmount) =>
    `You signed an exchange of ${amount} for at least ${minAmount}.`,
  expiryLine: at => `Expires by ${at}.`,

  awaitingDepositTitle: 'Waiting for the deposit',
  awaitingDepositBody: sym =>
    `Waiting for your ${sym} deposit to land - the exchange starts when it arrives. If it misses the window, the quote expires and your ${sym} stays in your wallet.`,
  providerProcessingTitle: 'Converting',
  providerProcessingBody: sym =>
    `The exchange holds your deposit and is converting it. Your ${sym} arrives when it completes.`,
  quoteExpiredTitle: 'Quote expired',
  quoteExpiredBody: sym =>
    `The quote expired before the deposit arrived - nothing was swapped, and a late deposit is returned. dpay keeps watching in the background and this screen updates on its own. Your ${sym} stays put.`,
  providerRefundedTitle: 'Refunded',
  providerRefundedBody: sym =>
    `The exchange cancelled the order and returned your ${sym}. Watch for it in Balances.`,
  stuckWatching: 'dpay keeps watching - this screen flips on its own when funds move.',
  stuckAcknowledge: 'Understood - stop watching',
  stuckAcknowledged: 'Watch stopped - funds moving later still land at this wallet\u2019s address.',

  stuckReceiptsTitle: 'What happened',
  stuckErrorLine: d => `Error: ${d}`,
  stuckExpiredLine: at => `Expired at ${at}.`,
  stuckExpiredBody:
    'The signed swap can no longer execute. dpay settles this from the evidence above: unsent money stays put; money that moved shows in your balance.',
  stuckLastCheckedLine: at => `Last checked ${at}`,
  failedWindowClosedBody: sym =>
    `The swap could not be confirmed before its window closed - your ${sym} never left your wallet.`,

  evm: {
    heading: (inSym, outSym, chain) => `Convert ${inSym} to ${outSym} (${chain})`,
    feeLabel: unit => `Network fee (${unit}, estimate)`,
    pendingBody: 'The swap is on-chain and confirmed. Waiting for your balance to show it.',
    failedBody: inSym => `Nothing was sent. Your ${inSym} is still in your wallet.`,
    sentFailedBody: 'The swap was sent but stopped before completing. The transaction record below shows what moved; the network fee is spent.',
    stuckBody: outSym => `The swap may or may not have landed. Your ${outSym} balance will resolve on its own; do not start a second swap.`,
  },
  cow: {
    feeLine: fee => `CoW fee (estimate): ${fee}`,
    protocolFeeLine: bps => `plus the venue's volume fee (${bps} bps)`,
    settlingBody: 'The order is with the solvers - it fills in seconds to minutes. This screen resolves on its own; do not start a second swap.',
    failedBody: (inSym, detail) => `The order did not fill (${detail}). Nothing left your wallet - your ${inSym} is still there; the signing permission expires unused.`,
  },
  multihop: {
    destLabel: 'Destination',
    destDirect: sym => `${sym} - your wallet`,
    destRoute: (sym, network) => `${sym} - to your ${network} address`,
    destRouteSol: (sym, network, venue) => `${sym} - to your ${network} address · final step via ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route: ${inSym} → ${hopSym} (to ${network})`,
    destAddressLabel: 'Your address on the destination network',
    destAddressInvalid: 'Invalid address - expected 0x followed by 40 hex characters.',
    destPayoutNote: 'Funds land at your address.',
    destChange: 'Change destination',
    routeHeading: (inSym, hopSym, destSym, network) => `Route: ${inSym} → ${hopSym} → ${destSym} on ${network}`,
    swapPaysLabel: 'The swap pays into this wallet',
    legApprovePull: sym => `Approve the pool to pull your ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Swap ${inSym} → ${hopSym} on ${venue}`,
    legApproveBurn: sym => `Approve the ${sym} burn (the cash-out amount)`,
    legApproveGas: sym => `Approve ${sym} to pay the cash-out gas`,
    legWithdraw: (hopSym, destSym, network) => `Burn ${hopSym} - ${destSym} arrives on ${network}`,
    legStatePending: 'Waiting',
    legStateSent: 'Sent',
    legStateConfirmed: 'Confirmed',
    legStateFailed: 'Refused',
    legProgress: (n, total) => `Step ${n} of ${total}`,
    destInWallet: sym => `${sym} - your wallet`,
    destGroupOther: 'Other destinations',
    mechDirect: 'Direct pool',
    mechViaHub: hubSym => `Via ${hubSym}`,
    mechViaCctp: 'Via Circle CCTP',
    mechViaVenue: venue => `Via ${venue}`,
    mechNoneSelected: 'Pick a mechanism above to see the quote.',
    viaHub: hubSym => `via ${hubSym} · 2 swaps`,
    hubShape: () => '2 swaps',
    routeMinWalletLine: amount => `Min ${amount} balance`,
    hubQuoteSource: (venue1, venue2, at) => `${venue1} + ${venue2} · ${at}`,
    hubCensusHeading: 'Two swaps, itemized',
    approveFeeLine: amount => `Approving the next pool costs ${amount} (the ledger\u2019s own transfer fee)`,
    hubRateLine: (inSym, destSym) => `Combined rate, ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Above the floor, the surplus stays spendable as ${hubSym} or ${destSym}.`,
    gasFeeLine: amount => `Cash-out gas (live quote): ${amount}`,
    routeMinLine: amount => `Min ${amount} at your address`,
    routeSurplusNote: hopSym => `Above the floor, the surplus stays spendable as ${hopSym}.`,
    routeDestEstimate: (amount, sym) =>
      `Lands \u2248 ${amount} ${sym} at your Solana address - the final Jupiter step re-quotes fresh`,
    routeVenues: (icVenue, solVenue) => `Route: ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Gas needed first',
    gasPreflightBody: needed =>
      `The crossing needs about ${needed} of gas money in ckETH - this wallet holds too little. Get ckETH into this wallet first, then come back.`,
    executingTitle: 'Running the route',
    doneRouteTitle: 'Cash-out under way',
    doneRouteBody: (amount, address) => `At least ${amount} is on its way to ${address}.`,
    doneOnItsWay: 'Delivery runs on Ethereum and can take a while - dpay cannot watch that network.',
    failedLegTitle: 'Cash-out refused',
    failedLegBody: (sym, reason) =>
      `The swap went through - you hold ${sym}. The cash-out refused${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Cash out via Pay \u25B8 Send to address - paste any destination address.',
    stuckRouteBody: 'A leg\u2019s outcome is unknown - dpay keeps watching the ledgers; this screen flips on its own.',
    stuckRouteBodyExpired: 'The watch window has closed. dpay settles this from the evidence above.',
    failedHop2Title: 'Second swap refused',
    failedHop2Body: (hubSym, outSym, reason) =>
      `The first swap went through - you hold ${hubSym}. The ${hubSym} \u2192 ${outSym} swap was refused${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Your ${hubSym} are spendable as-is - keep, convert, or send them. Nothing to reverse.`,
    stuckHoldsLine: hubSym => `So far: you hold ${hubSym}.`,
    insufficientHubLine: (needed, balance) =>
      `Needs ${needed} - the amount plus three fees - you have ${balance}.`,
  },

  /** CeFi venues (SideShift widening, 2026-09-15): the deposit handoff screen. The venue
   *  holds the funds mid-trade; the user's own deposit IS the value movement - nothing is
   *  signed by dpay. Every address/amount shown is the venue's own, verbatim. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} on ${network} - via ${venue} (exchange service)`,
    destRowMulti: (sym, network) => `${sym} on ${network}`,
    settleAddressLabel: 'Payout lands at your address',
    settleRailEthereum: 'Pays out native ETH on Ethereum mainnet',
    depositAddressLabel: 'Deposit address',
    depositAmountLabel: 'Exact amount',
    depositMemoLabel: 'Memo (required)',
    counterparty: venue =>
      `Executed by ${venue} - an automated exchange service, not a bank, not dpay.`,
    checklistSigns:
      'Nothing is signed on this phone - after you confirm, you send the deposit to the venue\u2019s address yourself.',
    checklistSignsAuto:
      'After you confirm, this wallet sends the deposit to the venue itself - the trade is the venue\u2019s.',
    refusalLine: sym =>
      `If the deposit never arrives, the order expires - your ${sym} stays in your wallet.`,
    insufficientLine: (needed, balance) =>
      `The deposit needs ${needed} (transfer fee included) - you have ${balance}.`,
    payoutAt: address => `Paid out to your address: ${address}`,
    depositExpiryLine: at => `Order expires ${at}`,
    noExpiryLine: 'No published expiry - dpay keeps watching.',
    lastCheckedLine: at => `Last checked ${at}.`,
    shiftId: id => `Shift ${id}`,
    orderId: id => `Order ${id}`,
    settlingFundsLine: 'Funds confirmed - your payout is locked at the quoted amount.',
    settlingWatchLine: 'Most settle within minutes - dpay monitors every shift and steps in if one stalls.',
    depositNote: (venue, sym) =>
      `Send ${sym} from your wallet to ${venue}\u2019s deposit address above - the exact deposit amount. ${venue} holds it mid-trade, then pays out to your address. dpay is not a party and is paid nothing.`,
    depositAutoNote: (venue, sym) =>
      `The ${sym} deposit is sent to ${venue}\u2019s address automatically - the exact deposit amount. ${venue} holds it mid-trade, then pays out to your address. dpay is not a party and is paid nothing.`,
    stillWaitingDeposit: 'Still watching for your deposit - this page updates on its own.',
    stillWaitingAuto: 'The deposit sends itself once - watching for the venue\u2019s word; this page updates on its own.',
    depositSolFeeNote: 'The deposit also pays a small network fee in SOL - keep a little SOL.',
    solInsufficientLine: (needed, balance) =>
      `The deposit sends ${needed} - you have ${balance}.`,
    noQuoteTitle: 'No live market',
    noQuoteBody: 'This pair has no live market right now. Pick another venue or try again later.',
    minDepositBody: (venueMessage, min) =>
      `This amount is below the exchange's minimum: \u201C${venueMessage}\u201D (minimum ${min}). Raise the amount and try again.`,
  },

  /** The chain family (2026-09-28, the any-pair mandate): one consent, two phases - the
   *  venue order + the signed deposit first, the IC legs from the frozen plan second. */
  chain: {
    depositSending: 'Sending your deposit',
    orderLine: (venue, depositAmt, midSym) => `Order at ${venue}: ${depositAmt} in, ${midSym} out`,
    depositSent: (depositAmt, midSym) => `${depositAmt} sent - waiting for the ${midSym} payout`,
    phase2Note: 'The second leg runs itself once the payout lands.',
    phase2Leg: (midSym, outSym, venue) => `Then ${midSym} → ${outSym} via ${venue} - quoted fresh when the payout lands`,
    rowShape: midSym => `via ${midSym}, converts in one tap`,
    phase2Failed: midSym => `The second leg could not run - you hold ${midSym}. Convert it normally (pre-selected).`,
    depositFailed: sym => `The deposit never landed on-chain - your ${sym} never left your wallet.`,
  },

  /** The cross-rail family (Routes B/C, 2026-09-16): everything past the five IC legs -
   *  the CCTP handoff (dpay renders the exact transactions, the USER's own Ethereum wallet
   *  signs; dpay never holds an EVM key), the Circle attestation watch, and Route C's
   *  final Jupiter offer. Every dead-end names where the funds sit and the exit. */
  crossrail: {
    heading: 'Sign in your Ethereum wallet',
    handoffIntro: (amount) =>
      `IC part done: ${amount} is at your Ethereum address. Your wallet crosses it - dpay never touches your Ethereum keys.`,
    stepApproveLabel: 'Step 1 - let Circle\u2019s contract move the USDC',
    stepBurnLabel: 'Step 2 - burn the USDC for the Solana transfer',
    txAmountLabel: 'Amount',
    copy: 'Copy',
    copied: 'Copied',
    approveHint: 'Lets Circle\u2019s TokenMessenger move only these USDC.',
    burnHint: 'Locks the USDC on Ethereum; Circle\u2019s bridge mints the same USDC at your Solana address - no wrapped token.',
    timingNote: 'Fast path: seconds to a few minutes (measured ~20 s). If Ethereum is busy, longer - this screen updates on its own.',
    externalGasLine: 'Gas is paid from your wallet\u2019s ETH - dpay cannot pay it or quote it in advance.',
    circleFeeLine: fee => `Circle\u2019s bridge fee (its own figure, from the amount): at most ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Min ${floor} ${sym} at your Solana address - the final step swaps it onward`,
    mintFloorDestLine: (floor, sym) => `Min ${floor} ${sym} arrive at your Solana address`,
    burnTxLabel: 'Burn tx hash (from your wallet)',
    burnTxPlaceholder: '0x…',
    attachButton: 'I signed it - watch the crossing',
    burnTxInvalid: 'Not an Ethereum transaction hash.',
    declineButton: 'I\u2019m not signing',
    whatSigning: 'You sign two ordinary Ethereum transactions in your wallet: an approval, then the burn. Nothing is signed on dpay\u2019s side.',
    crossingTitle: 'Crossing to Solana',
    crossingBody: 'Your USDC is crossing to Solana - the bridge mints it at your address. This screen updates on its own.',
    viewBurnTx: 'View the burn transaction',
    viewCircle: 'Circle\u2019s status page',
    stillCrossing: 'Still pending - not failed. Fast path: seconds to minutes; if Ethereum is congested, longer.',
    solReadyTitle: 'USDC landed on Solana',
    solReadyBody: (credit, ata) => `${credit} verified at ${ata}. Finish the route, or keep the USDC - yours either way.`,
    abortedCrossing: ata =>
      `Watch stopped. The crossing is out - it may still complete the mint; the USDC lands at your Solana address ${ata} either way. Check Balances later.`,
    abortedSolReady: ata =>
      `Nothing was signed - the final swap never ran. Your USDC sits at your Solana address ${ata}: keep it, or convert it there.`,
    solQuoteLabel: venue => `${venue} quote`,
    solMinLine: (min, sym) => `Min ${min} ${sym} at your address`,
    solConfirmButton: sym => `Swap to ${sym}`,
    solFeeLine: fee => `Solana fee: ${fee}`,
    solPreflightTitle: 'SOL needed for the fee',
    solPreflightBody:
      'The swap\u2019s fee is paid in SOL and this wallet holds none. Add a little SOL - the USDC stays put.',
    doneTitle: 'Converted',
    doneBody: (amount, sym, address) => `${amount} ${sym} is at your Solana address ${address} - verified on-chain.`,
    doneVia: (icVenue, solVenue) => `Via ${icVenue}, Circle and ${solVenue}.`,
    declinedTitle: 'Handoff cancelled',
    declinedBody: address =>
      `Nothing crossed. Your USDC sits at your Ethereum address ${address} - send it anywhere, or run this route again later.`,
    solFailedTitle: 'Solana swap failed',
    solFailedBody: ata =>
      `The USDC crossed - it is at your Solana address ${ata}. The final swap was declined: try again in a moment, or keep the USDC.`,
    legCctpBurn: (sym, network) => `Cross ${sym} to ${network} via Circle (you sign this in your wallet)`,
    legSolSwap: (venue, sym) => `Swap for ${sym} on ${venue}`,
    destAddressCrossNote: 'This address also signs the crossing - paste an address you control.',
    // Swap-typing stage 2 (2026-10-03): the destination IS the device's own address, so the
    // device signs the crossing itself - the disclosure and the address note fork on it.
    deviceSignTitle: 'Your device signs the crossing',
    deviceSignBody: 'This wallet\u2019s own key signs the crossing - no other wallet, no extra step. Keep a little ETH at the payout address for its gas.',
    destAddressDeviceNote: 'Your device signs the crossing - keep a little ETH for its gas.',
    // The stage-2 dead end: the device burn refused at its own gate (gas short, a reverted
    // leg, a refused broadcast) AFTER the five IC legs ran - the USDC is at the EVM address.
    burnFailedBody: (address, reason) =>
      `The crossing was refused before anything left. Your USDC sits at your Ethereum address ${address}${reason ? `: ${reason}` : ''} - send it anywhere, or run this route again later.`,
    checksumMismatch: 'Checksum mismatch',
    retypeAddress: 'Re-type the address',
    retypeMismatch: 'Does not match',
    gasFundTitle: 'Needs ETH gas you don\u2019t have',
    gasFundNeed: eth => `Need \u2248 ${eth}`,
    gasFundHave: eth => `Your wallet: ${eth}`,
    gasFundWalletButton: 'Fund from this wallet',
    gasFundSelfButton: 'I\u2019ll fund it myself',
    gasFundSelfMin: eth => `Send \u2265 ${eth} to:`,
    gasFundRecheck: 'Check again',
    gasFundShort: short => `Still ${short} short`,
    gasLegsNote: 'First legs fund the gas.',
    abortedGasBody: 'The gas funding landed, untouched. The conversion never ran.',
    declinedWithGasBody: address => `Nothing crossed. Your USDC is at your Ethereum address ${address}; the gas funding is untouched.`,
    gasShortFailedBody: needed => `The gas funding fell short of ${needed}. Nothing left this wallet - the conversion never started.`,
  },

  errors: {
    quoteUnreachable: 'The exchange is unreachable right now. Check your connection and try again in a moment.',
    quoteRefused: 'No quote for this pair right now. Try again in a moment.',
    buildRefused: 'The exchange could not be prepared. Nothing moved - try again in a moment.',
    quoteUnavailable: code => `Quote unavailable (code ${code}).`,
    quoteUnconfigured: 'No exchange is set up on this relay for this pair yet - nothing is wrong with your wallet.',
    gasUnavailable: 'The gas price was unavailable - nothing was signed. Try again.',
    cctpFeeUnavailable: 'The crossing fee could not be fetched - nothing was signed. Check your connection and try again.',
    chainDepositUnreadable: 'The deposit address could not be verified on Solana - nothing was signed. Check your connection and try again, or send the deposit from your wallet.',
    chainSenderEmpty: sym => `No ${sym} token account - nothing was signed. Receive ${sym} first.`,
    chainSenderShort: sym => `The wallet\u2019s ${sym} balance does not cover this amount - nothing was signed.`,
    chainRentShort: sym => `The venue\u2019s ${sym} account needs a little SOL for rent - the wallet is short. Nothing was signed; top up SOL and try again.`,
  },
};
