/**
 * The EVM seam (`app/evm.ts`) isolation boundary — the `solana-seam.test.ts` contract, EVM
 * restated (spec 2026-09-26 D10):
 *
 *   1. OFFLINE (the default jest state: `__DPAY_TEST_EVM_RPC_URL=''` from jest.setup.js) — the
 *      network functions NO-OP or throw WITHOUT importing the network module (`evm/service`)
 *      and WITHOUT any fetch. Proven with a doMock that trips if the module so much as
 *      EVALUATES: the offline inner loop must never load the network code, not merely never
 *      reach the network.
 *   2. CONFIGURED (a test override URL, isolated module registry, mocked fetch) — the reads
 *      work through the pipe, the honest taxonomy holds: the relay's dead-leg marker maps
 *      STRAIGHT to 'unreachable' with NO connectivity probe (the relay answered HTTP, which
 *      already proves the phone is online), and the wrong-chain guard refuses a send before
 *      any spend-shaped request.
 */
import {describe, test, expect, jest, afterEach, beforeEach} from '@jest/globals';

const realFetch = globalThis.fetch;

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const TOKEN = '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553'; // ZCHF Arbitrum One (checksummed)
const STUB = 'https://stub.test/api/v1/evm/rpc/31337';

/** A minimal Response double. */
function res(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => null},
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const envelope = (result: unknown) => JSON.stringify({jsonrpc: '2.0', id: 1, result});
const marker = (code: string) => JSON.stringify({dpayRelayError: code, detail: 'no upstream'});

/** Install a JSON-RPC router: byUrl[method] → result (or a function for full control). Any
 *  request to a NON-listed origin throws — which is exactly how the "no IC probe" property is
 *  pinned (a stray probe would explode the test, not pass it). */
function rpcRoute(byMethod: Record<string, unknown>): {calls: Array<{url: string; method: string}>} {
  const calls: Array<{url: string; method: string}> = [];
  (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
    const u = String(url);
    const method = (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?';
    calls.push({url: u, method});
    if (!u.startsWith('https://stub.test')) throw new Error(`NON-RAIL request observed: ${u} ${method}`);
    const entry = byMethod[method];
    if (entry === undefined) throw new Error(`no route for ${method}`);
    const result = typeof entry === 'function' ? (entry as () => unknown)() : entry;
    return res(200, envelope(result));
  }) as typeof fetch;
  return {calls};
}

beforeEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

describe('evm seam — offline (the jest.setup.js state)', () => {
  test('readEvmBalances answers offline for every key with NO fetch and NO network-module load', async () => {
    let networkModuleLoaded = false;
    let fetched = false;
    (globalThis as unknown as {fetch: unknown}).fetch = (async () => {
      fetched = true;
      throw new Error('no network offline');
    }) as typeof fetch;
    let seam!: typeof import('../evm');
    jest.isolateModules(() => {
      // Trip-wire: the seam's offline paths must never even EVALUATE the network module.
      jest.doMock('../evm/service', () => {
        networkModuleLoaded = true;
        throw new Error('network module loaded offline');
      });
      seam = require('../evm');
    });
    const read = await seam.readEvmBalances(SEED_HEX, [{chainId: 31337, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18}]);
    expect(read).toEqual({
      gas: {31337: {kind: 'offline'}},
      tokens: {'31337:ZCHF': {kind: 'offline'}},
    });
    expect(fetched).toBe(false);
    expect(networkModuleLoaded).toBe(false);
  });

  test('getEvmHistory answers offline with no fetch and no network-module load', async () => {
    let networkModuleLoaded = false;
    let seam!: typeof import('../evm');
    jest.isolateModules(() => {
      jest.doMock('../evm/history', () => {
        networkModuleLoaded = true;
        throw new Error('history loaded offline');
      });
      seam = require('../evm');
    });
    await expect(seam.getEvmHistory(31337, '0xabc', TOKEN)).resolves.toEqual({kind: 'offline'});
    expect(networkModuleLoaded).toBe(false);
  });

  test('the money paths THROW honestly (never silently succeed) with no network-module load', async () => {
    let networkModuleLoaded = false;
    let seam!: typeof import('../evm');
    jest.isolateModules(() => {
      jest.doMock('../evm/service', () => {
        networkModuleLoaded = true;
        throw new Error('network module loaded offline');
      });
      seam = require('../evm');
    });
    const input = {chainId: 31337, tokenAddress: TOKEN, to: '0x' + '11'.repeat(20), rawAmount: '1', decimals: 18};
    await expect(seam.sendErc20(SEED_HEX, input)).rejects.toThrow(/not configured/);
    await expect(seam.quoteEvmFee(31337, '0x' + '11'.repeat(20), TOKEN, '0x70a08231')).rejects.toThrow(/not configured/);
    await expect(seam.getEvmReceiptStatus(31337, '0x' + 'ab'.repeat(32))).rejects.toThrow(/not configured/);
    expect(seam.isEvmRpcAvailable(31337)).toBe(false);
    expect(networkModuleLoaded).toBe(false);
  });

  test('the pure surface works with zero rail: derive + validate addresses offline', () => {
    const seam = require('../evm') as typeof import('../evm');
    const address = seam.deriveEvmAddress(SEED_HEX);
    expect(seam.isValidEvmAddress(address)).toBe(true);
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(seam.deriveEvmAddress(SEED_HEX)).toBe(address); // deterministic
    expect(seam.isValidEvmAddress('0x123')).toBe(false);
    expect(seam.isValidEvmAddress('0x' + 'zz'.repeat(20))).toBe(false);
  });
});

