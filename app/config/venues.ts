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
import {
  EURC_MINT_ADDRESS,
  USDC_MINT_ADDRESS,
  WRAPPED_SOL_MINT_ADDRESS,
} from '../solana/tokens';

// Extensible by design: each new venue kind is a new value here + in the truth file, not a
// schema break (`kind` stays a plain string on the wire).
export type VenueKind = 'ic_amm' | 'cefi' | 'solana_amm';

/** One venue's settlement verdict block (relay probe result, verdict derived relay-side —
 *  see VenueEntry.health). settle_seconds is the measured order→settle latency; measured_at
 *  is unix seconds (or the relay's ISO string — opaque here, display never needs it). */
export type VenueHealth = {
  readonly status: 'ok' | 'degraded';
  readonly settle_seconds?: number;
  readonly measured_at?: number | string;
};

export type VenueEntry = {
  readonly venue_id: string;
  readonly display_name: string;
  readonly kind: VenueKind;
  // The venue's contract — for ic_amm the update target (pool canister principal) the phone
  // signs against; for solana_amm an https ORIGIN the phone talks to device-direct (keyless).
  readonly endpoint: string;
  // The traded pair as an UNORDERED pair of identifiers. IC rows: ledger principals. Solana
  // rows: MINTS — and the native side is identified by the WRAPPED-SOL mint (an AMM route
  // names mints; see WRAPPED_SOL_MINT_ADDRESS). Never read as ordered.
  readonly pair_ledgers: readonly string[];
  readonly testnet: boolean;
  // Key into the legal/disclosure copy (app/i18n) — locale text is never in this table.
  readonly disclosure_key: string;
  // OPTIONAL settlement health from GET /api/v1/venues (2026-09-20 SLA gate): 'degraded' =
  // the last measured payout missed the 30-minute SLA or never settled. Absent = never
  // measured — healthy by default, never invented. The DEMOTION is the relay's row order
  // (V5 red line: the app never ranks); the app only renders the honest slow line.
  readonly health?: VenueHealth;
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
  {
    // Pair-scoped ICPSwap pools (registered 2026-09-15): same venue family, each its own pool
    // contract on its own pair. Order mirrors dfx/catalog_truth.json venues[] (stable wire
    // order); the pair stays an UNORDERED set — token0/token1 is read live off each pool.
    venue_id: 'icpswap-ckusdc',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: 'mohjv-bqaaa-aaaag-qjyia-cai',
    pair_ledgers: [mainnetIcLedger(8), mainnetIcLedger(2)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
  {
    venue_id: 'icpswap-cketh',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: 'angxa-baaaa-aaaag-qcvnq-cai',
    pair_ledgers: [mainnetIcLedger(8), mainnetIcLedger(6)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
  {
    // The 2026-09-16 coverage expansion (docs/specs/2026-09-16-convert-coverage-expansion.md
    // §1): four more pair-scoped ICPSwap pools, each MEASURED off the live pool's own
    // `metadata` — same venue family, each its own pool contract on its own pair. Order
    // mirrors dfx/catalog_truth.json venues[] (stable wire order); the pair stays an
    // UNORDERED set — token0/token1 is read live off each pool.
    venue_id: 'icpswap-ckbtc',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: 'xmiu5-jqaaa-aaaag-qbz7q-cai',
    pair_ledgers: [mainnetIcLedger(1), mainnetIcLedger(8)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
  {
    venue_id: 'icpswap-ckbtc-cketh',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: 'akhru-myaaa-aaaag-qcvna-cai',
    pair_ledgers: [mainnetIcLedger(1), mainnetIcLedger(6)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
  {
    venue_id: 'icpswap-vchf-ckusdc',
    display_name: 'ICPSwap',
    kind: 'ic_amm',
    endpoint: 'hx7nb-diaaa-aaaar-qbxsa-cai',
    pair_ledgers: [mainnetIcLedger(7), mainnetIcLedger(2)],
    testnet: false,
    disclosure_key: 'icpswap',
  },
  {
    // The FIRST Solana venue (registered 2026-09-15, multi-venue readiness V11): Jupiter, the
    // autonomous on-chain aggregator, for the rail-local pair SOL ↔ USDC(Solana). Identifier
    // semantics per kind: `endpoint` is an https ORIGIN — the venue's IDENTITY and attribution
    // (it renders in the pool/attribution line), NOT a dial target since 2026-09-16: quotes +
    // unsigned swap tx builds go through dpay's relay proxy (`/api/v1/jupiter/*`,
    // services/jupiter.ts) — and `pair_ledgers` are MINTS — the native side by its WRAPPED form.
    // The mints are DERIVED from the Solana token registry (the app's one copy of each), never
    // standalone literals. No ic fixture exists for this kind (fixtures are ic_amm-only); the
    // offline stand-in is the relay's test stub upstream (DPAY_JUPITER_API_BASE →
    // /api/v1/test/jupiter-upstream, e2e/harness/jupiter.mjs).
    venue_id: 'jupiter',
    display_name: 'Jupiter',
    kind: 'solana_amm',
    endpoint: 'https://lite-api.jup.ag',
    pair_ledgers: [WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'jupiter',
  },
  {
    // The SECOND Solana venue (registered 2026-09-16, coverage expansion §1): the same
    // Jupiter aggregator family, on the rail-local pair SOL ↔ EURC — everything the
    // jupiter row comment above says holds verbatim (https-origin endpoint as identity,
    // relay-proxied dials, mints derived from the Solana token registry, no fixture,
    // offline stand-in = the relay's test stub upstream).
    // Measured live 2026-09-16: SOL→EURC healthy keyless; the USDC↔EURC pair probed
    // 2026-09-16 was SKIPPED on a then-apparent ~13% spread (an artifact of 1:1 USD/EUR
    // parity) and REGISTERED 2026-09-19 as jupiter-usdc-eurc once re-measured.
    venue_id: 'jupiter-eurc',
    display_name: 'Jupiter',
    kind: 'solana_amm',
    endpoint: 'https://lite-api.jup.ag',
    pair_ledgers: [WRAPPED_SOL_MINT_ADDRESS, EURC_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'jupiter',
  },
  {
    // The THIRD Solana venue (registered 2026-09-19, EUR↔USD completion — founder mandate):
    // the same Jupiter aggregator family, on the rail-local pair USDC ↔ EURC — everything
    // the jupiter row comment above says holds verbatim (https-origin endpoint as identity,
    // relay-proxied dials, mints derived from the Solana token registry and UNORDERED, no
    // fixture, offline stand-in = the relay's test stub upstream).
    // Measured live 2026-09-19: 10 USDC → 8.698735 EURC and 8.6 EURC → 9.885319 USDC,
    // keyless, platformFee null — both directions within ~2-3% of fair at EUR/USD ~1.17;
    // the 2026-09-16 skip verdict had compared against 1:1 parity.
    venue_id: 'jupiter-usdc-eurc',
    display_name: 'Jupiter',
    kind: 'solana_amm',
    endpoint: 'https://lite-api.jup.ag',
    pair_ledgers: [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'jupiter',
  },
  {
    // The FIRST CeFi venue (registered 2026-09-15, founder decision 3 — relay-held
    // partner-key infrastructure, docs/specs/2026-09-14-swap-venue-feasibility.md
    // §Partner-key infrastructure): SideShift, an automated instant-exchange service, on
    // the CROSS-RAIL pair ICP ↔ SOL. Identifier semantics per kind: `endpoint` is the
    // venue's https API BASE (verified live 2026-09-15 — the old api.sideshift.ai host
    // is NXDOMAIN), and `pair_ledgers` are RAIL-CANONICAL ids: the IC side by ledger
    // principal, the Solana side by MINT (native SOL as its wrapped form, the jupiter
    // row's own precedent). UNLIKE every other row this venue carries a partner
    // credential — quotes and fixed-order creation run through dpay's relay proxy
    // (app/services/sideshift.ts; the account secret attaches relay-side, never here),
    // while shift STATUS is the venue's own keyless device-direct GET. No ic fixture
    // for this kind (ic_amm-only by rule); the offline stand-ins are the relay's
    // /api/v1/test/sideshift-upstream stub + the e2e window.fetch stub on the status
    // origin.
    venue_id: 'sideshift',
    display_name: 'SideShift',
    kind: 'cefi',
    endpoint: 'https://sideshift.ai/api/v2',
    pair_ledgers: [mainnetIcLedger(8), WRAPPED_SOL_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'sideshift',
  },
  {
    // The SECOND CeFi venue (registered 2026-09-16, coverage expansion §1): the same
    // SideShift venue family, on the cross-rail pair ICP ↔ USDC(Solana) — the first
    // pair with two registered routes from one screen (this beside the CCTP multihop
    // Route B out of the ckUSDC leg). Everything the sideshift row comment above says
    // holds verbatim (relay-held partner key, keyless status reads, no fixture). The
    // venue stays absent until the partner key exists — the 503 tripwire is unchanged.
    venue_id: 'sideshift-usdc',
    display_name: 'SideShift',
    kind: 'cefi',
    endpoint: 'https://sideshift.ai/api/v2',
    pair_ledgers: [mainnetIcLedger(8), USDC_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'sideshift',
  },
  {
    // The THIRD CeFi venue (registered 2026-09-19, the EUR→IC bridge): the same SideShift
    // venue family, on the cross-rail pair ICP ↔ EURC(Solana) — the pair that completes
    // dpay's EUR rail: EURC (deposit on Solana) ⇄ ICP (settle on the Internet Computer),
    // the only registered route between the two. Everything the sideshift row comment
    // above says holds verbatim (relay-held partner key, keyless status reads, no
    // fixture). The pair is verified KEYLESS 2026-09-19: both /pair endpoints answer
    // live, and the venue's own words are `eurc`/`solana` ↔ `ICP`/`icp`. Quoting 503s
    // until the relay holds the founder partner key — the tripwire is unchanged.
    venue_id: 'sideshift-eurc',
    display_name: 'SideShift',
    kind: 'cefi',
    endpoint: 'https://sideshift.ai/api/v2',
    pair_ledgers: [mainnetIcLedger(8), EURC_MINT_ADDRESS],
    testnet: false,
    disclosure_key: 'sideshift',
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

// The solana_amm venues serving a mint, in REGISTRY ORDER — the SOL convert surface's candidate
// list (the venuesForPair analog). `mint` is the venue-side identifier: callers pass the SPL
// mint, or the WRAPPED-SOL mint for native SOL (the registry's identifier for the native side).
// Testnet rows are kept out — the enabled gate for a real wallet is mainnet rows only.
export function solanaVenuesForMint(mint: string): readonly VenueEntry[] {
  return registeredVenues().filter(
    v => v.kind === 'solana_amm' && !v.testnet && v.pair_ledgers.includes(mint),
  );
}

// The bundled solana_amm venue trading this mint, if any — the single place "is SOL convert
// REACHABLE for this asset" is decided (the icAmmVenueForPair analog; fail-closed by null).
export function solanaAmmVenueForMint(mint: string): VenueEntry | null {
  return (
    BUNDLED_VENUES.find(
      v => v.kind === 'solana_amm' && !v.testnet && v.pair_ledgers.includes(mint),
    ) ?? null
  );
}

/** The cefi venue's OTHER-side rail id for this deposit ledger: what actually arrives
 *  (a mint for the Solana rail, a principal for IC). This is the cross-rail widening —
 *  the convert screen's destination rows for CeFi venues are keyed by it. Null when the
 *  venue does not serve this deposit side. */
export function cefiOtherSide(v: VenueEntry, depositLedger: string): string | null {
  if (v.kind !== 'cefi') return null;
  const [a, b] = v.pair_ledgers;
  if (a === depositLedger) return b;
  if (b === depositLedger) return a;
  return null;
}

// The cefi venues a deposit ledger can send through, in REGISTRY ORDER (the
// solanaVenuesForMint analog for the cross-rail surface). Testnet rows are kept out —
// a real wallet only routes deposits at mainnet venues. Callers resolve the other side
// (`cefiOtherSide`) to name what arrives.
export function cefiVenuesForLedger(depositLedger: string): readonly VenueEntry[] {
  return registeredVenues().filter(
    v => v.kind === 'cefi' && !v.testnet && cefiOtherSide(v, depositLedger) != null,
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
