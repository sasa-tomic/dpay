/**
 * R3 — the Solana read-failure CLASSIFICATION (spec 2026-09-09-relay-ha-and-solana-proxy §"What
 * the app says when the relay is down and the phone is not"). A read that produced no fact must
 * name WHY, and the transport-side causes are different facts about the world with different user
 * moves: `refused` (the endpoint ANSWERED and did not serve us — this device is online and the
 * RAIL is down), `offline` (nothing answered anywhere, the IC boundary probe included — this
 * phone has no connectivity, and dpay must not claim an outage it cannot see), `unreachable`
 * (nothing answered on the rail's path while the phone IS online — the service side).
 *
 * The oracle that splits offline from unreachable is `classifyTransportFailure` in `app/solana.ts`,
 * EXPORTED (wave 3) because the hooks' residual catches call the same oracle — the export is part
 * of the seam's contract now, not a module-private detail. This suite pins it the way production
 * drives it: through the public read path (`readSolanaBalances`) and the exported function's
 * probe/memo behavior via the `__DPAY_TEST_*` overrides. Its reference host is the IC
 * BOUNDARY ORIGIN (`https://icp-api.io`, or the per-call `__DPAY_TEST_IC_GATEWAY` override — the
 * SAME seam `services/icp.ts` reads, so the e2e harness's fake-IC gateway redirect covers the
 * oracle too): probing the relay would collapse exactly when the relay IS the Solana rail path
 * (post-proxy), and any HTTP answer from the IC origin proves the phone is online. The refusal
 * branch is proven with the BRANDED error shape (`dpayEndpointRefused`, `solana/errors.ts`),
 * never message text — that is the only test the seam itself trusts (two module registries make
 * `instanceof` a silent lie).
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import type {SolanaRpcStub} from '../solana/rpc';

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

type Read = {
  sol: {kind: string; failure?: string};
  tokens: Record<string, {kind: string; failure?: string}>;
};

const realFetch = globalThis.fetch;

// Every test here drives a FAILURE path, and the seam console.warn's the classified cause on each
// (that warn is the dev loop's diagnosability for exactly these states). Silenced for the file;
// the tests that read it clear/mock it as needed.
const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

const g = globalThis as unknown as {
  __DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub;
  __DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online';
  __DPAY_TEST_IC_GATEWAY?: string;
};

afterEach(() => {
  warn.mockClear();
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete g.__DPAY_TEST_SOLANA_RPC_STUB;
  delete g.__DPAY_TEST_SOLANA_CONNECTIVITY;
  delete g.__DPAY_TEST_IC_GATEWAY;
});

/** A transport-level failure: the stub's getMultipleAccounts THROWS the way a dead network stack
 *  does. The stub branch sits before any cooldown logic in `rpcFetch`, so the thrown shape reaches
 *  the seam verbatim — branded or plain, exactly what the classification branches on. */
const transportThrow = (): unknown => {
  throw new Error('fetch failed');
};

/** The oracle's probe, mocked: the stub intercepts the RPC call itself, so any fetch this mock
 *  sees IS the connectivity probe — and its arguments pin WHERE the oracle probed. */
const probeFetch = (impl: () => Promise<unknown>) => {
  const fn = jest.fn(impl);
  (globalThis as unknown as {fetch: unknown}).fetch = fn;
  return fn;
};

/** One read against a failing endpoint. Each case gets its OWN url and an isolated module
 *  registry: `solanaRpcUrl()` and the seam's connectivity memo are module state, and one case's
 *  verdict must not answer for the next. */
function readFailing(handler: (params: unknown[]) => unknown, url: string, signal?: AbortSignal): Promise<Read> {
  g.__DPAY_TEST_SOLANA_RPC_STUB = {getMultipleAccounts: handler};
  const u = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
  let p: Promise<Read> | undefined;
  jest.isolateModules(() => {
    u.__DPAY_TEST_SOLANA_RPC_URL = url;
    const {readSolanaBalances} = require('../solana');
    p = (readSolanaBalances as (
      s: string, m: string[], sig?: AbortSignal,
    ) => Promise<Read>)(SEED_HEX, [USDC_MINT], signal);
  });
  u.__DPAY_TEST_SOLANA_RPC_URL = '';
  return p!;
}

const setConnectivity = (v: 'offline' | 'online') => {
  g.__DPAY_TEST_SOLANA_CONNECTIVITY = v;
};

