/**
 * The SOL seam (`app/solana.ts`) isolation boundary. With the default jest state
 * (`__DPAY_TEST_SOLANA_RPC_URL=''`, set in jest.setup.js), the network functions must NO-OP
 * (balance → null, send → throw) WITHOUT importing the network module — so the offline inner loop
 * never touches devnet. The "configured" path is then exercised by overriding the global inside an
 * isolated module registry (mirrors walletconnect.test.ts) with a mocked fetch.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

describe('solana seam — offline (SOLANA_RPC_URL empty)', () => {
  test('getSolanaBalance returns null without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {getSolanaBalance} = require('../solana');
    const bal = await getSolanaBalance('AnyAddress');
    expect(bal).toBeNull();
    expect(called).toBe(false); // never imported rpc, never fetched
  });

  test('sendSol throws an offline error without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {sendSol} = require('../solana');
    await expect(sendSol('4f'.repeat(16), 'ToAddr', 1000n)).rejects.toThrow('offline');
    expect(called).toBe(false);
  });
});

describe('solana seam — configured (RPC URL set) calls through to rpc', () => {
  test('getSolanaBalance fetches via the rpc client', async () => {
    const mock = jest.fn(() =>
      Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({result: {value: 2500000000}})} as unknown as Response),
    );
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    // Override the seam constant inside an isolated module registry so SOLANA_RPC_URL is non-empty.
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://rpc.test';
      const {getSolanaBalance} = require('../solana');
      p = getSolanaBalance('AddrX');
    });
    const b = await p;
    expect(b).toBe('2500000000');
    expect(mock).toHaveBeenCalled();
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
  });
});
