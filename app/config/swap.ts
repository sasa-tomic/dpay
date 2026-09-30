// The SWAP PAIR resolution — the currency-level walk behind the 2026-09-24 swap screen.
//
// The redesign makes Convert a first-class action of every CURRENCY (founder sketch): the user
// names a source currency and a target currency, and the screen below shows THE VENUES that
// serve the resolved pair (fork #3: several venues → rows in registry order, NONE preselected,
// the user picks). This module is that resolution, pure and total: everything the screen can
// offer for (source asset, target currency), derived from the same registries every other
// convert surface reads — never hardcoded, never ranked by anything but registry walk order.
//
// A row is ONE executable way to convert the standing source rail into the target currency:
//   direct     a registered ic_amm pool trading (source ledger, target IC rail)
//   solamm     a registered solana_amm venue (Jupiter) trading the SOL-rail pair
//   hub        a 2-leg IC composition over two pools (app/routes.ts hubRoutes)
//   composed   an IC→CeFi chain (design brief 2026-09-26 §5.4 item 2): the IC legs land the
//              hub asset in this wallet, then a registered cefi venue's order carries it to a
//              SOL-rail mint — the walk comes from resolveConvertDestinations (./convert), the
//              same source every other convert surface reads
//   crossrail  a composed CCTP route (Routes B/C — in-wallet landings only; the external-address
//              cash-out routes are NOT offered here: the swap screen converts BETWEEN the user's
//              own balances, and cashing out to an external address is the withdraw surface's job)
//   cefi       a registered CeFi venue (SideShift/Trocador) whose pair carries the two rails
//
// Registry order is the ONLY order: targets follow the caller's currency list (stables, then
// Other), rows follow kind order (direct, hub, composed, crossrail, cefi, solamm) with each kind
// in its own registry walk order. Nothing here sees a quote, so nothing here can rank by price —
// the no-ranking red line holds by construction.
//
// PURE: no React, no network. Deterministic in (catalog, assets, source, target currencies).
import type {CurrencyDescriptor} from './catalog';
import type {SelectableAsset} from './assets';
import {currencyOfLinkToken, isStableCurrency, type HomeCurrency} from './currency';
import {assetLinkToken} from './catalog';
import {
  cefiOtherSide,
  cefiVenuesForLedger,
  registeredVenues,
  solanaVenuesForMint,
  venuesForPair,
  type VenueEntry,
} from './venues';
import {hubRoutes, multihopRoutesFrom, type HubRoute, type MultihopRoute} from '../routes';
import {hubEndpointOf} from '../routes';
import {resolveConvertDestinations, type ChainConvertRoute, type ComposedConvertRoute} from './convert';
import {ETH_NATIVE_CHAIN_ID, ETH_NATIVE_DECIMALS, ETH_NATIVE_RAIL_ID, ETH_NATIVE_SYMBOL, evmNativeVenuesForLedger} from './evmConvert';
import {evmAmmChainOf, evmAmmRailId, evmAmmVenuesForRail, evmNativeRailId} from './evmAmm';
import type {EvmAsset} from '../lib/evmCatalog';
import {SOLANA_TOKENS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

/** Mint → {symbol, decimals} for venue-pair mints: the wrapped-SOL identifier resolves to SOL
 *  itself (the registry's stable id for the native side), everything else reverse-looks-up the
 *  SPL registry. Null for unknown mints — every consumer fails closed on it. (Moved verbatim
 *  from the old ConvertSolDest module — one resolver, one copy.) */
export function solAssetOfMint(mint: string): {symbol: string; decimals: number} | null {
  if (mint === WRAPPED_SOL_MINT_ADDRESS) {
    return {symbol: 'SOL', decimals: SOLANA_TOKENS.SOL.decimals};
  }
  const found = Object.entries(SOLANA_TOKENS).find(([, info]) => info.mint === mint);
  return found != null ? {symbol: found[0], decimals: found[1].decimals} : null;
}

/** ONE executable way to convert the standing source rail into the target currency. Every
 *  variant carries everything its quote flow and confirm need, resolved + priced (a row whose
 *  legs cannot be priced is not a row — the fail-closed bar every registry walk here applies). */
export type SwapRow =
  | {kind: 'direct'; rowId: string; venue: VenueEntry; inLedger: string; outLedger: string; outDesc: CurrencyDescriptor}
  | {kind: 'hub'; rowId: string; route: HubRoute}
  | {kind: 'composed'; rowId: string; route: ComposedConvertRoute}
  | {kind: 'chain'; rowId: string; route: ChainConvertRoute}
  | {kind: 'crossrail'; rowId: string; route: MultihopRoute}
  | {kind: 'cefi'; rowId: string; venue: VenueEntry; inLedgerOrMint: string; outLedger: string | null; outMint: string | null; outSym: string; outDecimals: number;
     /** The settle side's RAIL-CANONICAL id when the venue pays NATIVE gas on an EVM chain
      *  (the 2026-09-27 widening: ICP → native ETH, `ETH_NATIVE_RAIL_ID`) — the settle
      *  address is the device's EVM address (chain-independent derivation), not an IC
      *  account id and not a Solana pubkey. Null on every IC-ledger and Solana-mint settle
      *  (the discriminator the sheet and the quote call key on — the quote sends it as the
      *  settle rail id, exactly what the relay maps onto the venue's coin/network codes). */
     outRailId: string | null}
  | {kind: 'solamm'; rowId: string; venue: VenueEntry; inMint: string; outMint: string; outSym: string; outDecimals: number}
  // The EVM widening (2026-09-28, the any-pair mandate): a Uniswap V3 row (config/evmAmm.ts)
  // trading an EVM-token source into a same-chain rail — native gas (the unwrap path) or
  // another catalog token. Rail ids are chain-qualified (`evm:<chainId>:<address>`), so a
  // row can never cross chains: one chain serves one ledger (the wrong-chain gate's doctrine).
  | {kind: 'evmamm'; rowId: string; venue: VenueEntry; chainId: number; inRailId: string; inAddress: string; inSymbol: string; inDecimals: number;
     out: {kind: 'native'; railId: string; symbol: string; decimals: number}
       | {kind: 'token'; railId: string; address: string; symbol: string; decimals: number}};

/** One TARGET CURRENCY and every row that reaches it from the standing source. `unavailable`
 *  is set (with the reason) when NO executable row exists: the pair stays VISIBLE and refuses
 *  honestly — absence is never the verdict for a named target (the any-pair mandate, 2026-09-28). */
export type SwapTarget = {currency: HomeCurrency; rows: SwapRow[]; unavailable?: 'no-venue'};

/** One TARGET RAIL, resolved from the CATALOG and the Solana token registry — deliberately NOT
 *  from the wallet's selectable-asset list: the asset list is RPC-gated (a Solana rail whose
 *  endpoint is unconfigured renders no rows), while a swap TARGET is a registry fact — the CCTP
 *  route lands USDC on Solana whether or not this device has ever polled that rail. The
 *  EVM-native rail (native ETH on Ethereum) is the EXCEPTION: it is RPC-gated like the asset
 *  list (`evmEnabled`), because its completion UX is the chain's own balance surface — a
 *  destination whose arrival the device cannot show is a silent dead end (the 84d07b3 rule). */
type SwapRail = {kind: 'ic'; ledger: string} | {kind: 'sol'; mint: string}
  | {kind: 'evm-native'; railId: string; chainId: number}
  | {kind: 'evm-token'; railId: string; chainId: number; address: string; symbol: string; decimals: number};

/** Every mainnet rail that settles `currency`, in preference order: the IC catalog rows whose
 *  link token settles it, then the SOL-registry mints, then the EVM rails (catalog token rows +
 *  the chain-qualified native settle rails — `evmConvert.ts` / `evmAmm.ts`, gated on the
 *  caller's EVM-rail enablement). Derived, never hardcoded. `sourceChainId` scopes the native
 *  settle rail to the SOURCE's chain when the source itself is an EVM rail: a destination the
 *  source chain cannot pay for is not a rail (one chain serves one ledger). */
function railsOfCurrency(
  currency: HomeCurrency,
  catalog: CurrencyDescriptor[],
  evmEnabled: boolean,
  evmAssets: readonly EvmAsset[],
  sourceChainId: number | null,
): SwapRail[] {
  const rails: SwapRail[] = [];
  for (const row of catalog) {
    if (row.testnet || row.ledger == null || row.ledger === '') continue;
    if (currencyOfLinkToken(assetLinkToken(row)) === currency) rails.push({kind: 'ic', ledger: row.ledger});
  }
  for (const [name, info] of Object.entries(SOLANA_TOKENS)) {
    if (currencyOfLinkToken(name) !== currency) continue;
    // Native SOL rides the registry's WRAPPED identifier (the venue rows' own convention).
    rails.push({kind: 'sol', mint: info.mint ?? WRAPPED_SOL_MINT_ADDRESS});
  }
  // The EVM-token settle rails: the catalog's own EVM rows, chain-qualified.
  if (evmEnabled) {
    for (const row of evmAssets) {
      if (row.testnet) continue;
      if (currencyOfLinkToken(row.token) !== currency) continue;
      rails.push({kind: 'evm-token', chainId: row.chainId, railId: evmAmmRailId(row.chainId, row.address), address: row.address, symbol: row.symbol, decimals: row.decimals});
    }
  }
  // The EVM-native settle rails: first the chain-1 rail every IC/SOL cefi row settles
  // (`ETH_NATIVE_RAIL_ID`), then — when the SOURCE itself is an EVM rail — the source
  // chain's own native rail (the Uniswap unwrap destination). Gated, like the asset list,
  // on the EVM rail being configured at all.
  if (evmEnabled && currency === 'ETH') {
    rails.push({kind: 'evm-native', railId: ETH_NATIVE_RAIL_ID, chainId: ETH_NATIVE_CHAIN_ID});
    if (sourceChainId != null) {
      const railId = evmNativeRailId(sourceChainId);
      if (!rails.some(r => r.kind === 'evm-native' && r.railId === railId)) {
        rails.push({kind: 'evm-native', railId, chainId: sourceChainId});
      }
    }
  }
  return rails;
}

/** Every target-currency + rows list for the standing source, over the caller's target
 *  currencies (the visible list — the wallet's own currency-first scope). EVERY requested
 *  target is returned: one with no executable row carries `unavailable: 'no-venue'` — the
 *  pair is visible and refused with the reason, never silently hidden (the any-pair
 *  mandate, 2026-09-28). Null when the source rail itself cannot be resolved (no catalog
 *  row, a testnet row, an unknown mint). */
export function resolveSwapTargets(args: {
  catalog: CurrencyDescriptor[];
  source: SelectableAsset;
  /** The currencies offered as targets, in presentation order, source EXCLUDED by the caller. */
  targetCurrencies: readonly HomeCurrency[];
  /** Whether the EVM rail is configured (the same `isEvmRailConfigured` gate the EVM asset
   *  surfaces read). Gates the EVM rails — absent/false resolves exactly the pre-ETH walk
   *  (byte-stable history for every other row). */
  evmEnabled?: boolean;
  /** The catalog's EVM token rows (the `evmAssetsOf(networks)` view) — the evm-token settle
   *  rails + the EVM source's own display facts derive from them. */
  evmAssets?: readonly EvmAsset[];
}): SwapTarget[] | null {
  const {catalog, source, targetCurrencies} = args;
  const evmEnabled = args.evmEnabled ?? false;
  const evmAssets = args.evmAssets ?? [];
  const inLedger = source.protocol === 'ic'
    ? catalog.find(c => c.currency === source.currency)?.ledger ?? null
    : null;
  const inMint: string | null = source.protocol === 'solana'
    ? (source.mint ?? WRAPPED_SOL_MINT_ADDRESS)
    : null;
  if (source.protocol === 'ic' && (inLedger == null || inLedger === '')) return null;
  const inRow = source.protocol === 'ic'
    ? catalog.find(c => c.currency === source.currency)
    : null;
  if (source.protocol === 'ic' && (inRow == null || inRow.testnet)) return null;
  if (source.protocol === 'solana' && solAssetOfMint(inMint!) == null) return null;
  // The EVM source rail: the asset's own chain + contract (a parsed, EIP-55-verified row —
  // the wallet only mounts Convert on assets the catalog served).
  const inEvm = source.protocol === 'evm' && evmEnabled
    ? {
        chainId: source.chainId,
        railId: evmAmmRailId(source.chainId, source.address),
        address: source.address,
        symbol: source.symbol,
        decimals: source.decimals,
      }
    : null;
  const sourceChainId = inEvm?.chainId ?? null;

  // Pre-resolve the composed-route walks once per source (they are source-keyed, not
  // target-keyed): the crossrail rows filter the same walk every previous surface walked.
  const crossrailRoutes = inLedger != null && inRow != null && !inRow.testnet
    ? multihopRoutesFrom(catalog, inRow.currency).filter(r => r.crossRail != null)
    : [];
  // The composed IC→CeFi routes (2026-09-26), keyed by their SETTLE MINT so they join the
  // target rail loop below exactly like the crossrail rows do. resolveConvertDestinations
  // is the one walk (the IC-ledger destinations it also returns are this module's own
  // direct/hub rows and are ignored here).
  const composedByMint = new Map<string, ComposedConvertRoute[]>();
  if (inLedger != null && inRow != null && !inRow.testnet) {
    for (const dest of resolveConvertDestinations(inLedger, inRow.testnet, catalog)) {
      for (const route of dest.routes) {
        if (route.kind !== 'composed') continue;
        const list = composedByMint.get(route.settleMint);
        if (list != null) list.push(route);
        else composedByMint.set(route.settleMint, [route]);
      }
    }
  }

  const targets: SwapTarget[] = [];
  for (const currency of targetCurrencies) {
    const direct: SwapRow[] = [];
    const hub: SwapRow[] = [];
    const composed: SwapRow[] = [];
    const chain: SwapRow[] = [];
    const cross: SwapRow[] = [];
    const cefi: SwapRow[] = [];
    const amm: SwapRow[] = [];
    const evmamm: SwapRow[] = [];
    for (const rail of railsOfCurrency(currency, catalog, evmEnabled, evmAssets, sourceChainId)) {
      const ledger = rail.kind === 'ic' ? rail.ledger : null;
      const mint = rail.kind === 'sol' ? rail.mint : null;
      const evmRailId = rail.kind === 'evm-native' ? rail.railId : null;
      // DIRECT — a registered pool trading the two IC ledgers.
      if (inLedger != null && ledger != null) {
        for (const v of venuesForPair(inLedger, ledger)) {
          const outDesc = catalog.find(c => c.ledger === ledger);
          if (outDesc == null || outDesc.fee == null || outDesc.decimals == null) continue;
          direct.push({kind: 'direct', rowId: v.venue_id, venue: v, inLedger, outLedger: ledger, outDesc});
        }
        // HUB — a 2-leg composition onto this IC rail.
        for (const hr of hubRoutes(catalog, inLedger, ledger)) {
          hub.push({kind: 'hub', rowId: hr.routeId, route: hr});
        }
      }
      // COMPOSED — an IC→CeFi chain whose settle side lands this rail's mint.
      if (mint != null) {
        for (const route of composedByMint.get(mint) ?? []) {
          composed.push({kind: 'composed', rowId: route.routeId, route});
        }
      }
      // CHAIN — the composed mirror (2026-09-28): a cefi venue carries the SOL source into
      // a mid IC ledger, and registered IC legs carry it on to THIS IC rail. The plain
      // cefi row (venue's other side IS this ledger) is not a chain — it already stands.
      // Every leg fails closed on a row the catalog cannot fully price, like every walk.
      if (inMint != null && ledger != null) {
        const destRow = catalog.find(c => c.ledger === ledger && !c.testnet);
        if (destRow != null && destRow.fee != null && destRow.decimals != null
          && (destRow.backing_symbol ?? destRow.symbol) != null) {
          for (const v of cefiVenuesForLedger(inMint)) {
            const mid = cefiOtherSide(v, inMint);
            if (mid == null || mid === ledger) continue;
            const midEp = hubEndpointOf(catalog, mid);
            if (midEp == null) continue;
            const deposit = solAssetOfMint(inMint);
            if (deposit == null) continue;
            for (const pool of registeredVenues()) {
              if (pool.kind !== 'ic_amm' || pool.testnet) continue;
              if (!pool.pair_ledgers.includes(mid) || !pool.pair_ledgers.includes(ledger)) continue;
              chain.push({
                kind: 'chain',
                rowId: `chain:${v.venue_id}:${pool.venue_id}`,
                route: {
                  kind: 'chain',
                  routeId: `chain:${v.venue_id}:${pool.venue_id}`,
                  cefiVenueId: v.venue_id,
                  depositMint: inMint,
                  depositSymbol: deposit.symbol,
                  depositDecimals: deposit.decimals,
                  legs: [{venueId: pool.venue_id, pool: pool.endpoint, fromLedger: mid, toLedger: ledger}],
                  endpoints: [midEp, {currency: destRow.currency, ledger, symbol: destRow.backing_symbol ?? destRow.symbol!, decimals: destRow.decimals, fee: destRow.fee, network: destRow.network ?? 'Internet Computer'}],
                },
              });
            }
            for (const hr of hubRoutes(catalog, mid, ledger)) {
              chain.push({
                kind: 'chain',
                rowId: `chain:${v.venue_id}:${hr.routeId}`,
                route: {
                  kind: 'chain',
                  routeId: `chain:${v.venue_id}:${hr.routeId}`,
                  cefiVenueId: v.venue_id,
                  depositMint: inMint,
                  depositSymbol: deposit.symbol,
                  depositDecimals: deposit.decimals,
                  legs: hr.legs.map(l => ({...l})),
                  endpoints: [midEp, hr.hub, hr.dest],
                },
              });
            }
          }
        }
      }
      // CROSSRAIL — a composed CCTP route whose FINAL landing is this rail's mint.
      // Route B (no sol leg) mints canonical USDC on Solana, period — the CCTP builder is
      // pinned to it. Route C lands its own registered out mint.
      if (mint != null) {
        for (const r of crossrailRoutes) {
          const outMint = r.crossRail?.sol != null ? r.crossRail.sol.outMint : USDC_MINT_ADDRESS;
          if (outMint !== mint) continue;
          cross.push({kind: 'crossrail', rowId: r.routeId, route: r});
        }
      }
      // CEFI — a registered venue whose pair carries the source rail and this target rail.
      if (inLedger != null && mint != null) {
        for (const v of cefiVenuesForLedger(inLedger)) {
          if (cefiOtherSide(v, inLedger) !== mint) continue;
          const tok = solAssetOfMint(mint);
          if (tok == null) continue;
          cefi.push({kind: 'cefi', rowId: v.venue_id, venue: v, inLedgerOrMint: inLedger, outLedger: null, outMint: mint, outSym: tok.symbol, outDecimals: tok.decimals, outRailId: null});
        }
      }
      if (inMint != null && ledger != null) {
        for (const v of cefiVenuesForLedger(inMint)) {
          if (cefiOtherSide(v, inMint) !== ledger) continue;
          const row = catalog.find(c => c.ledger === ledger);
          if (row == null || row.decimals == null) continue;
          const sym = row.backing_symbol ?? row.symbol;
          if (sym == null) continue;
          cefi.push({kind: 'cefi', rowId: v.venue_id, venue: v, inLedgerOrMint: inMint, outLedger: ledger, outMint: null, outSym: sym, outDecimals: row.decimals, outRailId: null});
        }
      }
      // CEFI, EVM-NATIVE settle (2026-09-27): an IC source paying an adapter-owned venue
      // whose payout is NATIVE gas on an EVM chain — first ICP → native ETH. The settle
      // side has no catalog row and no mint, so the walk keys on the settle RAIL id; the
      // row carries it verbatim (the settle address is the device's EVM address — the
      // derivation is a function of the key, not of the chain).
      if (inLedger != null && evmRailId != null) {
        for (const v of evmNativeVenuesForLedger(inLedger)) {
          if (cefiOtherSide(v, inLedger) !== evmRailId) continue;
          cefi.push({kind: 'cefi', rowId: v.venue_id, venue: v, inLedgerOrMint: inLedger, outLedger: null, outMint: null, outSym: ETH_NATIVE_SYMBOL, outDecimals: ETH_NATIVE_DECIMALS, outRailId: evmRailId});
        }
      }
      // SOLAMM — a registered Solana venue trading the SOL-rail pair.
      if (inMint != null && mint != null) {
        for (const v of solanaVenuesForMint(inMint)) {
          if (!v.pair_ledgers.includes(mint)) continue;
          const tok = solAssetOfMint(mint);
          if (tok == null) continue;
          amm.push({kind: 'solamm', rowId: v.venue_id, venue: v, inMint, outMint: mint, outSym: tok.symbol, outDecimals: tok.decimals});
        }
      }
      // EVMAMM — a Uniswap V3 row trading the EVM-token source into this EVM rail
      // (native gas of the SAME chain, or another catalog token on it). The venue rows
      // carry chain-qualified rail ids, so a cross-chain match is structurally impossible.
      if (inEvm != null && (rail.kind === 'evm-native' || rail.kind === 'evm-token')) {
        const outRailId = rail.railId;
        if (outRailId !== inEvm.railId) {
          for (const v of evmAmmVenuesForRail(inEvm.railId)) {
            const otherSide = v.pair_ledgers.find(l => l !== inEvm.railId);
            if (otherSide !== outRailId) continue;
            const out = rail.kind === 'evm-native'
              ? {kind: 'native' as const, railId: rail.railId, symbol: railChainNative(v)?.nativeSymbol ?? 'ETH', decimals: 18}
              : {kind: 'token' as const, railId: rail.railId, address: rail.address, symbol: rail.symbol, decimals: rail.decimals};
            evmamm.push({kind: 'evmamm', rowId: v.venue_id, venue: v, chainId: inEvm.chainId, inRailId: inEvm.railId, inAddress: inEvm.address, inSymbol: inEvm.symbol, inDecimals: inEvm.decimals, out});
          }
        }
      }
    }
    // Kind order is fixed (direct, hub, composed, chain, crossrail, cefi, solamm, evmamm);
    // inside a kind, registry walk order. A duplicate rowId cannot exist within one kind
    // (venue/route ids are unique per walk), and one row lands in exactly one kind — the
    // list is dedupe-free by construction.
    const all = [...direct, ...hub, ...composed, ...chain, ...cross, ...cefi, ...amm, ...evmamm];
    // HONEST UNAVAILABILITY: a target with no executable row is still returned, refused
    // with the reason — the pair stays visible in the picker (the any-pair mandate).
    targets.push(all.length > 0 ? {currency, rows: all} : {currency, rows: [], unavailable: 'no-venue'});
  }
  return targets;
}

/** The evmAmm chain facts behind a venue row (the native rail's display name comes from the
 *  chain registry — the venue row itself carries only rail ids). */
function railChainNative(v: {venue_id: string}): {nativeSymbol: string} | null {
  const chain = evmAmmChainOf(v.venue_id);
  return chain != null ? {nativeSymbol: chain.nativeSymbol} : null;
}

/** The STANDING target: for a STABLE source, the stable pair (CHF→USD, not CHF→a volatile) —
 *  the founder's decision (2026-09-25, recorded in the redesign spec) after visual validation
 *  surfaced the volatile historical default: a fiat holder is there for the other stable, one
 *  fewer tap. A categorical preference, not a ranking: the founder's no-ranking rule governs
 *  VENUES (fork 3 — venues are the things a price could rank), and within each pass the winner
 *  is still the FIRST registered rail-local row (an ic_amm pool or a Solana venue — registry
 *  order). Falls back through non-stable direct targets, then the first reachable target for a
 *  source with no direct row (a hub-only source). Null when the source reaches nothing. */
export function standingTarget(targets: SwapTarget[]): SwapTarget | null {
  const walk = (stableOnly: boolean): SwapTarget | null => {
    let best: SwapTarget | null = null;
    let bestIdx = Number.MAX_SAFE_INTEGER;
    for (const t of targets) {
      if (stableOnly && !isStableCurrency(t.currency)) continue;
      for (const r of t.rows) {
        if (r.kind !== 'direct' && r.kind !== 'solamm') continue;
        const idx = registeredVenues().findIndex(v => v.venue_id === r.rowId);
        if (idx >= 0 && idx < bestIdx) {
          bestIdx = idx;
          best = t;
        }
      }
    }
    return best;
  };
  return walk(true) ?? walk(false) ?? targets.find(t => t.rows.length > 0) ?? null;
}
