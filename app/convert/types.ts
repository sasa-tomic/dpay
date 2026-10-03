// --- the §4 state machine record -------------------------------------------------------------------

// PRE-BROADCAST INVARIANT (2026-09-24): NO record exists before the user's confirm tap.
// Every prepare*Record runs AT the confirm gesture and only then hands the record to the
// engine (adoptConvertRecord); going back at review discards in-memory state — nothing was
// persisted, so there is nothing to clean up (pinned by jest: convertMode.test.tsx and
// convertCefiConfirm.test.tsx). The ONE pre-broadcast side effect is CeFi's, and the copy
// says so honestly: confirming CREATES the venue order (the record is born at
// `awaiting_deposit`), so a Stop after confirm does not un-create it — the abort copy
// (`convert.abortedProvider`) names that the order dies unfunded at the venue if the
// deposit never went out.

export type ConvertStep =
  | 'quote' | 'confirming' | 'approving' | 'approved' | 'swapping' | 'settling'
  | 'done' | 'pending_withdrawal' | 'failed_refunded' | 'failed_leg' | 'stuck'
  // The user's Stop tap (2026-09-19): the record freezes where it is and no driver ever
  // re-enters it. The body copy is derived from the legs (convertAbortFlavor).
  | 'aborted'
  // CeFi-shaped states (multi-venue readiness V2): round-tripped by hydration today; the
  // drivers that move a record INTO them arrive with the CeFi wave. Kept snake_case like
  // the rest of the persisted vocabulary.
  | 'awaiting_deposit' | 'provider_processing'
  | 'quote_expired' | 'provider_refunded'
  // The cross-rail widening (2026-09-16, Routes B/C): the CCTP phases that follow the
  // five IC legs. `awaiting_external` = the user's own EVM wallet must sign approve+burn
  // (dpay never holds EVM keys — the record waits on USER action, no driver advances it);
  // `crossing` = the burn tx hash is known and Circle's attestation/mint is being watched;
  // `sol_ready` = the USDC mint landed and is verified at the ATA, and the final Jupiter
  // leg is OFFERED for the user to confirm on a fresh quote (Route C only).
  | 'awaiting_external' | 'crossing' | 'sol_ready';

/** The EVM widening (2026-09-28, the any-pair mandate): the FROZEN facts of a Uniswap V3
 *  swap the device signs on the EVM rail (an `evm_amm` venue row — config/evmAmm.ts). The
 *  executor re-derives the tx sequence from THESE facts alone at drive time (nonces move, so
 *  EVM legs are signed at execution, never frozen — the Solana leg's mirror exception), and
 *  the record's own rail ids (`evm:<chainId>:<address>`, `evm:native-eth:<chainId>`) make a
 *  cross-chain execution structurally impossible. dpay never custodies: the device key signs,
 *  gas is the user's own, the gas-honesty gate runs BEFORE any signature. */
export type EvmSwapLeg = {
  protocol: 'evm';
  chainId: number;
  /** The evm_amm venue row id (looked up via venueOfId at drive time — never assumed). */
  venueId: string;
  /** Rail-canonical ids (the record's inLedger/outLedger carry the SAME strings). */
  inRailId: string;
  outRailId: string;
  /** Token contracts, lowercase ('' = the chain's native gas on the OUT side → the unwrap
   *  path; native IN is not derived yet). */
  tokenIn: string;
  tokenOut: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  /** Raw amounts: the exact input the approve leg sizes, and the slippage FLOOR the swap
   *  leg signs (the D31 5%-headroom lesson generalized: min-out from the quote + bps). */
  amountIn: string;
  minOut: string;
  feeTier: number;
  /** Absolute unix seconds — the multicall deadline (the trade's own expiry). */
  deadlineSecs: number;
  slippageBps: number;
  /** The WETH-hub composition's frozen facts (present iff the quote was the hub fallback —
   *  no direct pool answered). The executor builds the 2-leg plan from them. */
  hub?: {feeTierLeg1: number; feeTierLeg2: number; minOutLeg1: string};
  /** The OUT rail's pre-trade raw balance (the realized-credit baseline; null fails open). */
  preOutRaw?: string;
  /** Durable identity per broadcast leg, in order (approve, swap, …) — the crash-safe
   *  watch keys; the EVM twin of `outTx`/`hopTx`. */
  txHashes?: string[];
};

