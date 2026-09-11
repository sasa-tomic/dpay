/**
 * Delegated-conversion — dpay's OWN conversion choices (spec 2026-09-07 §1/§2, multi-venue
 * readiness V1/V4). What this file may hold is dpay's policy: slippage options, staleness,
 * approve lifetime, impact thresholds, the storage key. What it must NEVER hold is a venue
 * FACT — the pool principal, its pair and its fee tier live in the venue registry
 * (`./venues`, drift-alarmed against `dfx/catalog_truth.json` `venues[]`) and the pair ORDER
 * belongs to the venue itself, read live per quote (`zero_for_one` echo). The 2026-09-07 build
 * kept an ordered pair as constants here and in the relay; both were backwards, and the app's
 * copy could not have detected that because nothing app-side ever talks to the venue directly.
 */
import {BUNDLED_VENUES} from './venues';

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

/**
 * AsyncStorage key for ONE IDENTITY's persisted conversion records (multi-venue readiness V6):
 * the convert store is a per-wallet store like every other one (offramp `dpay.offramp.<pub>`,
 * sol merchant `dpay.sol.merchant.v1.<pub>`) and now scopes the same way — records whose legs
 * were signed by THIS device key. One record per swap id; v2 = the legs schema (V2).
 */
export function convertStoreKey(publicHex: string): string {
  return `dpay.convert.v2.${publicHex}`;
}

/** The pre-scoping v2 store key (every record under one key, whichever identity was active).
 *  Read ONCE per identity: an identity with no scoped store ADOPTS whatever is here into its
 *  scoped key, then the unscoped key is retired — the same one-time-migration shape the v1 key
 *  below uses. (Single-active-identity is the real deployment: the founder device.) */
export const CONVERT_UNSCOPED_STORAGE_KEY = 'dpay.convert.v2';

/** The pre-legs store key — read once during migration, then removed. */
export const CONVERT_LEGACY_STORAGE_KEY = 'dpay.convert.v1';

// --- the app-level resume engine (V6): cadence bounds ---------------------------------------------
// One engine drives every live record while the wallet is open (mounted screen or not). The
// bounds below are what keeps it idle-safe: every re-arm is a SINGLE bounded network round
// after a sleep — never a spin loop — and terminal states stop their record's timer for good.

/** A pending_withdrawal / settling record re-probes the ledgers at this cadence (the mounted
 *  screen's own 2 s re-arm is gone; the engine owns the watch for everyone). */
export const CONVERT_ENGINE_REARM_MS = 10_000;

/** An expired-unconfirmed record parked on `stuck` (outcome unknown, resubmission forbidden)
 *  is still probed at this SLOW cadence until it resolves or the user acknowledges the stuck
 *  state — a record that cannot be advanced any faster must not be polled any faster. */
export const CONVERT_ENGINE_STUCK_WATCH_MS = 60_000;

/** A live providerRef record (CeFi shape) polls its statusUrl at this cadence — one request
 *  per interval per record, forever bounded by that rate, stopping at the first terminal
 *  provider state. A venue that holds funds for hours is watched, not hammered. */
export const CONVERT_ENGINE_PROVIDER_POLL_MS = 10_000;

/** One provider status read's transport budget. */
export const CONVERT_PROVIDER_TIMEOUT_MS = 8_000;

/** The settlement probe's indexed window: how many newest rows of each ledger it scans
 *  (V6; the relay caps `limit` at 100). 10 was the PoC window; 50 tolerates a busy wallet
 *  between submit and payout without paying for the relay's full page. Fail-closed posture
 *  unchanged: a row OUTSIDE the window is still unknown, never optimistically done. */
export const CONVERT_PROBE_WINDOW_ROWS = 50;

/** What the venue serves for a selected asset: the OTHER side of the pair, and nothing else.
 *  There is deliberately no `zeroForOne` here — the direction flag the swap arg carries comes
 *  from the relay's `zero_for_one` echo, which the relay derived from the pool's OWN metadata. */
export type ConvertDirection = {
  /** The OTHER side's ledger principal — looked up in the catalog for the destination descriptor. */
  otherLedger: string;
};

/** Fail-closed venue resolution: given the selected asset's ledger principal (+ its testnet flag),
 *  return the counter-asset iff a registered venue serves the pair (`./venues` — looked up, never
 *  a module constant). Every asset gets the SAME Convert entry point (uniform-IA hard rule); this
 *  function decides enablement honestly. Testnet rows never have a venue — the registered IC
 *  pools are mainnet contracts. */
export function resolveConvertDirection(
  ledger: string | undefined,
  isTestnet: boolean,
): ConvertDirection | null {
  if (!ledger || isTestnet) return null;
  for (const venue of BUNDLED_VENUES) {
    if (venue.kind !== 'ic_amm' || venue.testnet) continue;
    const i = venue.pair_ledgers.indexOf(ledger);
    if (i >= 0) return {otherLedger: venue.pair_ledgers[i === 0 ? 1 : 0]};
  }
  return null;
}
