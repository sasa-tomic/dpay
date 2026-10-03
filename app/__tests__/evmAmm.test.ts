// The Uniswap V3 venue table (config/evmAmm.ts) — the adapter-owned evm_amm rows (2026-09-28,
// the any-pair mandate). Pins:
//   • registry shape — every row is structurally a VenueEntry (the compile-time pin lives in
//     config/venues.ts; this file pins the RUNTIME lookups: venueOfId resolves the rows like a
//     bundled one, even with a runtime overlay installed).
//   • chain/address parity — each row's chainId + token address agree with the EVM chain
//     registry (evm/chains.ts ZCHF_TOKEN) and the drift-alarmed truth file
//     (dfx/catalog_truth.json erc20_contracts): three copies, one fact, no silent drift.
//   • rail ids — the pair ids are the rail-canonical forms (`evm:<chainId>:<address>`,
//     `evm:native-eth:<chainId>`), and the walk `evmAmmVenuesForRail` matches them exactly.
//   • per-chain Uniswap facts — router/quoter/WETH are pinned byte-for-byte (the D31 live trip
//     proved the Ethereum set on mainnet; WETH differs per chain, so it is per-chain config).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from '@jest/globals';
import {
  EVM_AMM_VENUES,
  EVM_AMM_CHAINS,
  COWSWAP_SETTLEMENT,
  UNISWAP_V3_ROUTER,
  UNISWAP_V3_QUOTER,
  evmAmmFamilyOf,
  evmAmmRailId,
  evmNativeRailId,
  evmAmmVenuesForRail,
  evmAmmChainOf,
  type EvmAmmChain,
} from '../config/evmAmm';
import {venueOfId} from '../config/venues';
import {ZCHF_TOKEN, type EvmChainId} from '../evm/chains';
import {setRuntimeVenues} from '../config/venues';

const ROOT = join(__dirname, '..', '..');

