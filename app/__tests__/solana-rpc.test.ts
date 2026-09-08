/**
 * Solana JSON-RPC client (`solana/rpc.ts`). Mocks global `fetch` (no real network) to assert the
 * JSON-RPC 2.0 request shape, response parsing, base64 tx encoding, error handling, the bounded-
 * timeout backstop, and the confirmation poll loop. Mirrors the relay.test.ts fetch-mock idiom.
 */
import {describe, test, expect, jest, afterEach, beforeEach} from '@jest/globals';

const realFetch = globalThis.fetch;

// Mock fetch with a queue of JSON result bodies. Each call pops the next response: if the entry is
// `{ok:false,status}` an HTTP error Response is returned; if `{error:...}` a 200 with an RPC error;
// otherwise a 200 carrying `{result: <entry>}`. Captures the request body for request-shape asserts.
function installRpcFetch(responses: Array<unknown | {ok: false; status: number} | {error: unknown}>) {
  const calls: {url: string; body: unknown}[] = [];
  const mock = jest.fn((url: string, init?: RequestInit) => {
    calls.push({url, body: init?.body ? JSON.parse(String(init.body)) : null});
    const next = responses.shift() ?? null;
    const httpOk = !(next && typeof next === 'object' && 'ok' in (next as any) && (next as any).ok === false);
    const status = next && typeof next === 'object' && 'status' in (next as any) ? (next as any).status : 200;
    let payload: string;
    if (next && typeof next === 'object' && 'error' in (next as any)) {
      payload = JSON.stringify({jsonrpc: '2.0', id: 1, error: (next as any).error});
    } else {
      payload = JSON.stringify({jsonrpc: '2.0', id: 1, result: next});
    }
    // `headers` is real on every Response; the rate-limit gate reads `Retry-After` off a 429, so
    // the mock carries a Headers-shaped reader seeded from an optional `headers` field.
    const hdrs: Record<string, string> = (next && typeof next === 'object' && 'headers' in (next as any) ? (next as any).headers : {}) ?? {};
    const headers = {get: (k: string) => hdrs[k] ?? hdrs[k.toLowerCase()] ?? null};
    // `text` is real on every Response too, and a non-2xx now reads the body so its message can
    // carry the endpoint's own explanation (a Helius 401 says WHICH key). A double whose failure
    // path lacked `text` would make the error under test unreachable.
    return Promise.resolve({
      ok: httpOk, status, headers,
      json: () => Promise.resolve(JSON.parse(payload)),
      text: () => Promise.resolve(payload),
    } as unknown as Response);
  });
  (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
  return {calls};
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  jest.useRealTimers();
});

describe('solana rpc — request/response', () => {
  test('getBalance sends JSON-RPC getBalance and returns lamports as a string', async () => {
    const {calls} = installRpcFetch([{value: 1500000000}]);
    const {getBalance} = require('../solana/rpc');
    const bal = await getBalance('https://rpc.example', 'AddrXYZ');
    expect(bal).toBe('1500000000');
    expect(calls[0].body).toEqual({jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['AddrXYZ']});
  });

  test('getLatestBlockhash parses blockhash + lastValidBlockHeight + contextSlot', async () => {
    const {calls} = installRpcFetch([{context: {slot: 200}, value: {blockhash: 'BlockhashABC', lastValidBlockHeight: 123456}}]);
    const {getLatestBlockhash} = require('../solana/rpc');
    const bh = await getLatestBlockhash('https://rpc.example');
    expect(bh).toEqual({blockhash: 'BlockhashABC', lastValidBlockHeight: 123456, slot: 200, contextSlot: 200});
    // Phase 3: commitment='confirmed' is now passed (the freshness state machine requires it for
    // reorg-consistent getLatestBlockhash + downstream isBlockhashValid/getBlockHeight calls).
    expect(calls[0].body).toEqual(expect.objectContaining({method: 'getLatestBlockhash', params: [{commitment: 'confirmed'}]}));
  });

  test('sendTransaction base64-encodes the raw bytes and returns the signature', async () => {
    const {calls} = installRpcFetch(['SigReturn']);
    const {sendTransaction} = require('../solana/rpc');
    const raw = new Uint8Array([1, 2, 3, 200, 255]); // bytes incl. values > 127 to exercise encoding
    const sig = await sendTransaction('https://rpc.example', raw);
    expect(sig).toBe('SigReturn');
    const params = (calls[0].body as {params: unknown[]}).params;
    expect(params[1]).toEqual({encoding: 'base64'});
    expect(params[0]).toBe('AQIDyP8='); // base64 of [1,2,3,200,255]
  });

  test('an RPC-level error (result.error) throws its message', async () => {
    installRpcFetch([{error: {code: -32000, message: 'AccountNotFound'}}]);
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance('https://rpc.example', 'X')).rejects.toThrow('solana rpc: AccountNotFound');
  });

  // 429 is NOT used here: it is the one status with its own behaviour (the rate-limit gate, pinned
  // in its own describe below), so pinning the generic path on it would test two things at once.
  test('a non-2xx HTTP status throws', async () => {
    installRpcFetch([{ok: false, status: 503}]);
    const {getBalance} = require('../solana/rpc');
    // The message names the method, the HOST (never the URL — it carries the API key) and the
    // body, because a bare status is not something anyone can act on.
    await expect(getBalance('https://rpc.example', 'X')).rejects.toThrow(/solana rpc getBalance → rpc\.example: HTTP 503/);
  });
});

