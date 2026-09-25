/**
 * resolveSwapTargets (config/swap.ts) — the currency-level pair walk behind the 2026-09-24
 * swap screen. Successor of the old destination-group pins: the picker is now ONE row per
 * TARGET CURRENCY with the executable ROWS beneath the venue area, and the same honesty
 * contract carries over:
 *   • target ORDER: the caller's currency list order (stables, then Other) — reachable
 *     targets only; the SOURCE currency never appears (the caller filters; the screen
 *     renders it disabled);
 *   • row ORDER inside a target: kind order (direct, hub, crossrail, cefi, solamm), each
 *     kind in its own registry walk order — grouping is presentation, never a re-sort;
 *   • the rows PARTITION the ways to execute the pair — a rowId appears exactly once;
 *   • the resolver sees NO quote, so nothing can be ranked by price (the no-ranking red
 *     line holds by construction);
 *   • external-address cash-out routes (the old Route A) are NOT offered: the swap screen
 *     converts between the user's OWN balances; the withdraw surface owns cash-out.
 * Pinned over the REAL bundled registry, source = VCHF (the richest walk: direct + hub +
 * cross-rail all in one source).
 */
import {describe, expect, jest, test} from '@jest/globals';

import {resolveSwapTargets, standingTarget, type SwapTarget} from '../config/swap';
import {WALLET_CURRENCIES, type HomeCurrency} from '../config/currency';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';

jest.mock('../services/native', () => ({DpayCore: {}}));

const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const VCHF = ASSETS.find(a => a.protocol === 'ic' && a.currency === 7)!;
const SOL_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.symbol === 'SOL')!;
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;

const targetsFor = (source: SelectableAsset): SwapTarget[] =>
  resolveSwapTargets({
    catalog: CATALOG,
    source,
    targetCurrencies: (WALLET_CURRENCIES as readonly HomeCurrency[]).filter(c => c !== source.symbol),
  }) ?? [];

const rowKinds = (t: SwapTarget): string[] => t.rows.map(r => r.kind);
const rowIds = (t: SwapTarget): string[] => t.rows.map(r => r.rowId);

describe('resolveSwapTargets — the currency-level pair walk', () => {
  test('VCHF source: targets in currency-list order, only reachable ones, source excluded', () => {
    const ts = targetsFor(VCHF);
    expect(ts.map(t => t.currency)).toEqual(['USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']);
    expect(ts.some(t => t.currency === 'CHF')).toBe(false);
  });

  test('row kind order is fixed per target: direct, hub, crossrail, cefi, solamm', () => {
    const ts = targetsFor(VCHF);
    const usd = ts.find(t => t.currency === 'USD')!;
    // The standing direct pool first, then the via-ICP hub composition, then the composed
    // CCTP route (Route B lands USDC on the Solana rail — the USD currency's second rail).
    expect(rowKinds(usd)).toEqual(['direct', 'hub', 'crossrail']);
    expect(rowIds(usd)[0]).toBe('icpswap-vchf-ckusdc');
    const sol = ts.find(t => t.currency === 'SOL')!;
    expect(rowKinds(sol)).toEqual(['crossrail']);
    const eth = ts.find(t => t.currency === 'ETH')!;
    // One hub composition reaches ckETH (via ICP — the only pool chain the registry serves).
    expect(rowKinds(eth)).toEqual(['hub']);
    const icp = ts.find(t => t.currency === 'ICP')!;
    expect(rowKinds(icp)).toEqual(['direct', 'hub']);
    expect(rowIds(icp)[0]).toBe('icpswap');
  });

  test('rowIds never repeat within a target (the rows partition the ways to execute)', () => {
    for (const t of targetsFor(VCHF)) {
      expect(new Set(rowIds(t)).size).toBe(rowIds(t).length);
    }
  });

  test('the STANDING target: a STABLE pair wins for a stable source, registry order within', () => {
    // 2026-09-25 visual-validation polish: a fiat holder converting CHF is there for the other
    // stable (CHF→USD, the founder sketch's own flow), not the volatile pair the registry used
    // to open on. icpswap (registry row 0) still wins WITHIN each pass — it just no longer
    // drags a stable source to a volatile target when a stable direct pair exists.
    const standing = standingTarget(targetsFor(VCHF));
    expect(standing?.currency).toBe('USD');
    // A volatile source is unchanged: ICP's registry row 0 pool is ICP↔VCHF, so the standing
    // pair was already the stable CHF before the preference existed.
    const icpTargets = standingTarget(targetsFor(ICP_ASSET));
    expect(icpTargets?.currency).toBe('CHF');
  });

  test('EUR reaches VCHF through the composed CCTP+Jupiter route (Route C generalization)', () => {
    const eur = targetsFor(VCHF).find(t => t.currency === 'EUR');
    expect(eur?.rows.map(r => r.kind)).toEqual(['crossrail']);
    expect(eur?.rows[0]?.rowId).toContain('cctp:jupiter-usdc-eurc');
  });

  test('SOL source: rail-local venues as solamm rows, the cross-rail CeFi rows as cefi rows', () => {
    const ts = targetsFor(SOL_ASSET);
    expect(ts.map(t => t.currency)).toEqual(['USD', 'EUR', 'ICP']);
    const usd = ts.find(t => t.currency === 'USD')!;
    expect(rowKinds(usd)).toEqual(['solamm']);
    expect(rowIds(usd)).toEqual(['jupiter']);
    const eur = ts.find(t => t.currency === 'EUR')!;
    expect(rowIds(eur)).toEqual(['jupiter-eurc']);
    const icp = ts.find(t => t.currency === 'ICP')!;
    // Both CeFi services on the ICP landing spot, registry order — never ranked.
    expect(rowKinds(icp)).toEqual(['cefi', 'cefi']);
    expect(rowIds(icp)).toEqual(['sideshift', 'trocador']);
  });

  test('cross-rail routes never offer the external-address cash-out (Route A is not a swap row)', () => {
    for (const t of targetsFor(VCHF)) {
      for (const r of t.rows) {
        if (r.kind === 'crossrail') expect(r.route.crossRail).toBeDefined();
      }
    }
  });
});