/** ONE signed IC update, frozen at prepare time. The executor only ever re-submits the
 *  envelope bytes; `argHex` is kept for audit/recovery, not re-signing. */
export type SignedLeg = {
  canister: string; // update target principal (the input ledger for the approve; the venue pool for the swap)
  method: string; // the update method ('icrc2_approve' | 'depositFromAndSwap' today)
  argHex: string; // '' only on legs migrated from a pre-legs record (its envelope froze the args)
  envelopeHex: string; // the SIGNED envelope bytes — the only thing retries re-submit
  requestIdHex: string; // the request id — the on-chain dedup key
  expiresAtMs: number; // ms form of this leg envelope's OWN ingress expiry — the certified-clock submit-death (the failure-screen countdown)
};

/** A CeFi provider's handle on an order it issued (the empty-legs record shape). */
export type ProviderRef = {
  orderId: string;
  statusUrl?: string;
  /** The RELAY's own order id for this trade (the `X-Dpay-Order-Id` response header echoed
   *  at trade creation, 2026-09-22 partner agreement): the correlation key the relay records
   *  next to the venue's trade id (its order store + compliance log), and the `webhook_key`
   *  its webhook-first status push is keyed on. Absent on every pre-agreement record and on
   *  the sideshift family (whose status read never touches the relay) — optional, so legacy
   *  records hydrate byte-identically. */
  relayOrderId?: string;
};

/** The CeFi handoff facts (the SideShift widening, 2026-09-15): what the USER must do
 *  with their own funds, frozen at order creation and displayed VERBATIM. This is the
 *  honest CeFi boundary made data: `depositAddress` is the VENUE's own address — the
 *  user sends to it from their wallet, dpay signs nothing and holds nothing mid-trade.
 *  `depositAmount` is the EXACT figure the fixed order prices (a fixed shift settles
 *  only this deposit; anything else refunds). `depositMemo` must ride the deposit when
 *  the venue issues one (their wire: a deposit without its memo is lost). All strings
 *  are the provider's own, never reformatted. */
export type ProviderDeposit = {
  /** The venue's deposit address — where the USER sends. Not a dpay address, ever. */
  depositAddress: string;
  /** The venue's memo/tag when its wire requires one on the deposit. */
  depositMemo?: string;
  /** The exact deposit amount (decimal string, venue units) the fixed order prices. */
  depositAmount: string;
  /** When the order dies unfunded (ms; the venue's own expiresAt, parsed). */
  expiresAtMs?: number;
};

/** ONE signed Solana transaction — the Solana rail's widening of the leg vocabulary (Jupiter,
 *  2026-09-15; the per-leg protocol discriminator design: ONE record shape, per-leg protocol).
 *  A Solana venue does not hand the wallet two update calls to sign — it hands it ONE
 *  pre-assembled transaction around its route, so ONE leg is the whole truth. Field-for-field
 *  the SignedLeg analogs: `signedTxHex` is the envelopeHex (the only bytes retries re-submit —
 *  identical, chain-deduped), `signature` is the requestIdHex (the on-chain identity), and
 *  `lastValidBlockHeight` is the expiresAtMs (the venue-declared death of the tx's
 *  recent-blockhash: past that height the bytes can never land, and recovery NEVER resubmits
 *  them — it only watches). */
export type SolanaSwapLeg = {
  protocol: 'solana';
  /** The SIGNED transaction bytes, lowercase hex. Frozen at prepare; never re-signed. */
  signedTxHex: string;
  /** The transaction's base58 signature — its on-chain identity and dedup key. */
  signature: string;
  /** The last block height at which the tx's blockhash is still valid (Jupiter's own figure). */
  lastValidBlockHeight: number;
};

/** The cross-rail widening (2026-09-16, Routes B/C of the feasibility doc): what the
 *  record knows about the CCTP leg that follows the five IC legs. dpay builds the burn
 *  calldata and renders it for the USER's own EVM wallet to sign — no EVM key ever lives
 *  in dpay (the module header's non-negotiable). Durable facts only; everything else is
 *  re-derived from the record's own frozen numbers or fetched live:
 *  - the burn AMOUNT is the IC route's minOut (convertRecordMinOut — deterministic);
 *  - the mint RECIPIENT is deriveAta(solAddress, USDC mint), re-derived and re-verified
 *    at every handoff render;
 *  - Circle's fee is fetched live (at confirm for the census, again at handoff for the
 *    signed maxFee — the census copy says both). */
