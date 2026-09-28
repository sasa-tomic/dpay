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
import {hubEndpointOf, hubRoutes, type HubEndpoint, type HubLeg} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from './catalog';
import {solAssetOfMint} from './swap';

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
 * were signed by THIS device key. One record per swap id; v3 = the composed IC+CeFi widening
 * (the deposit-leg record, 2026-09-26). Every earlier generation is adopted ONCE on first
 * load: v1 (pre-legs) and the unscoped v2 store below, plus the per-identity v2 store this
 * key replaced (the `dpay.convert.v2.<pub>` scoped store — the immediately-prior generation).
 */
export function convertStoreKey(publicHex: string): string {
  return `dpay.convert.v3.${publicHex}`;
}

/** The prior GENERATION's per-identity store prefix (`dpay.convert.v2.<pub>`): read ONCE per
 *  identity when no v3 store exists, adopted into the v3 key, then retired — the same
 *  one-time-migration shape every generation before it used. (Single-active-identity is the
 *  real deployment: the founder device.) */
export const CONVERT_PRIOR_SCOPED_STORAGE_PREFIX = 'dpay.convert.v2';

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

/**
 * The Trocador partner agreement's poll FLOOR (2026-09-22 spec term 4): a trocador-family
 * provider record never polls its relay status route faster than ONE request / 60 s per
 * trade id, and never past the first terminal status word (the provider driver's terminal
 * steps already retire the timer; the completed-early matrix widening lands the record at
 * `done` even when `completed` is the FIRST word a poll observes). Like every bound above,
 * this is a REAL-API compliance bound: an offline test world has no partner budget to
 * protect, so the engine seam's mere presence stands the floor DOWN (0) — the e2e driver
 * re-times the whole engine through `__DPAY_TEST_CONVERT_ENGINE` — and a jest suite pins
 * the floor's mechanics by passing an explicit `providerPollFloorMs` engine opt.
 */
export const CONVERT_ENGINE_PROVIDER_POLL_FLOOR_MS =
  CONVERT_ENGINE_TEST_OPTS != null ? 0 : 60_000;

/** One provider status read's transport budget. */
export const CONVERT_PROVIDER_TIMEOUT_MS = 8_000;

/**
 * The CONFIRM-time CeFi quote + order-creation transport budget (both rails). It MUST cover
 * the relay's own per-upstream budget (crates/dpay-relay/src/sideshift.rs DEFAULT_TIMEOUT,
 * 15 s): a client abort BELOW the relay's bound means the phone gives up while the relay is
 * still mid-venue-call — for ORDER creation that orphans a real venue-side order (the venue
 * 201s; the app shows "Could not reach SideShift"; the record is never adopted; the deposit
 * handoff never begins). That is exactly the live 2026-09-21 attempt-#3 signature: one
 * shifts/fixed 201 in the relay proxy log, no awaiting-deposit panel, 30 dead confirms.
 * 20 s = the DepositSheet precedent for a slow value-adjacent call (8 s above the relay's
 * bound; the confirm UI holds `confirmBusy` for the whole wait — honest, and adoption of a
 * created order is worth more than snappiness). */
export const CONVERT_CEFI_CONFIRM_TIMEOUT_MS = 20_000;

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

/** ONE route option from an asset to ONE destination, in the shape the Convert screen
 *  renders: `direct` = a single registered ic_amm venue for the pair (today's standing
 *  behavior); `hub` = a 2-leg from→hub→dest composition over two venues (app/routes.ts
 *  hubRoutes); `composed` = an IC→CeFi chain (design brief 2026-09-26 §5.4 item 2): the IC
 *  legs land the hub asset in the wallet, then a REGISTERED cefi venue's order carries it
 *  to a Solana-rail mint — the engine executes the venue's deposit transfer as a
 *  device-signed leg of the SAME intent (convert/prepare + execute). Registry order
 *  throughout — direct routes before hub routes before composed, never ranked. */
export type ComposedConvertRoute = {
  kind: 'composed';
  routeId: string;
  /** The IC legs in execution order (one direct pool leg, or the two legs of a hub route) —
   *  each names its registered venue, pool endpoint, and ordered ledger pair. */
  legs: HubLeg[];
  /** The IC endpoints in walk order: endpoints[i] is leg i's source, endpoints[legs.length]
   *  the final IC ledger — the CeFi DEPOSIT ledger (fully priced catalog rows throughout). */
  endpoints: HubEndpoint[];
  /** The CeFi venue that holds the order (registry id — facts are looked up, never assumed). */
  cefiVenueId: string;
  /** The settle side: the Solana-rail mint the venue pays, with its registry-resolved
   *  symbol + decimals (a leg that cannot be NAMED is never a route). */
  settleMint: string;
  settleSymbol: string;
  settleDecimals: number;
};

/**
 * The CHAIN widening (2026-09-28, the any-pair mandate): the MIRROR of a composed route —
 * a registered cefi venue's order carries a SOLANA-rail source INTO a mid IC ledger (the
 * venue's settle side), and REGISTERED ic_amm legs then carry it the rest of the way to
 * the IC target. Execution order is composed reversed: the venue order is created FIRST
 * (its locked settle figure is known at confirm), the device signs ONE Solana deposit
 * transfer (frozen bytes, submitted immediately), the venue settles the mid asset into
 * the wallet, and the IC legs are signed AT PHASE TIME from the record's own frozen plan
 * — an IC envelope dies at its +300 s ingress expiry, so the phase-2 legs can never be
 * pre-signed at confirm. dpay is never a party: the order is the user's, the deposit is
 * the user's signature, the IC legs are the user's signatures.
 */
