// --- the §4 state machine record -------------------------------------------------------------------

export type ConvertStep =
  | 'quote' | 'confirming' | 'approving' | 'approved' | 'swapping' | 'settling'
  | 'done' | 'pending_withdrawal' | 'failed_refunded' | 'failed_leg' | 'stuck'
  // The user's Stop tap (2026-09-19): the record freezes where it is and no driver ever
  // re-enters it. The body copy is derived from the legs (convertAbortFlavor).
  | 'aborted'
  // CeFi-shaped states (multi-venue readiness V2): round-tripped by hydration today; the
  // drivers that move a record INTO them arrive with the CeFi wave. Kept snake_case like
  // the rest of the persisted vocabulary.
  | 'awaiting_user_authorization' | 'awaiting_deposit' | 'provider_processing'
  | 'quote_expired' | 'provider_refunded'
  // The cross-rail widening (2026-09-16, Routes B/C): the CCTP phases that follow the
  // five IC legs. `awaiting_external` = the user's own EVM wallet must sign approve+burn
  // (dpay never holds EVM keys — the record waits on USER action, no driver advances it);
  // `crossing` = the burn tx hash is known and Circle's attestation/mint is being watched;
  // `sol_ready` = the USDC mint landed and is verified at the ATA, and the final Jupiter
  // leg is OFFERED for the user to confirm on a fresh quote (Route C only).
  | 'awaiting_external' | 'crossing' | 'sol_ready';

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
  failureCode?: 'approve_refused' | 'swap_refused' | 'refunded' | 'withdraw_refused' | 'unknown'
    // The cross-rail additions: the user declined/abandoned the external signing step
    // (funds sit as USDC at their OWN EVM address — the copy names it).
    | 'external_declined'
    // The gas-fund addition: the funding did not deliver (a pre-leg refused, or the
    // post-pre-leg balance re-check came up short) — the MAIN conversion has not started
    // and every source value sits in-wallet. The failed card names the shortfall.
    | 'gas_short';
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
export type LegKind = 'approve' | 'swap' | 'approve_gas' | 'withdraw_erc20' | 'cctp_burn' | 'sol_swap';

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
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
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
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'done', 'quote_expired', 'provider_refunded',
  'aborted',
]);

/** The provider vocabulary WITHOUT `done` (the one terminal shared by both drivers). A
 *  legs-bearing record parked here is malformed-by-construction — see hydrateOneRecord. */
export const PROVIDER_ONLY_STEPS: ReadonlySet<ConvertStep> = new Set([
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
]);

/** The steps a Solana-shaped record (`solanaLeg`) may sit at: the Solana driver's own
 *  vocabulary, start to terminal. There is no approve state (nothing to approve — the venue's
 *  tx is the whole route) and no provider states. Prepare lands at `swapping` with the leg
 *  already signed; anything else driverless fails hydration, same rule as the other two
 *  vocabularies. */
export const SOLANA_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'swapping', 'settling', 'done', 'pending_withdrawal', 'failed_refunded', 'stuck',
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
