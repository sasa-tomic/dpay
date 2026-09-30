// resolveSwapTargets — the EVM widening (2026-09-28, the any-pair mandate):
//   • an EVM source (a ZCHF row) resolves evm_amm rows into the same-chain native gas rail;
//   • the native rail is CHAIN-QUALIFIED (a chain-1 source targets chain-1 native ETH, an
//     Arbitrum source targets Arbitrum native ETH — one chain serves one ledger);
//   • an IC source keeps the chain-1 sideshift settle rail only (byte-stable history);
//   • HONEST UNAVAILABILITY: a target currency with no executable row is still RETURNED,
//     marked `unavailable: 'no-venue'` — visible, refused with the reason, never hidden.
import {describe, expect, it, beforeEach, afterEach} from '@jest/globals';

import {resolveSwapTargets, type SwapTarget} from '../config/swap';
import type {SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {ETH_NATIVE_RAIL_ID} from '../config/evmConvert';
import {evmAmmRailId, evmNativeRailId} from '../config/evmAmm';
import {setEvmDevToken, clearEvmDevToken} from '../evm/chains';

const catalog: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);

function evmSource(chainId: 1 | 42161, address: string): SelectableAsset {
  return {
    id: `evm:${chainId}:ZCHF`,
    protocol: 'evm',
    token: 'ZCHF',
    symbol: 'ZCHF',
    linkToken: 'ZCHF',
    chainId,
    chainName: chainId === 1 ? 'Ethereum' : 'Arbitrum One',
    address,
    decimals: 18,
    minFractionDigits: 2,
    native: false,
  } as unknown as SelectableAsset;
}

const TARGETS = ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const;

