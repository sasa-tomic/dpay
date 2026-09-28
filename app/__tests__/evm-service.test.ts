/**
 * The EVM money-path services (app/evm/service.ts) over a mocked pipe — spec 2026-09-26
 * D15 (fee quote, THE GAS HONESTY GATE, sign → broadcast → receipt poll) and D10 (the
 * balances read, the receipt status). Every test runs against a FRESH module registry (the
 * wrong-chain verdict memo is module state, keyed by endpoint list) with the test override
 * URL pointing at a JSON-RPC router that records the exact request ORDER — the gate order is
 * the money-safety order, and the order is the assertion.
 *
 * The signed tx is decoded from the broadcast bytes with the rail's own RLP decoder, so the
 * assertion is over the BYTES the chain would see, not over internal builder calls.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {rlpDecode, minimalBeToInt, type RlpDecoded} from '../evm/rlp';
import {encodeTransfer, encodeBalanceOf} from '../evm/abi';
import {keccak256} from '../evm/keccak';
import {hexToBytes, bytesToHex} from '../lib/format';

const realFetch = globalThis.fetch;

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const TOKEN = '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const ANVIL_CHAIN = 31337;
const STUB = 'https://stub.test/api/v1/evm/rpc/31337';
const TX_HASH = '0x' + 'ab'.repeat(32);

type Service = typeof import('../evm/service');

/** A minimal Response double (a raw Http-shaped answer, for the non-JSON-RPC cases). */
function res(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => null},
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

type RouteEntry = unknown; // JSON-RPC result value, () => value, or a raw Response
type Route = Record<string, RouteEntry>;

interface Harness {
  service: Service;
  /** Every JSON-RPC request, in order. */
  calls: Array<{url: string; method: string}>;
  /** The LAST request body for a method (params included) — assertions read it. */
  bodyOf: (method: string) => {params: unknown[]};
}

/** Install the test override + a fresh service module + a recording router. */
function fresh(routes: Route): Harness {
  const calls: Array<{url: string; method: string}> = [];
  const bodies = new Map<string, string>();
  (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
    const u = String(url);
    const body = init?.body ?? '{}';
    const method = (JSON.parse(body) as {method?: string}).method ?? '?';
    calls.push({url: u, method});
    bodies.set(method, body);
    const entry = routes[method];
    if (entry === undefined) throw new Error(`unexpected method ${method} → ${u}`);
    if (entry instanceof Response) return entry;
    const params = (JSON.parse(body) as {params?: unknown[]}).params ?? [];
    const value = typeof entry === 'function' ? (entry as (p: unknown[]) => unknown)(params) : entry;
    return res(200, JSON.stringify({jsonrpc: '2.0', id: 1, result: value}));
  }) as typeof fetch;
  const g = globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string};
  g.__DPAY_TEST_EVM_RPC_URL = STUB;
  let service!: Service;
  jest.isolateModules(() => {
    service = require('../evm/service');
  });
  g.__DPAY_TEST_EVM_RPC_URL = '';
  return {
    service,
    calls,
    bodyOf: (method: string) => {
      const raw = bodies.get(method);
      if (raw === undefined) throw new Error(`no ${method} call recorded`);
      return JSON.parse(raw) as {params: unknown[]};
    },
  };
}

const DEFAULT_ROUTES: Route = {
  eth_chainId: '0x7a69',                                  // 31337 — the anvil chain
  eth_estimateGas: '0x5208',                              // 21000
  eth_gasPrice: '0x3b9aca00',                             // 1 gwei
  eth_maxPriorityFeePerGas: '0x1',                        // 1 wei
  eth_getBalance: '0x2386f26fc10000',                     // 0.01 ETH — comfortable gas
  eth_call: '0x64',                                       // balanceOf → 100 raw
  eth_getTransactionCount: '0x5',                         // nonce 5
  eth_sendRawTransaction: TX_HASH,
  eth_getTransactionReceipt: {status: '0x1', blockNumber: '0x64', transactionHash: TX_HASH},
};

const SEND = {chainId: ANVIL_CHAIN, tokenAddress: TOKEN, to: RECIPIENT, rawAmount: '2', decimals: 18};
const SEND_RAW = 2000000000000000000n;

