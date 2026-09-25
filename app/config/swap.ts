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
//   crossrail  a composed CCTP route (Routes B/C — in-wallet landings only; the external-address
//              cash-out routes are NOT offered here: the swap screen converts BETWEEN the user's
//              own balances, and cashing out to an external address is the withdraw surface's job)
//   cefi       a registered CeFi venue (SideShift/Trocador) whose pair carries the two rails
//
// Registry order is the ONLY order: targets follow the caller's currency list (stables, then
// Other), rows follow kind order (direct, hub, crossrail, cefi, solamm) with each kind in its
// own registry walk order. Nothing here sees a quote, so nothing here can rank by price —
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
  | {kind: 'crossrail'; rowId: string; route: MultihopRoute}
  | {kind: 'cefi'; rowId: string; venue: VenueEntry; inLedgerOrMint: string; outLedger: string | null; outMint: string | null; outSym: string; outDecimals: number}
  | {kind: 'solamm'; rowId: string; venue: VenueEntry; inMint: string; outMint: string; outSym: string; outDecimals: number};

/** One TARGET CURRENCY and every row that reaches it from the standing source. */
export type SwapTarget = {currency: HomeCurrency; rows: SwapRow[]};

/** One TARGET RAIL, resolved from the CATALOG and the Solana token registry — deliberately NOT
 *  from the wallet's selectable-asset list: the asset list is RPC-gated (a Solana rail whose
 *  endpoint is unconfigured renders no rows), while a swap TARGET is a registry fact — the CCTP
 *  route lands USDC on Solana whether or not this device has ever polled that rail. */
type SwapRail = {kind: 'ic'; ledger: string} | {kind: 'sol'; mint: string};

/** Every mainnet rail that settles `currency`, in preference order: the IC catalog rows whose
 *  link token settles it, then the SOL-registry mints. Derived, never hardcoded. */
function railsOfCurrency(currency: HomeCurrency, catalog: CurrencyDescriptor[]): SwapRail[] {
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
  return rails;
}

/** Every target-currency + rows list for the standing source, over the caller's target
 *  currencies (the visible list — the wallet's own currency-first scope). A target with NO
 *  executable row is not offered: absence is the honest verdict for an unquoted pair, and the
 *  screen's no-market state covers the venue-side emptiness (the flow-207 pattern). Null when
 *  the source rail itself cannot be resolved (no catalog row, a testnet row, an unknown mint). */
export function resolveSwapTargets(args: {
  catalog: CurrencyDescriptor[];
  source: SelectableAsset;
  /** The currencies offered as targets, in presentation order, source EXCLUDED by the caller. */
  targetCurrencies: readonly HomeCurrency[];
}): SwapTarget[] | null {
  const {catalog, source, targetCurrencies} = args;
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

  // Pre-resolve the composed-route walks once per source (they are source-keyed, not
  // target-keyed): the crossrail rows filter the same walk every previous surface walked.
  const crossrailRoutes = inLedger != null && inRow != null && !inRow.testnet
    ? multihopRoutesFrom(catalog, inRow.currency).filter(r => r.crossRail != null)
    : [];

  const targets: SwapTarget[] = [];
  for (const currency of targetCurrencies) {
    const direct: SwapRow[] = [];
    const hub: SwapRow[] = [];
    const cross: SwapRow[] = [];
    const cefi: SwapRow[] = [];
    const amm: SwapRow[] = [];
    for (const rail of railsOfCurrency(currency, catalog)) {
      const ledger = rail.kind === 'ic' ? rail.ledger : null;
      const mint = rail.kind === 'sol' ? rail.mint : null;
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
          cefi.push({kind: 'cefi', rowId: v.venue_id, venue: v, inLedgerOrMint: inLedger, outLedger: null, outMint: mint, outSym: tok.symbol, outDecimals: tok.decimals});
        }
      }
      if (inMint != null && ledger != null) {
        for (const v of cefiVenuesForLedger(inMint)) {
          if (cefiOtherSide(v, inMint) !== ledger) continue;
          const row = catalog.find(c => c.ledger === ledger);
          if (row == null || row.decimals == null) continue;
          const sym = row.backing_symbol ?? row.symbol;
          if (sym == null) continue;
          cefi.push({kind: 'cefi', rowId: v.venue_id, venue: v, inLedgerOrMint: inMint, outLedger: ledger, outMint: null, outSym: sym, outDecimals: row.decimals});
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
    }
    // Kind order is fixed (direct, hub, crossrail, cefi, solamm); inside a kind, registry walk
    // order. A duplicate rowId cannot exist within one kind (venue/route ids are unique per
    // walk), and one row lands in exactly one kind — the list is dedupe-free by construction.
    const all = [...direct, ...hub, ...cross, ...cefi, ...amm];
    if (all.length > 0) targets.push({currency, rows: all});
  }
  return targets;
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
  return walk(true) ?? walk(false) ?? targets[0] ?? null;
}