export type ChainConvertRoute = {
  kind: 'chain';
  routeId: string;
  /** The cefi venue that holds the order (registry id — looked up, never assumed). */
  cefiVenueId: string;
  /** The source side: the Solana-rail mint the device's transfer funds the order with. */
  depositMint: string;
  depositSymbol: string;
  depositDecimals: number;
  /** The IC legs in execution order (one direct pool leg, or the two legs of a hub
   *  route) — each names its registered venue, pool endpoint, and ordered ledger pair. */
  legs: HubLeg[];
  /** The IC endpoints in walk order: endpoints[i] is leg i's source (the FIRST is the
   *  venue's settle ledger), endpoints[legs.length] the final IC ledger. */
  endpoints: HubEndpoint[];
};

export type ConvertRouteOption =
  | {kind: 'direct'; venueId: string}
  | {kind: 'hub'; routeId: string; venue1Id: string; venue2Id: string; hubLedger: string}
  | ComposedConvertRoute
  | ChainConvertRoute;

/** One hub-reachable destination: the dest IC ledger + every route that reaches it. */
export type ConvertDestination = {
  destLedger: string;
  routes: ConvertRouteOption[];
};

/** Every destination an asset can convert to — directly, over one hub leg, OR as a COMPOSED
 *  IC→CeFi chain. This is the Convert-entry enablement widened from "a direct venue exists"
 *  to "ANY route exists": an asset with no direct pool but a hub path (e.g. VCHF → ckETH via
 *  ICP) converts as ONE intent, and (2026-09-26) a pool/hub leg that lands on an asset a
 *  registered CeFi venue buys extends into a composed route (VCHF → ICP → EURC via
 *  SideShift's ICP order). Same posture as resolveConvertDirection (kept above, unchanged,
 *  for its existing callers): the BUNDLED registry is the truth, mainnet rows only, and the
 *  walk fails closed on any leg that cannot be priced or named. First-encounter destination
 *  order.
 *
 *  `catalogArg` overrides the bundled IC catalog (jest only — the fail-closed gates are
 *  pinned against doctored rows); production callers never pass it. */
export function resolveConvertDestinations(
  ledger: string | undefined,
  isTestnet: boolean,
  catalogArg?: CurrencyDescriptor[],
): ConvertDestination[] {
  if (!ledger || isTestnet) return [];
  const catalog: CurrencyDescriptor[] = catalogArg ?? icpCatalogOf(BUNDLED_NETWORKS);
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
    // (no row, a fee-less row, missing decimals or symbol) is not a destination this
    // build offers. hubRoutes' own endpoints already fail closed this way (app/routes.ts
    // hubEndpointOf) — the direct side must hold the same bar, or a venue would offer a
    // destination every downstream surface refuses to price. (ckBTC sat behind this gate
    // on its null fee until the MEASURED 2026-09-18 icrc1_fee → 10 landed on the row.)
    const otherRow = catalog.find(c => c.ledger === other && !c.testnet);
    if (otherRow == null || otherRow.fee == null || otherRow.decimals == null
      || (otherRow.backing_symbol ?? otherRow.symbol) == null) continue;
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
  // The COMPOSED walk (2026-09-26): every registered CeFi venue whose DEPOSIT side is a
  // fully priced IC ledger this source can reach (a direct pool, else a hub composition)
  // extends into a composed route. The settle side must be a mint the Solana registry can
  // name (symbol + decimals) — a leg that cannot be priced is not a route, like every walk
  // above. The source's own ledger is skipped: a CeFi deposit straight from the source is
  // the plain cefi row's surface, not a composition. Destinations key on the SETTLE MINT
  // (a Solana-rail id, disjoint from the IC-ledger keys above). Registry order throughout:
  // cefi venues outer, per-venue IC legs direct-before-hub, never ranked.
  for (const venue of BUNDLED_VENUES) {
    if (venue.kind !== 'cefi' || venue.testnet) continue;
    for (const mid of venue.pair_ledgers) {
      if (mid === ledger) continue;
      const settleMint = mid === venue.pair_ledgers[0] ? venue.pair_ledgers[1] : venue.pair_ledgers[0];
      const settle = solAssetOfMint(settleMint);
      if (settle == null) continue;
      const hubRow = catalog.find(c => c.ledger === mid && !c.testnet);
      if (hubRow == null || hubRow.fee == null || hubRow.decimals == null
        || (hubRow.backing_symbol ?? hubRow.symbol) == null) continue;
      for (const pool of BUNDLED_VENUES) {
        if (pool.kind !== 'ic_amm' || pool.testnet) continue;
        const i = pool.pair_ledgers.indexOf(ledger);
        if (i < 0) continue;
        const other = pool.pair_ledgers[i === 0 ? 1 : 0];
        if (other !== mid) continue;
        const srcEp = hubEndpointOf(catalog, ledger);
        const midEp = hubEndpointOf(catalog, mid);
        if (srcEp == null || midEp == null) continue;
        push(settleMint, {
          kind: 'composed',
          routeId: `composed:${pool.venue_id}:${venue.venue_id}`,
          legs: [{venueId: pool.venue_id, pool: pool.endpoint, fromLedger: ledger, toLedger: mid}],
          endpoints: [srcEp, midEp],
          cefiVenueId: venue.venue_id,
          settleMint,
          settleSymbol: settle.symbol,
          settleDecimals: settle.decimals,
        });
      }
      for (const hr of hubRoutes(catalog, ledger, mid)) {
        push(settleMint, {
          kind: 'composed',
          routeId: `composed:${hr.routeId}:${venue.venue_id}`,
          legs: hr.legs.map(l => ({...l})),
          endpoints: [hr.from, hr.hub, hr.dest],
          cefiVenueId: venue.venue_id,
          settleMint,
          settleSymbol: settle.symbol,
          settleDecimals: settle.decimals,
        });
      }
    }
  }
  return [...byDest.values()];
}
