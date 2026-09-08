/**
 * SOL rail transaction history (`solana/history.ts`) — the balance-delta reader that turns a
 * Solana account's recent signatures into ledger rows for SOL and USDC.
 *
 * Driven entirely through the `__DPAY_TEST_SOLANA_RPC_STUB` seam (the idiom solana-seam.test.ts
 * uses) with realistic `getSignaturesForAddress` / `getTransaction` bodies — plus one fetch-mocked
 * case (the solana-rpc.test.ts idiom) that pins the exact JSON-RPC request shape. No real network.
 *
 * The assertions are about MONEY: exact direction, exact raw amount, which rows exist at all, and
 * that an unreadable transaction is logged and counted rather than rendered as a plausible payment.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import bs58 from 'bs58';
import {deriveSolanaKeypair} from '../solana/identity';
import {deriveAta, USDC_MINT_ADDRESS, USDC_DECIMALS, TOKEN_PROGRAM_ADDRESS} from '../solana/spl';
import {SYSTEM_PROGRAM_ADDRESS} from '../solana/constants';
import type {SolanaRpcStub} from '../solana/rpc';
import {fetchSolanaHistory, resetSolanaHistoryCache, SOL_HISTORY_LIMIT} from '../solana/history';

const realFetch = globalThis.fetch;

const OWNER = deriveSolanaKeypair('4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6').address;
const PEER = deriveSolanaKeypair('aa'.repeat(32)).address;
const OTHER = deriveSolanaKeypair('bb'.repeat(32)).address;
const OWNER_ATA = bs58.encode(deriveAta(OWNER, USDC_MINT_ADDRESS));
const PEER_ATA = bs58.encode(deriveAta(PEER, USDC_MINT_ADDRESS));

const RPC = 'https://rpc.example';
const BLOCK_TIME = 1_756_000_000;
const FEE = 5_000;
const ATA_RENT = 2_039_280;

type SigEntry = {signature: string; slot: number; blockTime: number | null};
type TxSource = unknown | (() => unknown);

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Transaction details are cached by signature across calls (history.ts) — clear it so one
  // case's bodies can never answer the next case's fetch.
  resetSolanaHistoryCache();
});

afterEach(() => {
  warn.mockRestore();
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
});

/** Route both history RPC methods to in-memory tables keyed by address / signature. A transaction
 *  entry may be a thunk so a test can make one detail fetch throw. */
function installStub(signatures: Record<string, SigEntry[]>, transactions: Record<string, TxSource> = {}) {
  const calls: {method: string; params: unknown[]}[] = [];
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
    getSignaturesForAddress: (params: unknown[]) => {
      calls.push({method: 'getSignaturesForAddress', params});
      return signatures[params[0] as string] ?? [];
    },
    getTransaction: (params: unknown[]) => {
      calls.push({method: 'getTransaction', params});
      const entry = transactions[params[0] as string];
      if (entry === undefined) return null;
      return typeof entry === 'function' ? (entry as () => unknown)() : entry;
    },
  };
  (globalThis as unknown as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };
  return {calls};
}

const sig = (signature: string, slot: number, blockTime: number | null = BLOCK_TIME): SigEntry =>
  ({signature, slot, blockTime});

/** A USDC pre/post token-balance entry as the RPC emits it. */
const tokenBalance = (accountIndex: number, owner: string | undefined, amount: string, decimals = USDC_DECIMALS) => ({
  accountIndex,
  mint: USDC_MINT_ADDRESS,
  ...(owner === undefined ? {} : {owner}),
  uiTokenAmount: {amount, decimals, uiAmountString: amount},
});

function tx(opts: {
  keys: string[];
  pre: number[];
  post: number[];
  fee?: number;
  err?: unknown;
  slot?: number;
  blockTime?: number | null;
  preTokenBalances?: unknown[];
  postTokenBalances?: unknown[];
  loadedAddresses?: {writable: string[]; readonly: string[]};
}) {
  return {
    slot: opts.slot ?? 100,
    blockTime: opts.blockTime === undefined ? BLOCK_TIME : opts.blockTime,
    meta: {
      err: opts.err ?? null,
      fee: opts.fee ?? FEE,
      preBalances: opts.pre,
      postBalances: opts.post,
      preTokenBalances: opts.preTokenBalances ?? [],
      postTokenBalances: opts.postTokenBalances ?? [],
      ...(opts.loadedAddresses ? {loadedAddresses: opts.loadedAddresses} : {}),
    },
    transaction: {message: {accountKeys: opts.keys}},
  };
}