export type CrossRailInfo = {
  /** 'cctp' = Route B (ends at USDC on Solana); 'cctp_sol' = Route C (+ the Jupiter leg). */
  kind: 'cctp' | 'cctp_sol';
  /** Swap-typing stage 2 (2026-10-03): who signs the burn. 'device' = the destination IS the
   *  device's own derived EVM address, so the device key signs approve + depositForBurnWithHook
   *  itself and the record never parks at `awaiting_external`. 'external' = the user named
   *  another wallet (Change destination); the handoff panel owns the burn, exactly as before.
   *  Optional + additive: every record written before stage 2 hydrates byte-identically and
   *  reads as 'external' (the handoff is the legacy behavior). */
  burnSigner?: 'device' | 'external';
  /** The device-derived Solana address — the owner whose USDC ATA receives the mint. */
  solAddress: string;
  /** The USDC ATA (base58) the burn names as its mint recipient (display + the credit
   *  verification's account). Frozen at prepare; re-derivation must match or the handoff
   *  refuses to render. */
  mintRecipientAta: string;
  /** Circle's fee census AT CONFIRM (maxFee incl. the 20% buffer, USDC base units) and
   *  the honest mint floor it implies. The signed maxFee is re-fetched live at handoff. */
  maxFeeSubunits?: string;
  mintFloorSubunits?: string;
  /** The Ethereum burn tx hash once the user's wallet has signed (the status-watch key). */
  burnTxHash?: string;
  /** Circle's destination forward tx (a Solana signature) once the mint executed. */
  forwardTxHash?: string;
  /** The VERIFIED USDC credit at the ATA when the mint landed (SOL-rail read). */
  mintSubunits?: string;
  /** Route C's final leg: the registered Jupiter venue id (frozen at prepare from the
   *  route — the record's own `venueId` stays the IC venue the five legs traded on). */
  solVenueId?: string;
  /** The Jupiter leg's own min-out floor (lamports), frozen when the leg is signed.
   *  The native-SOL shape — an SPL-out record freezes `solExpectedSubunits` instead,
   *  and the two shapes are mutually exclusive (hydration refuses both). */
  solExpectedLamports?: string;
  /** The SPL-out widening (2026-09-19, any registered USDC↔token venue — e.g. EURC):
   *  the final leg's OUT mint + its decimals, frozen at prepare from the route. Absent
   *  on a native-SOL record — the out mint is WRAPPED_SOL_MINT_ADDRESS by construction
   *  there. All optional, so native-SOL records keep their exact bytes. */
  solOutMint?: string;
  solOutDecimals?: number;
  /** The Jupiter leg's own min-out floor for an SPL out, in the OUT MINT's base units,
   *  frozen when the leg is signed. Requires solOutMint+solOutDecimals (hydration). */
  solExpectedSubunits?: string;
};

/** ONE gas-FUNDING pre-leg (2026-09-20, the cross-rail gas widening): the frozen facts of
 *  the ordinary approve+swap pair that moves an in-wallet IC asset INTO the gas ledger
 *  (ckETH) ahead of the route's own legs. Exactly the hub-leg shape plus the two signed
 *  amounts — no new leg kind, no new arg builder (the mandate's red line). */
export type GasFundPreLeg = {
  venueId: string;
  pool: string;
  fromLedger: string;
  toLedger: string;
  /** The raw amount the pre-swap pulls (the approve covers this + the from-ledger fee). */
  inAmount: string;
  /** The leg's own slippage floor (raw out-units of `toLedger`) — leg i+1 is QUOTED on
   *  leg i's minOut, the same compounding-floor rule the hub record freezes. */
  minOut: string;
};

/** The record's frozen `gasPre` block: the funding target (fresh feeWei + 20% headroom at
 *  prepare, the CCTP forward-fee buffer convention) and the pre-legs IN ORDER — leg i's
 *  toLedger is leg i+1's fromLedger, the last lands on the burn route's gasLedger. */
export type GasFundPlan = {
  neededWei: string;
  legs: GasFundPreLeg[];
};

/** What resolution hands the SIGNER, on top of the frozen record shape: each pre-leg's
 *  live direction flag (read per quote, never assumed) and the two ledger fees the
 *  approve/swap args carry. The record stores only the frozen `GasFundPlan` subset. */
export type ResolvedGasFundPlan = GasFundPlan & {
  legs: Array<GasFundPreLeg & {zeroForOne: boolean; fromFee: string; toFee: string}>;
};

