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

  // LEAK REGRESSION: arming the backstop is only half the contract — it must also be DISARMED when
  // the call settles. `depositInfo`/`ckerc20OnrampParams` used to compose the signal by hand and
  // throw the composed `cancel` on the floor, so every omitted-signal call left a live 10s timeout
  // holding its AbortController until it fired a no-op abort (a leaked handle on the phone, and the
  // open handle jest reported at worker teardown). Both now route through `fetchWithTimeout`, which
  // cancels in `finally`. Asserted on BOTH exit paths — a 200 and a thrown non-OK — because the
  // clear lives in `finally` precisely so the throwing path is covered too.
  const body = (ok: boolean, payload: unknown) =>
    jest.fn(() => Promise.resolve({ok, status: ok ? 200 : 503, json: () => Promise.resolve(payload)} as unknown as Response));
  type LeakCase = [name: string, call: (m: any) => Promise<unknown>, ok: unknown, err: string];
  const leakCases: LeakCase[] = [
    ['depositInfo', m => m.depositInfo('http://relay.example', 1), {min_confirmations: 4, deposit_fee: '0', deposit_min_amount: null}, 'deposit/info 503'],
    ['ckerc20OnrampParams', m => m.ckerc20OnrampParams('http://relay.example', 2), {helper_address: '0xhelper', erc20_address: null, kind: 'native_eth'}, 'onramp/ckerc20 503'],
  ];
  test.each(leakCases)('%s leaves NO pending backstop timer once the call settles', async (_name, call, ok, err) => {
    jest.useFakeTimers();
    const relay = require('../services/relay');
    const idle = jest.getTimerCount();

    (globalThis as unknown as {fetch: unknown}).fetch = body(true, ok);
    await expect(call(relay)).resolves.toEqual(ok);
    expect(jest.getTimerCount()).toBe(idle); // success path: timer cleared, not left to fire

    (globalThis as unknown as {fetch: unknown}).fetch = body(false, {});
    await expect(call(relay)).rejects.toThrow(err);
    expect(jest.getTimerCount()).toBe(idle); // throwing path: `finally` clears it too
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

describe('relayCapabilities', () => {
  const response = (ok: boolean, payload: unknown) => ({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(payload),
  } as unknown as Response);

  test('accepts only the explicit boolean capability shape', async () => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => Promise.resolve(response(true, {till: true, demo_faucet: false})));
    const {relayCapabilities} = require('../services/relay');
    await expect(relayCapabilities('http://relay.example')).resolves.toEqual({till: true, demoFaucet: false});
  });

  test.each([
    ['non-OK response', response(false, {})],
    ['missing field', response(true, {till: true})],
    ['wrong field type', response(true, {till: 'yes', demo_faucet: true})],
  ])('fails closed for %s', async (_name, result) => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => Promise.resolve(result));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {relayCapabilities} = require('../services/relay');
    await expect(relayCapabilities('http://relay.example')).resolves.toEqual({till: false, demoFaucet: false});
    warn.mockRestore();
  });

  test('fails closed on a network error', async () => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => Promise.reject(new Error('offline')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {relayCapabilities} = require('../services/relay');
    await expect(relayCapabilities('http://relay.example')).resolves.toEqual({till: false, demoFaucet: false});
    warn.mockRestore();
  });

  // Failing closed is the right POLICY and silently failing closed is a bug: the wallet then hides
  // the cashier and the top-up with nothing anywhere saying why (exactly how a relay that was in
  // fact serving a faucet came to look like one that wasn't). Every failure path must leave a line
  // naming the URL that was asked and what came back.
  test.each([
    ['non-OK response', response(false, {}), ['404']],
    ['malformed body', response(true, {till: true}), ['till']],
    ['network error', Promise.reject(new Error('offline')), ['offline']],
  ])('logs the URL and the reason for %s', async (_name, result, mustMention) => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() =>
      result instanceof Promise ? result : Promise.resolve(result),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {relayCapabilities} = require('../services/relay');
    await relayCapabilities('http://relay.example');
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map(c => c.map(a => String(a)).join(' ')).join('\n');
    expect(logged).toContain('http://relay.example/api/v1/capabilities');
    for (const fragment of mustMention) expect(logged).toContain(fragment);
    warn.mockRestore();
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

  // (IC-rail cutover fix 2026-08-20: `facade_principal` was REMOVED from the onramp params. The
  // deposit `principal` arg is the user's OWN IC principal, derived in-app via
  // DpayCore.icpSelfPrincipal — the facade-era field minted deposits at the FACADE principal,
  // invisible to user-principal balance reads. Pins the client shape so the field can't creep back.)
  test('ckerc20OnrampParams success shape carries NO facade_principal (the deposit principal is derived in-app)', async () => {
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          helper_address: '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68',
          erc20_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          kind: 'erc20',
        }),
      } as unknown as Response),
    );
    const {ckerc20OnrampParams} = require('../services/relay');
    const p = await ckerc20OnrampParams('http://relay.example', 2);
    expect(p.helper_address).toBe('0x18901044688D3756C35Ed2b36D93e6a5B8e00E68');
    expect(p.kind).toBe('erc20');
    expect((p as Record<string, unknown>).facade_principal).toBeUndefined();
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