describe('solana rpc — bounded timeout backstop', () => {
  test('a caller that OMITS its signal aborts at the default timeout', async () => {
    jest.useFakeTimers();
    let captured: {signal?: AbortSignal} | undefined;
    const mock = jest.fn((_url: string, init?: RequestInit) => {
      captured = init;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    });
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    const {getBalance} = require('../solana/rpc');

    const p = getBalance('https://rpc.example', 'X', {timeoutMs: 3000});
    const signal = captured?.signal;
    expect(signal).toBeDefined();
    jest.advanceTimersByTime(2999);
    expect(signal!.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal!.aborted).toBe(true);
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('solana rpc — confirmTransaction poll', () => {
  test('resolves once confirmationStatus is confirmed', async () => {
    // First poll: signature not found yet (null). Second poll: confirmed.
    installRpcFetch([{value: [null]}, {value: [{confirmationStatus: 'confirmed'}]}]);
    const {confirmTransaction} = require('../solana/rpc');
    await expect(confirmTransaction('https://rpc.example', 'Sig1', {pollMs: 5, timeoutMs: 5000}))
      .resolves.toBeUndefined();
  });

  test('finalized also resolves', async () => {
    installRpcFetch([{value: [{confirmationStatus: 'finalized'}]}]);
    const {confirmTransaction} = require('../solana/rpc');
    await expect(confirmTransaction('https://rpc.example', 'Sig1')).resolves.toBeUndefined();
  });

  test('a reported transaction error throws', async () => {
    installRpcFetch([{value: [{err: {InstructionError: [0, 'InsufficientFunds']}}]}]);
    const {confirmTransaction} = require('../solana/rpc');
    await expect(confirmTransaction('https://rpc.example', 'Sig1')).rejects.toThrow('transaction failed');
  });
});

describe('solana rpc — accountExists (F4 ATA gate)', () => {
  test('returns true when getAccountInfo returns a non-null account', async () => {
    const {calls} = installRpcFetch([{value: {data: ['', 'base64'], owner: 'tok', lamports: 1}}]);
    const {accountExists} = require('../solana/rpc');
    const exists = await accountExists('https://rpc.example', 'SomeAtaAddr');
    expect(exists).toBe(true);
    expect(calls[0].body).toEqual(expect.objectContaining({
      jsonrpc: '2.0', method: 'getAccountInfo', params: ['SomeAtaAddr', {encoding: 'base64'}],
    }));
  });

  test('returns false when getAccountInfo returns null (the ATA does not exist on-chain)', async () => {
    installRpcFetch([{value: null}]);
    const {accountExists} = require('../solana/rpc');
    const exists = await accountExists('https://rpc.example', 'MissingAtaAddr');
    expect(exists).toBe(false);
  });

  test('throws on a network error (never silently reports absent)', async () => {
    installRpcFetch([{ok: false, status: 500}]);
    const {accountExists} = require('../solana/rpc');
    await expect(accountExists('https://rpc.example', 'X')).rejects.toThrow(/solana rpc getAccountInfo → rpc\.example: HTTP 500/);
  });
});

describe('solana rpc — e2e stub seam (__DPAY_TEST_SOLANA_RPC_STUB)', () => {
  afterEach(() => {
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  test('when the stub is set, rpcFetch routes to it and fetch is NEVER called', async () => {
    let fetchCalls = 0;
    (globalThis as {fetch: unknown}).fetch = () => { fetchCalls++; throw new Error('fetch must not be called'); };
    const stub = {
      getBalance: (_params: unknown[]) => ({value: 777}),
    };
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
    const {getBalance} = require('../solana/rpc');
    const bal = await getBalance('https://rpc.example', 'AddrX');
    expect(bal).toBe('777');
    expect(fetchCalls).toBe(0);
  });

  test('sendTransaction routes through the stub', async () => {
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const stub = {
      sendTransaction: (params: unknown[]) => 'STUB_SIG_' + String((params as unknown[])[0]).slice(0, 4),
    };
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
    const {sendTransaction} = require('../solana/rpc');
    const sig = await sendTransaction('https://rpc.example', new Uint8Array([1, 2, 3]));
    expect(sig).toBe('STUB_SIG_AQID');
  });

  test('a method missing from the stub throws a typed error and does not fall through to fetch', async () => {
    let fetchCalls = 0;
    (globalThis as {fetch: unknown}).fetch = () => { fetchCalls++; throw new Error('fetch must not be called'); };
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {}; // no methods
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance('https://rpc.example', 'X')).rejects.toThrow(/stub|not implemented|getBalance/i);
    expect(fetchCalls).toBe(0);
  });

  test('clearing the stub restores real fetch routing', async () => {
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
    installRpcFetch([{value: 42}]);
    const {getBalance} = require('../solana/rpc');
    const bal = await getBalance('https://rpc.example', 'X');
    expect(bal).toBe('42');
  });
});

// Phase 2 — exact-string SPL token balance. `getTokenAccountBalance` reads an ATA's raw `amount`
// (decimal-digit STRING) + `decimals` from `getTokenAccountBalance` and MUST preserve the exact
// string — never coerce through JS `number` (money-critical; values >2^53 lose precision). The
// hook (useSolanaBalances) trusts this to render a Solana-USDC balance row distinctly from SOL.
describe('solana rpc — getTokenAccountBalance (exact-string SPL)', () => {
  afterEach(() => {
    // The stub set by the stub-routing tests MUST be cleared so the request-shape test (which uses
    // installRpcFetch → real-fetch routing) sees no stub. Without this the stub leaks across tests.
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  test('returns the exact amount string + decimals from a stub response (no number coercion)', async () => {
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getTokenAccountBalance: () => ({value: {amount: '1234567', decimals: 6, uiAmount: 1.234567}}),
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const {getTokenAccountBalance} = require('../solana/rpc');
    const r = await getTokenAccountBalance('https://rpc.example', 'SomeAtaAddr');
    expect(r).toEqual({amount: '1234567', decimals: 6});
    expect(typeof r.amount).toBe('string'); // NEVER a number
  });

  test('preserves a large amount (>2^53) as a STRING — proves no JS number path', async () => {
    // 10_000_000_000_000_000 raw units = 1e16 — well above 2^53 (~9e15). Number coercion would
    // lose precision; the string must be preserved verbatim.
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getTokenAccountBalance: () => ({value: {amount: '10000000000000000', decimals: 6, uiAmount: null}}),
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const {getTokenAccountBalance} = require('../solana/rpc');
    const r = await getTokenAccountBalance('https://rpc.example', 'BigAta');
    expect(r.amount).toBe('10000000000000000');
    expect(typeof r.amount).toBe('string');
  });

  test('preserves the raw "0" amount for a zero-balance ATA (NOT coerced to null or absent)', async () => {
    // A zero balance is still a balance — distinguishable from a missing ATA. Must stay '0'.
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0}}),
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const {getTokenAccountBalance} = require('../solana/rpc');
    const r = await getTokenAccountBalance('https://rpc.example', 'ZeroAta');
    expect(r).toEqual({amount: '0', decimals: 6});
  });

  test('a method missing from the stub throws a typed error (never a falsy/zero default)', async () => {
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {}; // no methods
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const {getTokenAccountBalance} = require('../solana/rpc');
    await expect(getTokenAccountBalance('https://rpc.example', 'X'))
      .rejects.toThrow(/stub|not implemented|getTokenAccountBalance/i);
  });

  test('an RPC error response throws (never silently returns a zero balance)', async () => {
    installRpcFetch([{error: {code: -32000, message: 'Invalid param: account not found'}}]);
    const {getTokenAccountBalance} = require('../solana/rpc');
    await expect(getTokenAccountBalance('https://rpc.example', 'MissingAta'))
      .rejects.toThrow(/account not found|solana rpc/i);
  });

  test('request shape: posts getTokenAccountBalance with the ATA pubkey as the sole param', async () => {
    const {calls} = installRpcFetch([{value: {amount: '500000', decimals: 6, uiAmount: null}}]);
    const {getTokenAccountBalance} = require('../solana/rpc');
    await getTokenAccountBalance('https://rpc.example', 'AtaAddrXYZ');
    expect(calls[0].body).toEqual(expect.objectContaining({
      jsonrpc: '2.0', method: 'getTokenAccountBalance', params: ['AtaAddrXYZ'],
    }));
  });
});

// Phase 3 — v2 recent-blockhash freshness RPC methods. The merchant's broadcast state machine
// (solana.ts broadcastSolPayment) requires these to authoritatively prove a request is still
// broadcastable BEFORE sendTransaction, and to authoritatively classify a confirm timeout as
// expired vs honest-unknown. All run at SOL_PAYMENT_COMMITMENT='confirmed' and accept
// `minContextSlot` (the request's context slot) for reorg-aware behavior.
describe('solana rpc — Phase 3 freshness methods', () => {
  afterEach(() => {
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  test('getGenesisHash returns the hash string and caches per URL (second call skips rpcFetch)', async () => {
    let calls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => { calls++; return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; },
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    // isolateModules resets the rpc module so the genesisHashCache Map is fresh for this test
    // (the cache is module-level and would otherwise persist across tests in this file).
    await jest.isolateModules(async () => {
      const {getGenesisHash} = require('../solana/rpc');
      const url = 'https://genesis-cache.test';
      const h1 = await getGenesisHash(url);
      const h2 = await getGenesisHash(url);
      expect(h1).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
      expect(h2).toBe(h1);
      expect(calls).toBe(1); // cached — second call did NOT invoke the stub handler
    });
  });

  test('getGenesisHash does NOT cache on failure (a transient error must not pin a wrong cluster)', async () => {
    let calls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => { calls++; throw new Error('rpc down'); },
    };
    await jest.isolateModules(async () => {
      const {getGenesisHash} = require('../solana/rpc');
      await expect(getGenesisHash('https://genesis-fail.test')).rejects.toThrow('rpc down');
      await expect(getGenesisHash('https://genesis-fail.test')).rejects.toThrow('rpc down');
      expect(calls).toBe(2); // NOT cached — both calls invoked the stub handler
    });
  });

  test('getBlockHeight passes commitment + minContextSlot through to the RPC params', async () => {
    const {calls} = installRpcFetch([123456]);
    const {getBlockHeight} = require('../solana/rpc');
    const h = await getBlockHeight('https://rpc.example', {minContextSlot: 200});
    expect(h).toBe(123456);
    expect(calls[0].body).toEqual(expect.objectContaining({
      method: 'getBlockHeight', params: [{commitment: 'confirmed', minContextSlot: 200}],
    }));
  });

  test('getBlockHeight omits minContextSlot when not provided (only commitment)', async () => {
    const {calls} = installRpcFetch([42]);
    const {getBlockHeight} = require('../solana/rpc');
    const h = await getBlockHeight('https://rpc.example');
    expect(h).toBe(42);
    expect(calls[0].body).toEqual(expect.objectContaining({
      method: 'getBlockHeight', params: [{commitment: 'confirmed'}],
    }));
  });

  test('isBlockhashValid returns {valid, contextSlot} from value + context.slot', async () => {
    const {calls} = installRpcFetch([{context: {slot: 300}, value: true}]);
    const {isBlockhashValid} = require('../solana/rpc');
    const r = await isBlockhashValid('https://rpc.example', 'BlockhashX', {minContextSlot: 250});
    expect(r).toEqual({valid: true, contextSlot: 300});
    expect(calls[0].body).toEqual(expect.objectContaining({
      method: 'isBlockhashValid', params: ['BlockhashX', {commitment: 'confirmed', minContextSlot: 250}],
    }));
  });

  test('isBlockhashValid returns valid=false cleanly when the blockhash expired', async () => {
    installRpcFetch([{context: {slot: 350}, value: false}]);
    const {isBlockhashValid} = require('../solana/rpc');
    const r = await isBlockhashValid('https://rpc.example', 'DeadBlockhash', {minContextSlot: 250});
    expect(r).toEqual({valid: false, contextSlot: 350});
  });

  test('getSignatureStatusesForSig passes searchTransactionHistory:true and unwraps value[0]', async () => {
    const {calls} = installRpcFetch([{context: {slot: 400}, value: [{confirmationStatus: 'confirmed'}]}]);
    const {getSignatureStatusesForSig} = require('../solana/rpc');
    const r = await getSignatureStatusesForSig('https://rpc.example', 'SigBase58');
    expect(r).toEqual({status: {confirmationStatus: 'confirmed'}, contextSlot: 400});
    const params = (calls[0].body as {params: unknown[]}).params;
    expect(params[0]).toEqual(['SigBase58']);
    expect(params[1]).toEqual({searchTransactionHistory: true});
  });

  test('getSignatureStatusesForSig returns null status cleanly when value is [null]', async () => {
    installRpcFetch([{context: {slot: 410}, value: [null]}]);
    const {getSignatureStatusesForSig} = require('../solana/rpc');
    const r = await getSignatureStatusesForSig('https://rpc.example', 'UnknownSig');
    expect(r).toEqual({status: null, contextSlot: 410});
  });

  test('getFeeForMessage returns the lamport fee as a bigint', async () => {
    const {calls} = installRpcFetch([5000]);
    const {getFeeForMessage} = require('../solana/rpc');
    const fee = await getFeeForMessage('https://rpc.example', 'MessageBase64==', {minContextSlot: 200});
    expect(fee).toBe(5000n);
    expect(typeof fee).toBe('bigint');
    expect(calls[0].body).toEqual(expect.objectContaining({
      method: 'getFeeForMessage', params: ['MessageBase64==', {commitment: 'confirmed', minContextSlot: 200}],
    }));
  });

  test('getFeeForMessage returns null cleanly (message not yet fee-calculable)', async () => {
    installRpcFetch([null]);
    const {getFeeForMessage} = require('../solana/rpc');
    const fee = await getFeeForMessage('https://rpc.example', 'BadMessage==');
    expect(fee).toBeNull();
  });

  test('all Phase 3 freshness methods route through the stub (no real network)', async () => {
    let fetchCalls = 0;
    (globalThis as {fetch: unknown}).fetch = () => { fetchCalls++; throw new Error('fetch must not be called'); };
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => 'gen',
      getBlockHeight: () => 1,
      isBlockhashValid: () => ({context: {slot: 1}, value: true}),
      getSignatureStatuses: () => ({context: {slot: 1}, value: [null]}),
      getFeeForMessage: () => 42,
    };
    await jest.isolateModules(async () => {
      const rpc = require('../solana/rpc');
      await rpc.getGenesisHash('https://stub-freshness.test');
      await rpc.getBlockHeight('https://stub-freshness.test');
      await rpc.isBlockhashValid('https://stub-freshness.test', 'bh');
      await rpc.getSignatureStatusesForSig('https://stub-freshness.test', 'sig');
      await rpc.getFeeForMessage('https://stub-freshness.test', 'msg');
      expect(fetchCalls).toBe(0);
    });
  });
});


// ---------------------------------------------------------------------------------------------
// H4 — HTTP 429. Measured on a real first load (2026-09-08): the app issued 17 RPC POSTs in 10.4s,
// every one 429ed, and it re-sent the identical volley every 2.5s forever because nothing anywhere
// read the status code, honoured `Retry-After`, or backed off. The three Solana rows sat at '—'.
// These cases pin the gate that replaced that: a 429 becomes a typed, actionable refusal, and the
// endpoint is left alone for the interval it asked for.
//
// The gate's cooldown map is module state, so every case starts from a fresh module registry.
// (`jest.isolateModules` is NOT usable here: it does not await an async callback, so the body would
// run on after the test ended and afterEach had already restored real timers.)
// ---------------------------------------------------------------------------------------------
describe('solana rpc — 429 rate-limit gate', () => {
  const URL_A = 'https://rpc.example';
  beforeEach(() => { jest.resetModules(); });

  test('a 429 throws a rate-limit error, and the NEXT call never reaches the network', async () => {
    const {calls} = installRpcFetch([{ok: false, status: 429}, {value: 1}]);
    const {getBalance, SolanaRateLimited} = require('../solana/rpc');
    await expect(getBalance(URL_A, 'AddrXYZ')).rejects.toBeInstanceOf(SolanaRateLimited);
    expect(calls.length).toBe(1);
    // Inside the cooldown the client refuses locally — this is what stops the 2.5s poll from
    // re-sending the volley the limiter just refused.
    await expect(getBalance(URL_A, 'AddrXYZ')).rejects.toBeInstanceOf(SolanaRateLimited);
    expect(calls.length).toBe(1);
  });

  test('the error says what is happening and how long the wait is (every error path is actionable)', async () => {
    installRpcFetch([{ok: false, status: 429, headers: {'Retry-After': '7'}}]);
    const {getBalance} = require('../solana/rpc');
    const err = await getBalance(URL_A, 'AddrXYZ').catch((e: Error) => e);
    expect((err as unknown as {retryAfterMs: number}).retryAfterMs).toBe(7000); // the endpoint's own Retry-After
    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).toContain('7s');
  });

  test('the cooldown expires: exactly ONE probe goes out, and a success clears the gate', async () => {
    jest.useFakeTimers();
    const {calls} = installRpcFetch([{ok: false, status: 429, headers: {'Retry-After': '5'}}, {value: 42}, {value: 43}]);
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance(URL_A, 'A')).rejects.toThrow();
    expect(calls.length).toBe(1);
    jest.advanceTimersByTime(4999);
    await expect(getBalance(URL_A, 'A')).rejects.toThrow(); // still inside the window
    expect(calls.length).toBe(1);
    jest.advanceTimersByTime(2);
    expect(await getBalance(URL_A, 'A')).toBe('42');        // the probe
    expect(calls.length).toBe(2);
    expect(await getBalance(URL_A, 'A')).toBe('43');        // gate cleared by the success
    expect(calls.length).toBe(3);
  });

  test('repeated refusals back off exponentially to a CAP, instead of hammering at a fixed rate', async () => {
    jest.useFakeTimers();
    // No Retry-After header: the client picks the interval and doubles it on every refusal.
    installRpcFetch(Array.from({length: 12}, () => ({ok: false, status: 429})));
    const {getBalance, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS} = require('../solana/rpc');
    const waitOf = async (): Promise<number> => {
      const e = await getBalance(URL_A, 'A').catch((x: {retryAfterMs: number}) => x);
      return e.retryAfterMs;
    };
    const first = await waitOf();
    expect(first).toBe(RATE_LIMIT_BASE_MS);
    jest.advanceTimersByTime(first);
    expect(await waitOf()).toBe(RATE_LIMIT_BASE_MS * 2);
    jest.advanceTimersByTime(RATE_LIMIT_BASE_MS * 2);
    expect(await waitOf()).toBe(RATE_LIMIT_BASE_MS * 4);
    // …and it is bounded: a permanently-limited endpoint is probed at the cap, never faster and
    // never slower (an unbounded backoff would make the wallet look dead forever).
    for (let i = 0; i < 4; i++) { jest.advanceTimersByTime(RATE_LIMIT_MAX_MS); await waitOf(); }
    jest.advanceTimersByTime(RATE_LIMIT_MAX_MS);
    expect(await waitOf()).toBe(RATE_LIMIT_MAX_MS);
  });

  test('the gate is PER ENDPOINT — a limited URL never silences a different one', async () => {
    const {calls} = installRpcFetch([{ok: false, status: 429}, {value: 9}]);
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance(URL_A, 'A')).rejects.toThrow();
    expect(await getBalance('https://other.example', 'A')).toBe('9');
    expect(calls.length).toBe(2);
  });

  test('a non-429 HTTP error does NOT open a cooldown (only the limiter gets to mute us)', async () => {
    const {calls} = installRpcFetch([{ok: false, status: 500}, {value: 5}]);
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance(URL_A, 'A')).rejects.toThrow(/HTTP 500/);
    expect(await getBalance(URL_A, 'A')).toBe('5');
    expect(calls.length).toBe(2);
  });
});