/** The composed IC→CeFi widening (2026-09-26, design brief §5.4 item 2): the CeFi DEPOSIT
 *  facts of a composed route's final leg, frozen at order creation and re-verified before
 *  the transfer may ever sign. The venue's order is created FIRST (its own deposit address
 *  + locked figure are known before anything signs), the IC legs + the deposit transfer are
 *  then signed in one pass (the user consents once on the review), and the engine submits
 *  the deposit transfer as the LAST leg: to the VENUE's own address, for the EXACT order
 *  amount. Every string the venue issued is carried verbatim. dpay is never a party: the
 *  order is the user's, the deposit is the user's signed transfer, the payout lands at the
 *  user's own settle address. */
export type ComposedDepositInfo = {
  /** The cefi venue that holds the order (registry id — looked up, never assumed). */
  venueId: string;
  /** The venue's order id — providerRef.orderId's twin (one order, one id). */
  orderId: string;
  /** The VENUE's own deposit account, VERBATIM (ICRC-1 account text or the ICP ledger's
   *  64-hex account identifier — whichever the venue issued). The transfer signs to it. */
  depositAddress: string;
  /** The parsed owner of that account (the ledger-row match key for the sent evidence). */
  depositOwner: string;
  /** The venue's decimal figure for the exact deposit (verbatim, never reformatted). */
  amountDecimal: string;
  /** The SAME amount in raw hub-ledger units — what the signed transfer moves. */
  amountRaw: string;
  /** The hub ledger's own transfer fee the leg signed (paid on top, never out of the order). */
  fee: string;
  /** When the venue's deposit window dies (its own order expiry, parsed) — past it the
   *  transfer must never be submitted: the venue would not credit the order. */
  expiresAtMs?: number;
  /** The venue's memo/tag when its wire requires one on the deposit (rides the transfer). */
  depositMemo?: string;
  /** The settle side's display facts (from the composed route's registry resolution). */
  settleSymbol: string;
  settleDecimals: number;
  /** The venue's own locked settle figure, decimal (verbatim) — the honest order-side
   *  number beside the rate attribution. */
  settleAmountDecimal?: string;
  /** The same settle figure in raw settle units — the done-state fallback when the venue's
   *  completed status carries no amount. */
  settleAmountRaw?: string;
  /** Durable identity of the deposit leg's ledger row once the transfer is known-sent
   *  (the settled block index, else the history row's identity). */
  sentTx?: string;
};

/**
 * The CHAIN widening (2026-09-28, the any-pair mandate): the record block of a cefi-FIRST
 * chain (a SOL-rail source → a cefi venue's order → the mid IC ledger → registered IC legs
 * → the IC target). Phase 1 is the composed flow reversed: the venue order exists BEFORE
 * any signature (its deposit address + locked figures are facts first), then ONE device-
 * signed Solana deposit transfer (the frozen `solanaLeg` — same leg shape every Solana
 * record carries) funds it, and the provider poll owns the wait. Phase 2 — the IC legs —
 * CANNOT be pre-signed (an IC envelope dies at its own +300 s ingress expiry; a venue
 * settles on minutes): the block freezes the LEG PLAN (venues, pools, ordered pairs) at
 * confirm and the engine signs phase 2 ONLY from that frozen plan, on a fresh quote, when
 * the venue's completion names the settle. Every venue-issued string is carried verbatim.
 * dpay is never a party: the order is the user's, the deposit is the user's signature,
 * the IC legs are the user's signatures.
 */
export type ChainRouteInfo = {
  /** The cefi venue that holds the order (registry id — record.venueId's twin, pinned). */
  venueId: string;
  /** The venue's order id — providerRef.orderId's twin (one order, one id). */
  orderId: string;
  /** The VENUE's own Solana deposit address, VERBATIM (base58). The transfer signs to it. */
  depositAddress: string;
  /** The venue's decimal deposit figure (verbatim, never reformatted). */
  amountDecimal: string;
  /** The SAME amount in raw mint units — what the signed transfer moves. */
  amountRaw: string;
  /** The venue's memo/tag when its wire requires one (rides the transfer). */
  depositMemo?: string;
  /** When the venue's deposit window dies (its own order expiry, parsed). */
  expiresAtMs?: number;
  /** The venue's own locked settle figure, decimal (verbatim) — phase 2's input amount. */
  settleAmountDecimal?: string;
  settleAmountRaw?: string;
  /** The venue's settle evidence once its status names the payout (tx hash / id). */
  settleTx?: string;
  /** The phase-2 plan, frozen at confirm: the IC legs in execution order — leg 0's
   *  fromLedger is the venue's settle ledger, the last leg's toLedger is the record's
   *  outLedger. The engine quotes + signs these EXACT pairs, never others. */
  icLegs: Array<{venueId: string; pool: string; fromLedger: string; toLedger: string}>;
  /** Each IC leg's FROM-ledger transfer fee (a catalog fact, frozen like every other
   *  number the plan signs with) — the self-funding rule's own inputs at phase time. */
  icFromFees: string[];
};