/** The gate order: prove the chain, price it, gate the gas — every one BEFORE the next. */
const GATE_ORDER = ['eth_chainId', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBalance'];

function asArray(x: RlpDecoded): RlpDecoded[] {
  if (!Array.isArray(x)) throw new Error('expected an RLP list');
  return x;
}
function asBytes(x: RlpDecoded): Uint8Array {
  if (Array.isArray(x)) throw new Error('expected RLP bytes');
  return x;
}
function asInt(x: RlpDecoded): bigint {
  return minimalBeToInt(asBytes(x));
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  jest.useRealTimers();
});

describe('sendErc20 — the gate order and the bytes', () => {
  /** The honest node answer: the hash OF THE BYTES we sent (keccak of the raw tx). */
  const hashOfRaw = (params: unknown[]) => '0x' + bytesToHex(keccak256(hexToBytes((params as [string])[0])));

  test('happy path: gate order holds, signed type-2 tx carries exactly the typed inputs', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_sendRawTransaction: hashOfRaw});
    let broadcasted: string | null = null;
    const {txHash} = await h.service.sendErc20(SEED_HEX, SEND, undefined, (h2) => { broadcasted = h2; });
    const rawParam = (h.bodyOf('eth_sendRawTransaction').params as [string])[0];
    expect(txHash).toBe('0x' + bytesToHex(keccak256(hexToBytes(rawParam.slice(2))))); // the hash OF OUR bytes
    expect(broadcasted).toBe(txHash); // onBroadcast fired on ACCEPT, before the receipt

    const methods = h.calls.map((c) => c.method);
    const positions = GATE_ORDER.map((m) => methods.indexOf(m));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions); // strictly in order
    expect(methods.indexOf('eth_getTransactionCount')).toBeGreaterThan(methods.indexOf('eth_getBalance'));
    expect(methods).toContain('eth_sendRawTransaction');
    expect(methods[methods.length - 1]).toBe('eth_getTransactionReceipt');

    // The broadcast bytes: a type-2 (0x02 || RLP) tx with EXACTLY the typed inputs.
    expect(rawParam.startsWith('0x02')).toBe(true);
    const fields = asArray(rlpDecode(hexToBytes(rawParam.slice(4))));
    expect(fields.length).toBe(12); // 9 payload fields + yParity + r + s
    expect(asInt(fields[0])).toBe(BigInt(ANVIL_CHAIN));
    expect(asInt(fields[1])).toBe(5n);                              // nonce
    expect(asInt(fields[2])).toBe(1n);                              // priority
    expect(asInt(fields[3])).toBe(2000000001n);                     // maxFee = 2×1gwei + 1
    expect(asInt(fields[4])).toBe(25201n);                          // gasLimit = 21000 ×1.2 +1
    expect('0x' + bytesToHex(asBytes(fields[5]))).toBe(TOKEN.toLowerCase()); // to = the TOKEN contract (bytes ride lowercase)
    expect(asInt(fields[6])).toBe(0n);                              // value 0 (ERC-20 move)
    expect('0x' + bytesToHex(asBytes(fields[7]))).toBe('0x' + bytesToHex(encodeTransfer(RECIPIENT, SEND_RAW)));
    expect(fields[8]).toEqual([]);                                  // empty access list
  });

  test('THE GAS GATE: a wallet that cannot cover the max fee refuses BEFORE signing or broadcasting', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_getBalance: '0x1'}); // 1 wei of gas
    await expect(h.service.sendErc20(SEED_HEX, SEND)).rejects.toMatchObject({
      dpayEvmGasGate: true,
      chainId: ANVIL_CHAIN,
      nativeSymbol: 'ETH',
      requiredWei: String(2000000001n * 25201n),
      gasBalanceWei: '1',
    });
    const methods = h.calls.map((c) => c.method);
    expect(methods).not.toContain('eth_getTransactionCount'); // no nonce reserved
    expect(methods).not.toContain('eth_sendRawTransaction');  // nothing broadcast
    expect(methods).not.toContain('eth_getTransactionReceipt');
  });

  test('the wrong-chain guard fires BEFORE the fee probe and every spend-shaped request', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_chainId: '0x1'}); // a chain-1 node
    await expect(h.service.sendErc20(SEED_HEX, SEND)).rejects.toMatchObject({dpayEvmWrongChain: true});
    expect(h.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  test('a node echoing an unexpected hash is NOT a verdict: the receipt decides by our hash', async () => {
    const h = fresh(DEFAULT_ROUTES); // the router answers a canned hash ≠ our keccak
    const {txHash} = await h.service.sendErc20(SEED_HEX, SEND);
    const rawParam = (h.bodyOf('eth_sendRawTransaction').params as [string])[0];
    expect(txHash).toBe('0x' + bytesToHex(keccak256(hexToBytes(rawParam.slice(2))))); // OUR hash
    // The receipt poll still ran by OUR hash and settled 'included' — no false success, no
    // re-sign, no dropped send.
    expect(h.calls[h.calls.length - 1].method).toBe('eth_getTransactionReceipt');
  });

  test('the chain verdict is memoized per endpoint: the second send does not re-ask eth_chainId', async () => {
    const h = fresh(DEFAULT_ROUTES);
    await h.service.sendErc20(SEED_HEX, SEND);
    await h.service.sendErc20(SEED_HEX, SEND);
    expect(h.calls.filter((c) => c.method === 'eth_chainId').length).toBe(1);
  });

  test('a FAILED receipt is definitive: the send throws (no transfer happened)', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_getTransactionReceipt: {status: '0x0'}});
    await expect(h.service.sendErc20(SEED_HEX, SEND)).rejects.toThrow(/FAILED on-chain/);
  });

  test('a confirm timeout is the HONEST UNKNOWN: rejects naming the hash, never a false success', async () => {
    jest.useFakeTimers();
    const h = fresh({...DEFAULT_ROUTES, eth_getTransactionReceipt: null}); // never mined
    const p = h.service.sendErc20(SEED_HEX, SEND);
    const assertion = expect(p).rejects.toThrow(/no receipt for/);
    await jest.advanceTimersByTimeAsync(61_000);
    await assertion;
  });

  test('the caller signal bounds the whole flow: an aborted send rejects immediately', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_getTransactionReceipt: null});
    const ctrl = new AbortController();
    const p = h.service.sendErc20(SEED_HEX, SEND, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/);
  });
});

