/**
 * The SHARED transport-failure oracle (R3 generalized, work order 2026-09-30 "check your
 * connection" copy fires on relay failures while the phone is online).
 *
 * `classifyTransportFailure` moved out of `app/solana.ts` into its own module so BOTH rails can
 * ask the same question with a reference host that is OFF their own failing path:
 *   - the SOLANA rail's failures default to the IC boundary probe (unchanged R3 behavior —
 *     pinned end-to-end by solana-failure-classification.test.ts through readSolanaBalances);
 *   - the IC rail's failures (`classifyIcReadFailure`) probe the SOL rail's head endpoint —
 *     the mirror image. Probing the IC boundary for an IC-path failure would collapse every
 *     boundary outage into "offline", the exact misattribution the oracle exists to prevent.
 * `engineLoadCopy` classifies the payment-engine chunk failure (either rail's lazily-loaded
 * network module) and returns the FINAL user copy per blame — the loaders throw it directly.
 *
 * The oracle answers only 'offline' | 'unreachable'. A service that ANSWERED and refused is a
 * different fact ('refused') and is decided by the caller's own branded shapes, never here.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

const g = globalThis as unknown as {
  __DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online';
  __DPAY_TEST_IC_GATEWAY?: string;
  __DPAY_TEST_SOLANA_RPC_URL?: string;
};

afterEach(() => {
  warn.mockClear();
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete g.__DPAY_TEST_SOLANA_CONNECTIVITY;
  delete g.__DPAY_TEST_IC_GATEWAY;
  g.__DPAY_TEST_SOLANA_RPC_URL = ''; // restore the jest.setup.js default (SOL rail off)
});

/** A fetch mock: in these tests every fetch call IS an oracle probe (no other network runs). */
const probeFetch = (impl: () => Promise<unknown>) => {
  const fn = jest.fn(impl);
  (globalThis as unknown as {fetch: unknown}).fetch = fn;
  return fn;
};

/** Load the oracle in an ISOLATED module registry: the connectivity memo and the SOL test-URL
 *  override are module state captured at load, so every case gets a fresh instance. */
function loadOracle(): typeof import('../transportFailure') {
  let mod!: typeof import('../transportFailure');
  jest.isolateModules(() => {
    mod = require('../transportFailure') as typeof import('../transportFailure');
  });
  return mod;
}