export type ConvertRecord = {
  id: string;
  createdAtMs: number;
  step: ConvertStep;
  venueId: string; // WHICH venue executes (registry key — facts are looked up, never assumed)
  /** IC-catalog currency ids of the in/out assets. Absent on a Solana-shaped record
   *  (`solanaLeg`): the Solana rail has no numeric catalog currency — `inLedger`/`outLedger`
   *  carry the MINTS and the symbols carry the display. */
  inCurrency?: number;
  outCurrency?: number;
  /** IC records: ledger principals. Solana records: MINTS (wrapped-SOL for native SOL). */
  inLedger: string;
  outLedger: string;
  inSymbol: string; // backing native symbol for copy ("which asset the user holds")
  outSymbol: string;
  /** Each leg's ledger decimals, frozen at prepare (ADDITIVE, 2026-09-11): the state screens
   *  format `amountIn`/payouts/min-out through THEM, never a hardcoded 8. Records prepared
   *  before the field existed (and every legacy-migrated v1 record) carry none — renderers
   *  fall back to 8, the e8s world those records were signed in (every ledger the venue
   *  registry serves today is 8-decimal anyway). */
  inDecimals?: number;
  outDecimals?: number;
  amountIn: string; // raw e8s the venue pulls (raw in-units for Solana — lamports for SOL)
  expectedGross: string; // venue quote at confirm (gross)
  expectedNet: string; // gross − output fee (the end-state line); on Solana: the venue's own min-out floor
  inFee: string;
  outFee: string;
  slippageBps: number;
  legs: SignedLeg[]; // the signed updates, in submission order; EMPTY for a CeFi-shaped record
  /** The Solana widening (2026-09-15): ONE signed Solana swap transaction, present iff the
   *  record is Solana-shaped (mutually exclusive with legs>0, legPlan, and providerRef —
   *  hydration pins all three). `inFee`/`outFee` are '0' on this shape (no ledger fees); the
   *  Solana network fee is a separate fact (`solFeeLamports`, paid in SOL by the fee payer). */
  solanaLeg?: SolanaSwapLeg;
  /** The EVM widening (2026-09-28): present iff the record is EVM-shaped (mutually exclusive
   *  with solanaLeg, legs>0, and providerRef — hydration pins all of them). The device signs
   *  the legs AT EXECUTION from these frozen facts (nonces move); `evmSwap.txHashes` carries
   *  each broadcast leg's durable identity as it lands. */
  evmSwap?: EvmSwapLeg;
  /** The realized Solana network fee quote for the swap tx (lamports, SOL-paid), frozen at
   *  prepare — the honest fee line on the Solana done/failure screens. */
  solFeeLamports?: string;
  /** The multi-hop widening (2026-09-14 spec §3): a parallel per-leg plan, ADDITIVE — direct
   *  2-leg records carry none and keep their exact historical bytes and behavior. Present
   *  iff the record was prepared as a route; same length as `legs` on an IC-only route
   *  (Route A), or `legs` + the cctp_burn (+ sol_swap) entries on a cross-rail route. */
  legPlan?: LegPlan[];
  /** Route facts a failure/done screen must name (spec §4): the destination address the
   *  burn leg signed, the symbol + network that arrive there, and the hop asset the user
   *  holds in-wallet if the route dies mid-way. */
  destAddress?: string;
  destSymbol?: string;
  destNetwork?: string;
  hopLedger?: string;
  hopSymbol?: string;
  hopCurrency?: number;
  hopDecimals?: number;
  gasSymbol?: string; // the gas token's display symbol (ckETH) — the gas leg's census units
  gasDecimals?: number;
  /** The minter's live gas quote the approve_gas leg signed, plus the swap hop's venue fee
   *  tier (echoed verbatim from the quote — the leg census renders it as the swap leg's fee). */
  gasFeeWei?: string;
  feeMillionths?: number;
  /** Durable identity of the hop-ledger payout row that confirmed the swap leg (the
   *  ledger-watch evidence — never the #ok alone, spec §4). Set when the row is SEEN. */
  hopTx?: string;
  /** The IC hub 2-hop widening (2026-09-18, spec §11): the SECOND swap's facts — its venue,
   *  the destination ledger, and the quote figures its own watch + min-out derive from.
   *  Present iff the record was prepared on a hub route (legPlan = approve/swap/approve/swap).
   *  All optional: direct + Route A/B/C records never carry them (byte-identical history). */
  venue2Id?: string;
  destLedger?: string;
  destCurrency?: number;
  destDecimals?: number;
  destFee?: string; // the DEST ledger's own transfer fee — swap2's out fee
  expectedGross2?: string; // quote2's gross (quoted on minOut1 as its input — the compounding floor)
  expectedNet2?: string; // gross2 − destFee
  feeMillionths2?: number; // venue2's own fee tier, echoed verbatim
  /** Durable identity of the DEST-ledger payout row that confirmed swap2 — `outTx`'s twin
   *  for a hub record (whose `out*` fields name the HUB, the first watchable ledger). */
  destTx?: string;
  providerRef?: ProviderRef; // required when legs is empty; ignored otherwise
  /** The CeFi handoff block — present iff the record was prepared as a CeFi order
   *  (empty legs + providerRef): the venue's deposit facts the state screen shows
   *  verbatim. Hydration validates it exactly like the record's other money fields. */
  providerDeposit?: ProviderDeposit;
  outAmountNet?: string; // actually-received amount (from the ledger row) when done
  outTx?: string; // durable identifier of the incoming output-ledger row when done
  /** Durable identity of the input-ledger refund row a `failed_refunded` resolution consumed —
   *  the record's CLAIM on that row, so a sibling record's probe can never match the same
   *  refund twice (the refund-side twin of `outTx`). */
  refundTx?: string;
  /** Set by the USER's acknowledge tap on a `stuck` record (V6): the outcome is unknown, the
   *  user has read the instructions, and the background watch may stop. Until it is set, an
   *  expired-unconfirmed stuck record keeps being probed at the engine's slow cadence. */
  acknowledgedStuckAtMs?: number;
  /** Set when the USER taps Stop (2026-09-19): the record freezes where it is. What the stop
   *  cost is derived from the legs (convertAbortFlavor), not stored. */
  abortedAtMs?: number;
  /** The step the record sat at when Stop was tapped. The abort rewrites `step` to 'aborted',
   *  which erases the flight position a DIRECT record's stop cost is derived from (its legs
   *  carry no legPlan states — convertAbortFlavor reads this instead). Planned and Solana
   *  records never need it: their flavor reads survive the rewrite untouched. */
  abortedFromStep?: ConvertStep;
  /** The cefi-deposit handoff marker (2026-10-02 P0): set when the record-lifecycle deposit
   *  sender TOOK this record's IC-source deposit — persisted BEFORE the transfer envelope
   *  leaves, so a kill mid-send can never double-send after a restart (a rebuilt envelope is
   *  a fresh transfer, and a fresh transfer is a second spend). Additive and optional: every
   *  record prepared before it existed hydrates byte-identically. */
  depositSentAtMs?: number;
  /** The setup-ownership link (2026-10-02 P0): the absent-mint targets of the ONE-TAP setup
   *  run that adopted this record, frozen on adopt. Non-setup records (a plain convert)
   *  never carry it — so the setup card's LIVE state keys on the intersection with the
   *  CURRENT plan's targets: a record holds the card exactly while its own accounts are
   *  still absent, and never hijacks a card its conversion does not serve. */
  ataTargetMints?: string[];
  /** The cross-rail block (Routes B/C): present iff the record was prepared on a route with
   *  a CCTP leg; extends the five IC legs with the external-signature burn and (Route C)
   *  the final Jupiter leg. */
  crossRail?: CrossRailInfo;
  /** The gas-fund widening (2026-09-20): present iff the intent was prepared WITH gas
   *  funding — the pre-legs are the FIRST entries of `legs`/`legPlan` (two per pre-leg,
   *  approve then swap), and the executor re-checks the ACTUAL in-wallet gas-ledger
   *  balance against `neededWei` before the approve_gas leg may run. Hydration pins the
   *  whole shape (legs.length === pre-legs×2 + 5, the approve/swap rhythm, the ledger
   *  chain). Absent on every record this build wrote before it — byte-identical history. */
  gasPre?: GasFundPlan;
  /** The composed IC→CeFi widening (2026-09-26, brief §5.4 item 2): present iff the record
   *  was prepared on a COMPOSED route — three legs (approve, swap, deposit_transfer) plus
   *  a providerRef the final phase polls. Mutually exclusive with crossRail, solanaLeg and
   *  gasPre (hydration pins all three). */
  composedDeposit?: ComposedDepositInfo;
  /** The CHAIN widening (2026-09-28): present iff the record was prepared on a CHAIN
   *  route — the cefi order + the signed Solana deposit leg come FIRST, the IC legs are
   *  signed at phase time from the frozen plan. Carries solanaLeg + providerRef from
   *  birth; `legs` is empty until phase 2 signs (then 2 or 4 approve/swap legs). */
  chainRoute?: ChainRouteInfo;
  failureCode?: 'approve_refused' | 'swap_refused' | 'refunded' | 'withdraw_refused' | 'unknown'
    // The cross-rail additions: the user declined/abandoned the external signing step
    // (funds sit as USDC at their OWN EVM address — the copy names it).
    | 'external_declined'
    // The gas-fund addition: the funding did not deliver (a pre-leg refused, or the
    // post-pre-leg balance re-check came up short) — the MAIN conversion has not started
    // and every source value sits in-wallet. The failed card names the shortfall.
    | 'gas_short'
    // The composed-deposit addition (2026-09-26): the deposit transfer was refused at a
    // gate or by the ledger, ONCE, and was never retried — the swap payout (the hub
    // asset) is still in the wallet and the failure names that exit.
    | 'deposit_refused'
    // The stuck-expiry resolution (2026-10-02 POCO P0): the swap could not be confirmed
    // before its signed window closed and the input is verifiably still in the wallet —
    // nothing left, there was nothing to refund, and the body says exactly that.
    | 'window_closed';
  failureDetail?: string;
};

