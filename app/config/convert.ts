/**
 * Delegated-conversion venue constants (spec 2026-09-07 §1/§2) — the ONLY place the ICPSwap pool
 * identity lives app-side. Currency ids and ledger fees are NEVER hardcoded here: callers resolve
 * them from the catalog descriptors at runtime so the swap targets the same ledgers the deposit
 * sheets show (and a catalog fee change propagates into the approval arithmetic automatically).
 *
 * The relay holds the same consts (crates/dpay-relay/src/catalog.rs SWAP_POOL_PRINCIPAL +
 * ICP_VCHF_VENUE); this file mirrors them for the PoC per spec §2 — catalog migration is a
 * declared follow-up, not this build.
 */

/** The ICPSwap V3 pool canister that executes the swap. `depositFromAndSwap` is called ON this
 *  principal; the user's icrc2_approve names exactly this principal as spender. */
export const CONVERT_POOL_PRINCIPAL = '65mrh-fqaaa-aaaar-qapoa-cai';

/** The pool's own pair order (token0/token1 from its metadata — the reason `zero_for_one` comes
 *  from the venue quote rather than pair order). Identified by LEDGER principal text so a catalog
 *  row's currency id is never duplicated here. */
export const CONVERT_VENUE_LEDGERS = {
  token0: 'ryjl3-tyaaa-aaaaa-aaaba-cai', // ICP ledger
  token1: 'ly36x-wiaaa-aaaai-aqj7q-cai', // VCHF ledger
} as const;

/** Pool fee tier: 3000 millionths = 0.30% (display-only fact about the venue, shown separately
 *  from both ledger fees). */
export const CONVERT_POOL_FEE_TIER_LABEL = '0.30%';

/** Slippage choices on the Convert screen (spec §5): 0.5% / 1% / 3%, default 1%. */
export const CONVERT_SLIPPAGE_BPS_OPTIONS = [50, 100, 300] as const;
export const CONVERT_SLIPPAGE_BPS_DEFAULT = 100;

/** A quote older than this auto-refreshes (spec §5: stale at >30s), and the confirm tap re-quotes
 *  before anything is signed. Test seam: e2e shrinks this via __DPAY_TEST_CONVERT_STALE_MS. */
export const CONVERT_STALE_MS = 30_000;

/** Allowance lifetime (spec §3): approve expires at now + 10 min; a stuck-but-unspent approval
 *  dies worthless within this window (the failure screen shows that countdown). */
export const CONVERT_APPROVE_LIFETIME_S = 600;

/** Price-impact warning threshold (spec §5: warn above 5%). Impact is MEASURED app-side by
 *  comparing the venue's quote for this amount against a near-zero reference quote through the
 *  same curve — never blended into the displayed rate. */
export const CONVERT_IMPACT_WARN_BPS = 500;

/** The near-zero reference trade (raw e8s) used to measure impact: small enough to ride the
 *  curve's edge, large enough to survive floor quantization against ~1e14 reserves. */
export const CONVERT_IMPACT_REF_AMOUNT_IN = '1000';

/** AsyncStorage key for the persisted swap records (spec §4): one record per swap id. */
export const CONVERT_STORAGE_KEY = 'dpay.convert.v1';

/** Direction of a venue-supported pair, derived from the venue's own token0/token1. */
export type ConvertDirection = {
  /** true when token_in is the pool's token0 (the quote route's zero_for_one echo). */
  zeroForOne: boolean;
  /** The OTHER side's ledger principal — looked up in the catalog for the destination descriptor. */
  otherLedger: string;
};

/** Fail-closed venue resolution: given the selected asset's ledger principal (+ its testnet flag),
 *  return the direction iff the PoC venue serves it. Every asset gets the SAME Convert entry
 *  point (uniform-IA hard rule); this function decides enablement honestly. Testnet rows never
 *  have a venue — the PoC pool is a mainnet contract. */
export function resolveConvertDirection(
  ledger: string | undefined,
  isTestnet: boolean,
): ConvertDirection | null {
  if (!ledger || isTestnet) return null;
  if (ledger === CONVERT_VENUE_LEDGERS.token0) {
    return {zeroForOne: true, otherLedger: CONVERT_VENUE_LEDGERS.token1};
  }
  if (ledger === CONVERT_VENUE_LEDGERS.token1) {
    return {zeroForOne: false, otherLedger: CONVERT_VENUE_LEDGERS.token0};
  }
  return null;
}
