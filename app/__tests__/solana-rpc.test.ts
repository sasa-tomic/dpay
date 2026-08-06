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