describe('solana history — native SOL', () => {
  test('an outgoing transfer reports the NET delta (transfer + fee) with the fee broken out', async () => {
    // 1.0 SOL → 0.899995 SOL: 0.1 SOL to PEER plus the 5000-lamport fee we paid as account index 0.
    installStub(
      {[OWNER]: [sig('SigOut', 100)]},
      {SigOut: tx({keys: [OWNER, PEER, SYSTEM_PROGRAM_ADDRESS], pre: [1_000_000_000, 0, 1], post: [899_995_000, 100_000_000, 1]})},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(dropped).toBe(0);
    expect(rows).toEqual([{
      signature: 'SigOut',
      slot: 100,
      blockTime: BLOCK_TIME,
      token: 'SOL',
      direction: 'out',
      amount: '100005000', // 100_000_000 transferred + 5_000 fee — what actually left the wallet
      feeLamports: '5000',
      counterparty: PEER,
      ok: true,
    }]);
  });

  test('an incoming transfer is "in" for the exact credited amount and charges us no fee', async () => {
    installStub(
      {[OWNER]: [sig('SigIn', 101)]},
      {SigIn: tx({keys: [PEER, OWNER, SYSTEM_PROGRAM_ADDRESS], pre: [500_000_000, 0, 1], post: [249_995_000, 250_000_000, 1], slot: 101})},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: 'SOL', direction: 'in', amount: '250000000', feeLamports: '0', counterparty: PEER, ok: true,
    });
  });

  test('a failed transaction is kept, marked ok:false, and shows only the fee it really cost', async () => {
    // The chain rolls a failed transaction back except the fee, so the delta IS the fee. Rendering
    // the attempted transfer here would be a lie about money that never moved.
    installStub(
      {[OWNER]: [sig('SigFail', 102)]},
      {SigFail: tx({
        keys: [OWNER, PEER, SYSTEM_PROGRAM_ADDRESS],
        pre: [1_000_000_000, 0, 1],
        post: [999_995_000, 0, 1],
        err: {InstructionError: [1, {Custom: 1}]},
      })},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: 'SOL', direction: 'out', amount: '5000', feeLamports: '5000', ok: false, counterparty: null,
    });
  });

  test('blockTime null rides through as null — never substituted with a plausible time', async () => {
    installStub(
      {[OWNER]: [sig('SigNoTime', 103, null)]},
      {SigNoTime: tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [899_995_000, 100_000_000], blockTime: null})},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows[0].blockTime).toBeNull();
    expect(rows[0].slot).toBe(103); // ordering still works: slot is always present
  });

  test('a counterparty is null when more than one account moved the opposite way', async () => {
    // A batch paying two recipients: naming one of them would be inventing a payee.
    installStub(
      {[OWNER]: [sig('SigBatch', 104)]},
      {SigBatch: tx({
        keys: [OWNER, PEER, OTHER],
        pre: [1_000_000_000, 0, 0],
        post: [899_995_000, 50_000_000, 50_000_000],
      })},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows[0]).toMatchObject({direction: 'out', amount: '100005000', counterparty: null});
  });

  test('a versioned (v0) transaction resolves the owner through loadedAddresses', async () => {
    // Balances are indexed over static keys ++ loadedAddresses.writable ++ .readonly; the owner is
    // only reachable through the lookup table here.
    installStub(
      {[OWNER]: [sig('SigV0', 105)]},
      {SigV0: tx({
        keys: [PEER, SYSTEM_PROGRAM_ADDRESS],
        loadedAddresses: {writable: [OWNER], readonly: []},
        pre: [500_000_000, 1, 0],
        post: [449_995_000, 1, 50_000_000],
      })},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({direction: 'in', amount: '50000000', feeLamports: '0', counterparty: PEER});
  });
});

