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

  // A caller that takes EXPLICIT responsibility for its deadline (passes a signal) must NOT be
  // silently capped by the 10s backstop. A real example: ckBTC deposit_address is an IC update call
  // (relay → facade → minter) observed at 5–7s on mainnet and occasionally longer; DepositSheet arms
  // a 20s controller (DEPOSIT_ADDRESS_TIMEOUT_MS). Before this fix the backstop always armed and
  // "first abort wins" capped that fetch at 10s, defeating the 20s headroom and re-introducing the
  // "Couldn't load your deposit address" failure the separate-controller decoupling was meant to
  // prevent. The backstop is a SAFETY NET for callers that OMIT their signal only.
  test('a caller signal with a LONGER deadline is NOT capped at the backstop (caller owns the deadline)', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    const {depositInfo} = require('../services/relay');

    const callerCtrl = new AbortController();
    const callerTimer = setTimeout(() => callerCtrl.abort(), 20000);
    const p = depositInfo('http://relay.example', 1, callerCtrl.signal);
    p.catch(() => {}); // suppress unhandled rejection so the RED assertion below can report
    const signal = getCaptured()?.signal;

    jest.advanceTimersByTime(10000); // cross the 10s backstop
    expect(signal!.aborted).toBe(false); // caller's 20s deadline must win, not the 10s backstop

    jest.advanceTimersByTime(10000); // reach the caller's 20s deadline
    expect(signal!.aborted).toBe(true);
    clearTimeout(callerTimer);
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

/**
 * `fetchWithTimeout` — the single source of truth for the inline `AbortController + setTimeout +
 * fetch + clearTimeout` incantation previously duplicated across Wallet.tsx + the component sheets
 * + catalog.ts. A caller-configurable timeout (default = the 10s relay backstop), composing an
 * optional caller signal so a caller abort still wins (first abort wins), and clearing the timer in
 * `finally` so no lingering no-op abort fires after the fetch settles. These tests mirror the
 * safety-net tests above: mock `globalThis.fetch`, fake timers, the mock rejects on signal abort.
 */
describe('fetchWithTimeout helper', () => {
  test('omits a signal → aborts at the given timeoutMs (caller-configurable)', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    const {fetchWithTimeout} = require('../services/relay');

    const p = fetchWithTimeout('http://relay.example', undefined, 3000);
    const signal = getCaptured()?.signal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(2999);
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(1); // cross 3000ms → internal controller aborts
    expect(signal!.aborted).toBe(true);
    await expect(p).rejects.toThrow('aborted');
  });

  test('a caller-supplied signal that fires FIRST wins (composed, shorter timeout preserved)', async () => {
    jest.useFakeTimers();
    const getCaptured = installNeverResolvingFetch();
    const {fetchWithTimeout} = require('../services/relay');

    const callerCtrl = new AbortController();
    const p = fetchWithTimeout('http://relay.example', {signal: callerCtrl.signal}, 3000);
    const signal = getCaptured()?.signal;
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(500);
    callerCtrl.abort(); // caller aborts well before the 3000ms timeout
    expect(signal!.aborted).toBe(true); // forwarded into the internal controller
    await expect(p).rejects.toThrow('aborted');
  });

  test('success before timeout → returns the Response and clears the timer (no lingering abort)', async () => {
    jest.useFakeTimers();
    const fakeResponse = {__sentinel: true} as unknown as Response;
    (globalThis as unknown as {fetch: typeof fetch}).fetch = jest.fn(() => Promise.resolve(fakeResponse));
    const {fetchWithTimeout} = require('../services/relay');

    const before = jest.getTimerCount();
    const r = await fetchWithTimeout('http://relay.example', undefined, 5000);
    expect(r).toBe(fakeResponse);
    // The internal timeout timer was cleared in `finally` — advancing past the timeout fires nothing.
    expect(jest.getTimerCount()).toBe(before);
  });
});

/**
 * M11 — relay TS client surfaces the JSON `{error}` body on non-OK responses, mirroring
 * `withdrawFunds`. Before this fix, depositInfo/depositAddress/depositRefresh/ckerc20OnrampParams
 * threw `new Error('<path> <status>')`, dropping the relay/canister's real reason (e.g. the
 * family-gate "cur 6 not a btc family" message). The fix reads the body via `readJsonOrEmpty`
 * and surfaces `j?.error` when it's a string. These tests mock fetch to return a 503-with-body
 * and assert the thrown Error carries the body message (not just the status).
 */
function installJsonResponse(status: number, body: unknown) {
  const mock = jest.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
  (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
}

describe('relay client surfaces JSON error body (M11)', () => {
  afterEach(() => {
    (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  });

  test('depositInfo surfaces the body error on a 503', async () => {
    installJsonResponse(503, {error: 'minter unreachable (currency 6)'});
    const {depositInfo} = require('../services/relay');
    await expect(depositInfo('http://relay.example', 6)).rejects.toThrow('minter unreachable (currency 6)');
  });

  // (depositAddress + depositRefresh retired with the facade-subaccount deposit path — the deposit
  // sheet queries the ckBTC minter at the user principal; see services/rail.ts.)

  test('ckerc20OnrampParams surfaces the body error on a 503', async () => {
    installJsonResponse(503, {error: 'no CkEthErc20 onramp for currency 6'});
    const {ckerc20OnrampParams} = require('../services/relay');
    await expect(ckerc20OnrampParams('http://relay.example', 6)).rejects.toThrow('no CkEthErc20 onramp for currency 6');
  });

  test('depositInfo falls back to "<path> <status>" when the body has no string error', async () => {
    installJsonResponse(503, {});
    const {depositInfo} = require('../services/relay');
    await expect(depositInfo('http://relay.example', 1)).rejects.toThrow('deposit/info 503');
  });

  test('depositInfo falls back when the body fails to parse', async () => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('invalid json')),
      } as unknown as Response),
    );
    const {depositInfo} = require('../services/relay');
    await expect(depositInfo('http://relay.example', 1)).rejects.toThrow('deposit/info 502');
  });
});