describe('evm seam — configured (isolated registry, mocked fetch)', () => {
  // The override is CAPTURED AT MODULE LOAD — including inside the isolated registry when the
  // seam's lazy `import('./evm/service')` first resolves (mid-test, not at require time). So
  // the stub URL stays installed for the WHOLE test and afterEach restores the offline default.
  const g = globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string};
  beforeEach(() => {
    // The offline describe's trip-wire doMocks leak into this file's mock registry, and the
    // dynamic `import('./evm/service')` may resolve through the SHARED registry across tests —
    // so: drop the trip-wires AND reset the shared module cache, guaranteeing the seam's lazy
    // service load builds FRESH instances while the stub URL is installed.
    jest.resetModules();
    jest.dontMock('../evm/service');
    jest.dontMock('../evm/history');
    g.__DPAY_TEST_EVM_RPC_URL = STUB;
  });
  afterEach(() => {
    g.__DPAY_TEST_EVM_RPC_URL = '';
  });

  function configuredSeam(): typeof import('../evm') {
    let seam!: typeof import('../evm');
    jest.isolateModules(() => {
      seam = require('../evm');
    });
    return seam;
  }

  test('readEvmBalances reads the gas leg + balanceOf through the rail, amounts exact', async () => {
    const seam = configuredSeam();
    const {calls} = rpcRoute({
      eth_chainId: '0x7a69',                     // 31337 — the endpoint PROVES its chain
      eth_getBalance: '0x13c68',                 // 81000 wei
      eth_call: '0x64',                          // balanceOf → 100 raw
    });
    const read = await seam.readEvmBalances(SEED_HEX, [{chainId: 31337, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18}]);
    expect(read.gas[31337]).toEqual({kind: 'balance', wei: '81000'});
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'balance', amount: '100'});
    expect(calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getBalance', 'eth_call']);
    expect(calls.every((c) => c.url === STUB)).toBe(true);
  });

  test('the relay dead-leg marker maps STRAIGHT to "unreachable" — the IC probe is never fired', async () => {
    const seam = configuredSeam();
    const calls: Array<{url: string; method: string}> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
      const u = String(url);
      calls.push({url: u, method: (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?'});
      if (!u.startsWith('https://stub.test')) throw new Error(`IC PROBE FIRED: ${u}`); // must not happen
      return res(503, marker('evm-unconfigured'));
    }) as typeof fetch;
    const read = await seam.readEvmBalances(SEED_HEX, [{chainId: 31337, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18}]);
    expect(read.gas[31337]).toEqual({kind: 'error', failure: 'unreachable'});
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'error', failure: 'unreachable'});
    expect(calls.every((c) => c.url === STUB)).toBe(true);
  });

  test('THE WRONG-CHAIN GUARD: an endpoint serving chain 1 refuses a 31337 send before any spend', async () => {
    const seam = configuredSeam();
    const {calls} = rpcRoute({
      eth_chainId: '0x1', // the endpoint answers: "I am chain 1"
    });
    const input = {chainId: 31337, tokenAddress: TOKEN, to: '0x' + '11'.repeat(20), rawAmount: '1', decimals: 18};
    await expect(seam.sendErc20(SEED_HEX, input)).rejects.toMatchObject({
      dpayEvmWrongChain: true,
      expectedChainId: 31337,
      actualChainId: 1,
    });
    // LOUD means named: the refusal message names both chains.
    await expect(seam.sendErc20(SEED_HEX, input)).rejects.toThrow(/serves chain 1[\s\S]*31337/);
    // No estimate, no gas read, no nonce, no broadcast — the guard is BEFORE every spend-shaped
    // request. The only method that ever left the device is the chain-identity read.
    expect(calls.every((c) => c.method === 'eth_chainId')).toBe(true);
  });

  test('the wrong-chain guard also refuses a BALANCE read (a wrong-ledger number is the same danger)', async () => {
    const seam = configuredSeam();
    const {calls} = rpcRoute({eth_chainId: '0x1'});
    const read = await seam.readEvmBalances(SEED_HEX, [{chainId: 31337, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18}]);
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'error', failure: 'refused'});
    expect(read.gas[31337]).toEqual({kind: 'error', failure: 'refused'});
    expect(calls.every((c) => c.method === 'eth_chainId')).toBe(true);
  });

  test('the payer settled-check clamps its getLogs floor to the recent window (strict ranges)', async () => {
    const seam = configuredSeam();
    const bodies: Array<{method: string; params: Array<Record<string, string>>}> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
      const u = String(url);
      const parsed = JSON.parse(init?.body ?? '{}') as {method?: string; params?: Array<Record<string, string>>};
      bodies.push({method: parsed.method ?? '?', params: parsed.params ?? []});
      if (!u.startsWith('https://stub.test')) throw new Error(`NON-RAIL request observed: ${u}`);
      const route: Record<string, string> = {eth_chainId: '0x7a69', eth_blockNumber: '0x186a0'}; // tip 100000
      if (parsed.method === 'eth_getLogs') return res(200, envelope([]));
      const entry = route[parsed.method ?? ''];
      if (entry === undefined) throw new Error(`no route for ${parsed.method}`);
      return res(200, envelope(entry));
    }) as typeof fetch;
    const found = await seam.findEvmSettledTransfer(31337, TOKEN, '0x' + '22'.repeat(20), '0x' + '33'.repeat(20), '1');
    expect(found).toBeNull();
    const getLogs = bodies.find((b) => b.method === 'eth_getLogs');
    expect(getLogs).toBeDefined();
    // tip 100000 − MAX_PAGES(10) × PAGE_SIZE(2000) = 80000 — NOT 0: a strict provider's getLogs
    // range limit must not fail the re-entry / settled-check closed (the fromBlock-0 bug).
    expect(getLogs!.params[0].fromBlock).toBe('0x' + (100000 - 10 * 2000).toString(16));
    expect(getLogs!.params[0].toBlock).toBe('latest');
    expect(bodies.map((b) => b.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_getLogs']);
  });

  test('an unreadable tip degrades the clamp to the raw floor: the scan runs unclamped, never skipped', async () => {
    const seam = configuredSeam();
    const bodies: Array<{method: string; params: Array<Record<string, string>>}> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
      const u = String(url);
      const parsed = JSON.parse(init?.body ?? '{}') as {method?: string; params?: Array<Record<string, string>>};
      bodies.push({method: parsed.method ?? '?', params: parsed.params ?? []});
      if (!u.startsWith('https://stub.test')) throw new Error(`NON-RAIL request observed: ${u}`);
      if (parsed.method === 'eth_blockNumber') throw new Error('tip read refused'); // the fallback leg
      if (parsed.method === 'eth_getLogs') return res(200, envelope([]));
      if (parsed.method === 'eth_chainId') return res(200, envelope('0x7a69'));
      throw new Error(`no route for ${parsed.method}`);
    }) as typeof fetch;
    const found = await seam.findEvmSettledTransfer(31337, TOKEN, '0x' + '22'.repeat(20), '0x' + '33'.repeat(20), '1');
    expect(found).toBeNull(); // the scan still RAN — fail-closed honesty preserved
    const getLogs = bodies.find((b) => b.method === 'eth_getLogs');
    expect(getLogs!.params[0].fromBlock).toBe('0x0');
  });
});