describe('classifyTransportFailure — the parameterized reference host', () => {
  test('default probe is the IC boundary origin, HEAD, and ANY answer ⇒ unreachable', async () => {
    const fetchMock = probeFetch(() => Promise.resolve({ok: false, status: 503} as unknown as Response));
    const {classifyTransportFailure} = loadOracle();
    await expect(classifyTransportFailure()).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://icp-api.io', expect.objectContaining({method: 'HEAD'}));
  });

  test('default probe honors __DPAY_TEST_IC_GATEWAY (the e2e fake-IC redirect)', async () => {
    g.__DPAY_TEST_IC_GATEWAY = 'https://fake-ic-gateway.example';
    const fetchMock = probeFetch(() => Promise.resolve({ok: true, status: 200} as unknown as Response));
    const {classifyTransportFailure} = loadOracle();
    await expect(classifyTransportFailure()).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledWith('https://fake-ic-gateway.example', expect.anything());
  });

  test('an explicit probeUrl replaces the default — the caller owns the reference host', async () => {
    const fetchMock = probeFetch(() => Promise.resolve({ok: true, status: 405} as unknown as Response));
    const {classifyTransportFailure} = loadOracle();
    await expect(classifyTransportFailure('https://relay-head.example/health')).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://relay-head.example/health', expect.objectContaining({method: 'HEAD'}));
  });

  test('probe deaf ⇒ offline, whoever is asked', async () => {
    const fetchMock = probeFetch(() => Promise.reject(new Error('Network request failed')));
    const {classifyTransportFailure} = loadOracle();
    await expect(classifyTransportFailure('https://deaf.example')).resolves.toBe('offline');
    await expect(classifyTransportFailure()).resolves.toBe('offline');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('the __DPAY_TEST_SOLANA_CONNECTIVITY override answers first, with NO fetch at all', async () => {
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    const {classifyTransportFailure} = loadOracle();
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    await expect(classifyTransportFailure()).resolves.toBe('offline');
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    await expect(classifyTransportFailure('https://anywhere.example')).resolves.toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the probe is memoized PER probe URL within the TTL window', async () => {
    const fetchMock = probeFetch(() => Promise.reject(new Error('Network request failed')));
    const {classifyTransportFailure} = loadOracle();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await expect(classifyTransportFailure('https://a.example')).resolves.toBe('offline');
      await expect(classifyTransportFailure('https://b.example')).resolves.toBe('offline');
      expect(fetchMock).toHaveBeenCalledTimes(2); // two hosts, two probes
      await expect(classifyTransportFailure('https://a.example')).resolves.toBe('offline');
      await expect(classifyTransportFailure('https://b.example')).resolves.toBe('offline');
      expect(fetchMock).toHaveBeenCalledTimes(2); // both answered from the memo
      nowSpy.mockReturnValue(12_000); // past CONNECTIVITY_PROBE_TTL_MS (10s)
      await expect(classifyTransportFailure('https://a.example')).resolves.toBe('offline');
      expect(fetchMock).toHaveBeenCalledTimes(3); // re-probed past the window
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('classifyIcReadFailure — the IC rail asks the SOL rail (mirror of R3)', () => {
  test('probes the SOL rail head endpoint, HEAD; an answer ⇒ unreachable', async () => {
    // The SOL head is module-load state in jest (the '' test override). A fresh registry with a
    // real head URL is how production runs (relay base + proxy path).
    g.__DPAY_TEST_SOLANA_RPC_URL = 'https://sol-head.example/api/v1/solana/rpc';
    let mod!: typeof import('../transportFailure');
    jest.isolateModules(() => {
      mod = require('../transportFailure') as typeof import('../transportFailure');
    });
    const fetchMock = probeFetch(() => Promise.resolve({ok: false, status: 405} as unknown as Response));
    await expect(mod.classifyIcReadFailure()).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://sol-head.example/api/v1/solana/rpc',
      expect.objectContaining({method: 'HEAD'}),
    );
  });

  test('an empty SOL head (rail off / jest default) falls back to the IC boundary probe', async () => {
    // jest.setup.js ships __DPAY_TEST_SOLANA_RPC_URL = '' — the head is empty, so there is no
    // off-path home; the oracle falls back to the IC boundary rather than fetching ''.
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    const fetchMock = probeFetch(() => Promise.resolve({ok: true, status: 200} as unknown as Response));
    const {classifyIcReadFailure} = loadOracle();
    await expect(classifyIcReadFailure()).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledWith('https://icp-api.io', expect.objectContaining({method: 'HEAD'}));
  });

  test('the connectivity override binds the IC classification too', async () => {
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    const {classifyIcReadFailure} = loadOracle();
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    await expect(classifyIcReadFailure()).resolves.toBe('offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('engineLoadCopy — the payment-engine chunk failure', () => {
  const rawDeadline = 'solana rpc module failed to load within 10000ms (the engine chunk never arrived)';
  const rawEvm = 'evm rpc module failed to load within 10000ms (the engine chunk never arrived)';
  const rawFastFail = 'TypeError: Failed to fetch dynamically imported module: https://relay.example/rpc-123.js';

  test('deadline-class raw message + phone online ⇒ the unreachable copy (names dpay)', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    const fetchMock = probeFetch(() => Promise.reject(new Error('the oracle must not probe')));
    const {engineLoadCopy} = loadOracle();
    await expect(engineLoadCopy(rawDeadline)).resolves.not.toBeNull();
    await expect(engineLoadCopy(rawEvm)).resolves.not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const {M} = require('../i18n') as typeof import('../i18n');
    await expect(engineLoadCopy(rawDeadline)).resolves.toBe(M.errors.engine.unreachable);
  });

  test('the same class with no connectivity ⇒ the offline copy — never connection blame', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    const {engineLoadCopy} = loadOracle();
    const {M} = require('../i18n') as typeof import('../i18n');
    await expect(engineLoadCopy(rawEvm)).resolves.toBe(M.errors.engine.offline);
  });

  test('a fast dynamic-import failure is the same user fact and classifies too', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    const {engineLoadCopy} = loadOracle();
    const {M} = require('../i18n') as typeof import('../i18n');
    await expect(engineLoadCopy(rawFastFail)).resolves.toBe(M.errors.engine.unreachable);
  });

  test('any other failure class returns null — the caller keeps its own verdict', async () => {
    const {engineLoadCopy} = loadOracle();
    await expect(engineLoadCopy('sol send aborted (deadline)')).resolves.toBeNull();
    await expect(engineLoadCopy('transaction failed: custom-program error')).resolves.toBeNull();
    await expect(engineLoadCopy('')).resolves.toBeNull();
  });

  test('the two arms are DISTINCT and neither blames the connection while online', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    const {engineLoadCopy} = loadOracle();
    const online = await engineLoadCopy(rawDeadline);
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    const {engineLoadCopy: fresh} = loadOracle();
    const offline = await fresh(rawDeadline);
    expect(online).not.toBeNull();
    expect(offline).not.toBeNull();
    expect(online).not.toBe(offline);
    expect(online!).not.toMatch(/check your connection/i);
    expect(offline!).toMatch(/offline/i);
  });
});
