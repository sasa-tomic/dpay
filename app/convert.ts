/**
 * Delegated conversion (spec 2026-09-07; multi-venue readiness V1/V2) — the standalone
 * wallet-level Convert action.
 *
 * dpay is NEVER a party to the trade: the user's phone signs EVERY value-moving call (today:
 * `icrc2_approve` naming the venue pool as spender, and the pool's `depositFromAndSwap` — one
 * SignedLeg each), and they are submitted through the exact app-signed /api/v2 rail every IC
 * transfer already uses (services/icp.ts → services/rail.ts). The venue's own quote is
 * displayed verbatim, attributed and timestamped — never computed, blended, or ranked here.
 * dpay charges nothing and is paid nothing.
 *
 * A record names its VENUE by the stable `venue_id` (registry: `./config/venues`); venue facts
 * (display name, endpoint) are looked up from it, never imported as constants.
 *
 * The §4 state machine (persisted in AsyncStorage under the identity-scoped key
 * `convertStoreKey(publicHex)` — `dpay.convert.v2.<pub>`, V6; one record per conversion id;
 * v1 and pre-scoping v2 records are MIGRATED on load — per-record salvage: a corrupt record
 * is dropped, never the whole store, and a legacy key is retired only after a fully
 * successful adoption):
 *
 *   quote → confirming → approving → approved → swapping → settling
 *         ├→ done {outAmountNet, outTx}            (output-ledger credit SEEN — never from #ok alone)
 *         ├→ pending_withdrawal                    (pool #ok, output not seen yet — keep watching)
 *         ├→ failed_refunded                       (refused/refunded — user's position named)
 *         └→ stuck                                 (honest unknown — instructions, not a spinner)
 *
 *   CeFi-shaped states (multi-venue readiness V2): awaiting_deposit
 *   → provider_processing → done | quote_expired | provider_refunded. A CeFi record carries NO
 *   legs — an empty `legs` + a `providerRef {orderId}` is valid — because nothing on the IC rail
 *   moves. Their DRIVER (V6) polls the provider's statusUrl; see `convertResume.ts` for the
 *   status vocabulary and the honest-transition rules (no fabricated outcomes).
 *
 * Recovery is EXPIRY-HONEST (V6). An unconfirmed leg is a trichotomy, never one rule:
 *   (a) unconfirmed + NOT yet expired → resubmit the SAME signed bytes (spec §4 identical-
 *       envelope discipline; request_id dedup makes it a no-op if it already executed);
 *   (b) unconfirmed + EXPIRED → NEVER resubmit (the ingress rejects the bytes anyway, and they
 *       may already have executed — the outcome is UNKNOWN): probe settlement until it resolves
 *       done/refunded, else park on `stuck` and keep slow-watching until it resolves or the
 *       user acknowledges the stuck state (`acknowledgedStuckAtMs`);
 *   (c) venue refused before value moved → failed_refunded (unchanged).
 *   `quote_expired` is a DIFFERENT event — the provider's own quote/deposit window died before
 *   any value moved (a CeFi driver transition) — and is never set by leg expiry.
 *
 * Retry discipline (offrampRetry heritage): a record carries the SIGNED envelope bytes; every
 * retry re-submits those identical bytes (dedup'd on-chain by request_id) — args are NEVER rebuilt
 * mid-swap. NOTHING NEW IS EVER SIGNED during recovery (red line, spec 2026-09-07 §4). Settlement
 * is detected by the same ledger-watch machinery the merchant reconciliation uses (relay
 * /api/v1/transactions against the user's principal) — the pool's #ok is treated as "the pool
 * pulled the input", NOT as settlement, because the pool's out figure is GROSS and the wallet
 * actually receives it minus the output-ledger fee.
 */

export type {
  ConvertRecord,
  ConvertStep,
  CrossRailInfo,
  GasFundPlan,
  GasFundPreLeg,
  LegKind,
  LegPlan,
  LegState,
  ProviderDeposit,
  ProviderRef,
  ResolvedGasFundPlan,
  SignedLeg,
  SolanaSwapLeg,
} from './convert/types';
export {TERMINAL_CONVERT_STEPS, isTerminalConvertStep} from './convert/types';

export type {CeFiQuoteResult, ConvertMath, ConvertQuote, SwapQuoteBody} from './convert/quotes';
export {
  ceFiQuoteFromResult,
  ceFiServiceError,
  createCeFiOrder,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchCeFiQuoteResult,
  fetchConvertQuote,
  isQuoteStale,
  loadVenueRegistry,
} from './convert/quotes';

export type {SalvagedStore} from './convert/records';
export {
  convertAbortFlavor,
  convertAborted,
  convertLegsExpired,
  convertRecordMinOut,
  hydrateConvertStore,
  isHubConvertRecord,
  loadConvertRecords,
  requestConvertAbort,
  salvageConvertStore,
  saveConvertRecord,
} from './convert/records';

export {prepareConvertRecord, prepareCeFiConvertRecord} from './convert/prepare';

export {
  gasFundNeededWei,
  prepareHubConvertRecord,
  prepareMultihopConvertRecord,
  resolveGasFundPlan,
} from './convert/plan';

export type {CctpHandoff} from './convert/cctp';
export {
  attachCctpBurnTx,
  buildCctpHandoff,
  declineCctpHandoff,
  fetchCctpBurnFee,
  fetchCctpMessageStatus,
} from './convert/cctp';

export type {ConvertExecutorDeps, SettleWatch} from './convert/execute';
export {executeConvert, probeConvertSettlement, probeHopPayout} from './convert/execute';

export type {SolanaConvertPrepareArgs, SolanaExecutorDeps, SolanaExecutorOpts} from './convert/executeSolana';
export {executeSolanaConvert, prepareSolanaConvertRecord} from './convert/executeSolana';

export type {CrossRailDeps, CrossRailOpts} from './convert/executeCrossRail';
export {
  executeCrossRailConvert,
  executeCrossRailSolSwap,
  prepareCrossRailSolLeg,
} from './convert/executeCrossRail';
