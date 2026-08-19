/**
 * wasm-core shim bounded fetch (A-F3) — `e2e/web/dpay-core-wasm.ts` loadBytes must bound the prod
 * /wallet wasm fetch so a hung CDN/connection can never hang wallet boot. Mirrors the
 * solana-rpc.test.ts fake-fetch + fake-timers idiom. The module is required (never statically
 * imported) so tsc's app program stays off the e2e tree.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  jest.useRealTimers();
});

describe('dpay-core-wasm — bounded wasm fetch (A-F3)', () => {
  test('a never-resolving fetch aborts at the timeout and throws an error naming the URL', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const mock = jest.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    });
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    await jest.isolateModules(async () => {
      const {DpayCore} = require('../../e2e/web/dpay-core-wasm');
      // Any first method call warms the lazy init (which fetches the wasm); keypairFromSecret is
      // a surviving surface method (the facade wireLen retired with the 2026-08-19 IC-rail cutover).
      const p = DpayCore.keypairFromSecret('11'.repeat(32));
      expect(signal).toBeDefined();
      jest.advanceTimersByTime(9_999);
      expect(signal!.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(signal!.aborted).toBe(true);
      await expect(p).rejects.toThrow('timed out after 10000ms');
      await expect(p).rejects.toThrow(/\/dpay-core\.wasm/);
      expect(jest.getTimerCount()).toBe(0); // the abort timer was cleared in the finally
    });
  });

  test('an HTTP error status still names the URL and clears the timer (no timeout path)', async () => {
    jest.useFakeTimers();
    const mock = jest.fn(() => Promise.resolve({ok: false, status: 503} as unknown as Response));
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    await jest.isolateModules(async () => {
      const {DpayCore} = require('../../e2e/web/dpay-core-wasm');
      await expect(DpayCore.keypairFromSecret('11'.repeat(32))).rejects.toThrow('HTTP 503');
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