describe('solana history — USDC (SPL)', () => {
  test('an outgoing USDC transfer is ONE row; its SOL fee is folded in, not listed twice', async () => {
    installStub(
      {[OWNER]: [sig('SigUsdcOut', 200)], [OWNER_ATA]: [sig('SigUsdcOut', 200)]},
      {SigUsdcOut: tx({
        keys: [OWNER, OWNER_ATA, PEER_ATA, USDC_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        pre: [1_000_000_000, ATA_RENT, ATA_RENT, 1, 1],
        post: [999_995_000, ATA_RENT, ATA_RENT, 1, 1],
        preTokenBalances: [tokenBalance(1, OWNER, '5000000'), tokenBalance(2, PEER, '1000000')],
        postTokenBalances: [tokenBalance(1, OWNER, '2500000'), tokenBalance(2, PEER, '3500000')],
        slot: 200,
      })},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([{
      signature: 'SigUsdcOut',
      slot: 200,
      blockTime: BLOCK_TIME,
      token: 'USDC',
      direction: 'out',
      amount: '2500000', // 2.5 USDC at 6 decimals
      feeLamports: '5000',
      counterparty: PEER, // the OWNER wallet behind the destination token account, not the ATA
      ok: true,
    }]);
  });

  test('an incoming USDC transfer is found via the ATA query alone (the wallet is not an account key)', async () => {
    installStub(
      {[OWNER_ATA]: [sig('SigUsdcIn', 201)]},
      {SigUsdcIn: tx({
        keys: [PEER, PEER_ATA, OWNER_ATA, USDC_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        pre: [1_000_000_000, ATA_RENT, ATA_RENT, 1, 1],
        post: [999_995_000, ATA_RENT, ATA_RENT, 1, 1],
        preTokenBalances: [tokenBalance(1, PEER, '10000000'), tokenBalance(2, OWNER, '0')],
        postTokenBalances: [tokenBalance(1, PEER, '7000000'), tokenBalance(2, OWNER, '3000000')],
        slot: 201,
      })},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: 'USDC', direction: 'in', amount: '3000000', feeLamports: '0', counterparty: PEER, ok: true,
    });
  });

  test('SOL spent beyond the fee (recipient account rent) still gets its own row', async () => {
    installStub(
      {[OWNER]: [sig('SigUsdcRent', 202)]},
      {SigUsdcRent: tx({
        keys: [OWNER, OWNER_ATA, PEER_ATA, USDC_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        pre: [1_000_000_000, ATA_RENT, 0, 1, 1],
        post: [1_000_000_000 - FEE - ATA_RENT, ATA_RENT, ATA_RENT, 1, 1],
        preTokenBalances: [tokenBalance(1, OWNER, '5000000')],
        postTokenBalances: [tokenBalance(1, OWNER, '2500000'), tokenBalance(2, PEER, '2500000')],
        slot: 202,
      })},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({token: 'USDC', direction: 'out', amount: '2500000', counterparty: PEER});
    // The SOL leg's counterparty is the account the lamports actually funded — the recipient's
    // token account. Reporting the wallet there would be a nicer-looking claim than the truth.
    expect(rows[1]).toMatchObject({
      token: 'SOL', direction: 'out', amount: String(FEE + ATA_RENT), feeLamports: '5000', counterparty: PEER_ATA,
    });
  });

  test('a USDC balance whose ownership is unstated drops the transaction (never a guessed delta)', async () => {
    installStub(
      {[OWNER_ATA]: [sig('SigNoOwner', 203)]},
      {SigNoOwner: tx({
        keys: [PEER, PEER_ATA, OWNER_ATA, USDC_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        pre: [1_000_000_000, ATA_RENT, ATA_RENT, 1, 1],
        post: [999_995_000, ATA_RENT, ATA_RENT, 1, 1],
        preTokenBalances: [tokenBalance(2, undefined, '0')],
        postTokenBalances: [tokenBalance(2, undefined, '3000000')],
      })},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][0])).toContain('SigNoOwner');
    expect(String(warn.mock.calls[0][1])).toMatch(/states no owner/);
  });

  test('a USDC balance claiming the wrong decimals drops the transaction (a 1000x wrong amount)', async () => {
    installStub(
      {[OWNER_ATA]: [sig('SigBadDecimals', 204)]},
      {SigBadDecimals: tx({
        keys: [PEER, PEER_ATA, OWNER_ATA, USDC_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        pre: [1_000_000_000, ATA_RENT, ATA_RENT, 1, 1],
        post: [999_995_000, ATA_RENT, ATA_RENT, 1, 1],
        preTokenBalances: [tokenBalance(2, OWNER, '0', 9)],
        postTokenBalances: [tokenBalance(2, OWNER, '3000000', 9)],
      })},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/decimals/);
  });
});

describe('solana history — ordering, bounds and RPC shape', () => {
  test('both pages are unioned, deduped by signature and ordered newest-first by slot', async () => {
    const {calls} = installStub(
      {
        [OWNER]: [sig('SigNew', 30), sig('SigShared', 20)],
        [OWNER_ATA]: [sig('SigShared', 20), sig('SigOld', 10)],
      },
      {
        SigNew: tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [999_995_000, 0], slot: 30}),
        SigShared: tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [899_995_000, 100_000_000], slot: 20}),
        SigOld: tx({keys: [PEER, OWNER], pre: [1_000_000_000, 0], post: [899_995_000, 100_000_000], slot: 10}),
      },
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows.map(r => r.signature)).toEqual(['SigNew', 'SigShared', 'SigOld']);
    // The shared signature is fetched ONCE — dedup happens before the detail fan-out.
    expect(calls.filter(c => c.method === 'getTransaction')).toHaveLength(3);
  });

  test('limit bounds both the signature pages and the number of detail fetches', async () => {
    const {calls} = installStub(
      {[OWNER]: [sig('SigA', 30), sig('SigB', 20)], [OWNER_ATA]: [sig('SigC', 10)]},
      {SigA: tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [999_995_000, 0], slot: 30})},
    );
    const {rows} = await fetchSolanaHistory(RPC, OWNER, {limit: 1});
    expect(rows.map(r => r.signature)).toEqual(['SigA']);
    expect(calls.filter(c => c.method === 'getTransaction')).toHaveLength(1);
    for (const c of calls.filter(c => c.method === 'getSignaturesForAddress')) {
      expect(c.params[1]).toMatchObject({limit: 1});
    }
  });

  test('an empty signature list yields no rows, no drops and no detail fetches', async () => {
    const {calls} = installStub({});
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(0);
    expect(calls.every(c => c.method === 'getSignaturesForAddress')).toBe(true);
    expect(calls).toHaveLength(2); // the wallet and its USDC ATA — nothing else
  });

  test('the JSON-RPC requests query the wallet AND its derived USDC ATA with the exact params', async () => {
    const bodies: {method: string; params: unknown[]}[] = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (_url: string, init?: {body?: string}) => {
      const body = JSON.parse(String(init?.body)) as {method: string; params: unknown[]};
      bodies.push(body);
      const result = body.method === 'getSignaturesForAddress'
        ? (body.params[0] === OWNER ? [sig('SigShape', 300)] : [])
        : tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [999_995_000, 0], slot: 300});
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({jsonrpc: '2.0', id: 1, result})});
    };
    const {rows} = await fetchSolanaHistory(RPC, OWNER, {limit: 7});
    expect(rows).toHaveLength(1);
    expect(bodies.filter(b => b.method === 'getSignaturesForAddress').map(b => b.params)).toEqual([
      [OWNER, {limit: 7, commitment: 'confirmed'}],
      [OWNER_ATA, {limit: 7, commitment: 'confirmed'}],
    ]);
    // maxSupportedTransactionVersion is REQUIRED — without it the RPC errors on every v0 transaction.
    expect(bodies.find(b => b.method === 'getTransaction')?.params).toEqual([
      'SigShape', {encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0},
    ]);
  });

  test('SOL_HISTORY_LIMIT (20) is the default page size', async () => {
    const {calls} = installStub({});
    await fetchSolanaHistory(RPC, OWNER);
    expect(SOL_HISTORY_LIMIT).toBe(20);
    expect(calls[0].params[1]).toMatchObject({limit: SOL_HISTORY_LIMIT});
  });
});

