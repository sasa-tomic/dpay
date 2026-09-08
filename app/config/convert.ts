/**
 * Delegated-conversion venue constants (spec 2026-09-07 §1/§2) — the ONLY place the ICPSwap pool
 * identity lives app-side. Currency ids and ledger fees are NEVER hardcoded here: callers resolve
 * them from the catalog descriptors at runtime so the swap targets the same ledgers the deposit
 * sheets show (and a catalog fee change propagates into the approval arithmetic automatically).
 *
 * What this file may hold is dpay's OWN choices: which pool to talk to, and which pair of assets
 * the Convert action is offered for. What it must NEVER hold is a claim about the venue —
 * the pool's token0/token1 ORDER and its FEE TIER belong to the pool, are read off it by the
 * relay on every quote (`crates/dpay-relay/src/agent_ledger.rs swap_pool_metadata`) and reach the
 * app only as the quote's own `zero_for_one` / `fee_millionths` echo. The 2026-09-07 build kept
 * an ORDERED pair here and in the relay; both were backwards, and the app's copy could not have
 * detected that because nothing app-side ever talks to the venue directly.
 */

/** The ICPSwap V3 pool canister that executes the swap. `depositFromAndSwap` is called ON this
 *  principal; the user's icrc2_approve names exactly this principal as spender. */
export const CONVERT_POOL_PRINCIPAL = '65mrh-fqaaa-aaaar-qapoa-cai';

/** The two assets this venue trades, as an UNORDERED pair of LEDGER principals (a catalog row's
 *  currency id is never duplicated here). Deliberately not `{token0, token1}`: which one the pool
 *  calls token0 is the pool's fact, not the app's, and holding an order the app cannot verify is
 *  exactly the bug this replaced. */
export const CONVERT_VENUE_LEDGERS = [
  'ly36x-wiaaa-aaaai-aqj7q-cai', // VCHF ledger
  'ryjl3-tyaaa-aaaaa-aaaba-cai', // ICP ledger
] as const;

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

/**
 * The near-zero reference trade used to measure impact, in RAW units of whichever ledger is the
 * input leg (both PoC legs are 8-decimal, so this is 0.01 ICP / 0.01 VCHF).
 *
 * The size is a resolution decision, and it was measured, not guessed. The pool FLOORS every
 * quote, so the reference carries a quantization error of one output unit; the reference's own
 * impact biases the measurement the other way. Against the live pool on 2026-09-08 (see
 * `__tests__/convert.test.ts` for the eight measured points):
 *   * 0.00001 ICP (the 2026-09-07 value, `'1000'`) quoted 406 against a true 406.36 — a 0.23%
 *     quantization error, i.e. 23 bps of noise on top of a signal that is 0.006 bps at 1 ICP and
 *     9 bps at 1 000 ICP. It could not resolve ANY real trade, and did not: impact came back
 *     unmeasurable at every size.
 *   * 0.01 ICP quotes 406356 — one floored unit is 0.025 bps of noise, and the reference's own
 *     impact is ~0.0001 bps. Both are 40× finer than the 1 bp the screen displays.
 */
export const CONVERT_IMPACT_REF_AMOUNT_IN = '1000000';

/**
 * Fixed-point scale for the two per-unit prices impact is measured from (out-units per in-unit,
 * ×1e12). It is NOT the bps scale: dividing by the trade size first and expressing the result in
 * bps floored the price to four significant digits, which threw away three orders of magnitude
 * more precision than the impact being measured (a 1 ICP trade and a near-zero one landed on the
 * same 4063, and the gap the measurement needs vanished). 1e12 keeps every digit the ledgers have.
 */
export const CONVERT_IMPACT_PRICE_SCALE = 10n ** 12n;

/** AsyncStorage key for the persisted swap records (spec §4): one record per swap id. */
export const CONVERT_STORAGE_KEY = 'dpay.convert.v1';

/** What the venue serves for a selected asset: the OTHER side of the pair, and nothing else.
 *  There is deliberately no `zeroForOne` here — the direction flag the swap arg carries comes
 *  from the relay's `zero_for_one` echo, which the relay derived from the pool's OWN metadata. */
export type ConvertDirection = {
  /** The OTHER side's ledger principal — looked up in the catalog for the destination descriptor. */
  otherLedger: string;
};

/** Fail-closed venue resolution: given the selected asset's ledger principal (+ its testnet flag),
 *  return the counter-asset iff the PoC venue serves it. Every asset gets the SAME Convert entry
 *  point (uniform-IA hard rule); this function decides enablement honestly. Testnet rows never
 *  have a venue — the PoC pool is a mainnet contract. */
export function resolveConvertDirection(
  ledger: string | undefined,
  isTestnet: boolean,
): ConvertDirection | null {
  if (!ledger || isTestnet) return null;
  const i = CONVERT_VENUE_LEDGERS.indexOf(ledger as (typeof CONVERT_VENUE_LEDGERS)[number]);
  if (i < 0) return null;
  return {otherLedger: CONVERT_VENUE_LEDGERS[i === 0 ? 1 : 0]};
}
