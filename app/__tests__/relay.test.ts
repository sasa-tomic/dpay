/**
 * PR8 — default relay-fetch timeout safety net. Every exported fetch client in `services/relay.ts`
 * composes an optional caller signal with an internal `DEFAULT_RELAY_TIMEOUT_MS` backstop, so a
 * caller that OMITS its signal still aborts (no infinite spinner on a hung relay). Callers that pass
 * their own signal still abort at THEIR (shorter) timeout — the two aborts race, first wins.
 *
 * These tests mock global `fetch` so the timeout logic is exercised directly (no real network).
 * `jest.useFakeTimers()` controls the internal `setTimeout`, and the mock rejects on signal abort
 * (mirrors how real `fetch` surfaces an abort). The original `fetch`/timer state is restored after.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

// Capture the signal the relay client passed to fetch, and resolve/reject like a real fetch under
// abort (never resolves on its own — only the timeout/caller abort can settle it). A real `fetch`
// rejects SYNCHRONOUSLY if handed an already-aborted signal (it doesn't wait for an `abort` event
// that already fired); the mock mirrors that.
function installNeverResolvingFetch() {
  let captured: {signal?: AbortSignal} | undefined;
  const mock = jest.fn((_url: string, init?: RequestInit) => {
    captured = init;
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (sig?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      sig?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
    });
  });
  (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
  return () => captured;
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  jest.useRealTimers();
});

describe('relay fetch default timeout (PR8 safety net)', () => {
  test('a caller that OMITS its signal still aborts at DEFAULT_RELAY_TIMEOUT_MS (10s)', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    // Re-require so the module captures the mocked fetch (defensive — module-level fetch lookup).
    const {depositInfo} = require('../services/relay');

    const p = depositInfo('http://relay.example', 1);
    const signal = getCaptured()?.signal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(9999);
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(1); // cross the 10s backstop → internal controller aborts
    expect(signal!.aborted).toBe(true);
    await expect(p).rejects.toThrow('aborted');
  });

  test('a caller-supplied signal that fires FIRST wins (shorter timeout preserved)', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    const {depositInfo} = require('../services/relay');

    const callerCtrl = new AbortController();
    const p = depositInfo('http://relay.example', 1, callerCtrl.signal);
    const signal = getCaptured()?.signal;
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(2000);
    callerCtrl.abort(); // caller aborts well before the 10s backstop
    expect(signal!.aborted).toBe(true); // forwarded into the internal controller
    await expect(p).rejects.toThrow('aborted');
  });

  test('a caller signal already aborted before the call propagates immediately', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    const {depositInfo} = require('../services/relay');

    const callerCtrl = new AbortController();
    callerCtrl.abort();
    const p = depositInfo('http://relay.example', 1, callerCtrl.signal);
    const signal = getCaptured()?.signal;
    expect(signal!.aborted).toBe(true);
    await expect(p).rejects.toThrow('aborted');
  });
});