describe('solana history — failure paths are loud, and never become rows', () => {
  test('a failing signature query REJECTS (an unreadable list is an error, not an empty ledger)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => { throw new Error('rpc unreachable'); },
    };
    await expect(fetchSolanaHistory(RPC, OWNER)).rejects.toThrow('rpc unreachable');
  });

  test('a failing detail fetch is logged with its signature and counted as dropped', async () => {
    installStub(
      {[OWNER]: [sig('SigBoom', 400)]},
      {SigBoom: () => { throw new Error('rpc http 500'); }},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][0])).toContain('SigBoom');
  });

  test('a signature the node has no detail for is logged and dropped, not silently skipped', async () => {
    installStub({[OWNER]: [sig('SigPruned', 401)]}, {}); // getTransaction → null
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/SigPruned.*(pruned|unknown)/);
  });

  test('a transaction whose account list and balance arrays disagree is dropped, not attributed', async () => {
    installStub(
      {[OWNER]: [sig('SigMismatch', 402)]},
      {SigMismatch: tx({keys: [OWNER, PEER, SYSTEM_PROGRAM_ADDRESS], pre: [1_000_000_000, 0], post: [999_995_000, 0]})},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/length mismatch/);
  });

  test('a lamport balance too large to be exact in JSON is refused, not rounded into a row', async () => {
    // 2^53 lamports has already lost precision by the time JSON.parse returns it; a delta computed
    // from it would be quietly wrong.
    installStub(
      {[OWNER]: [sig('SigUnsafe', 403)]},
      {SigUnsafe: tx({keys: [OWNER, PEER], pre: [Number.MAX_SAFE_INTEGER + 2, 0], post: [1, 0]})},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/safe lamport integer/);
  });

  test('a non-object getTransaction result throws in the RPC layer and is dropped here', async () => {
    installStub({[OWNER]: [sig('SigJunk', 404)]}, {SigJunk: 42});
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/non-object/);
  });

  test('a malformed signature entry rejects the whole fetch (an unorderable list is unusable)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => [{signature: 'SigNoSlot'}],
    };
    await expect(fetchSolanaHistory(RPC, OWNER)).rejects.toThrow(/malformed entry/);
  });

  test('an unreadable blockTime is dropped — "null" must keep meaning "the node has no time"', async () => {
    installStub(
      {[OWNER]: [sig('SigBadTime', 407)]},
      {SigBadTime: {
        ...tx({keys: [OWNER, PEER], pre: [1_000_000_000, 0], post: [899_995_000, 100_000_000]}),
        blockTime: 'yesterday',
      }},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/blockTime/);
  });

  test('a transaction with no meta is dropped (balances unknown ⇒ nothing can be claimed)', async () => {
    installStub(
      {[OWNER]: [sig('SigNoMeta', 405)]},
      {SigNoMeta: {slot: 405, blockTime: BLOCK_TIME, meta: null, transaction: {message: {accountKeys: [OWNER]}}}},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/no meta/);
  });

  test('a readable transaction that moved nothing of ours yields no row and is NOT a drop', async () => {
    installStub(
      {[OWNER]: [sig('SigMemoOnly', 406)]},
      {SigMemoOnly: tx({keys: [PEER, OWNER], pre: [1_000_000_000, 7], post: [999_995_000, 7]})},
    );
    const {rows, dropped} = await fetchSolanaHistory(RPC, OWNER);
    expect(rows).toEqual([]);
    expect(dropped).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('transaction details are read ONCE', () => {
  test('a second poll re-reads the signature LIST but no already-known detail', async () => {
    // Measured 2026-09-08: the 15s history poll re-fetched the same ≤20 immutable details forever
    // (80 getTransaction/min from an idle wallet) against an RPC key that answers HTTP 429.
    let listCalls = 0;
    let detailCalls = 0;
    const sigs = [sig('SigCachedA', 300), sig('SigCachedB', 299)];
    const bodies = {
      SigCachedA: tx({keys: [OWNER, PEER, SYSTEM_PROGRAM_ADDRESS], pre: [1_000_000_000, 0, 1], post: [899_995_000, 100_000_000, 1], slot: 300}),
      SigCachedB: tx({keys: [PEER, OWNER, SYSTEM_PROGRAM_ADDRESS], pre: [1_000_000_000, 0, 1], post: [899_995_000, 100_000_000, 1], slot: 299}),
    };
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: (params: unknown[]) => {
        listCalls++;
        return params[0] === OWNER ? sigs : [];
      },
      getTransaction: (params: unknown[]) => {
        detailCalls++;
        return (bodies as Record<string, unknown>)[params[0] as string] ?? null;
      },
    };
    const first = await fetchSolanaHistory(RPC, OWNER);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(detailCalls).toBe(2);
    const second = await fetchSolanaHistory(RPC, OWNER);
    // The list is authoritative and is re-read every cycle (a dropped transaction must vanish);
    // the details behind it are not re-read.
    expect(listCalls).toBe(4);   // owner + USDC ATA, twice
    expect(detailCalls).toBe(2); // …and not one detail more
    expect(second.rows).toEqual(first.rows);
  });

  test('a detail the node does not have yet is NOT cached — it is asked for again', async () => {
    let detailCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: (params: unknown[]) => (params[0] === OWNER ? [sig('SigPending', 400)] : []),
      getTransaction: () => { detailCalls++; return null; },
    };
    await fetchSolanaHistory(RPC, OWNER);
    await fetchSolanaHistory(RPC, OWNER);
    expect(detailCalls).toBe(2);
  });
});
