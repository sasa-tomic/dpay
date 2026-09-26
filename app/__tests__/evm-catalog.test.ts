/**
 * The EVM app-side catalog (app/lib/evmCatalog.ts) — D6/D7. Pinned here: the fail-closed row
 * parse (a checksum-BROKEN address, a non-hex address, or a missing chainId SKIPS the row —
 * a mangled checksum on the wire is a money-routing bug, not a display nit), the
 * `evm:<chainId>:<TOKEN>` identity, the chain slugs (the canonical link spellings `arbitrum`
 * and `ethereum`), the collision chips 'ZCHF·Arb' / 'ZCHF·Eth', the exact tokenEq (no VCHF
 * collision), and the visible-keys enumeration whose membership always matches what the
 * builder would render (the visibleSolanaMints invariant).
 */
import {describe, test, expect} from '@jest/globals';
import {
  parseEvmRow, evmSectionsOf, evmAssetsOf, evmSelectableRow, parseEvmAssetId,
  evmChainSlug, evmChainIdOfSlug, linkNetworkOfEvm, evmTokenEq, evmChipLabel,
  evmShortNetworkTag, visibleEvmKeys, type EvmSection,
} from '../lib/evmCatalog';

const ZCHF_ARB = '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553';   // EIP-55 checksummed
const ZCHF_ETH = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';   // EIP-55 checksummed

// The wire shape the relay's `EvmAsset` serde produces (snake_case).
const wireRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  token: 'ZCHF', symbol: 'ZCHF', decimals: 18, min_fraction_digits: 2,
  chain_id: 42161, address: ZCHF_ARB, onramp: 'Unavailable', offramp: 'Unavailable',
  ...over,
});

describe('parseEvmRow — fail-closed (D6)', () => {
  test('a well-formed row parses field-for-field, testnet stamped from the SECTION', () => {
    expect(parseEvmRow(wireRow(), false)).toEqual({
      token: 'ZCHF', symbol: 'ZCHF', decimals: 18, minFractionDigits: 2,
      chainId: 42161, address: ZCHF_ARB, liquidity: null,
      onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
    });
    expect(parseEvmRow(wireRow({chain_id: 31337, address: '0x' + 'ab'.repeat(20)}), true)?.testnet).toBe(true);
  });

  test('a checksum-BROKEN address rejects the row (money-routing bug, not a display nit)', () => {
    // Flip one hex letter's case: same address bytes, broken EIP-55 checksum.
    const broken = '0xD4DD9e2F021BB459D5A5f6c24C12fE09c5D45553';
    expect(broken.toLowerCase()).toBe(ZCHF_ARB.toLowerCase());
    expect(parseEvmRow(wireRow({address: broken}), false)).toBeNull();
  });

  test('a non-hex address, a missing chainId, and non-fields all skip', () => {
    expect(parseEvmRow(wireRow({address: 'not-hex'}), false)).toBeNull();
    expect(parseEvmRow(wireRow({address: '0x' + 'zz'.repeat(20)}), false)).toBeNull();
    expect(parseEvmRow(wireRow({chain_id: undefined}), false)).toBeNull();
    expect(parseEvmRow(wireRow({chain_id: 0}), false)).toBeNull();
    expect(parseEvmRow(wireRow({decimals: '18'}), false)).toBeNull();
    expect(parseEvmRow(wireRow({token: ''}), false)).toBeNull();
    expect(parseEvmRow(null, false)).toBeNull();
    expect(parseEvmRow('ZCHF', false)).toBeNull();
  });

  test('ramps fail closed to Unavailable; liquidity fails closed to null', () => {
    expect(parseEvmRow(wireRow({onramp: 'Direct'}), false)?.onramp).toBe('Direct');
    expect(parseEvmRow(wireRow({onramp: 'whatever'}), false)?.onramp).toBe('Unavailable');
    expect(parseEvmRow(wireRow({liquidity: 'deep'}), false)?.liquidity).toBe('deep');
    expect(parseEvmRow(wireRow({liquidity: 'oceanic'}), false)?.liquidity).toBeNull();
  });
});

describe('evmSectionsOf — the raw wire envelope', () => {
  test('pulls ONLY the evm sections, in order, environment stamped', () => {
    const sections = evmSectionsOf([
      {protocol: 'icp', name: 'Internet Computer', environment: 'mainnet', assets: []},
      {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: []},
      {protocol: 'evm', name: 'Arbitrum One', environment: 'mainnet', assets: [wireRow()]},
      {protocol: 'evm', name: 'Ethereum', environment: 'mainnet', assets: [wireRow({chain_id: 1, address: ZCHF_ETH})]},
    ]);
    expect(sections.length).toBe(2);
    expect(sections[0].name).toBe('Arbitrum One');
    expect(sections[0].assets[0].chainId).toBe(42161);
    expect(sections[1].assets[0].address).toBe(ZCHF_ETH);
    expect(evmAssetsOf(sections).length).toBe(2);
  });

  test('a bad environment skips the section WHOLE (classification is server-declared)', () => {
    const sections = evmSectionsOf([
      {protocol: 'evm', name: 'X', environment: 'devnet', assets: [wireRow()]},
    ]);
    expect(sections).toEqual([]);
  });

  test('an unparseable row drops out of an otherwise-good section (fail-closed per row)', () => {
    const sections = evmSectionsOf([
      {protocol: 'evm', name: 'Anvil', environment: 'testnet', assets: [wireRow({chain_id: 31337, address: '0x' + 'cd'.repeat(20)}), wireRow({token: ''})]},
    ]);
    expect(sections[0].assets.length).toBe(1);
    expect(sections[0].assets[0].chainId).toBe(31337);
    expect(sections[0].assets[0].testnet).toBe(true);
  });
});

