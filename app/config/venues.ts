// The venue registry — the app-side copy of dpay's conversion-venue table (multi-venue
// readiness V1/V4). A venue is identified by its stable `venue_id`; every other fact
// (display name, kind, endpoint, pair) is LOOKED UP from this table, never imported as a
// standalone constant. The table is the bundled fallback of `GET /api/v1/venues` and is
// drift-alarmed field-for-field against `dfx/catalog_truth.json` `venues[]` by
// `app/__tests__/catalog.test.ts` — same pattern as the bundled currency catalog.
//
// What deliberately does NOT live here:
//   - the pair ORDER (which side a pool calls token0) — the venue's own fact, read live per
//     quote (`zero_for_one`); `pair_ledgers` is an UNORDERED set (2026-09-08 lesson);
//   - the fee tier — the venue's quote echoes its own;
//   - fixture entries — invented offline stand-ins are never BUNDLED (they reach a wallet only
//     when the offline test relay serves them knob-gated, V5).
import {BUNDLED_NETWORKS, icpCatalogOf} from './catalog';

// Extensible by design: a later Solana venue kind is a new value here + in the truth file,
// not a schema break (`kind` stays a plain string on the wire).
export type VenueKind = 'ic_amm' | 'cefi';

export type VenueEntry = {
  readonly venue_id: string;
  readonly display_name: string;
  readonly kind: VenueKind;
  // The venue's canister principal — for ic_amm, the update target the phone signs against.
  readonly endpoint: string;
  // The traded pair as an UNORDERED pair of ledger principals. Never read as ordered.
  readonly pair_ledgers: readonly string[];
  readonly testnet: boolean;
  // Key into the legal/disclosure copy (app/i18n) — locale text is never in this table.
  readonly disclosure_key: string;
};

// The dpay-OWNED canister principals (multi-venue readiness V9, spec §0 red line 1: funds
// never touch a dpay-controlled address). A conversion execution target — the approve's
// spender and the swap's update canister — may never be one of these, no matter what any
// venue table (bundled, relay-served, or hostile) claims. Mirrored from `canister_ids.json`
// at the repo root (every `ic` id there); drift-alarmed by `app/__tests__/venueInvariants.test.ts`
// so a NEW dpay canister that lands without extending this list fails a gate, not a red line.
export const DPAY_CANISTER_PRINCIPALS: readonly string[] = [
  'ssqti-wiaaa-aaaab-qhdia-cai', // dpay_canister — the facade
  'td2nx-oaaaa-aaaab-qhdnq-cai', // icrc_ledger — the DUSD/DEMO ledger (dpay-minted asset)
];

// The pair principals are DERIVED from the bundled catalog rows (the app's one copy of each
// ledger principal) — the jest alarm pins the derivation against the truth file.
function mainnetIcLedger(currency: number): string {
  const row = icpCatalogOf(BUNDLED_NETWORKS).find(r => r.currency === currency && !r.testnet);
  return row?.ledger ?? '';
}

export const BUNDLED_VENUES: readonly VenueEntry[] = [
  {
    venue_id: 'icpswap',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: '65mrh-fqaaa-aaaar-qapoa-cai',
    pair_ledgers: [mainnetIcLedger(7), mainnetIcLedger(8)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
];

// The RUNTIME overlay — what THIS relay's `GET /api/v1/venues` actually serves (multi-venue
// readiness V5). `loadVenueRegistry` (./../convert) sets it once per relay; until a reply
// lands (or if the relay is unreachable) every lookup below falls back to the bundled table.
// The overlay is never sorted or filtered client-side: the relay's row order IS the chooser's
// row order — stable and quote-independent (V5 red line: the app never ranks venues).
let RUNTIME_VENUES: readonly VenueEntry[] | null = null;

/** Replace the runtime overlay (production code calls this only with the relay's own reply;
 *  jest pins/overrides it directly as the test seam). `null` = fall back to the bundled table. */
export function setRuntimeVenues(venues: readonly VenueEntry[] | null): void {
  RUNTIME_VENUES = venues;
}

/** Every known venue, in REGISTRY ORDER — the runtime overlay when the relay's registry
 *  landed, else the bundled table. Order is deliberate: the chooser renders it verbatim. */
export function registeredVenues(): readonly VenueEntry[] {
  return RUNTIME_VENUES ?? BUNDLED_VENUES;
}

export function venueOfId(venueId: string): VenueEntry | null {
  return registeredVenues().find(v => v.venue_id === venueId) ?? null;
}

export function venueOfEndpoint(endpoint: string): VenueEntry | null {
  return registeredVenues().find(v => v.endpoint === endpoint) ?? null;
}

// Every ic_amm venue serving this pair, as an UNORDERED ledger set, in REGISTRY ORDER
// (multi-venue readiness V5). This is the chooser's candidate list — what COULD execute the
// pair — so it does NOT apply the enabled-gate's testnet filter: the offline two-venue test
// world serves its fixture rows testnet-labelled, and prod's enabled-gate
// (resolveConvertDirection, ./convert) is where "mainnet rows only" is decided against the
// BUNDLED real registry. Rows render in the returned order, never ranked by output.
export function venuesForPair(a: string, b: string): readonly VenueEntry[] {
  return registeredVenues().filter(
    v => v.kind === 'ic_amm' && samePair(v.pair_ledgers, [a, b]),
  );
}

// The ic_amm venue trading this pair out of the BUNDLED registry, if any — the single place
// "which venue serves this conversion" is decided for the ENABLED gate and legacy-record
// migration (ONE venue per pair today; the chooser builds on venuesForPair instead). `a`/`b`
// are ledger principals matched as an unordered set; testnet rows never have a venue.
export function icAmmVenueForPair(a: string, b: string): VenueEntry | null {
  return (
    BUNDLED_VENUES.find(
      v => v.kind === 'ic_amm' && !v.testnet && samePair(v.pair_ledgers, [a, b]),
    ) ?? null
  );
}

function samePair(pair: readonly string[], other: readonly string[]): boolean {
  return (
    pair.length === other.length &&
    ((pair[0] === other[0] && pair[1] === other[1]) ||
      (pair[0] === other[1] && pair[1] === other[0]))
  );
}

// Display name for a stored `venue_id` — the ONLY sanctioned way copy renders a venue's name
// (locale-invariant names never live in components, and a record's venue is looked up, not
// assumed). Consults the runtime overlay first so a relay-served venue renders its served
// name; falls back to the id itself so an unknown venue still renders honestly.
export function venueDisplayName(venueId: string): string {
  return venueOfId(venueId)?.display_name ?? venueId;
}

// The venue's endpoint for a stored `venue_id` (settlement matching signs against the
// RECORD's own venue, never a module constant). Empty string when unknown — callers
// fail closed on it.
export function venueEndpointOf(venueId: string): string {
  return venueOfId(venueId)?.endpoint ?? '';
}
