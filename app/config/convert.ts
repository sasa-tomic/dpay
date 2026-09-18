/**
 * Delegated-conversion — dpay's OWN conversion choices (spec 2026-09-07 §1/§2, multi-venue
 * readiness V1/V4). What this file may hold is dpay's policy: slippage options, staleness,
 * approve lifetime, the storage key. What it must NEVER hold is a venue
 * FACT — the pool principal, its pair and its fee tier live in the venue registry
 * (`./venues`, drift-alarmed against `dfx/catalog_truth.json` `venues[]`) and the pair ORDER
 * belongs to the venue itself, read live per quote (`zero_for_one` echo). The 2026-09-07 build
 * kept an ordered pair as constants here and in the relay; both were backwards, and the app's
 * copy could not have detected that because nothing app-side ever talks to the venue directly.
 *
 * There is deliberately NO price-impact policy here anymore (removed 2026-09-11): the venues
 * dpay quotes publish no impact figure, so dpay displays none (spec 2026-09-08 V8 — "display
 * what the venue publishes, derive only what it does not"). The old CONVERT_IMPACT_* knobs
 * fed a second per-venue reference quote whose curve-slope estimate was presented as venue
 * fact; the execution protection is the venue's own amounts plus the signed minimum-out.
 */
import {BUNDLED_VENUES} from './venues';
import {hubRoutes} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from './catalog';

/** Slippage choices on the Convert screen (spec §5): 0.5% / 1% / 3%, default 1%. */
export const CONVERT_SLIPPAGE_BPS_OPTIONS = [50, 100, 300] as const;
export const CONVERT_SLIPPAGE_BPS_DEFAULT = 100;

/** A quote older than this auto-refreshes (spec §5: stale at >30s), and the confirm tap re-quotes
 *  before anything is signed. Test seam: e2e shrinks this via __DPAY_TEST_CONVERT_STALE_MS. */
export const CONVERT_STALE_MS = 30_000;

/** Allowance lifetime (spec §3): approve expires at now + 10 min; a stuck-but-unspent approval
 *  dies worthless within this window (the failure screen shows that countdown). */
export const CONVERT_APPROVE_LIFETIME_S = 600;

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

/**
 * e2e/jest seam for the engine cadences below — the exact POLL pattern: read ONCE at module load
 * from `__DPAY_TEST_CONVERT_ENGINE`, before any bundle code runs (driver.mjs
 * evaluateOnNewDocument). In a shipped build the global is never set → every `??` falls through
 * to the prod default. `executorOpts` also seeds ENGINE_EXECUTOR_OPTS (convertResume.ts) and
 * executeConvert's default settle budget (convert.ts), so ONE object re-times the whole engine.
 * Jest suites that need speed pass explicit opts instead — they must not depend on module state.
 */
export const CONVERT_ENGINE_TEST_OPTS: {
  rearmMs?: number;
  stuckWatchMs?: number;
  providerPollMs?: number;
  executorOpts?: {submitAttempts?: number; poll?: {attempts: number; intervalMs: number}; settleAttempts?: number; settleIntervalMs?: number};
} | null =
  (globalThis as {__DPAY_TEST_CONVERT_ENGINE?: {
    rearmMs?: number;
    stuckWatchMs?: number;
    providerPollMs?: number;
    executorOpts?: {submitAttempts?: number; poll?: {attempts: number; intervalMs: number}; settleAttempts?: number; settleIntervalMs?: number};
  }}).__DPAY_TEST_CONVERT_ENGINE ?? null;

/** A pending_withdrawal / settling record re-probes the ledgers at this cadence (the mounted
 *  screen's own 2 s re-arm is gone; the engine owns the watch for everyone). */
export const CONVERT_ENGINE_REARM_MS = CONVERT_ENGINE_TEST_OPTS?.rearmMs ?? 10_000;

/** An expired-unconfirmed record parked on `stuck` (outcome unknown, resubmission forbidden)
 *  is still probed at this SLOW cadence until it resolves or the user acknowledges the stuck
 *  state — a record that cannot be advanced any faster must not be polled any faster. */
export const CONVERT_ENGINE_STUCK_WATCH_MS = CONVERT_ENGINE_TEST_OPTS?.stuckWatchMs ?? 60_000;

/** A live providerRef record (CeFi shape) polls its statusUrl at this cadence — one request
 *  per interval per record, forever bounded by that rate, stopping at the first terminal
 *  provider state. A venue that holds funds for hours is watched, not hammered. */
export const CONVERT_ENGINE_PROVIDER_POLL_MS = CONVERT_ENGINE_TEST_OPTS?.providerPollMs ?? 10_000;

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

// --- the IC hub 2-hop widening (2026-09-18, spec §11): destination enumeration ---------------------

/** ONE route option from an asset to ONE destination ledger, in the shape the Convert screen
 *  renders: `direct` = a single registered ic_amm venue for the pair (today's standing
 *  behavior); `hub` = a 2-leg from→hub→dest composition over two venues (app/routes.ts
 *  hubRoutes). Registry order throughout — direct routes before hub routes, never ranked. */
export type ConvertRouteOption =
  | {kind: 'direct'; venueId: string}
  | {kind: 'hub'; routeId: string; venue1Id: string; venue2Id: string; hubLedger: string};

/** One hub-reachable destination: the dest IC ledger + every route that reaches it. */
export type ConvertDestination = {
  destLedger: string;
  routes: ConvertRouteOption[];
};

/** Every IC destination an asset can convert to — directly OR over one hub leg. This is the
 *  Convert-entry enablement widened from "a direct venue exists" to "ANY route exists": an
 *  asset with no direct pool but a hub path (e.g. VCHF → ckETH via ICP) converts as ONE
 *  intent, and where both shapes exist both are OFFERED, never ranked. Same posture as
 *  resolveConvertDirection (kept above, unchanged, for its existing callers): the BUNDLED
 *  registry is the truth, mainnet rows only, and hubRoutes fails closed on any missing
 *  number (a leg that cannot be priced is not a route). First-encounter destination order. */
export function resolveConvertDestinations(
  ledger: string | undefined,
  isTestnet: boolean,
): ConvertDestination[] {
  if (!ledger || isTestnet) return [];
  const catalog: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
  if (!catalog.some(c => c.ledger === ledger && !c.testnet)) return [];
  const byDest = new Map<string, ConvertDestination>();
  const push = (destLedger: string, route: ConvertRouteOption): void => {
    let d = byDest.get(destLedger);
    if (d == null) { d = {destLedger, routes: []}; byDest.set(destLedger, d); }
    d.routes.push(route);
  };
  for (const venue of BUNDLED_VENUES) {
    if (venue.kind !== 'ic_amm' || venue.testnet) continue;
    const i = venue.pair_ledgers.indexOf(ledger);
    if (i < 0) continue;
    const other = venue.pair_ledgers[i === 0 ? 1 : 0];
    // Fail closed on the counter-row too: a destination the catalog cannot fully price
    // (e.g. a fee-less row) is not a destination this build offers.
    if (!catalog.some(c => c.ledger === other && !c.testnet)) continue;
    push(other, {kind: 'direct', venueId: venue.venue_id});
  }
  for (const hr of hubRoutes(catalog, ledger)) {
    push(hr.dest.ledger, {
      kind: 'hub',
      routeId: hr.routeId,
      venue1Id: hr.legs[0].venueId,
      venue2Id: hr.legs[1].venueId,
      hubLedger: hr.hub.ledger,
    });
  }
  return [...byDest.values()];
}