describe('the evm asset identity (D7)', () => {
  test('ids are `evm:<chainId>:<TOKEN>`, stable across metadata refreshes', () => {
    const row = parseEvmRow(wireRow(), false)!;
    const asset = evmSelectableRow(row);
    expect(asset.id).toBe('evm:42161:ZCHF');
    expect(asset.protocol).toBe('evm');
    expect(asset.linkToken).toBe('ZCHF');
    expect(asset.chainName).toBe('Arbitrum One');
    expect(asset.network).toBe('Arbitrum One');
    expect(asset.testKey).toBe('evm-zchf-arbitrum');
    const eth = evmSelectableRow(parseEvmRow(wireRow({chain_id: 1, address: ZCHF_ETH}), false)!);
    expect(eth.id).toBe('evm:1:ZCHF');
    expect(eth.testKey).toBe('evm-zchf-ethereum');
  });

  test('parseEvmAssetId is shape-checked and normalized (never two spellings of one id)', () => {
    expect(parseEvmAssetId('evm:42161:ZCHF')).toBe('evm:42161:ZCHF');
    expect(parseEvmAssetId('evm:042161:ZCHF')).toBe('evm:42161:ZCHF'); // Number-normalized
    expect(parseEvmAssetId('evm:1:VCHF')).toBe('evm:1:VCHF');          // shape-valid; membership is reconcile's job
    expect(parseEvmAssetId('evm:x:ZCHF')).toBeNull();
    expect(parseEvmAssetId('evm:42161:zchf')).toBeNull();              // registry tokens are UPPERCASE
    expect(parseEvmAssetId('solana:SOL')).toBeNull();
    expect(parseEvmAssetId(null)).toBeNull();
  });

  test('the chain slugs are the canonical link spellings (the founder?s ?network=arbitrum)', () => {
    expect(evmChainSlug(42161)).toBe('arbitrum');
    expect(evmChainSlug(1)).toBe('ethereum');
    expect(evmChainSlug(421614)).toBe('arbitrum-sepolia');
    expect(evmChainSlug(31337)).toBe('anvil');
    expect(evmChainSlug(8453)).toBeNull();
    expect(evmChainIdOfSlug('arbitrum')).toBe(42161);
    expect(evmChainIdOfSlug('ethereum')).toBe(1);
    expect(evmChainIdOfSlug('Arbitrum One')).toBeNull(); // proper nouns are NOT slugs
    expect(linkNetworkOfEvm({chainId: 42161})).toBe('arbitrum');
  });
});

describe('tokenEq — exact identity, no VCHF collision (D7)', () => {
  test('ZCHF names the EVM rows and nothing else; no prefix/substring matching exists', () => {
    expect(evmTokenEq('ZCHF', 'ZCHF')).toBe(true);
    expect(evmTokenEq('ZCHF', 'zchf')).toBe(true);   // hand-typed links are case-insensitive
    expect(evmTokenEq('ZCHF', 'VCHF')).toBe(false);  // the IC VCHF row is a DIFFERENT asset
    expect(evmTokenEq('CHF', 'ZCHF')).toBe(false);   // no substring
    expect(evmTokenEq('ZCHF', 'ZCHF ')).toBe(false); // no trimming
    expect(evmTokenEq('USDC', 'USDC')).toBe(true);
  });
});

describe('chip labels — the collision-qualified chip (D5 jest half)', () => {
  test('two visible ZCHF rows qualify as ZCHF·Arb / ZCHF·Eth; a lone row stays bare', () => {
    const rows = [
      {symbol: 'ZCHF', chainName: 'Arbitrum One'},
      {symbol: 'ZCHF', chainName: 'Ethereum'},
    ];
    expect(evmChipLabel(rows[0], rows)).toBe('ZCHF·Arb');
    expect(evmChipLabel(rows[1], rows)).toBe('ZCHF·Eth');
    // A LONE ZCHF row (no other visible row shares the symbol) stays bare — qualifying every
    // chip would just add noise (the config chipLabel rule).
    expect(evmChipLabel(rows[1], [rows[0]])).toBe('ZCHF');
  });

  test('the short tags map the proper nouns and fall back compact', () => {
    expect(evmShortNetworkTag('Arbitrum One')).toBe('Arb');
    expect(evmShortNetworkTag('Ethereum')).toBe('Eth');
    expect(evmShortNetworkTag('Anvil')).toBe('Anv');
    expect(evmShortNetworkTag('Op Chain')).toBe('Op');
  });
});

describe('visibleEvmKeys — the rendered rows ARE the polled set', () => {
  const sections: EvmSection[] = evmSectionsOf([
    {protocol: 'evm', name: 'Arbitrum One', environment: 'mainnet', assets: [wireRow()]},
    {protocol: 'evm', name: 'Anvil', environment: 'testnet', assets: [wireRow({chain_id: 31337, address: '0x' + 'ab'.repeat(20)})]},
  ]) as EvmSection[];

  test('testnet rows hide unless opted in; the tuple is exactly the poll key', () => {
    expect(visibleEvmKeys(sections)).toEqual([
      {chainId: 42161, token: 'ZCHF', tokenAddress: ZCHF_ARB, decimals: 18},
    ]);
    expect(visibleEvmKeys(sections, {showTestnet: true}).length).toBe(2);
    expect(visibleEvmKeys(sections, {showTestnet: true})[1]).toEqual({
      chainId: 31337, token: 'ZCHF', tokenAddress: '0x' + 'ab'.repeat(20), decimals: 18,
    });
  });

  test('evmEnabled false empties the rail entirely (the solanaEnabled precedent)', () => {
    expect(visibleEvmKeys(sections, {evmEnabled: false})).toEqual([]);
  });
});