describe('quoteEvmFee — the chain\'s own arithmetic (D15.2)', () => {
  test('estimate + price + priority compose into an exact max fee', async () => {
    const h = fresh(DEFAULT_ROUTES);
    const q = await h.service.quoteEvmFee(ANVIL_CHAIN, '0x' + '22'.repeat(20), TOKEN, '0x' + bytesToHex(encodeBalanceOf('0x' + '22'.repeat(20))));
    expect(q.gasUnits).toBe('21000');
    expect(q.baseFeeWei).toBe('1000000000');
    expect(q.priorityFeeWei).toBe('1');
    expect(q.maxFeePerGasWei).toBe('2000000001');
    expect(q.maxFeeWei).toBe(String(2000000001n * 21000n));
    // The quote also runs the wrong-chain gate: it asked eth_chainId first.
    expect(h.calls[0].method).toBe('eth_chainId');
  });

  test('a node without eth_maxPriorityFeePerGas still quotes (priority 0, nothing invented)', async () => {
    const h = fresh({
      ...DEFAULT_ROUTES,
      eth_maxPriorityFeePerGas: res(200, JSON.stringify({jsonrpc: '2.0', id: 1, error: {message: 'method not found'}})),
    });
    const q = await h.service.quoteEvmFee(ANVIL_CHAIN, '0x' + '22'.repeat(20), TOKEN, '0x70a08231');
    expect(q.priorityFeeWei).toBe('0');
    expect(q.maxFeePerGasWei).toBe('2000000000');
  });
});