/** What one leg of a route DOES (the label key for copy + the executor's decode dispatch).
 *  Wave-1 vocabulary (docs/specs/2026-09-14-multihop-conversion-spec.md §1): the two approve
 *  kinds share 'approve' — which asset is being approved for whom is the leg's canister +
 *  position, never a third kind. The cross-rail widening (2026-09-16): `cctp_burn` is an
 *  EXTERNAL-signature leg (no device signature — it tracks the user's own EVM wallet tx,
 *  its hash, and Circle's mint status; `canister` is '' because no IC canister is called)
 *  and `sol_swap` is the final device-signed Jupiter leg (same shape the standalone Solana
 *  convert signs — `canister` '' likewise). */
export type LegKind = 'approve' | 'swap' | 'approve_gas' | 'withdraw_erc20' | 'cctp_burn' | 'sol_swap'
  // The composed IC→CeFi widening (2026-09-26): the final device-signed transfer that funds
  // the venue order — an icrc1_transfer (or the ICP ledger's legacy transfer, when the
  // venue's deposit address is a 64-hex account identifier) to the VENUE's own address for
  // the EXACT order amount. Submitted last; never retried after a definitive refusal.
  | 'deposit_transfer';

/** One leg's completion state. `sent` ≠ `pending` only in what the USER sees — both resume
 *  by re-submitting the identical envelope bytes (request_id dedup makes that safe); the
 *  split exists so the progress list can show "sent, waiting" honestly. */