describe('readSolanaBalances — the R3 failure classification', () => {
  test('nothing reachable anywhere ⇒ "offline" — the phone, not the rail', async () => {
    setConnectivity('offline');
    const r = await readFailing(transportThrow, 'https://offline.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'offline'});
    expect(String(warn.mock.calls[0]?.[0])).toContain('offline'); // the dev loop sees the cause too
  });

  test('rail path down while the phone is online ⇒ "unreachable"', async () => {
    setConnectivity('online');
    const r = await readFailing(transportThrow, 'https://unreachable.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'unreachable'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'unreachable'});
  });

  test('an endpoint that ANSWERED and refused ⇒ "refused" — and that beats the oracle', async () => {
    // The brand is checked BEFORE the oracle: a refusal is a fact the endpoint itself stated, and
    // no probe result may talk the seam out of it. The override says 'offline' ON PURPOSE — if the
    // branch order ever regresses, this is the test that says a rate-limited endpoint must not be
    // reported as an airplane-mode phone (the exact collapse R3 exists to prevent).
    setConnectivity('offline');
    const r = await readFailing(
      () => {
        throw Object.assign(new Error('solana rpc rate limit (HTTP 429)'), {dpayEndpointRefused: true, status: 429});
      },
      'https://refusing.example',
    );
    expect(r.sol).toEqual({kind: 'error', failure: 'refused'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'refused'});
  });

  test('the probe: ANY HTTP answer from the IC boundary origin ⇒ "unreachable" (transport works)', async () => {
    // No override — the oracle reaches its real decision. A 503 from the IC origin is still an
    // ANSWER: it proves the phone is online (off the Solana path), so the rail's path is what is
    // down. The stub intercepts the RPC call itself, so this mocked fetch can only be the probe —
    // and its arguments pin the probe TARGET: the bare icp-api.io origin, HEAD, never the relay.
    const fetchMock = probeFetch(() => Promise.resolve({ok: false, status: 503} as unknown as Response));
    const r = await readFailing(transportThrow, 'https://probe-answer.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'unreachable'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'unreachable'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://icp-api.io', expect.objectContaining({method: 'HEAD'}));
  });

  test('the probe: no answer from the IC boundary either ⇒ "offline" (nothing is reachable)', async () => {
    const fetchMock = probeFetch(() => Promise.reject(new Error('Network request failed')));
    const r = await readFailing(transportThrow, 'https://probe-deaf.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'offline'});
    expect(fetchMock).toHaveBeenCalledWith('https://icp-api.io', expect.anything());
  });

  test('the probe honors __DPAY_TEST_IC_GATEWAY — the SAME override services/icp.ts reads', async () => {
    // The e2e harness redirects IC traffic to an in-process gateway by setting this exact global;
    // if the oracle ever probed the real icp-api.io instead, the browser harness would fail the
    // run on an unknown-origin request. This is the pin that keeps the two seams reading ONE name.
    g.__DPAY_TEST_IC_GATEWAY = 'https://fake-ic-gateway.example';
    const fetchMock = probeFetch(() => Promise.resolve({ok: false, status: 404} as unknown as Response));
    const r = await readFailing(transportThrow, 'https://probe-gateway.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'unreachable'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://fake-ic-gateway.example', expect.anything());
  });

  test('the probe is memoized: ONE probe per TTL window, re-probed only past it', async () => {
    // The failing balance poll fires every POLL.balance tick (2.5s shipped) — FASTER than the
    // memo's TTL on purpose (the audit's finding: a 2s TTL re-probed on every failing tick).
    // Pin: two consecutive failing reads inside the window cost exactly ONE probe; the first read
    // past the 10s window re-probes. One isolateModules block = one module instance = one memo.
    const fetchMock = probeFetch(() => Promise.reject(new Error('Network request failed')));
    const u = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    // The RPC read must fail through the STUB, not through the mocked fetch — otherwise the RPC
    // request itself is counted as a "probe" and the pin measures the wrong thing.
    g.__DPAY_TEST_SOLANA_RPC_STUB = {getMultipleAccounts: transportThrow};
    let read!: () => Promise<Read>;
    try {
      jest.isolateModules(() => {
        u.__DPAY_TEST_SOLANA_RPC_URL = 'https://memo.example';
        const mod = require('../solana');
        read = (mod.readSolanaBalances as (
          s: string, m: string[], sig?: AbortSignal,
        ) => Promise<Read>).bind(null, SEED_HEX, [USDC_MINT]);
      });
      let r = await read();
      expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      r = await read(); // same window: the memo answers, no new probe
      expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(12_000); // past CONNECTIVITY_PROBE_TTL_MS (10s)
      r = await read();
      expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      u.__DPAY_TEST_SOLANA_RPC_URL = '';
    }
  });

  test('navigator.onLine === false ⇒ "offline" with NO probe (the web fast path)', async () => {
    // Feasible in this env (probed before writing): the RN jest preset exposes a navigator object
    // with no own onLine property, so the audit's Object.defineProperty mechanism applies cleanly.
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    const nav = (globalThis as unknown as {navigator?: {onLine?: boolean}}).navigator;
    expect(nav).toBeDefined();
    Object.defineProperty(nav, 'onLine', {value: false, configurable: true});
    try {
      const r = await readFailing(transportThrow, 'https://nav-offline.example');
      expect(r.sol).toEqual({kind: 'error', failure: 'offline'});
      expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'offline'});
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete (nav as {onLine?: boolean}).onLine; // restore: the property was absent before
    }
  });

  test('a CALLER-ABORTED read RETHROWS — no classification, no probe, no bogus warn (audit F6)', async () => {
    // Unmount/mint-change aborts used to run the oracle (a stray probe) and log a classified
    // cause for a read nobody wanted. The seam must rethrow the caller's error VERBATIM.
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    const abortErr = Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
    const ctrl = new AbortController();
    ctrl.abort();
    const p = readFailing(() => { throw abortErr; }, 'https://aborted.example', ctrl.signal);
    await expect(p).rejects.toBe(abortErr);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith('readSolanaBalances'))).toHaveLength(0);
  });

  test('rail disabled (empty RPC URL) answers "offline" for every account — no request, never a probe', async () => {
    // Unchanged by R3: `__DPAY_TEST_SOLANA_RPC_URL=''` (the jest.setup.js default) means the rail
    // is not configured, which is 'offline' — a config fact, not a failure, and never a probe.
    let stubCalls = 0;
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: () => { stubCalls++; throw new Error('stub must not be called'); },
    };
    const {readSolanaBalances} = require('../solana');
    const r = await (readSolanaBalances as (
      s: string, m: string[], sig?: AbortSignal,
    ) => Promise<Read>)(SEED_HEX, [USDC_MINT]);
    expect(r.sol).toEqual({kind: 'offline'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'offline'});
    expect(stubCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
