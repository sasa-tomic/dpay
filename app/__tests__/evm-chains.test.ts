import {describe, expect, test} from '@jest/globals';
import {
  clearEvmDevToken,
  EVM_CHAINS,
  evmDevToken,
  evmUsdcDeployment,
  evmUsdcToken,
  evmZchfDeployment,
  evmZchfToken,
  fromBaseUnits,
  setEvmDevToken,
  toBaseUnits,
  USDC_EVM_DECIMALS,
  USDC_TOKEN,
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

  test('ZCHF mainnet deployments are pinned, both on the MINIMAL permit domain', () => {
    expect(ZCHF_TOKEN[42161]).toEqual({
      address: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553',
      domainKind: 'minimal',
    });
    expect(ZCHF_TOKEN[1]).toEqual({
      address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
      domainKind: 'minimal',
    });
    expect(ZCHF_TOKEN[421614]).toBeUndefined(); // testnet mocks are injected at runtime
    expect(ZCHF_DECIMALS).toBe(18);
  });

  test('USDC mainnet deployments are pinned, both on the FULL permit domain (R1 step 0)', () => {
    // Circle's canonical USDC contracts (verified against api.mtpelerin.com/currencies/tokens
    // 2026-10-12). The FULL domain kind is the load-bearing pin: USDC's deployed EIP-712 domain
    // is name+version, NOT ZCHF's ERC20PermitLight minimal — the stated kind must never inherit
    // ZCHF's 'minimal' (no dpay flow signs a USDC permit today; verify on-chain before any use).
    expect(USDC_TOKEN[42161]).toEqual({
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      domainKind: 'full',
    });
    expect(USDC_TOKEN[1]).toEqual({
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      domainKind: 'full',
    });
    expect(USDC_TOKEN[421614]).toBeUndefined(); // testnet rows stay out
    expect(USDC_EVM_DECIMALS).toBe(6);
    expect(evmUsdcToken(42161)).toBe(USDC_TOKEN[42161]?.address ?? null);
    expect(evmUsdcToken(1)).toBe(USDC_TOKEN[1]?.address ?? null);
    expect(evmUsdcToken(31337)).toBeNull(); // no anvil deployment — absent key, fail-closed null
    expect(evmUsdcDeployment(1)?.domainKind).toBe('full');
  });
});

describe('evm/chains — dev-token override (the e2e driver seam)', () => {
  test('the override wins over the registry and clears back to it (with its domain kind)', () => {
    const mock = '0x00000000000000000000000000000000deadbeef';
    setEvmDevToken({chainId: 31337, address: mock, domainKind: 'minimal'});
    expect(evmZchfToken(31337)).toBe(mock);
    expect(evmZchfDeployment(31337)).toEqual({address: mock, domainKind: 'minimal'});
    expect(evmDevToken(42161)).toBeNull(); // scoped to the injected chain
    expect(evmZchfToken(42161)).toBe(ZCHF_TOKEN[42161]?.address ?? null);
    expect(evmZchfDeployment(42161)?.domainKind).toBe('minimal');
    clearEvmDevToken();
    expect(evmZchfToken(31337)).toBeNull();
    expect(evmDevToken(31337)).toBeNull();
    expect(evmZchfDeployment(31337)).toBeNull();
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