export type LegState = 'pending' | 'sent' | 'confirmed' | 'failed';

/** The executor's parallel per-leg view of a multi-hop record: same length and order as
 *  `legs`, one entry per signed update. `fee` is the leg's OWN transaction fee on its own
 *  ledger (the approve fees; '' where none is charged — the swap's pool tier lives on the
 *  record as `feeMillionths`, the withdraw itself charges nothing). */
export type LegPlan = {
  kind: LegKind;
  canister: string;
  fee: string;
  state: LegState;
};

export const CONVERT_STEPS: ConvertStep[] = [
  'quote', 'confirming', 'approving', 'approved', 'swapping', 'settling',
  'done', 'pending_withdrawal', 'failed_refunded', 'failed_leg', 'stuck',
  'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
  'awaiting_external', 'crossing', 'sol_ready', 'aborted',
];

/** The steps a cross-rail record (`crossRail`) may sit at: the IC phases (driven by the
 *  planned executor as always), the three cross-rail phases, the shared Solana-swap
 *  phases (Route C's final leg reuses `swapping`/`settling` once `solanaLeg` is set), and
 *  the shared terminals. Hydration pins a crossRail-bearing record to this vocabulary. */
export const CROSSRAIL_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'approving', 'pending_withdrawal', 'awaiting_external', 'crossing', 'sol_ready',
  'swapping', 'settling', 'done', 'failed_refunded', 'failed_leg', 'stuck',
  'aborted',
]);

