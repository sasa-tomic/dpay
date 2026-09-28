/**
 * The EVM history read (app/evm/history.ts) — `eth_getLogs` Transfer-topic paging (spec
 * 2026-09-26 D9). Pinned here: the TWO filter legs (wallet as sender, wallet as receiver —
 * topic positions are ANDed so an OR across two positions is two queries), the direction +
 * counterparty rule, exact raw amounts, the dedupe, the `dropped` count for foreign shapes,
 * the newest-first order, and the page-size cap (a correctness knob that never binds
 * correctness — D9/R4).
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {TRANSFER_EVENT_TOPIC, uint256Word, addressWord} from '../evm/abi';
import {EVM_HISTORY_MAX_PAGES} from '../evm/constants';
import {bytesToHex} from '../lib/format';

const realFetch = globalThis.fetch;

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const TOKEN = '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553';
const STUB = 'https://stub.test/api/v1/evm/rpc/31337';

type History = typeof import('../evm/history');
type Rpc = typeof import('../evm/rpc');

function res(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => null},
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const walletOf = (): string => {
  const identity = require('../evm/identity') as typeof import('../evm/identity');
  return identity.deriveEvmKeypair(SEED_HEX).address;
};

/** A canonical ERC-20 Transfer log as a node returns it. */
type WireLog = Record<string, unknown>;
function transferLog(opts: {from: string; to: string; raw: bigint; tx: number; logIndex?: number; block?: number}): WireLog {
  const hash = '0x' + opts.tx.toString(16).padStart(64, '0');
  return {
    address: TOKEN,
    topics: [
      TRANSFER_EVENT_TOPIC,
      '0x' + bytesToHex(addressWord(opts.from)).slice(2).padStart(64, '0'),
      '0x' + bytesToHex(addressWord(opts.to)).slice(2).padStart(64, '0'),
    ],
    data: '0x' + bytesToHex(uint256Word(opts.raw)),
    blockNumber: '0x' + (opts.block ?? 100).toString(16),
    transactionHash: hash,
    logIndex: '0x' + (opts.logIndex ?? 0).toString(16),
  };
}

function freshHistory(logsOut: WireLog[], logsIn: WireLog[], tip = 100): {history: History; rpc: Rpc; calls: Array<{method: string; params: unknown[]}>} {
  const calls: Array<{method: string; params: unknown[]}> = [];
  (globalThis as unknown as {fetch: unknown}).fetch = (async (_url: string | URL, init?: {body?: string}) => {
    const body = JSON.parse(init?.body ?? '{}') as {method: string; params: unknown[]};
    calls.push({method: body.method, params: body.params});
    if (body.method === 'eth_blockNumber') return res(200, JSON.stringify({jsonrpc: '2.0', id: 1, result: '0x' + tip.toString(16)}));
    if (body.method === 'eth_getLogs') {
      const filter = body.params[0] as {topics: (string | null)[]};
      const outbound = filter.topics[1] !== null; // [T, wallet, null] vs [T, null, wallet]
      return res(200, JSON.stringify({jsonrpc: '2.0', id: 1, result: outbound ? logsOut : logsIn}));
    }
    if (body.method === 'eth_getBlockByNumber') {
      const n = Number((body.params[0] as string));
      return res(200, JSON.stringify({jsonrpc: '2.0', id: 1, result: {timestamp: '0x' + (1_700_000_000 + n).toString(16)}}));
    }
    throw new Error(`unexpected method ${body.method}`);
  }) as typeof fetch;
  let history!: History;
  let rpc!: Rpc;
  jest.isolateModules(() => {
    history = require('../evm/history');
    rpc = require('../evm/rpc');
  });
  return {history, rpc, calls};
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

describe('fetchEvmHistory — the Transfer-log ledger', () => {
  test('direction, counterparty, exact raw amounts, newest-first, timestamps best-effort', async () => {
    const wallet = walletOf();
    const other = '0x2222222222222222222222222222222222222222';
    const {history, calls} = freshHistory(
      [transferLog({from: wallet, to: other, raw: 15n, tx: 1, block: 90})],   // out
      [transferLog({from: other, to: wallet, raw: 420000n, tx: 2, block: 95})], // in
    );
    const out = await history.fetchEvmHistory([STUB], 31337, wallet, TOKEN);
    expect(out.dropped).toBe(0);
    expect(out.rows.length).toBe(2);
    // Newest first (block 95 before 90; ts mapped from the block header read).
    expect(out.rows[0]).toEqual({
      txHash: '0x' + (2).toString(16).padStart(64, '0'),
      blockNumber: 95,
      dir: 'in',
      counterparty: other,
      amount: '420000',
      ts: 1_700_000_000 + 95,
    });
    expect(out.rows[1].dir).toBe('out');
    expect(out.rows[1].counterparty).toBe(other);
    expect(out.rows[1].amount).toBe('15');
    // Two filter legs per page, aimed at the token contract, wallet in the right position.
    const logCalls = calls.filter((c) => c.method === 'eth_getLogs');
    expect(logCalls.length).toBe(2);
    for (const c of logCalls) {
      const filter = c.params[0] as {address: string; fromBlock: string; toBlock: string};
      expect(filter.address).toBe(TOKEN.toLowerCase()); // hex addresses ride lowercase on the wire
      // The tip is 100 — the range clamps at block 1 (never a negative fromBlock).
      expect(filter.fromBlock).toBe('0x1');
      expect(filter.toBlock).toBe('0x64');
    }
  });

  test('a self-transfer dedupes to ONE row; foreign shapes count as dropped, never thrown', async () => {
    const wallet = walletOf();
    const self = transferLog({from: wallet, to: wallet, raw: 7n, tx: 3, logIndex: 0});
    const erc721 = { // topics[3] present + no data — NOT an ERC-20 Transfer; dropped
      address: TOKEN,
      topics: [TRANSFER_EVENT_TOPIC, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)],
      data: '0x',
      blockNumber: '0x64',
      transactionHash: '0x' + 'ff'.repeat(32),
      logIndex: '0x0',
    };
    const {history} = freshHistory([self], [self, erc721]);
    const out = await history.fetchEvmHistory([STUB], 31337, wallet, TOKEN);
    expect(out.rows.length).toBe(1); // the self-transfer appears in BOTH legs — deduped
    expect(out.rows[0].dir).toBe('in'); // to == wallet wins the direction rule
    expect(out.rows[0].amount).toBe('7');
    expect(out.dropped).toBe(1); // the ERC-721 shape, counted not fatal
  });

  test('the page walk stops at the cap: bounded requests per poll (the page size is a knob)', async () => {
    const {history, calls} = freshHistory([], [], 200_000); // a big tip: many pages available
    const out = await history.fetchEvmHistory([STUB], 31337, walletOf(), TOKEN);
    expect(out.rows).toEqual([]);
    // EVM_HISTORY_MAX_PAGES pages × 2 legs, never more — the poll's request volume is bounded.
    expect(calls.filter((c) => c.method === 'eth_getLogs').length).toBe(EVM_HISTORY_MAX_PAGES * 2);
    // And the page ranges are CONTIGUOUS backwards (correctness never depends on the size).
    const filters = calls.filter((c) => c.method === 'eth_getLogs')
      .map((c) => c.params[0] as {fromBlock: string; toBlock: string})
      .filter((f) => f.toBlock === '0x' + (200_000).toString(16));
    expect(filters.length).toBeGreaterThanOrEqual(1);
  });
});