describe('resolveSwapTargets — the EVM widening', () => {
  beforeEach(() => {
    // A chain-1 dev token stands in for the catalog row the source asset carries (the same
    // seam the e2e driver uses); the venue rows themselves are pinned in the registry.
    setEvmDevToken({chainId: 1, address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB', domainKind: 'minimal'});
  });
  afterEach(() => clearEvmDevToken());

  it('an EVM source resolves the same-chain native-ETH rail through the Uniswap row', () => {
    const targets = resolveSwapTargets({
      catalog,
      source: evmSource(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'),
      targetCurrencies: TARGETS,
      evmEnabled: true,
      evmAssets: [{
        token: 'ZCHF', symbol: 'ZCHF', decimals: 18, minFractionDigits: 2,
        chainId: 1, address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
        liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
      }],
    });
    expect(targets).not.toBeNull();
    const eth = targets!.find(t => t.currency === 'ETH');
    expect(eth).toBeDefined();
    const row = eth!.rows.find(r => r.kind === 'evmamm');
    expect(row).toBeDefined();
    if (row?.kind !== 'evmamm') return;
    expect(row.venue.venue_id).toBe('uniswapv3-eth');
    expect(row.chainId).toBe(1);
    expect(row.inRailId).toBe(evmAmmRailId(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'));
    expect(row.out.kind).toBe('native');
    if (row.out.kind !== 'native') return;
    expect(row.out.railId).toBe(evmNativeRailId(1));
    expect(row.out.symbol).toBe('ETH');
    expect(row.out.decimals).toBe(18);
  });

  it('is chain-qualified: an Arbitrum source never resolves the chain-1 native rail', () => {
    const targets = resolveSwapTargets({
      catalog,
      source: evmSource(42161, '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553'),
      targetCurrencies: TARGETS,
      evmEnabled: true,
      evmAssets: [{
        token: 'ZCHF', symbol: 'ZCHF', decimals: 18, minFractionDigits: 2,
        chainId: 42161, address: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553',
        liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
      }],
    });
    const eth = targets!.find(t => t.currency === 'ETH');
    const row = eth!.rows.find(r => r.kind === 'evmamm');
    if (row?.kind !== 'evmamm') return; // the assert below fails first
    expect(row.venue.venue_id).toBe('uniswapv3-arb');
    expect(row.chainId).toBe(42161);
    expect(row.out.kind === 'native' && row.out.railId).toBe(evmNativeRailId(42161));
  });

  it('is rail-gated: with the EVM rail off, an EVM source resolves nothing', () => {
    const targets = resolveSwapTargets({
      catalog,
      source: evmSource(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'),
      targetCurrencies: TARGETS,
      evmEnabled: false,
    });
    expect(targets).not.toBeNull();
    expect(targets!.every(t => t.rows.length === 0)).toBe(true);
  });

  it('an IC source keeps the chain-1 sideshift rail for ETH and never sees evm_amm rows', () => {
    const targets = resolveSwapTargets({
      catalog,
      source: {id: 'ic:8', protocol: 'ic', currency: 8, symbol: 'ICP', linkToken: 'ICP'} as unknown as SelectableAsset,
      targetCurrencies: TARGETS,
      evmEnabled: true,
      evmAssets: [{
        token: 'ZCHF', symbol: 'ZCHF', decimals: 18, minFractionDigits: 2,
        chainId: 1, address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
        liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
      }],
    });
    const eth = targets!.find(t => t.currency === 'ETH');
    const cefi = eth!.rows.find(r => r.kind === 'cefi' && r.venue.venue_id === 'sideshift-eth');
    expect(cefi).toBeDefined();
    expect(eth!.rows.every(r => r.kind !== 'evmamm')).toBe(true);
    const cefiRow = cefi as Extract<NonNullable<typeof cefi>, {kind: 'cefi'}>;
    expect(cefiRow.outRailId).toBe(ETH_NATIVE_RAIL_ID);
  });

  it('HONEST UNAVAILABILITY: an unreachable target stays visible with the no-venue reason', () => {
    const targets = resolveSwapTargets({
      catalog,
      source: evmSource(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'),
      targetCurrencies: TARGETS,
      evmEnabled: true,
      evmAssets: [{
        token: 'ZCHF', symbol: 'ZCHF', decimals: 18, minFractionDigits: 2,
        chainId: 1, address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
        liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
      }],
    });
    expect(targets).not.toBeNull();
    const ids = targets!.map(t => t.currency);
    // Every requested target is PRESENT — none silently hidden.
    for (const c of TARGETS) expect(ids).toContain(c);
    const usd = targets!.find(t => t.currency === 'USD')!;
    expect(usd.rows.length).toBe(0);
    expect(usd.unavailable).toBe('no-venue');
    // A reachable target carries no unavailable marker.
    const eth = targets!.find(t => t.currency === 'ETH')!;
    expect(eth.rows.length).toBeGreaterThan(0);
    expect(eth.unavailable).toBeUndefined();
  });

  it('shape: a testnet source still returns null; a resolvable source returns every target', () => {
    // A testnet source was always refused wholesale.
    expect(resolveSwapTargets({
      catalog,
      source: {id: 'ic:3', protocol: 'ic', currency: 3, symbol: 'ckBTC', linkToken: 'ckBTC'} as unknown as SelectableAsset,
      targetCurrencies: TARGETS,
      evmEnabled: false,
    })).toBeNull();
    // A resolvable IC source returns EVERY target; the unreachable ones carry the marker.
    const targets = resolveSwapTargets({
      catalog,
      source: {id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', linkToken: 'ckBTC'} as unknown as SelectableAsset,
      targetCurrencies: ['CHF', 'BTC'],
      evmEnabled: false,
    });
    expect(targets!.map(t => t.currency)).toEqual(['CHF', 'BTC']);
    // ckBTC reaches CHF over the ICP hub; its OWN currency has no executable pair.
    const chf = targets!.find(t => t.currency === 'CHF')!;
    expect(chf.rows.length).toBeGreaterThan(0);
    expect(chf.unavailable).toBeUndefined();
    const btc = targets!.find(t => t.currency === 'BTC')!;
    expect(btc.rows.length).toBe(0);
    expect(btc.unavailable).toBe('no-venue');
  });

  it('SwapTarget shape: unavailable targets render like every other target (typed field)', () => {
    const t: SwapTarget = {currency: 'USD', rows: [], unavailable: 'no-venue'};
    expect(t.unavailable).toBe('no-venue');
  });
});
