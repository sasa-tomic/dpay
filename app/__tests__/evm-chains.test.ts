import {describe, expect, test} from '@jest/globals';
import {
  clearEvmDevToken,
  EVM_CHAINS,
  evmDevToken,
  evmZchfToken,
  fromBaseUnits,
  setEvmDevToken,
  toBaseUnits,
  ZCHF_DECIMALS,
  ZCHF_TOKEN,
} from '../evm/chains';

describe('evm/chains — registry', () => {
  test('the four chains carry their relay path, explorer and native symbol', () => {
    expect(EVM_CHAINS[42161]).toMatchObject({
      id: 42161,
      name: 'Arbitrum One',
      rpcViaRelay: '/api/v1/evm/rpc',
      explorer: 'https://arbiscan.io',
      nativeSymbol: 'ETH',
    });
    expect(EVM_CHAINS[1].explorer).toBe('https://etherscan.io');
    expect(EVM_CHAINS[421614].explorer).toBe('https://sepolia.arbiscan.io');
    expect(EVM_CHAINS[31337]).toMatchObject({
      name: 'dpay-anvil',
      explorer: null, // nothing to link to on the dev chain
    });
  });

  test('every chain proxies through the relay (the app never holds an RPC vendor URL)', () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      expect(chain.rpcViaRelay).toBe('/api/v1/evm/rpc');
    }
  });

  test('ZCHF mainnet deployments are pinned', () => {
    expect(ZCHF_TOKEN[42161]).toBe('0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553');
    expect(ZCHF_TOKEN[1]).toBe('0xB58E61C3098d85632Df34EecfB899A1Ed80921cB');
    expect(ZCHF_TOKEN[421614]).toBeUndefined(); // testnet mocks are injected at runtime
    expect(ZCHF_DECIMALS).toBe(18);
  });
});

describe('evm/chains — dev-token override (the e2e driver seam)', () => {
  test('the override wins over the registry and clears back to it', () => {
    const mock = '0x00000000000000000000000000000000deadbeef';
    setEvmDevToken({chainId: 31337, address: mock});
    expect(evmZchfToken(31337)).toBe(mock);
    expect(evmDevToken(42161)).toBeNull(); // scoped to the injected chain
    expect(evmZchfToken(42161)).toBe(ZCHF_TOKEN[42161] ?? null);
    clearEvmDevToken();
    expect(evmZchfToken(31337)).toBeNull();
    expect(evmDevToken(31337)).toBeNull();
  });

  test('clear is idempotent', () => {
    clearEvmDevToken();
    expect(evmDevToken(31337)).toBeNull();
  });
});

describe('evm/chains — base-unit conversion (exact BigInt, uint256-scale)', () => {
  test('toBaseUnits: "1.5" @18 → 1.5e18', () => {
    expect(toBaseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
  });

  test('toBaseUnits: whole, fractional, leading-dot and trailing-dot inputs', () => {
    expect(toBaseUnits('10', 18)).toBe(10n * 10n ** 18n); // 10 whole ZCHF
    expect(toBaseUnits('1', 18)).toBe(10n ** 18n);
    expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(toBaseUnits('.5', 18)).toBe(500_000_000_000_000_000n);
    expect(toBaseUnits('5.', 18)).toBe(5n * 10n ** 18n);
  });

  test('toBaseUnits: uint256-scale values survive (the u64 parser in lib/amount cannot)', () => {
    expect(toBaseUnits('1000000000000', 18)).toBe(10n ** 12n * 10n ** 18n); // 1e30
  });

  test('toBaseUnits rejects malformed and over-precise amounts (caller bug, not a silent 0)', () => {
    expect(() => toBaseUnits('abc', 18)).toThrow(/not a decimal amount/);
    expect(() => toBaseUnits('-1', 18)).toThrow(/not a decimal amount/);
    expect(() => toBaseUnits('', 18)).toThrow(/not a decimal amount/);
    expect(() => toBaseUnits('1.0000000000000000001', 18)).toThrow(/more than 18 decimals/);
  });

  test('fromBaseUnits: shortest exact decimal string', () => {
    expect(fromBaseUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(fromBaseUnits(1n, 18)).toBe('0.000000000000000001');
    expect(fromBaseUnits(10n ** 12n * 10n ** 18n, 18)).toBe('1000000000000');
    expect(fromBaseUnits(0n, 18)).toBe('0');
    expect(fromBaseUnits(1_500_000n, 6)).toBe('1.5');
  });

  test('fromBaseUnits(toBaseUnits(x)) round-trips', () => {
    for (const s of ['0', '1', '1.5', '0.000001', '123.456789', '999999999.999999999999']) {
      expect(fromBaseUnits(toBaseUnits(s, 18), 18)).toBe(s);
    }
  });

  test('fromBaseUnits rejects negatives', () => {
    expect(() => fromBaseUnits(-1n, 18)).toThrow(/non-negative/);
  });
});