describe('evm_amm venue rows — registry parity', () => {
  it('carries a row per venue family on each ZCHF deployment chain in the chain registry', () => {
    const chains = Object.keys(ZCHF_TOKEN).map(Number) as EvmChainId[];
    expect(chains.length).toBeGreaterThan(0);
    // Two venue families serve chain 1 (Uniswap V3 + CoW Swap — the founder's 2+ venues per
    // currency); Arbitrum One carries one (Uniswap V3). The SET of chain ids is the pin.
    expect([...new Set(EVM_AMM_VENUES.map(v => evmAmmChainOf(v.venue_id)!.id))].sort((a, b) => a - b))
      .toEqual([...chains].sort((a, b) => a - b));
    // …and the family helper dispatches exactly the rows this table carries.
    for (const v of EVM_AMM_VENUES) {
      expect(evmAmmFamilyOf(v.venue_id)).not.toBeNull();
    }
  });

  it('every row resolves through venueOfId even under a runtime overlay', () => {
    const restore = venueOfId('uniswapv3-eth');
    setRuntimeVenues([]);
    try {
      for (const v of EVM_AMM_VENUES) {
        expect(venueOfId(v.venue_id)).toEqual(v);
      }
    } finally {
      setRuntimeVenues(null);
    }
    expect(restore).toEqual(EVM_AMM_VENUES[0]);
  });

  it('row chain + token address agree with ZCHF_TOKEN and the truth file', () => {
    const truth = JSON.parse(readFileSync(join(ROOT, 'dfx/catalog_truth.json'), 'utf8')) as {
      erc20_contracts: Record<string, string>;
      chains: Record<string, number>;
    };
    const truthByChain: Record<number, string> = {
      [truth.chains.ethereum]: truth.erc20_contracts.zchf_ethereum.toLowerCase(),
      [truth.chains.arbitrum_one]: truth.erc20_contracts.zchf_arbitrum.toLowerCase(),
    };
    for (const v of EVM_AMM_VENUES) {
      const c = evmAmmChainOf(v.venue_id);
      expect(c).not.toBeNull();
      const zchf = ZCHF_TOKEN[c!.id as EvmChainId];
      expect(zchf).toBeDefined();
      // The row's token rail id IS the registry's ZCHF address (lowercase — rail ids are
      // case-insensitive by convention; the catalog keeps the checksummed form).
      expect(v.pair_ledgers).toContain(evmAmmRailId(c!.id, zchf!.address));
      expect(zchf!.address.toLowerCase()).toBe(truthByChain[c!.id]);
    }
  });

  it('chain facts pin router, quoter and WETH byte-for-byte', () => {
    expect(UNISWAP_V3_ROUTER).toBe('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45');
    expect(UNISWAP_V3_QUOTER).toBe('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');
    expect(EVM_AMM_CHAINS[1]!.weth.toLowerCase()).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(EVM_AMM_CHAINS[42161]!.weth.toLowerCase()).toBe('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
    for (const c of Object.values(EVM_AMM_CHAINS)) {
      expect(c.router).toBe(UNISWAP_V3_ROUTER);
      expect(c.quoter).toBe(UNISWAP_V3_QUOTER);
    }
  });
});

describe('evm rail ids', () => {
  it('token rail ids are chain-qualified lowercase addresses', () => {
    expect(evmAmmRailId(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'))
      .toBe('evm:1:0xb58e61c3098d85632df34eecfb899a1ed80921cb');
  });

  it('native rail ids are chain-qualified and disjoint from the chain-1 sideshift id', () => {
    expect(evmNativeRailId(1)).toBe('evm:native-eth:1');
    expect(evmNativeRailId(42161)).toBe('evm:native-eth:42161');
  });
});

describe('evmAmmVenuesForRail — the pair walk', () => {
  it('finds every row family serving the pair, in table order', () => {
    const eth = evmAmmVenuesForRail(evmNativeRailId(1));
    expect(eth.map(v => v.venue_id)).toEqual(['uniswapv3-eth', 'cowswap-eth']);
    const zchf = evmAmmVenuesForRail(evmAmmRailId(1, ZCHF_TOKEN[1]!.address));
    expect(zchf.map(v => v.venue_id)).toEqual(['uniswapv3-eth', 'cowswap-eth']);
  });

  it('never crosses chains: a chain-1 rail cannot reach the Arbitrum row', () => {
    expect(evmAmmVenuesForRail(evmNativeRailId(42161)).map(v => v.venue_id)).toEqual(['uniswapv3-arb']);
    expect(evmAmmVenuesForRail(evmAmmRailId(1, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'))).toEqual([]);
    expect(evmAmmVenuesForRail('sol:nope')).toEqual([]);
  });
});

describe('row facts', () => {
  it('rows are mainnet evm_amm registry-shaped rows keyed to their venue contract', () => {
    for (const v of EVM_AMM_VENUES) {
      expect(v.kind).toBe('evm_amm');
      expect(v.testnet).toBe(false);
      const c = evmAmmChainOf(v.venue_id)!;
      // The endpoint is the row's OWN venue contract: SwapRouter02 for the Uniswap
      // families, the settlement contract for CoW (whose orders ride the relay pipes).
      expect(v.endpoint).toBe(evmAmmFamilyOf(v.venue_id) === 'cowswap' ? COWSWAP_SETTLEMENT : c.router);
      expect(v.disclosure_key).toBe(evmAmmFamilyOf(v.venue_id) === 'cowswap' ? 'cowswap' : 'uniswapv3');
    }
  });
});

// The chain table entry shape — referenced so a renamed field fails here first.
describe('EvmAmmChain shape', () => {
  it('carries the execution facts the adapter signs with', () => {
    const c: EvmAmmChain = EVM_AMM_CHAINS[1]!;
    expect(c.id).toBe(1);
    expect(c.name).toBe('Ethereum');
    expect(c.weth).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.router).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.quoter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.nativeSymbol).toBe('ETH');
  });
});
