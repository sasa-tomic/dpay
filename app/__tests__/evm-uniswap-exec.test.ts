// The Uniswap executor (app/evm/uniswap.ts executeUniswapSequence) over a mocked pipe —
// the gate ORDER is the money-safety order and the order is the assertion (the
// evm-service.test.ts harness pattern):
//   1. eth_chainId (the wrong-chain gate) BEFORE any spend-shaped request;
//   2. fee probe (gasPrice + priority + one estimate per leg);
//   3. THE AGGREGATE GAS HONESTY GATE — the native balance must cover the WHOLE sequence's
//      worst case, checked ONCE before anything is signed (a balance covering leg 1 but not
//      leg 2 must refuse at the gate, never strand mid-sequence);
//   4. ONE nonce read, sequential nonces, every leg waits for its own receipt.
// The signed txs are decoded from the broadcast bytes with the rail's own RLP decoder.
import {describe, expect, it, jest, afterEach} from '@jest/globals';
import {rlpDecode, minimalBeToInt} from '../evm/rlp';
import {hexToBytes, bytesToHex} from '../lib/format';
import {EVM_AMM_CHAINS} from '../config/evmAmm';
import {planTokenToNative, type UniswapSwapPlan} from '../evm/uniswap';

const realFetch = globalThis.fetch;

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const ZCHF = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const CHAIN = EVM_AMM_CHAINS[1]!;
const STUB = 'https://stub.test/api/v1/evm/rpc';

interface Harness {
  execute: (typeof import('../evm/uniswap'))['executeUniswapSequence'];
  calls: Array<{url: string; method: string}>;
  bodyOf: (method: string, nth?: number) => {params: unknown[]} | undefined;
}

type RouteValue =
  | string // literal JSON-RPC result
  | object // literal JSON-RPC result object (a receipt)
  | (() => string | object) // computed per call
  | {errorAt: number; code: number; message: string}; // refuse the Nth call of this method

function resJson(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true, status: 200, headers: {get: () => null},
    text: async () => text, json: async () => body,
  } as unknown as Response;
}

function harness(routes: Record<string, RouteValue>): Harness {
  const calls: Array<{url: string; method: string}> = [];
  const bodies = new Map<string, string[]>();
  (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
    const body = init?.body ?? '{}';
    const parsed = JSON.parse(body) as {method?: string; id?: number};
    const method = parsed.method ?? '?';
    calls.push({url: String(url), method: method as string});
    const list = bodies.get(method) ?? [];
    list.push(body);
    bodies.set(method, list);
    const n = list.length - 1;
    const route = routes[method];
    if (route === undefined) {
      return resJson({jsonrpc: '2.0', id: parsed.id ?? 1, error: {code: -32000, message: `unrouted: ${method}`}});
    }
    if (typeof route === 'object' && 'errorAt' in route && route.errorAt === n) {
      return resJson({jsonrpc: '2.0', id: parsed.id ?? 1, error: {code: route.code, message: route.message}});
    }
    const value = typeof route === 'function' ? route() : route;
    return resJson({jsonrpc: '2.0', id: parsed.id ?? 1, result: value});
  }) as typeof fetch;
  return {
    calls,
    bodyOf: (method: string, nth = 0) => {
      const raw = bodies.get(method)?.[nth];
      return raw != null ? JSON.parse(raw) as {params: unknown[]} : undefined;
    },
    // Loaded lazily so the route table is installed before the module registry wakes.
    execute: null,
  } as unknown as Harness;
}

const ETH_BAL = '0x56bc75e2d63100000'; // 100 ETH
const BASE_FEE = '0x77359400'; // 2 gwei
const PRIORITY = '0x0';

function happyRoutes(nonceHex = '0x7'): Record<string, RouteValue> {
  return {
    eth_chainId: '0x1',
    eth_gasPrice: BASE_FEE,
    eth_maxPriorityFeePerGas: PRIORITY,
    eth_estimateGas: () => `0x${(50_000 + Math.floor(Math.random() * 1000)).toString(16)}`,
    eth_getBalance: ETH_BAL,
    eth_getTransactionCount: nonceHex,
    eth_sendRawTransaction: () => `0x${'ab'.repeat(32)}`,
    eth_getTransactionReceipt: {status: '0x1'},
  };
}

