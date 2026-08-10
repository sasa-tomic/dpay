/**
 * Solana JSON-RPC client (`solana/rpc.ts`). Mocks global `fetch` (no real network) to assert the
 * JSON-RPC 2.0 request shape, response parsing, base64 tx encoding, error handling, the bounded-
 * timeout backstop, and the confirmation poll loop. Mirrors the relay.test.ts fetch-mock idiom.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

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
    return Promise.resolve({ok: httpOk, status, json: () => Promise.resolve(JSON.parse(payload))} as unknown as Response);
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

  test('getLatestBlockhash parses blockhash + lastValidBlockHeight', async () => {
    installRpcFetch([{value: {blockhash: 'BlockhashABC', lastValidBlockHeight: 123456}}]);
    const {getLatestBlockhash} = require('../solana/rpc');
    const bh = await getLatestBlockhash('https://rpc.example');
    expect(bh).toEqual({blockhash: 'BlockhashABC', lastValidBlockHeight: 123456});
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

  test('a non-2xx HTTP status throws', async () => {
    installRpcFetch([{ok: false, status: 429}]);
    const {getBalance} = require('../solana/rpc');
    await expect(getBalance('https://rpc.example', 'X')).rejects.toThrow('solana rpc http 429');
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

// bs58 v6 is CJS under jest (babel-jest): the default export lives under `.default`.
const _bs58Mod: unknown = require('bs58');
const bs58 = (_bs58Mod as {default?: {decode: (s: string) => Uint8Array; encode: (b: Uint8Array) => string}}).default ??
  (_bs58Mod as {decode: (s: string) => Uint8Array; encode: (b: Uint8Array) => string});

// Hand-rolled standard base64 (RFC 4648) — mirrors rpc.ts's private `bytesToBase64`. Test-side copy
// so the fixture builder does not depend on the impl's private helper.
function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : '=';
  }
  return out;
}

// Build an 80-byte NonceState account-data blob (the raw layout @solana/web3.js's
// NonceAccountLayout decodes): u32 version | u32 state | 32B authority | 32B nonce | u64 fee.
function buildNonceAccountData(authorityB58: string, nonceValueB58: string, lamportsPerSig = 5000): string {
  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0, true);  // version = 0
  dv.setUint32(4, 1, true);  // state = Initialized
  buf.set(bs58.decode(authorityB58), 8);
  buf.set(bs58.decode(nonceValueB58), 40);
  dv.setUint32(72, lamportsPerSig, true);  // low 4 bytes of u64 (5000 fits)
  dv.setUint32(76, 0, true);               // high 4 bytes
  return bytesToBase64(buf);
}

const AUTHORITY = '3jsvVphLjwR6wih9fQydrRNGieNjYzyMkyTxFueCssaK';
const NONCE_VALUE = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN';

describe('solana rpc — getNonceAccount', () => {
  test('parses an Initialized NonceState into {authority, value}', async () => {
    const data = buildNonceAccountData(AUTHORITY, NONCE_VALUE);
    installRpcFetch([{value: {data: [data, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}]);
    const {getNonceAccount} = require('../solana/rpc');
    const na = await getNonceAccount('https://rpc.example', 'NonceAcctAddr');
    expect(na).toEqual({authority: AUTHORITY, value: NONCE_VALUE});
  });

  test('throws on an Uninitialized nonce account (state=0)', async () => {
    const buf = new Uint8Array(80); // all zeros → version=0, state=0 (Uninitialized)
    installRpcFetch([{value: {data: [bytesToBase64(buf), 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}]);
    const {getNonceAccount} = require('../solana/rpc');
    await expect(getNonceAccount('https://rpc.example', 'NonceAcctAddr')).rejects.toThrow(/uninitialized|nonce/i);
  });

  test('throws on a null account (does not exist)', async () => {
    installRpcFetch([{value: null}]);
    const {getNonceAccount} = require('../solana/rpc');
    await expect(getNonceAccount('https://rpc.example', 'NonceAcctAddr')).rejects.toThrow(/not found|absent|exist/i);
  });

  test('throws on truncated/malformed account data', async () => {
    installRpcFetch([{value: {data: [bytesToBase64(new Uint8Array(40)), 'base64'], owner: '11111111111111111111111111111111', lamports: 1}}]);
    const {getNonceAccount} = require('../solana/rpc');
    await expect(getNonceAccount('https://rpc.example', 'NonceAcctAddr')).rejects.toThrow(/malformed|truncat|short|nonce/i);
  });

  test('requests getAccountInfo with base64 encoding', async () => {
    const {calls} = installRpcFetch([{value: {data: [buildNonceAccountData(AUTHORITY, NONCE_VALUE), 'base64']}}]);
    const {getNonceAccount} = require('../solana/rpc');
    await getNonceAccount('https://rpc.example', 'NonceAcctAddr');
    // `id` is a module-level counter advanced by every prior rpcFetch call across the suite, so
    // assert shape (not the exact id) — mirrors how the other request-shape asserts stay stable.
    expect(calls[0].body).toEqual(expect.objectContaining({
      jsonrpc: '2.0', method: 'getAccountInfo', params: ['NonceAcctAddr', {encoding: 'base64'}],
    }));
  });
});

describe('solana rpc — getMinimumBalanceForRentExemption', () => {
  test('returns the rent as a bigint', async () => {
    const {calls} = installRpcFetch([1447680]);
    const {getMinimumBalanceForRentExemption} = require('../solana/rpc');
    const rent = await getMinimumBalanceForRentExemption('https://rpc.example', 80);
    expect(rent).toBe(1447680n);
    expect(typeof rent).toBe('bigint');
    expect(calls[0].body).toEqual(expect.objectContaining({
      jsonrpc: '2.0', method: 'getMinimumBalanceForRentExemption', params: [80],
    }));
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
    await expect(accountExists('https://rpc.example', 'X')).rejects.toThrow('solana rpc http 500');
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

  test('getNonceAccount routes through the stub getAccountInfo and parses the result', async () => {
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
    const stub = {
      getAccountInfo: (_params: unknown[]) => ({value: {data: [buildNonceAccountData(AUTHORITY, NONCE_VALUE), 'base64']}}),
    };
    (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
    const {getNonceAccount} = require('../solana/rpc');
    const na = await getNonceAccount('https://rpc.example', 'NonceAcctAddr');
    expect(na).toEqual({authority: AUTHORITY, value: NONCE_VALUE});
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
