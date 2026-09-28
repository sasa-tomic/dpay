/**
 * The EVM endpoint machinery (app/evm/endpoints.ts) — the per-chain URL derivation, the
 * three-tier precedence (operator override > __DPAY_TEST_EVM_RPC_URL > relay-derived), and the
 * override validation. The `solana-rpc-config.test.ts` pins, restated for a chain-multiplexed
 * rail: chain 1 rides the BARE relay route (D12), every other chain rides `/{chainId}`.
 *
 * The test override is captured at MODULE LOAD, so each scenario builds a fresh module registry
 * (jest.isolateModules) with the global in the state that scenario models — exactly how the
 * e2e driver and jest.setup.js produce those states (evaluateOnNewDocument before the bundle /
 * the setup file before any test module).
 */
import {describe, test, expect, jest} from '@jest/globals';

type Endpoints = typeof import('../evm/endpoints');

/** Fresh endpoints module with the test override global in a given state ('' | url | undefined
 *  = deleted) — the three states the harness can produce. */
function freshEndpoints(override?: string): Endpoints {
  const g = globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string};
  const had = '__DPAY_TEST_EVM_RPC_URL' in g;
  const prev = g.__DPAY_TEST_EVM_RPC_URL;
  if (override === undefined) delete g.__DPAY_TEST_EVM_RPC_URL;
  else g.__DPAY_TEST_EVM_RPC_URL = override;
  let mod!: Endpoints;
  jest.isolateModules(() => {
    mod = require('../evm/endpoints');
  });
  // Restore the jest.setup.js state ('') so later suites see the offline default.
  if (had) g.__DPAY_TEST_EVM_RPC_URL = prev;
  else delete g.__DPAY_TEST_EVM_RPC_URL;
  return mod;
}

describe('evm endpoints — the test override (jest/e2e isolation contract)', () => {
  test("jest.setup.js state ('') means the rail is OFF: single empty candidate", () => {
    const ep = freshEndpoints('');
    expect(ep.evmRpcUrls(1)).toEqual(['']);
    expect(ep.evmRpcUrls(42161)).toEqual(['']);
    expect(ep.evmRpcUrl(31337)).toBe('');
  });

  test('a test override URL IS the whole candidate list for every chain (per-DEVICE, D11)', () => {
    const ep = freshEndpoints('http://127.0.0.1:8545');
    expect(ep.evmRpcUrls(1)).toEqual(['http://127.0.0.1:8545']);
    expect(ep.evmRpcUrls(42161)).toEqual(['http://127.0.0.1:8545']);
  });

  test('no override at all → the relay-derived per-chain routes', () => {
    const ep = freshEndpoints(undefined);
    // Chain 1 rides the BARE route — it IS chain 1 (D12), so the relay's default upstream
    // env (DPAY_EVM_RPC_URL) serves it.
    expect(ep.evmRpcUrls(1)).toEqual(['https://dpay.kalaj.org/api/v1/evm/rpc']);
    // Every other chain rides the per-chain suffix → DPAY_EVM_RPC_URL_<CHAINID>.
    expect(ep.evmRpcUrls(42161)).toEqual(['https://dpay.kalaj.org/api/v1/evm/rpc/42161']);
    expect(ep.evmRpcUrls(31337)).toEqual(['https://dpay.kalaj.org/api/v1/evm/rpc/31337']);
    expect(ep.evmRpcUrl(1)).toBe('https://dpay.kalaj.org/api/v1/evm/rpc');
  });
});

describe('evm endpoints — the operator override (setEvmRpcUrl)', () => {
  test('wins over BOTH the test override and the relay derivation; \'\' clears back', () => {
    const ep = freshEndpoints('http://127.0.0.1:8545'); // even a test override is present
    ep.setEvmRpcUrl('https://my-own-node.example/rpc');
    expect(ep.evmRpcUrls(1)).toEqual(['https://my-own-node.example/rpc']);
    expect(ep.evmRpcUrls(31337)).toEqual(['https://my-own-node.example/rpc']);
    ep.setEvmRpcUrl('');
    expect(ep.evmRpcUrls(1)).toEqual(['http://127.0.0.1:8545']); // back to the test override
  });

  test('plain http is accepted ONLY for local addresses (the anvil/e2e case)', () => {
    const ep = freshEndpoints('');
    expect(() => ep.setEvmRpcUrl('http://127.0.0.1:8545')).not.toThrow();
    expect(() => ep.setEvmRpcUrl('http://10.0.2.2:8545')).not.toThrow();
    expect(() => ep.setEvmRpcUrl('http://provider.example')).toThrow(/https/);
  });

  test('a non-URL throws with the paste-the-full-endpoint instruction', () => {
    const ep = freshEndpoints('');
    expect(() => ep.setEvmRpcUrl('not a url')).toThrow(/Not a valid URL/);
  });

  test('trailing slashes are stripped so the base composes cleanly', () => {
    const ep = freshEndpoints('');
    ep.setEvmRpcUrl('https://my-own-node.example/rpc/');
    expect(ep.evmRpcUrl(1)).toBe('https://my-own-node.example/rpc');
  });
});

describe('evm endpoints — setRelayBaseForEvm (the App-installed relay list)', () => {
  test('re-points the derivation: trailing slashes stripped, duplicates and empties dropped', () => {
    const ep = freshEndpoints(undefined);
    ep.setRelayBaseForEvm(['https://r1.example/', '', 'https://r1.example']);
    expect(ep.evmRpcUrls(42161)).toEqual(['https://r1.example/api/v1/evm/rpc/42161']);
    ep.setRelayBaseForEvm(['https://r2.example', 'https://r3.example']);
    expect(ep.evmRpcUrls(1)).toEqual(['https://r2.example/api/v1/evm/rpc', 'https://r3.example/api/v1/evm/rpc']);
  });

  test('an all-empty input is ignored (never corrupts the derivation)', () => {
    const ep = freshEndpoints(undefined);
    ep.setRelayBaseForEvm(['', '  ']);
    expect(ep.evmRpcUrl(1)).toBe('https://dpay.kalaj.org/api/v1/evm/rpc');
  });

  test('the operator override beats any relay base', () => {
    const ep = freshEndpoints(undefined);
    ep.setEvmRpcUrl('https://operator.example');
    ep.setRelayBaseForEvm(['https://r1.example']);
    expect(ep.evmRpcUrl(1)).toBe('https://operator.example');
  });
});

describe('evm endpoints — constants', () => {
  test('the proxy path and storage key are the fixed contract', () => {
    const ep = freshEndpoints('');
    expect(ep.EVM_RPC_PROXY_PATH).toBe('/api/v1/evm/rpc');
    expect(ep.EVM_RPC_STORAGE_KEY).toBe('dpay.evmRpc.v1');
    expect(ep.EVM_RPC_IMPORT_DEADLINE_MS).toBe(10000);
  });
});