describe('executeUniswapSequence — gate order', () => {
  afterEach(() => { (globalThis as unknown as {fetch: unknown}).fetch = realFetch; });

  async function load(routes: Record<string, RouteValue>): Promise<Harness> {
    jest.resetModules();
    (globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string}).__DPAY_TEST_EVM_RPC_URL = STUB;
    const h = harness(routes);
    h.execute = (await import('../evm/uniswap')).executeUniswapSequence;
    return h;
  }

  const planFor = (): UniswapSwapPlan => planTokenToNative({
    chain: CHAIN, tokenIn: ZCHF, amountIn: 10n ** 17n, minOut: 10n ** 14n, feeTier: 3000, deadlineSecs: 9n ** 9n,
  });

  it('proves the chain BEFORE any spend-shaped request', async () => {
    const h = await load(happyRoutes());
    await h.execute(SEED_HEX, {chainId: 1, plan: planFor(), minOut: 10n ** 14n, deadlineSecs: 9n ** 9n});
    expect(h.calls[0]!.method).toBe('eth_chainId');
    const spendIdx = h.calls.findIndex(c => c.method === 'eth_sendRawTransaction');
    expect(h.calls.slice(0, spendIdx).map(c => c.method)).toContain('eth_chainId');
  });

  it('refuses at the gate when the native balance covers leg 1 but not the WHOLE sequence', async () => {
    // Legs estimate ~50k each with headroom → ~2 × 60k × maxFee. 0.001 ETH covers neither.
    const h = await load({...happyRoutes(), eth_getBalance: '0xe8d4a51000'}); // 0.001 ETH
    await expect(h.execute(SEED_HEX, {chainId: 1, plan: planFor(), minOut: 10n ** 14n, deadlineSecs: 9n ** 9n}))
      .rejects.toMatchObject({name: 'EvmGasGateError'});
    expect(h.calls.map(c => c.method)).not.toContain('eth_sendRawTransaction');
    // The gate's requiredWei is the aggregate (both legs), not leg 1's alone.
    const balIdx = h.calls.findIndex(c => c.method === 'eth_getBalance');
    expect(h.calls.slice(0, balIdx + 1).filter(c => c.method === 'eth_estimateGas').length).toBe(2);
  });

  it('signs sequential nonces and waits for each receipt before the next leg', async () => {
    let sends = 0;
    const routes = happyRoutes();
    routes.eth_sendRawTransaction = () => {
      sends += 1;
      return `0x${sends.toString(16).padStart(2, '0')}${'ab'.repeat(31)}`;
    };
    routes.eth_getTransactionReceipt = {status: '0x1'};
    const h = await load(routes);
    const {steps} = await h.execute(SEED_HEX, {chainId: 1, plan: planFor(), minOut: 10n ** 14n, deadlineSecs: 9n ** 9n});
    expect(steps.map(s => s.label)).toEqual(['approve', 'swap']);
    // ONE nonce read, two sequential nonces.
    expect(h.calls.filter(c => c.method === 'eth_getTransactionCount').length).toBe(1);
    const n0 = h.bodyOf('eth_sendRawTransaction', 0)!.params[0] as string;
    const n1 = h.bodyOf('eth_sendRawTransaction', 1)!.params[0] as string;
    // Type-2 envelope: 0x02 || RLP([chainId, nonce, priority, maxFee, gas, to, value, data, [], yParity, r, s])
    const dec = (rawHex: string): {nonce: bigint; to: string; data: string} => {
      const f = rlpDecode(hexToBytes(rawHex.slice(4))) as unknown as Uint8Array[];
      return {
        nonce: minimalBeToInt(f[1] as unknown as Uint8Array),
        to: f[5] && (f[5] as unknown as Uint8Array).length > 0 ? '0x' + bytesToHex(f[5] as unknown as Uint8Array) : '0x',
        data: '0x' + bytesToHex(f[7] as unknown as Uint8Array),
      };
    };
    const t0 = dec(n0);
    const t1 = dec(n1);
    expect(t1.nonce).toBe(t0.nonce + 1n);
    // Leg 1 approves the ROUTER on the token; leg 2 multicalls the ROUTER with the
    // signer's own address filled into the recipient slot.
    expect(t0.to).toBe(ZCHF.toLowerCase());
    expect(t1.to).toBe(ROUTER.toLowerCase());
    // The recipient placeholder was REPLACED: no 0xee...ee word survives.
    expect(t1.data.includes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toBe(false);
    // Receipts were polled between broadcasts (2 receipts before the 2nd send).
    const recIdx = h.calls.map(c => c.method).lastIndexOf('eth_getTransactionReceipt');
    const send1Idx = h.calls.map(c => c.method).lastIndexOf('eth_sendRawTransaction');
    expect(recIdx).toBeGreaterThan(send1Idx);
  });

  it('stops dead on a reverted leg (no blind retry, later legs never signed)', async () => {
    const routes = happyRoutes();
    routes.eth_getTransactionReceipt = {status: '0x0'};
    const h = await load(routes);
    await expect(h.execute(SEED_HEX, {chainId: 1, plan: planFor(), minOut: 10n ** 14n, deadlineSecs: 9n ** 9n}))
      .rejects.toThrow(/reverted on-chain/);
    expect(h.calls.filter(c => c.method === 'eth_sendRawTransaction').length).toBe(1);
  });

  it('does not sign when the chain verdict names another chain', async () => {
    const h = await load({...happyRoutes(), eth_chainId: '0xa'});
    await expect(h.execute(SEED_HEX, {chainId: 1, plan: planFor(), minOut: 10n ** 14n, deadlineSecs: 9n ** 9n}))
      .rejects.toMatchObject({name: 'EvmWrongChainError'});
    expect(h.calls.map(c => c.method)).not.toContain('eth_sendRawTransaction');
  });
});