describe('readEvmBalances — one poll per visible row (D10/D16 read half)', () => {
  const KEYS = [{chainId: ANVIL_CHAIN, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18}];
  const wallet = require('../evm/identity') as typeof import('../evm/identity');

  test('gas leg + balanceOf in one poll, exact decimal strings', async () => {
    const h = fresh(DEFAULT_ROUTES);
    const read = await h.service.readEvmBalances(SEED_HEX, KEYS);
    expect(read.gas[ANVIL_CHAIN]).toEqual({kind: 'balance', wei: '10000000000000000'});
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'balance', amount: '100'});
    // balanceOf calldata went to the TOKEN address with the wallet as the argument.
    const params = h.bodyOf('eth_call').params as [{to: string; data: string}, string];
    expect(params[0].to).toBe(TOKEN);
    expect(params[0].data).toBe('0x' + bytesToHex(encodeBalanceOf(wallet.deriveEvmKeypair(SEED_HEX).address)));
    expect(params[1]).toBe('latest');
  });

  test('an unreadable balanceOf answer is unreadable — never a zero', async () => {
    const h = fresh({...DEFAULT_ROUTES, eth_call: '0xzz'});
    const read = await h.service.readEvmBalances(SEED_HEX, KEYS);
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'error', failure: 'unreadable'});
  });

  test('an offline rail is a per-key offline fact (no fetch, no throw)', async () => {
    let fetched = false;
    (globalThis as unknown as {fetch: unknown}).fetch = (async () => {
      fetched = true;
      throw new Error('no network');
    }) as typeof fetch;
    const g = globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string};
    g.__DPAY_TEST_EVM_RPC_URL = '';
    let service!: Service;
    jest.isolateModules(() => {
      service = require('../evm/service');
    });
    g.__DPAY_TEST_EVM_RPC_URL = '';
    const read = await service.readEvmBalances(SEED_HEX, KEYS);
    expect(read).toEqual({gas: {31337: {kind: 'offline'}}, tokens: {'31337:ZCHF': {kind: 'offline'}}});
    expect(fetched).toBe(false);
  });

  test('two chains poll in parallel and INDEPENDENTLY: one chain failing must not blank the other', async () => {
    // The RELAY-DERIVED routes (test override deleted) give each chain its own URL — the shape
    // production uses. Each URL proves (and answers for) its own chain.
    const r1 = 'https://dpay.kalaj.org/api/v1/evm/rpc/31337';
    const calls: Array<{url: string; method: string}> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
      const u = String(url);
      const method = (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?';
      calls.push({url: u, method});
      const chainHex = u.endsWith('/31337') ? '0x7a69' : '0xa4b1'; // 31337 | 42161
      const table: Record<string, string> = u === r1
        ? {eth_chainId: chainHex, eth_getBalance: '0x64', eth_call: '0x64'}
        : {eth_chainId: chainHex, eth_getBalance: '0x7b', eth_call: '0x7b'};
      const entry = table[method];
      if (entry === undefined) throw new Error(`unexpected ${method} → ${u}`);
      return res(200, JSON.stringify({jsonrpc: '2.0', id: 1, result: entry}));
    }) as typeof fetch;
    const g = globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string};
    delete g.__DPAY_TEST_EVM_RPC_URL; // the relay-derived path (the 'derive' driver state)
    let service!: Service;
    jest.isolateModules(() => {
      service = require('../evm/service');
    });
    g.__DPAY_TEST_EVM_RPC_URL = '';
    const read = await service.readEvmBalances(SEED_HEX, [
      {chainId: ANVIL_CHAIN, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18},
      {chainId: 42161, token: 'ZCHF', tokenAddress: TOKEN, decimals: 18},
    ]);
    expect(read.tokens['31337:ZCHF']).toEqual({kind: 'balance', amount: '100'});
    expect(read.tokens['42161:ZCHF']).toEqual({kind: 'balance', amount: '123'});
    expect(read.gas[ANVIL_CHAIN]).toEqual({kind: 'balance', wei: '100'});
    expect(read.gas[42161]).toEqual({kind: 'balance', wei: '123'});
  });
});

describe('getEvmReceiptStatus — the chain\'s verdict, verbatim', () => {
  test.each([
    [null, 'pending'],
    [{status: '0x1'}, 'included'],
    [{status: '0x0'}, 'failed'],
    [{}, 'unknown'],
  ])('%j → %s', async (receipt, expected) => {
    const h = fresh({...DEFAULT_ROUTES, eth_getTransactionReceipt: receipt});
    await expect(h.service.getEvmReceiptStatus(ANVIL_CHAIN, TX_HASH)).resolves.toBe(expected);
  });
});