/** The steps a legs==0 (CeFi-shaped) record may sit at: the provider driver's own vocabulary,
 *  start to terminal. Every OTHER step is an IC-legs step — a legless record there is
 *  malformed-by-construction (the IC executor has no legs to submit and the provider driver's
 *  transition matrix can never move it), so hydration refuses it rather than arm the resume
 *  engine's eternal no-op poll. */
export const PROVIDER_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'awaiting_deposit', 'provider_processing',
  'done', 'quote_expired', 'provider_refunded',
  'aborted',
]);

/** The provider vocabulary WITHOUT `done` (the one terminal shared by both drivers). A
 *  legs-bearing record parked here is malformed-by-construction — see hydrateOneRecord. */
export const PROVIDER_ONLY_STEPS: ReadonlySet<ConvertStep> = new Set([
  'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
]);

/** The steps a SOLANA-shaped record (`solanaLeg`) may sit at: the Solana driver's own
 *  vocabulary, start to terminal. There is no approve state (nothing to approve — the venue's
 *  tx is the whole route) and no provider states. Prepare lands at `swapping` with the leg
 *  already signed; anything else driverless fails hydration, same rule as the other two
 *  vocabularies. */
export const SOLANA_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'swapping', 'settling', 'done', 'pending_withdrawal', 'failed_refunded', 'stuck',
  'aborted',
]);

/** The steps an EVM-shaped record (`evmSwap`) may sit at: the SAME vocabulary as the Solana
 *  shape (the driver signs + watches inside `swapping`, the final balance read runs under
 *  `settling`). */
export const EVM_CONVERT_STEPS: ReadonlySet<ConvertStep> = SOLANA_CONVERT_STEPS;

/** The steps a COMPOSED record (`composedDeposit`) may sit at: the planned executor's own
 *  flight states while the IC legs + the deposit leg run, the provider vocabulary once the
 *  deposit transfer is sent (the venue poll owns the final phase), and the shared
 *  terminals. Hydration pins a composedDeposit-bearing record to this vocabulary, exactly
 *  like every other widening. */
export const COMPOSED_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'approving', 'pending_withdrawal', 'stuck', 'failed_refunded', 'failed_leg',
  'awaiting_deposit', 'provider_processing',
  'done', 'quote_expired', 'provider_refunded',
  'aborted',
]);

/** The steps a CHAIN record (`chainRoute`) may sit at: the Solana deposit leg's flight
 *  states (`swapping`/`settling`), the provider vocabulary while the venue settles, the
 *  planned executor's phase-2 states once the IC legs are signed, and the shared
 *  terminals. Hydration pins a chainRoute-bearing record to this vocabulary. */
export const CHAIN_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'swapping', 'settling',
  'awaiting_deposit', 'provider_processing',
  'approving', 'pending_withdrawal',
  'done', 'stuck', 'failed_refunded', 'failed_leg', 'quote_expired', 'provider_refunded',
  'aborted',
]);

/** The step a driver never touches again: done, failed_refunded, failed_leg, stuck,
 *  quote_expired, provider_refunded (V6 — the terminal provider states join the terminal
 *  set). The stuck nuance lives in the ENGINE, not the step: an unacknowledged
 *  expired-unconfirmed stuck record is still slow-watched; this set says only that no STATE
 *  transitions remain. `failed_leg` is the multi-hop dead-end (2026-09-14 spec §4): a burn
 *  leg refused after the swap confirmed — the hop asset is in-wallet, the exit is the
 *  standalone Withdraw flow, so no driver ever re-enters either. */
export const TERMINAL_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'done', 'failed_refunded', 'failed_leg', 'stuck', 'quote_expired', 'provider_refunded',
  'aborted',
]);

export function isTerminalConvertStep(step: ConvertStep): boolean {
  return TERMINAL_CONVERT_STEPS.has(step);
}