// ── The body read is bounded too ──────────────────────────────────────────────────────────────
// `fetchWithTimeout`'s abort signal is released the moment the Response object exists, so the body
// read that follows used to run unbounded: a server that answers `200 OK` and then stops writing
// held the caller forever — the very failure that helper exists to prevent, one step later.
describe('readBodyWithin — a stalled body is a failure, not a wait', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('a body that never finishes rejects with the bound and the context it belonged to', async () => {
    jest.useFakeTimers();
    const {readBodyWithin} = require('../services/relay');
    const settled = readBodyWithin(() => new Promise(() => {}), 'GET /api/v1/thing (HTTP 200)', 1_000)
      .then(() => 'resolved', (e: unknown) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    const e = await settled;
    expect(e).toBeInstanceOf(Error);
    // The message has to name WHICH read stalled — a bare "timed out" is unactionable across the
    // dozen call sites that share this helper.
    expect((e as Error).message).toContain('GET /api/v1/thing (HTTP 200)');
    expect((e as Error).message).toContain('1000 ms');
  });

  test('a body that arrives passes through untouched and leaves no timer', async () => {
    jest.useFakeTimers();
    const {readBodyWithin} = require('../services/relay');
    await expect(readBodyWithin(async () => ({ok: 1}), 'GET /x', 1_000)).resolves.toEqual({ok: 1});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a read that throws propagates ITS error, not the timeout', async () => {
    const {readBodyWithin} = require('../services/relay');
    await expect(readBodyWithin(async () => { throw new Error('invalid json'); }, 'GET /x'))
      .rejects.toThrow('invalid json');
  });
});

describe('readJsonOrEmpty — an unusable body is empty AND named', () => {
  test('a malformed body yields {} and a line carrying the url, the status and the cause', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const {readJsonOrEmpty} = require('../services/relay');
      const r = {url: 'http://relay.example/api/v1/currencies', status: 502, json: async () => { throw new Error('Unexpected token <'); }} as unknown as Response;
      await expect(readJsonOrEmpty(r)).resolves.toEqual({});
      // `'body parse failed'` on its own could not tell a reader which of a dozen callers had
      // failed, against which relay, with what status.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('http://relay.example/api/v1/currencies'),
        expect.stringContaining('Unexpected token <'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 502'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  test('a well-formed body is returned and nothing is logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const {readJsonOrEmpty} = require('../services/relay');
      const r = {url: 'http://relay.example/x', status: 200, json: async () => ({balance: '7'})} as unknown as Response;
      await expect(readJsonOrEmpty(r)).resolves.toEqual({balance: '7'});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
