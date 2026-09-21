/**
 * The SOL seam (`app/solana.ts`) isolation boundary. With the default jest state
 * (`__DPAY_TEST_SOLANA_RPC_URL=''`, set in jest.setup.js), the network functions must NO-OP
 * (balance → null, send → throw) WITHOUT importing the network module — so the offline inner loop
 * never touches devnet. The "configured" path is then exercised by overriding the global inside an
 * isolated module registry (mirrors walletconnect.test.ts) with a mocked fetch.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import bs58 from 'bs58';
import {encodeSolReq, decodeSolReq} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {buildCanonicalSolMessage, verifySolPayment, base58Decode32} from '../solana/tx';
import {buildCanonicalSplMessage, deriveAta, ASSOCIATED_TOKEN_PROGRAM_ADDRESS} from '../solana/spl';
import {USDC_DECIMALS} from '../solana/tokens';
import {deriveSolanaKeypair} from '../solana/identity';
import {isEndpointRefusal} from '../solana/errors';
import {utf8ToBytes} from '../lib/base64url';
import {bytesToBase64} from '../lib/base64';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE, RECEIPT_MISMATCH} from '../solana/payments';
import type {SolanaRpcStub, SolanaTransactionDetail} from '../solana/rpc';
import type {SolanaPayTransfer} from '../solana';

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
});

// --- fixtures ---
const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const MERCHANT_ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';

// --- tx-bytes helpers (parse the legacy layout of a base64 signed tx: sig(64) + message) ---

function readCompactU16(bytes: Uint8Array, off: number): {value: number; next: number} {
  let value = 0, shift = 0, pos = off;
  for (let i = 0; i < 3; i++) {
    const b = bytes[pos];
    pos++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return {value, next: pos};
    shift += 7;
  }
  return {value, next: pos};
}

/** Instruction count of a signed legacy tx: skip sigCount(1) + sig(64) + header(3), read the account table. */
function countInstructions(bytes: Uint8Array): number {
  const keys = readCompactU16(bytes, 65 + 3);
  const afterKeys = keys.next + keys.value * 32 + 32; // accounts + blockhash
  return readCompactU16(bytes, afterKeys).value;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// --- stub helpers ---

function withStubUrl<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
  let p: Promise<T> | undefined;
  jest.isolateModules(() => {
    g.__DPAY_TEST_SOLANA_RPC_URL = 'https://stub.test';
    p = fn();
  });
  g.__DPAY_TEST_SOLANA_RPC_URL = '';
  return p!;
}

describe('solana seam — offline (solanaRpcUrl() empty)', () => {
  test('readSolanaBalances answers "offline" for every rail without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {readSolanaBalances} = require('../solana');
    const r = await readSolanaBalances(SEED_HEX, [USDC_MINT]);
    expect(r).toEqual({sol: {kind: 'offline'}, tokens: {[USDC_MINT]: {kind: 'offline'}}});
    expect(called).toBe(false); // never imported rpc, never fetched
  });

  test('sendSol throws an offline error without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {sendSol} = require('../solana');
    await expect(sendSol('4f'.repeat(16), 'ToAddr', 1000n)).rejects.toThrow('offline');
    expect(called).toBe(false);
  });

  test('getSolSignatureStatus THROWS rather than answering "never seen it"', async () => {
    // The one caller re-reads a signature it already broadcast to decide whether an irreversible
    // payment can still be reported (`SolPayMode`), so a null here would read as "it never landed"
    // — a lost claim, not a missing RPC. Same offline contract as `sendSol`, and for the same
    // reason: a signature exists only because a broadcast succeeded.
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {getSolSignatureStatus} = require('../solana');
    await expect(getSolSignatureStatus('5ig'.repeat(10))).rejects.toThrow('offline');
    expect(called).toBe(false);
  });
});

describe('solana seam — configured (RPC URL set) calls through to rpc', () => {
  test('readSolanaBalances fetches via the rpc client, in ONE POST', async () => {
    const bodies: {method: string}[] = [];
    const mock = jest.fn((_url: string, init?: {body?: string}) => {
      bodies.push(JSON.parse(String(init?.body)) as {method: string});
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({
        result: {context: {slot: 1}, value: [{lamports: 2500000000, owner: '11111111111111111111111111111111', data: ['', 'base64']}]},
      })} as unknown as Response);
    });
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    // Override the seam constant inside an isolated module registry so solanaRpcUrl() is non-empty.
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://rpc.test';
      const {readSolanaBalances} = require('../solana');
      p = readSolanaBalances(SEED_HEX, []);
    });
    const r = await p as {sol: {kind: string; lamports?: string}};
    expect(r.sol).toEqual({kind: 'lamports', lamports: '2500000000'});
    expect(mock).toHaveBeenCalledTimes(1);
    expect(bodies.map(b => b.method)).toEqual(['getMultipleAccounts']);
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
  });

  test('getSolSignatureStatus asks history-aware and hands the verdict back verbatim', async () => {
    // `searchTransactionHistory` is the point: the claim is re-read minutes after the broadcast,
    // by which time a landed transaction has dropped out of the node's recent-status cache — and a
    // status the node has merely forgotten must never come back as "not found".
    const params: unknown[][] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignatureStatuses: (p: unknown[]) => {
        params.push(p);
        return {context: {slot: 42}, value: [{confirmationStatus: 'finalized', err: null}]};
      },
    };
    const status = await withStubUrl(async () => {
      const {getSolSignatureStatus} = require('../solana');
      return (getSolSignatureStatus as (s: string) => Promise<unknown>)('5ig'.repeat(10));
    });
    expect(status).toEqual({confirmationStatus: 'finalized', err: null});
    expect(params[0][0]).toEqual(['5ig'.repeat(10)]);
    expect(params[0][1]).toEqual({searchTransactionHistory: true});
  });

  test('getSolSignatureStatus answers null for a signature the cluster does not know', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignatureStatuses: () => ({context: {slot: 7}, value: [null]}),
    };
    const status = await withStubUrl(async () => {
      const {getSolSignatureStatus} = require('../solana');
      return (getSolSignatureStatus as (s: string) => Promise<unknown>)('5ig'.repeat(10));
    });
    expect(status).toBeNull();
  });
});

// ============================================================================
// Phase 2 — Solana USDC balance reader + RPC availability predicate.
//
// `getSolanaTokenBalance(secret, mint)` returns a discriminated union that distinguishes the four states the plan
// (invariant #10) requires stay distinct: offline (no/invalid config), absent (ATA missing — KNOWN
// zero/empty), balance (have an exact amount string), error (RPC failure — transient/unverifiable).
// `isSolanaRpcAvailable` exposes RPC availability independently from relay `online` (invariant #9).
// ============================================================================

describe('solana seam — readSolanaBalances (one request, honest states)', () => {
  const OWNER = deriveSolanaKeypair(SEED_HEX).address;
  const USDC_ATA = bs58.encode(deriveAta(OWNER, USDC_MINT));

  /** A real 165-byte SPL token account: mint ++ owner ++ amount u64LE ++ the rest. The layout is
   *  pinned against mainnet bytes in solana-account-decode.test.ts; here it is USED, so a decoder
   *  that drifted from the chain would fail there and a seam that mis-wires the positions fails
   *  here. */
  function tokenAccount(mint: string, owner: string, amount: bigint): string {
    const b = new Uint8Array(165);
    b.set(base58Decode32(mint), 0);
    b.set(base58Decode32(owner), 32);
    for (let i = 0; i < 8; i++) b[64 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
    return bytesToBase64(b);
  }
  /** A real 82-byte SPL mint account: decimals at offset 44. */
  function mintAccount(decimals: number): string {
    const b = new Uint8Array(82);
    b[44] = decimals;
    return bytesToBase64(b);
  }
  const account = (data: string, owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports = 2039280) =>
    ({data: [data, 'base64'], owner, lamports});

  /** Serve one `getMultipleAccounts` answer, positionally, and record what was asked for. */
  function serveAccounts(answers: (unknown | null)[]): {asked: string[][]} {
    const asked: string[][] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (params: unknown[]) => {
        asked.push(params[0] as string[]);
        return {context: {slot: 1}, value: answers};
      },
    };
    return {asked};
  }

  type Read = {sol: {kind: string; lamports?: string; failure?: string}; tokens: Record<string, {kind: string; amount?: string; decimals?: number; failure?: string}>};
  /** Drive the seam at a mainnet-shaped endpoint. `url` is a parameter because the rpc module keeps
   *  a PER-ENDPOINT 429 cooldown that outlives one test (by design — a refusal is held for the
   *  window the endpoint asked for), so the refusal case must not poison the next case's read. */
  const readBalances = (mints: string[], url = 'https://sol.example') => {
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<Read> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = url;
      const {readSolanaBalances} = require('../solana');
      p = (readSolanaBalances as (s: string, m: string[]) => Promise<Read>)(SEED_HEX, mints);
    });
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    return p!;
  };

  test('one request asks for the wallet, each token account and each MINT — and answers all of them', async () => {
    // The mint account is in the list because that is where `decimals` comes from: the chain still
    // states the scale, exactly as `getTokenAccountBalance` used to, and it costs no extra request.
    const {asked} = serveAccounts([
      account(bytesToBase64(new Uint8Array(0)), '11111111111111111111111111111111', 5_000_000_000),
      account(tokenAccount(USDC_MINT, OWNER, 1234567n)),
      account(mintAccount(6)),
    ]);
    const r = await readBalances([USDC_MINT]);
    expect(asked).toHaveLength(1);                       // ONE request for the whole wallet
    expect(asked[0]).toEqual([OWNER, USDC_ATA, USDC_MINT]);
    expect(r.sol).toEqual({kind: 'lamports', lamports: '5000000000'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'balance', amount: '1234567', decimals: 6});
  });

  test('a null token account is "absent" — the fact the sign gate is allowed to refuse on', async () => {
    serveAccounts([
      account(bytesToBase64(new Uint8Array(0)), '11111111111111111111111111111111', 1),
      null,
      account(mintAccount(6)),
    ]);
    const r = await readBalances([USDC_MINT]);
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'absent'});
    expect('amount' in r.tokens[USDC_MINT]).toBe(false); // absent carries no amount
  });

  test('a null WALLET account is a zero balance, not an error (the chain answers 0 for it)', async () => {
    serveAccounts([null]);
    const r = await readBalances([]);
    expect(r.sol).toEqual({kind: 'lamports', lamports: '0'});
  });

  test('preserves a large amount as an exact string (>2^53 — proves no number path)', async () => {
    serveAccounts([
      account(bytesToBase64(new Uint8Array(0)), '11111111111111111111111111111111', 1),
      account(tokenAccount(USDC_MINT, OWNER, 10_000_000_000_000_000n)),
      account(mintAccount(6)),
    ]);
    const r = await readBalances([USDC_MINT]);
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'balance', amount: '10000000000000000', decimals: 6});
    expect(typeof r.tokens[USDC_MINT].amount).toBe('string');
  });

  test('an endpoint that REFUSES is reported as refused — the rail is down and this device is not', async () => {
    // HTTP 429 is the exact answer the shipped key gives with its quota spent. The wallet must be
    // able to say that, rather than showing the same nothing an airplane-mode phone shows.
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() =>
      Promise.resolve({ok: false, status: 429, headers: {get: () => null}, text: () => Promise.resolve('max usage reached')} as unknown as Response));
    const r = await readBalances([USDC_MINT], 'https://refusing.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'refused'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'refused'});
  });

  test('an endpoint that ANSWERS NOTHING is reported as unreachable — an offline payer, not a dead rail', async () => {
    // URL-aware mock (the oracle redesign probes the IC ORIGIN, not the relay): the RPC POST fails,
    // but the probe answers — the phone IS online, so the rail's path is what is down. A mock that
    // rejected everything would (correctly) classify 'offline' instead.
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((url: unknown) =>
      String(url).startsWith('https://unreachable.example')
        ? Promise.reject(new Error('Network request failed'))
        : Promise.resolve({ok: true, status: 200} as unknown as Response));
    const r = await readBalances([USDC_MINT], 'https://unreachable.example');
    expect(r.sol).toEqual({kind: 'error', failure: 'unreachable'});
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'unreachable'});
  });

  test('bytes that cannot be trusted are "unreadable" for THAT mint only — never a zero, never a blanked wallet', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    serveAccounts([
      account(bytesToBase64(new Uint8Array(0)), '11111111111111111111111111111111', 42),
      account(tokenAccount(MERCHANT_USDC_ATA, OWNER, 5n)),  // a token account for the WRONG mint
      account(mintAccount(6)),
    ]);
    const r = await readBalances([USDC_MINT]);
    expect(r.sol).toEqual({kind: 'lamports', lamports: '42'});   // SOL is unaffected
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'error', failure: 'unreadable'});
    expect(String(warn.mock.calls[0]?.[0])).toContain(USDC_MINT);
    warn.mockRestore();
  });

  test('a mint the cluster cannot answer for is not asked about at all', async () => {
    // A devnet endpoint with mainnet mints: `solanaTokenAvailable` fails closed, so the token is
    // reported offline and — the point — its accounts never enter the request.
    const {asked} = serveAccounts([account(bytesToBase64(new Uint8Array(0)), '11111111111111111111111111111111', 7)]);
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<Read> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://api.devnet.solana.com';
      const {readSolanaBalances} = require('../solana');
      p = (readSolanaBalances as (s: string, m: string[]) => Promise<Read>)(SEED_HEX, [USDC_MINT]);
    });
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    const r = await p!;
    expect(asked[0]).toEqual([OWNER]);                 // the incoherent mint is absent from the request
    expect(r.tokens[USDC_MINT]).toEqual({kind: 'offline'});
    expect(r.sol).toEqual({kind: 'lamports', lamports: '7'});
  });
});

// ============================================================================
// Phase 6 — sendSpl (USDC direct send). Mirrors sendSol's shape but builds an SPL
// Token.transfer (single instruction, live blockhash) instead of a System Transfer.
// FAIL-CLOSED sender check: the device's source ATA must exist on-chain (you cannot
// send USDC you don't hold an account for — the error names the sender, the first
// check). RECIPIENT AUTO-CREATE (2026-08-14 founder-approved): a missing recipient
// ATA is created in the SAME tx via AssociatedTokenProgram.createIdempotent BEFORE
// the transfer (sender pays the one-time rent, disclosed on the review screen;
// idempotent ⇒ a TOCTOU race with another creator is a harmless no-op).
// Reuses the byte-exact buildSplTransferInstruction + buildCreateAtaIdempotentInstruction
// (both proven in solana-spl.test.ts).
// ============================================================================
describe('solana seam — sendSpl (Phase 6 SPL direct send — mint passed by the caller)', () => {
  test('throws offline error when solanaRpcUrl() is empty', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {sendSpl} = require('../solana');
    await expect((sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT)).rejects.toThrow('offline');
    expect(called).toBe(false);
  });

  test('throws a clear error when the sender ATA is missing (fail-closed)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      // Every ATA check returns null → device has no USDC account.
      getAccountInfo: () => ({value: null}),
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    })).rejects.toThrow(/USDC account/);
  });

  test('auto-creates a missing recipient ATA in the SAME tx (real createIdempotent ix, no throw)', async () => {
    // First getAccountInfo call (sender ATA) returns funded; second (recipient ATA) returns null.
    let calls = 0;
    const sent: string[] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => {
        calls++;
        return calls === 1 ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}} : {value: null};
      },
      getBalance: () => ({value: 1000000000}), // 1 SOL ≥ rent+fee — sender can fund the create
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: (params: unknown[]) => { sent.push(params[0] as string); return 'SigSplBase58'; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    const sig = await withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    });
    expect(sig).toBe('SigSplBase58');
    // Exactly ONE broadcast — create + transfer ride the same signed transaction.
    expect(sent.length).toBe(1);
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    // The message carries 2 instructions (create ATA + transfer).
    expect(countInstructions(bytes)).toBe(2);
    // The recipient's ATA and the ATA PROGRAM are both addressed in the real tx bytes.
    expect(indexOfBytes(bytes, deriveAta(MERCHANT_ADDRESS, USDC_MINT))).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(bytes, base58Decode32(ASSOCIATED_TOKEN_PROGRAM_ADDRESS))).toBeGreaterThanOrEqual(0);
    // The plain transfer already needs >120 chars; adding a 7-key create ix grows it further.
    expect(sent[0].length).toBeGreaterThan(250);
  });

  // `onBroadcast` exists for ONE caller: the OpenCryptoPay report is one-shot and irreversible, so
  // "the network never took it" and "it may still land" must be told apart, and only the signature
  // separates them (`services/opencryptopay.ts`). These two tests pin exactly that boundary.
  test('sendSol hands the signature to onBroadcast the moment the network accepts it — before confirming', async () => {
    const order: string[] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => { order.push('broadcast'); return 'SigSolBase58'; },
      getSignatureStatuses: () => { order.push('confirm'); return {value: [{confirmationStatus: 'confirmed'}]}; },
    };
    const seen: string[] = [];
    const sig = await withStubUrl(async () => {
      const {sendSol} = require('../solana');
      return (sendSol as (s: string, d: string, a: bigint, sig?: AbortSignal, cb?: (x: string) => void) => Promise<string>)(
        SEED_HEX, MERCHANT_ADDRESS, 1_000n, undefined, x => { order.push('onBroadcast'); seen.push(x); },
      );
    });
    expect(sig).toBe('SigSolBase58');
    expect(seen).toEqual(['SigSolBase58']);
    expect(order).toEqual(['broadcast', 'onBroadcast', 'confirm']);
  });

  test('a failure AFTER the broadcast still leaves the caller holding the signature', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => 'SigSolBase58',
      getSignatureStatuses: () => { throw new Error('rpc down'); },
    };
    const seen: string[] = [];
    await expect(withStubUrl(async () => {
      const {sendSol} = require('../solana');
      return (sendSol as (s: string, d: string, a: bigint, sig?: AbortSignal, cb?: (x: string) => void) => Promise<string>)(
        SEED_HEX, MERCHANT_ADDRESS, 1_000n, undefined, x => seen.push(x),
      );
    })).rejects.toThrow();
    // The throw says nothing about whether the transfer landed — but the signature is now known,
    // which is what lets the caller answer "unknown" instead of "not sent".
    expect(seen).toEqual(['SigSolBase58']);
  });

  test('sendSpl hands the signature to onBroadcast the moment the network accepts it — before confirming', async () => {
    const order: string[] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => { order.push('broadcast'); return 'SigSplBase58'; },
      getSignatureStatuses: () => { order.push('confirm'); return {value: [{confirmationStatus: 'confirmed'}]}; },
    };
    const seen: string[] = [];
    const sig = await withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string, sig?: AbortSignal, cb?: (x: string) => void) => Promise<string>)(
        SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT, undefined, x => { order.push('onBroadcast'); seen.push(x); },
      );
    });
    expect(sig).toBe('SigSplBase58');
    expect(seen).toEqual(['SigSplBase58']);
    expect(order).toEqual(['broadcast', 'onBroadcast', 'confirm']);
  });

  // THE 2026-09-21 DEFECT (EURC send-sheet hang, twice live): a provider/proxy that answers the
  // BROADCAST with HTTP 200 and a JSON-RPC error body (Helius's rejection shape, byte-faithful
  // through the relay's solana pipe). It is a broadcast FAILURE: the venue's own message must
  // surface immediately and the confirmation poll must NEVER run — a rejected broadcast has no
  // signature to confirm, so polling would spin forever against a transaction that does not exist.
  test('a 2xx JSON-RPC error body on sendTransaction is a broadcast FAILURE — venue message surfaced, confirmation never polled', async () => {
    const VENUE_MESSAGE = 'Transaction simulation failed: error processing Instruction 0: custom program error: 0x1';
    const methods: string[] = [];
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (_url: unknown, init?: {body: string}) => {
      const req = JSON.parse(init?.body ?? '{}') as {id: number; method: string};
      methods.push(req.method);
      if (req.method === 'sendTransaction') {
        // Helius's rejection shape: HTTP 200, `error` (not `result`).
        return {
          ok: true,
          status: 200,
          json: async () => ({jsonrpc: '2.0', id: req.id, error: {code: -32002, message: VENUE_MESSAGE}}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({jsonrpc: '2.0', id: req.id, result: {context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}}),
      } as unknown as Response;
    });
    let refusedBrand = false;
    await expect(withStubUrl(async () => {
      const {sendSol} = require('../solana');
      try {
        return await (sendSol as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000n);
      } catch (e) {
        refusedBrand = isEndpointRefusal(e); // the ENDPOINT answered and refused — a rail fact
        throw e;
      }
    })).rejects.toThrow(VENUE_MESSAGE);
    expect(refusedBrand).toBe(true);
    // Broadcast refused in place: no second candidate, no resubmit, NO confirmation poll.
    expect(methods).toEqual(['getLatestBlockhash', 'sendTransaction']);
  });

  // The seam's deadline GUARANTEE (the other half of the 2026-09-21 hang): the send promise
  // settles the moment the caller's signal aborts, even when a lower layer never does. The RPC
  // stub path is the honest stand-in for "a layer that ignores the abort" — it checks no signal
  // at all — so a confirm poll that never answers is cut off by the seam itself.
  test('sendSol settles the moment the caller aborts — even when the confirm poll never answers', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => 'SigSolBase58',
      getSignatureStatuses: () => new Promise(() => {}), // never settles — the un-honored abort
    };
    const ctrl = new AbortController();
    const p = withStubUrl(async () => {
      const {sendSol} = require('../solana');
      return (sendSol as (s: string, d: string, a: bigint, sig?: AbortSignal) => Promise<string>)(
        SEED_HEX, MERCHANT_ADDRESS, 1_000n, ctrl.signal,
      );
    });
    // Reach the confirm poll, then fire the deadline exactly as SOL_SEND_TIMEOUT would.
    await new Promise(r => setTimeout(r, 10));
    await expect(Promise.race([
      (async () => { ctrl.abort(); return p; })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send outlived its deadline')), 1000)),
    ])).rejects.toThrow(/sol send aborted/);
  });

  test('builds + broadcasts the SPL transfer when both ATAs exist', async () => {
    const sent: string[] = []; // base64-encoded tx bytes
    let accountChecks = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => { accountChecks++; return {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}; },
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: (params: unknown[]) => { sent.push(params[0] as string); return 'SigSplBase58'; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    const sig = await withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    });
    expect(sig).toBe('SigSplBase58');
    // Both ATA existence checks ran (sender + recipient).
    expect(accountChecks).toBe(2);
    // Exactly one broadcast, carrying a non-trivial signed transaction.
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBeGreaterThan(120); // base64 of sig(64)+header+accounts+blockhash+ix
  });

  test('throws a friendly pre-check error (NO broadcast) when sender SOL cannot cover the recipient rent', async () => {
    // Sender ATA funded, recipient ATA missing → the tx would carry createIdempotent. Sender SOL
    // (0.001) < rent+fee → sendSpl must fail-closed BEFORE building/signing (finding from the
    // 2026-08-15 audit: without this, the user passes review and hits a raw
    // "custom program error: 0x1" at broadcast).
    let calls = 0;
    let broadcasts = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => {
        calls++;
        return calls === 1 ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}} : {value: null};
      },
      getBalance: () => ({value: 1000000}), // 0.001 SOL < rent+fee
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => { broadcasts++; return 'SigSplBase58'; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    })).rejects.toThrow(/SOL|rent/i);
    expect(broadcasts).toBe(0); // fail-closed BEFORE any tx is signed or broadcast
  });

  test('checks the sender ATA BEFORE the recipient ATA (clear error attribution)', async () => {
    // Both ATAs missing: the error must be about the SENDER (the first check), not the recipient.
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: null}),
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    })).rejects.toThrow(/your wallet|USDC account/i); // not "recipient"
  });
});

// ============================================================================
// createUsdcAta — the receiver-side one-tap USDC account setup (2026-08-14). One
// real AssociatedTokenProgram.createIdempotent instruction, signed LOCALLY with the
// device key, paid by the device's own SOL (rent + fee pre-checked against the
// ESTIMATE; the chain enforces the real value). Mirrors the sendSpl stub shape.
// ============================================================================
describe('solana seam — createTokenAta (receiver-side one-tap setup)', () => {
  test('throws offline when solanaRpcUrl() is empty (no network import)', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {createTokenAta} = require('../solana');
    await expect((createTokenAta as (s: string, m: string) => Promise<string>)(SEED_HEX, USDC_MINT)).rejects.toThrow('not available');
    expect(called).toBe(false);
  });

  test('throws a friendly insufficient-SOL error (honest cost pre-check, no broadcast)', async () => {
    let balanceCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getBalance: () => { balanceCalls++; return {value: 1000000}; }, // 0.001 SOL < rent+fee
      sendTransaction: () => { throw new Error('must not broadcast'); },
    };
    await expect(withStubUrl(async () => {
      const {createTokenAta} = require('../solana');
      return (createTokenAta as (s: string, m: string) => Promise<string>)(SEED_HEX, USDC_MINT);
    })).rejects.toThrow(/one-time account rent|send a little SOL/i);
    expect(balanceCalls).toBe(1);
  });

  test('builds + broadcasts ONE createIdempotent ix for the device ATA, signed by the device key', async () => {
    const sent: string[] = [];
    const kp = deriveSolanaKeypair(SEED_HEX);
    const ownerAddress = bs58.encode(kp.publicKey);
    const deviceAta = deriveAta(ownerAddress, USDC_MINT);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getBalance: () => ({value: 1000000000}), // 1 SOL ≥ rent+fee
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: (params: unknown[]) => { sent.push(params[0] as string); return 'SigAtaBase58'; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    const sig = await withStubUrl(async () => {
      const {createTokenAta} = require('../solana');
      return (createTokenAta as (s: string, m: string) => Promise<string>)(SEED_HEX, USDC_MINT);
    });
    expect(sig).toBe('SigAtaBase58');
    expect(sent.length).toBe(1);
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    // Exactly ONE instruction in the message.
    expect(countInstructions(bytes)).toBe(1);
    // The ix addresses the DEVICE's ATA and the ATA program, and the tx carries the
    // device key's signature over its own rent (payer = owner = device key).
    expect(indexOfBytes(bytes, deviceAta)).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(bytes, base58Decode32(ASSOCIATED_TOKEN_PROGRAM_ADDRESS))).toBeGreaterThanOrEqual(0);
  });

  test('surfaces an on-chain failure after broadcast (no false success)', async () => {
    // Mid-flight failure: the tx was broadcast but FAILED on chain (e.g. rent changed). The
    // promise must reject with the reported error — never return the signature as success.
    let broadcasts = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getBalance: () => ({value: 1000000000}),
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => { broadcasts++; return 'SigAtaBase58'; },
      getSignatureStatuses: () => ({value: [{err: {InstructionError: [0, {Custom: 1}]}, confirmationStatus: 'processed'}]}),
    };
    await expect(withStubUrl(async () => {
      const {createTokenAta} = require('../solana');
      return (createTokenAta as (s: string, m: string) => Promise<string>)(SEED_HEX, USDC_MINT);
    })).rejects.toThrow(/transaction failed/i);
    expect(broadcasts).toBe(1); // broadcast DID happen — the error is the honest outcome
  });

  test('propagates an RPC error during confirmation (never a false success)', async () => {
    // Mid-flight failure: the RPC dies between broadcast and confirmation. The raw RPC error must
    // propagate — the signature was broadcast, so swallowing it would hide a possibly-landed tx.
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getBalance: () => ({value: 1000000000}),
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => 'SigAtaBase58',
      getSignatureStatuses: () => { throw new Error('rpc exploded mid-confirm'); },
    };
    await expect(withStubUrl(async () => {
      const {createTokenAta} = require('../solana');
      return (createTokenAta as (s: string, m: string) => Promise<string>)(SEED_HEX, USDC_MINT);
    })).rejects.toThrow('rpc exploded mid-confirm');
  });
});

describe('solana seam — isSolanaRpcAvailable (independent of relay online)', () => {
  test('returns false when solanaRpcUrl() is empty (offline inner loop)', () => {
    const {isSolanaRpcAvailable} = require('../solana');
    expect((isSolanaRpcAvailable as () => boolean)()).toBe(false);
  });

  test('returns true when solanaRpcUrl() is non-empty', () => {
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let result: boolean | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://sol.example';
      const {isSolanaRpcAvailable} = require('../solana');
      result = (isSolanaRpcAvailable as () => boolean)();
    });
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    expect(result).toBe(true);
  });
});

// ============================================================================
// The money path never awaits an UNBOUNDED module load (2026-09-21 root cause, blocker 2).
//
// Three live EURC sends sat down BEFORE any RPC fired and never broadcast: the first await inside
// sendSol/sendSpl is `await import('./solana/rpc')` — a lazy chunk in the served web build
// (`rpc-*.js`) — and a module load carries NO abort signal and NO timeout, so the caller's 60s
// deadline could not cut it and the sheet hung in `submitting` forever. These pin the fix: the
// send path's load is BOUNDED (an honest, classified, retryable failure), the failure renders as
// actionable copy, and every send step TRACES itself so the last `money:` line names the exact
// dead await on any future live attempt.
// ============================================================================
describe('solana seam — the send path\u2019s module load is bounded and traced', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('loadRpcForSend rejects with the engine-load class when the chunk never arrives', async () => {
    jest.useFakeTimers();
    const {loadRpcForSend} = require('../solana') as {loadRpcForSend: (d: number, load?: () => Promise<unknown>) => Promise<unknown>};
    const p = loadRpcForSend(50, () => new Promise(() => { /* the chunk fetch hangs — the live shape */ }));
    const settled = expect(p).rejects.toThrow(/rpc module failed to load/);
    await jest.advanceTimersByTimeAsync(51);
    await settled;
  });

  test('the bound is a RACE, not a cap — a loader that answers in time is honored', async () => {
    jest.useFakeTimers();
    const {loadRpcForSend} = require('../solana') as {loadRpcForSend: (d: number, load?: () => Promise<unknown>) => Promise<unknown>};
    const marker = {rpc: true};
    const p = loadRpcForSend(5000, () => Promise.resolve(marker));
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(marker);
  });

  test('friendlySolError maps the engine-load class to the actionable reopen instruction', () => {
    const {friendlySolError} = require('../solana/errors') as {friendlySolError: (m: string) => string};
    const {M} = require('../i18n') as {M: {sol: {engineLoad: string; timedOut: string}}};
    expect(friendlySolError('solana rpc module failed to load within 10000ms (the payment engine chunk never arrived)')).toBe(M.sol.engineLoad);
    // ...and the mapping does NOT swallow the timeout class into it (distinct copies).
    expect(friendlySolError('sol send aborted (deadline)')).toBe(M.sol.timedOut);
  });

  test('every send step traces itself — the last `money:` line names the dead await', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getLatestBlockhash: () => { throw new Error('origin connection stalled'); },
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n, USDC_MINT);
    })).rejects.toThrow('origin connection stalled');
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => /money: sol send SPL\(USDC\) start/.test(l))).toBe(true);
    expect(lines.some(l => /FAILED at step=blockhash: origin connection stalled/.test(l))).toBe(true);
    // The steps BEFORE the failure are on the record too — the trace is a story, not a verdict.
    expect(lines.some(l => /sender-ata-check|module-load/.test(l))).toBe(true);
    warn.mockRestore();
  });

  test('a send that survives to the chain traces the broadcast + confirmation signatures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => 'SigSolBase58',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    await withStubUrl(async () => {
      const {sendSol} = require('../solana');
      return (sendSol as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000n);
    });
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => /BROADCAST accepted.*SigSolBase58/.test(l))).toBe(true);
    expect(lines.some(l => /money: sol send confirmed sig=SigSolBase58/.test(l))).toBe(true);
    warn.mockRestore();
  });

  test('every MONEY send routes its module load through the bounded loader — never a raw import (wiring pin)', () => {
    // The 2026-09-21 root cause was a RAW `await import('./solana/rpc')` as a send's first await:
    // a chunk fetch carries no abort signal and no timeout, so the sheet hung in `submitting`
    // forever with nothing broadcast. The bounded loader is only real if the send paths USE it —
    // this pin fails if a send path ever reverts to a raw dynamic import.
    const fs = require('fs') as {readFileSync: (p: string, enc?: string) => string};
    const path = require('path') as {join: (...a: string[]) => string};
    const src = fs.readFileSync(path.join(__dirname, '../solana.ts'), 'utf8');
    const moneyPaths = [
      'export async function sendSol(',
      'export async function sendSpl(',
      'export async function sendSolanaPay(',
      'export async function submitRawSolTx(',
      'export async function getSolSignatureStatus(',
      'export async function createTokenAta(',
    ];
    for (const fn of moneyPaths) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThanOrEqual(0);
      // A top-level function body ends at the first `}` in column 0 (nested braces are indented).
      const body = src.slice(start, src.indexOf('\n}', start));
      expect(body).toContain('loadRpcForSend(');
      expect(body).not.toContain("await import('./solana/rpc')");
    }
  });
});

// ============================================================================
// The 2026-09-21 never-broadcast repro, OFFLINE (the live EURC→ICP driver's shape): the send
// sheet submits 9.284071 EURC to a fresh venue deposit address through the REAL seam against a
// RECORDING stub RPC. Three live attempts produced zero on-chain writes with the RPC healthy,
// and no test pinned the whole click→broadcast chain in one piece. This does: every await the
// send makes is recorded in order, the broadcast IS reached, and the transfer instruction rides
// the signed bytes. If a silent guard return, a wrong method, or an unbounded await ever enters
// this chain, this test names it.
// ============================================================================
describe('solana seam — the send reaches the broadcast (recording-stub repro, EURC shape)', () => {
  /** The 2026-09-21 live facts, verbatim: the app-derived rail, Circle's EURC mint, and the
   *  venue deposit address the refund came back to (funds ledger row 71). */
  const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
  const VENUE_DEPOSIT = '7nY7Xmo9TA85ZNQTJFw9rFGggKjK63vpD8QykDgZsSpQ';
  const LIVE_AMOUNT = 9_284_071n; // 9.284071 EURC at 6 decimals

  afterEach(() => {
    delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  test('the full await chain, recorded: ata×2 → balance → blockhash → BROADCAST → confirm', async () => {
    const calls: {method: string; params: unknown[]}[] = [];
    const record = <T,>(method: string, answer: (params: unknown[], n: number) => T): ((params: unknown[]) => T) => {
      let n = 0;
      return (params: unknown[]) => {
        calls.push({method, params});
        return answer(params, n++);
      };
    };
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      // 1st call = the sender's ATA (exists — the rail holds the EURC); 2nd = the venue's (fresh
      // order → fresh address → absent), which puts the createIdempotent ix in the tx.
      getAccountInfo: record('getAccountInfo', (_p, n) => (n === 0
        ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2_039_280}}
        : {value: null})),
      getBalance: record('getBalance', () => ({value: 4_699_835})), // the rail's measured SOL
      getLatestBlockhash: record('getLatestBlockhash', () => ({context: {slot: 449_102_443}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 427_143_204}})),
      sendTransaction: record('sendTransaction', () => '5ig'.repeat(10)),
      getSignatureStatuses: record('getSignatureStatuses', () => ({value: [{confirmationStatus: 'finalized', err: null}]})),
    };
    const sig = await withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, VENUE_DEPOSIT, LIVE_AMOUNT, EURC_MINT);
    });
    expect(sig).toBe('5ig'.repeat(10));
    // THE sequence — no other await, no silent guard between click and broadcast.
    expect(calls.map(c => c.method)).toEqual([
      'getAccountInfo', // sender ATA (fail-closed check)
      'getAccountInfo', // venue ATA (missing → the create joins the tx)
      'getBalance', // the honest rent pre-check for the create
      'getLatestBlockhash',
      'sendTransaction', // ← the broadcast, REACHED
      'getSignatureStatuses', // confirm poll
    ]);
    // The broadcast's bytes carry the createIdempotent + transfer instructions over the venue's
    // derived ATA — the transaction the three live attempts never produced.
    const sent = calls[4].params[0] as string;
    const bytes = Uint8Array.from(Buffer.from(sent, 'base64'));
    expect(countInstructions(bytes)).toBe(2);
    expect(indexOfBytes(bytes, deriveAta(VENUE_DEPOSIT, EURC_MINT))).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Phase 3 — v2 recent-blockhash payment seam. The lifecycle is: ONLINE merchant creates a request
// carrying a fresh blockhash → OFFLINE payer signs → ONLINE merchant strictly verifies +
// freshness-checks + broadcasts + confirms → returns a SolReceiptV2. These tests exercise every
// branch of the money-critical freshness state machine via the rpc stub (no real network).
// ============================================================================

const TEST_BLOCKHASH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN'; // valid base58 32-byte
const TEST_LVH = 300_000_000;
const TEST_SLOT = 250_000_000;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function solReqV2(overrides: Partial<SolReqV2> = {}): SolReqV2 {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 2,
    rid: 'a'.repeat(32),
    net: 'mainnet-beta',
    bh: TEST_BLOCKHASH,
    lvh: TEST_LVH,
    slot: TEST_SLOT,
    iat,
    exp: iat + 90,
    to: MERCHANT_ADDRESS,
    amt: '2000000',
    cur: 'SOL',
    mint: null,
    toAta: null,
    name: 'Test',
    memo: '',
    ...overrides,
  };
}

function usdcReqV2(overrides: Partial<SolReqV2> = {}): SolReqV2 {
  return solReqV2({
    cur: 'USDC',
    amt: '1000000',
    mint: USDC_MINT,
    toAta: MERCHANT_USDC_ATA,
    rid: 'b'.repeat(32),
    ...overrides,
  });
}

/** Build the canonical URI for a request (strips `v` — the codec stamps it). */
function buildUri(req: SolReqV2): string {
  const {v: _v, ...input} = req;
  void _v;
  return encodeSolReq(input);
}

describe('solana seam — createSolPaymentRequest (v2 freshness at creation)', () => {
  afterEach(() => {
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
    jest.resetModules(); // clear the rpc module's genesisHashCache (dynamic import bypasses isolateModules)
  });

  test('stubs genesis=mainnet + blockhash → SolReqV2 with iat<exp≤iat+90, mainnet-beta, slot=contextSlot, round-trips', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => MAINNET_GENESIS,
      getLatestBlockhash: () => ({context: {slot: 777}, value: {blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 555}}),
    };
    const result = await withStubUrl(async () => {
      const {createSolPaymentRequest} = require('../solana');
      return createSolPaymentRequest(
        {to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL', mint: null, toAta: null, name: 'Test', memo: ''},
        new AbortController().signal,
      ) as Promise<{request: SolReqV2; uri: string}>;
    });
    const {request, uri} = result;
    expect(request.v).toBe(2);
    expect(request.net).toBe('mainnet-beta');
    expect(request.bh).toBe(TEST_BLOCKHASH);
    expect(request.lvh).toBe(555);
    expect(request.slot).toBe(777); // contextSlot threads through
    expect(request.to).toBe(MERCHANT_ADDRESS);
    expect(request.cur).toBe('SOL');
    expect(request.exp - request.iat).toBeLessThanOrEqual(90);
    expect(request.exp).toBeGreaterThan(request.iat);
    // URI round-trips: decodeSolReq(uri) deep-equals the request.
    expect(decodeSolReq(uri)).toEqual(request);
  });

  test('genesis hash mismatch → throws (wrong cluster, never returns a silent result)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => 'WrongClusterHash',
      getLatestBlockhash: () => ({context: {slot: 1}, value: {blockhash: 'bh', lastValidBlockHeight: 1}}),
    };
    await expect(withStubUrl(async () => {
      const {createSolPaymentRequest} = require('../solana');
      return createSolPaymentRequest(
        {to: MERCHANT_ADDRESS, amt: '1', cur: 'SOL', mint: null, toAta: null, name: '', memo: ''},
        new AbortController().signal,
      );
    })).rejects.toThrow(/cluster genesis mismatch/i);
  });

  test('RPC failure → throws (honest error, never a silent empty result)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => { throw new Error('RPC is down'); },
    };
    await expect(withStubUrl(async () => {
      const {createSolPaymentRequest} = require('../solana');
      return createSolPaymentRequest(
        {to: MERCHANT_ADDRESS, amt: '1', cur: 'SOL', mint: null, toAta: null, name: '', memo: ''},
        new AbortController().signal,
      );
    })).rejects.toThrow(/RPC is down/i);
  });
});

describe('solana seam — signSolPayment / signSplPayment (OFFLINE, no network)', () => {
  test('signSolPayment does NOT touch the rpc stub; returns a SolPayV2 that strict-verifies', () => {
    let stubCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      __trap: () => { stubCalls++; throw new Error('stub must not be called'); },
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };

    const request = solReqV2();
    const {signSolPayment} = require('../solana');
    const pay = (signSolPayment as (s: string, r: SolReqV2) => SolPayV2)(SEED_HEX, request);
    expect(pay.v).toBe(2);
    expect(pay.rid).toBe(request.rid);
    expect(pay.tx.length).toBeGreaterThan(64);

    // The signed tx must strict-verify against the canonical SOL message.
    const {publicKey} = deriveSolanaKeypair(SEED_HEX);
    const message = buildCanonicalSolMessage(publicKey, request);
    const verify = verifySolPayment(message, pay);
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.signature.length).toBeGreaterThan(0);
    }
    expect(stubCalls).toBe(0); // OFFLINE — never touched the stub
  });

  test('signSplPayment does NOT touch the rpc stub; returns a SolPayV2 that strict-verifies (USDC)', () => {
    let stubCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      __trap: () => { stubCalls++; throw new Error('stub must not be called'); },
    };
    (globalThis as {fetch: unknown}).fetch = () => { throw new Error('fetch must not be called'); };

    const request = usdcReqV2();
    const {signSplPayment} = require('../solana');
    const pay = (signSplPayment as (s: string, r: SolReqV2) => SolPayV2)(SEED_HEX, request);
    expect(pay.v).toBe(2);
    expect(pay.rid).toBe(request.rid);

    const {publicKey} = deriveSolanaKeypair(SEED_HEX);
    const message = buildCanonicalSplMessage(publicKey, request, USDC_DECIMALS);
    const verify = verifySolPayment(message, pay);
    expect(verify.ok).toBe(true);
    expect(stubCalls).toBe(0);
  });
});

describe('solana seam — broadcastSolPayment (money-critical freshness state machine)', () => {
  afterEach(() => {
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  /** Sign a payment for the request using the offline signer, then extract the verified sig (the
   *  stable payment identity the broadcast must echo back via sendTransaction). */
  function signAndExtractSig(request: SolReqV2): {payment: SolPayV2; sig: string} {
    const {signSolPayment, signSplPayment} = require('../solana');
    const signer = request.cur === 'SOL' ? signSolPayment : signSplPayment;
    const payment = (signer as (s: string, r: SolReqV2) => SolPayV2)(SEED_HEX, request);
    const {publicKey} = deriveSolanaKeypair(SEED_HEX);
    const message = request.cur === 'SOL'
      ? buildCanonicalSolMessage(publicKey, request)
      : buildCanonicalSplMessage(publicKey, request, USDC_DECIMALS);
    const verify = verifySolPayment(message, payment);
    if (!verify.ok) throw new Error('test fixture: payment failed to verify');
    return {payment, sig: verify.signature};
  }

  /** The canonical message broadcastSolPayment will rebuild for this request (same builder, same
   *  payer key extracted from the signed tx). */
  function canonicalFor(request: SolReqV2): Uint8Array {
    const {publicKey} = deriveSolanaKeypair(SEED_HEX);
    return request.cur === 'SOL'
      ? buildCanonicalSolMessage(publicKey, request)
      : buildCanonicalSplMessage(publicKey, request, USDC_DECIMALS);
  }

  /** Serialize a legacy message into the json-detail shape getTransaction returns — the settle
   *  gate recompiles this back to wire bytes and compares against the canonical message. */
  function txDetailFromMessage(
    msg: Uint8Array,
    over: {message?: Record<string, unknown>; meta?: Record<string, unknown>; metaNull?: boolean} = {},
  ): SolanaTransactionDetail {
    let off = 0;
    const header = {numRequiredSignatures: msg[off++], numReadonlySignedAccounts: msg[off++], numReadonlyUnsignedAccounts: msg[off++]};
    const nk = readCompactU16(msg, off); off = nk.next;
    const accountKeys: string[] = [];
    for (let i = 0; i < nk.value; i++) { accountKeys.push(bs58.encode(msg.slice(off, off + 32))); off += 32; }
    const recentBlockhash = bs58.encode(msg.slice(off, off + 32)); off += 32;
    const ni = readCompactU16(msg, off); off = ni.next;
    const instructions: {programIdIndex: number; accounts: number[]; data: string}[] = [];
    for (let i = 0; i < ni.value; i++) {
      const programIdIndex = msg[off++];
      const na = readCompactU16(msg, off); off = na.next;
      const accounts: number[] = [];
      for (let j = 0; j < na.value; j++) accounts.push(msg[off++]);
      const nd = readCompactU16(msg, off); off = nd.next;
      instructions.push({programIdIndex, accounts, data: bytesToBase64(msg.slice(off, off + nd.value))});
      off += nd.value;
    }
    return {
      slot: 1,
      blockTime: null,
      meta: over.metaNull ? null : {err: null, fee: 5000, preBalances: [], postBalances: [], ...over.meta},
      transaction: {message: {accountKeys, recentBlockhash, header, instructions, version: 'legacy', ...over.message} as SolanaTransactionDetail['transaction']['message']},
    };
  }

  test('happy path: freshness OK + sendTransaction returns verified sig + confirmed + settle-verified body → SETTLED', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    let sendCalls = 0;
    let txReads = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => { sendCalls++; return sig; },
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => { txReads++; return txDetailFromMessage(canonicalFor(request)); },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_SETTLED);
    expect(receipt.rid).toBe(request.rid);
    expect(receipt.sig).toBe(sig);
    expect(sendCalls).toBe(1);
    expect(txReads).toBe(1); // confirmed → exactly one settle re-read before SETTLED
  });

  test('cross-home resubmit: A transport-dies after "accepting", B answers "already processed" → NOT REJECTED — confirmation decides', async () => {
    // R2 receipt honesty: the broadcast walk resubmits IDENTICAL bytes when home A dies
    // mid-broadcast. A may have accepted them; home B's "Transaction already processed/known"
    // RPC error used to classify RECEIPT_REJECTED — a FALSE rejection for a transaction that
    // may be on chain right now. The invariant: "already" ⇒ submitted-unknown at broadcast
    // time; the confirm loop's signature status settles it. Here B confirms the signature and
    // getTransaction verifies the canonical body → SETTLED, the strongest disproof of a
    // broadcast-time rejection. Drives the REAL two-home walk through the production candidate
    // derivation (relay bases + proxy path), fetch mocked per-origin.
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    const DEAD = 'https://dead-relay.example';
    const LIVE = 'https://live-relay.example';
    const volleys: {home: string; method: string}[] = [];
    (globalThis as {fetch: unknown}).fetch = async (url: unknown, init?: {body?: string}) => {
      const u = String(url);
      const method = (JSON.parse(String(init?.body)) as {method: string}).method;
      const home = u.startsWith(DEAD) ? DEAD : u.startsWith(LIVE) ? LIVE : null;
      if (home === null) throw new Error(`unexpected fetch to ${u}`);
      volleys.push({home, method});
      if (home === DEAD) throw new TypeError('fetch failed'); // transport-dead for EVERY call
      const double = (payload: unknown): Response => ({
        ok: true, status: 200,
        headers: {get: () => null},
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as unknown as Response);
      if (method === 'sendTransaction') {
        // The "already" answer as the walk surfaces it: 2xx + JSON-RPC error body →
        // SolanaEndpointRefused('solana rpc: Transaction already processed').
        return double({jsonrpc: '2.0', id: 1, error: {code: -32000, message: 'Transaction already processed'}});
      }
      const result = (() => {
        switch (method) {
          case 'isBlockhashValid': return {context: {slot: request.slot + 1}, value: true};
          case 'getBlockHeight': return request.lvh - 10; // never past lvh → expiry gates never fire
          case 'getSignatureStatuses': return {context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]};
          case 'getTransaction': return txDetailFromMessage(canonicalFor(request));
          default: throw new Error(`unexpected rpc method ${method}`);
        }
      })();
      return double({jsonrpc: '2.0', id: 1, result});
    };
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
    const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
    let p: Promise<{status: number; rid: string; sig: string}> | undefined;
    try {
      delete g.__DPAY_TEST_SOLANA_RPC_URL; // undefined ⇒ constants falls through to the relay-derived list
      jest.isolateModules(() => {
        const constants = require('../config/constants');
        constants.setRelayBaseForSolana([DEAD, LIVE]); // the production two-home derivation
        const {broadcastSolPayment} = require('../solana');
        p = broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal);
      });
      const receipt = await p!;
      expect(receipt.status).toBe(RECEIPT_SETTLED); // NOT REJECTED — "already" is never a broadcast-time rejection
      expect(receipt.sig).toBe(sig);
      // The walk DID resubmit the broadcast to B after A died — that resubmit is the whole
      // scenario, and B's "already" answer came from a REAL 2xx JSON-RPC error body.
      const sends = volleys.filter(v => v.method === 'sendTransaction');
      expect(sends.map(v => v.home)).toEqual([DEAD, LIVE]);
      // Every other volley (freshness + confirm) also walked DEAD → LIVE.
      expect(volleys.every(v => v.home === DEAD || v.home === LIVE)).toBe(true);
      expect(volleys.some(v => v.method === 'getSignatureStatuses' && v.home === LIVE)).toBe(true);
    } finally {
      if (prev === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
      else g.__DPAY_TEST_SOLANA_RPC_URL = prev;
    }
  });

  test('settle gate: confirmed but getTransaction THROWS each poll → transient, keeps polling to deadline → UNREACHABLE (never a decline)', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10, // never past lvh → honest unknown at timeout
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => { throw new Error('solana rpc http 503'); },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal, {confirmTimeoutMs: 60, pollMs: 5}) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
    expect(receipt.sig).toBe(sig);
  });

  test('settle gate: confirmed but getTransaction returns null (pruned/unknown) → keeps polling to deadline → UNREACHABLE', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => null,
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal, {confirmTimeoutMs: 60, pollMs: 5}) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
    expect(receipt.sig).toBe(sig);
  });

  test('settle gate: confirmed body with the WRONG AMOUNT → MISMATCH (3) — never SETTLED, never a decline', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    // A different well-formed canonical (amount 9999999) — a tx that pays LESS than the request.
    const wrongAmount = canonicalFor(solReqV2({amt: '9999999', rid: 'd'.repeat(32)}));
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => txDetailFromMessage(wrongAmount),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_MISMATCH);
    expect(receipt.rid).toBe(request.rid);
    expect(receipt.sig).toBe(sig);
  });

  test('settle gate: confirmed body claims version 0 + addressTableLookups → MISMATCH (3)', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => txDetailFromMessage(canonicalFor(request), {message: {version: 0, addressTableLookups: [{accountKey: USDC_MINT, writableIndexes: [0], readonlyIndexes: []}]}}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_MISMATCH);
    expect(receipt.sig).toBe(sig);
  });

  test('settle gate: confirmed body carries meta.err → REJECTED (the chain failure record)', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
      getTransaction: () => txDetailFromMessage(canonicalFor(request), {meta: {err: {InstructionError: [1, 'CustomProgramError(3)']}}}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.sig).toBe(sig);
  });

  test('semantic reject: payment signed for a DIFFERENT request → REJECTED sig="", no sendTransaction', async () => {
    const requestA = solReqV2({amt: '2000000'});
    // Sign a payment for requestB (different amount) — its canonical message won't match requestA.
    const requestB = solReqV2({amt: '9999999', rid: 'c'.repeat(32)});
    const {payment} = signAndExtractSig(requestB);
    let sendCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => { sendCalls++; return 'must-not-be-called'; },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(requestA, buildUri(requestA), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.rid).toBe(requestA.rid);
    expect(receipt.sig).toBe('');
    expect(sendCalls).toBe(0);
  });

  test('pre-broadcast expiry: isBlockhashValid=false → REJECTED, no sendTransaction', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    let sendCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: false}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => { sendCalls++; return sig; },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.rid).toBe(request.rid);
    expect(receipt.sig).toBe(sig); // sig is trusted post-verify (step 5)
    expect(sendCalls).toBe(0);
  });

  test('pre-broadcast expiry: blockhash valid but height > lvh → REJECTED, no sendTransaction', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    let sendCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh + 50, // past the validity window
      sendTransaction: () => { sendCalls++; return sig; },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(sendCalls).toBe(0);
  });

  test('on-chain rejection: history status with err → REJECTED', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{err: {InstructionError: [0, 'InsufficientFunds']}}]}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.sig).toBe(sig);
  });

  test('sig-identity mismatch: sendTransaction returns a DIFFERENT sig → UNREACHABLE (honest unknown)', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => sig + 'MUTATED', // different from the verified tx sig
      getSignatureStatuses: () => ({context: {slot: 1}, value: [{confirmationStatus: 'confirmed'}]}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
    expect(receipt.sig).toBe(sig); // the LOCAL verified sig is the receipt identity
  });

  test('malformed payment: garbage tx → REJECTED sig="", no sendTransaction', async () => {
    const request = solReqV2();
    const garbage: SolPayV2 = {v: 2, rid: request.rid, tx: new Uint8Array([0xff, 0xff, 0xff])};
    let sendCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => { sendCalls++; return 'must-not-be-called'; },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), garbage, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.rid).toBe(request.rid);
    expect(receipt.sig).toBe('');
    expect(sendCalls).toBe(0);
  });

  test('authoritative expiry on confirm-timeout: height>lvh AND bh invalid AND history null → REJECTED', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    // Stateful stubs: pre-broadcast call (1st) returns fresh values so the broadcast proceeds;
    // subsequent calls during the confirm loop + timeout return expired values.
    let bhValidCalls = 0;
    let heightCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => { bhValidCalls++; return {context: {slot: request.slot + 50}, value: bhValidCalls === 1}; },
      getBlockHeight: () => { heightCalls++; return heightCalls === 1 ? request.lvh - 10 : request.lvh + 100; },
      sendTransaction: () => sig,
      // History-aware status is null (tx never landed) + contextSlot ≥ invalidityContextSlot.
      getSignatureStatuses: () => ({context: {slot: request.slot + 60}, value: [null]}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(
        request, buildUri(request), payment, new AbortController().signal,
        {confirmTimeoutMs: 50, pollMs: 5},
      ) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
    expect(receipt.sig).toBe(sig);
  });

  test('confirm-timeout INCONSISTENT (blockhash still valid) → UNREACHABLE (honest unknown)', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    // Stateful height: pre-broadcast returns fresh (height ≤ lvh → broadcast proceeds), confirm
    // loop returns expired (height > lvh). But isBlockhashValid ALWAYS returns true — the
    // inconsistency means we cannot authoritatively prove the blockhash is dead → honest unknown.
    let heightCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 50}, value: true}), // always valid!
      getBlockHeight: () => { heightCalls++; return heightCalls === 1 ? request.lvh - 10 : request.lvh + 100; },
      sendTransaction: () => sig,
      getSignatureStatuses: () => ({context: {slot: request.slot + 60}, value: [null]}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(
        request, buildUri(request), payment, new AbortController().signal,
        {confirmTimeoutMs: 50, pollMs: 5},
      ) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
    expect(receipt.sig).toBe(sig);
  });
});

describe('solana seam — sendSolanaPay (a scanned Solana Pay transfer)', () => {
  const REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const SOL_TRANSFER = {
    recipient: MERCHANT_ADDRESS,
    splToken: null as string | null,
    amount: 1_000_000n, // 0.001 SOL
    references: [REFERENCE],
    memo: 'order-42',
  };

  function solanaPayStub(broadcast: string, sent: string[] = []) {
    return {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: (params: unknown[]) => { sent.push(params[0] as string); return broadcast; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
  }

  test('offline (solanaRpcUrl() empty) throws without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {sendSolanaPay} = require('../solana');
    await expect(
      (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, SOL_TRANSFER),
    ).rejects.toThrow('offline');
    expect(called).toBe(false);
  });

  test('an unknown mint is refused before ANY rpc call — the scan surface named it first', async () => {
    let calls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => { calls++; return {context: {slot: 1}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1}}; },
    };
    await expect(withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, {
        ...SOL_TRANSFER, splToken: REFERENCE, // a valid pubkey, but not the USDC mint
      });
    })).rejects.toThrow(/spl-token/i);
    expect(calls).toBe(0);
  });

  test('SOL: memo FIRST + transfer carrying the reference key, in ONE broadcast', async () => {
    const sent: string[] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = solanaPayStub('SigSpaySol', sent);
    const sig = await withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, SOL_TRANSFER);
    });
    expect(sig).toBe('SigSpaySol');
    expect(sent).toHaveLength(1);
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    // SPL Memo instruction + System transfer = exactly 2 instructions, one transaction.
    expect(countInstructions(bytes)).toBe(2);
    // The merchant's reference pubkey rides the account table — the matching mechanism itself.
    expect(indexOfBytes(bytes, base58Decode32(REFERENCE))).toBeGreaterThanOrEqual(0);
    // The memo bytes ride their own instruction's data.
    expect(indexOfBytes(bytes, utf8ToBytes('order-42'))).toBeGreaterThanOrEqual(0);
  });

  test('SOL with NO memo and NO references is the plain two-key transfer (byte-compat with sendSol)', async () => {
    const sent: string[] = [];
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = solanaPayStub('SigSpayPlain', sent);
    await withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, {
        recipient: MERCHANT_ADDRESS, splToken: null, amount: 1_000_000n, references: [], memo: null,
      });
    });
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    expect(countInstructions(bytes)).toBe(1);
    expect(indexOfBytes(bytes, utf8ToBytes('order-42'))).toBe(-1);
  });

  test('USDC: transferChecked against the recipient ATA, reference key attached', async () => {
    const sent: string[] = [];
    let accountChecks = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      ...solanaPayStub('SigSpayUsdc', sent),
      // Both ATAs exist (sender first, recipient second) — no create instruction.
      getAccountInfo: () => {
        accountChecks++;
        return {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}};
      },
    };
    const sig = await withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, {
        ...SOL_TRANSFER, splToken: USDC_MINT, amount: 1_500_000n, // 1.5 USDC
      });
    });
    expect(sig).toBe('SigSpayUsdc');
    expect(accountChecks).toBe(2);
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    // memo + transferChecked; the recipient's ATA (not the wallet owner) is the transfer target.
    expect(countInstructions(bytes)).toBe(2);
    expect(indexOfBytes(bytes, deriveAta(MERCHANT_ADDRESS, USDC_MINT))).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(bytes, base58Decode32(REFERENCE))).toBeGreaterThanOrEqual(0);
  });

  test('USDC: a missing recipient ATA is created in the SAME tx, rent pre-checked (sendSpl parity)', async () => {
    const sent: string[] = [];
    let calls = 0;
    let broadcasts = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => {
        calls++;
        return calls === 1 ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}} : {value: null};
      },
      getBalance: () => ({value: 1000000000}), // 1 SOL ≥ rent+fee — the create is fundable
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: (params: unknown[]) => { broadcasts++; sent.push(params[0] as string); return 'SigSpayUsdcAta'; },
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    const sig = await withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer) => Promise<string>)(SEED_HEX, {
        ...SOL_TRANSFER, splToken: USDC_MINT,
      });
    });
    expect(sig).toBe('SigSpayUsdcAta');
    expect(broadcasts).toBe(1);
    // memo + createIdempotent + transferChecked = 3 instructions, one broadcast.
    const bytes = Uint8Array.from(Buffer.from(sent[0], 'base64'));
    expect(countInstructions(bytes)).toBe(3);
  });

  test('onBroadcast fires the moment the network accepts — a confirm failure still hands back the sig', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      sendTransaction: () => 'SigSpayUnknown',
      getSignatureStatuses: () => { throw new Error('rpc down'); },
    };
    const seen: string[] = [];
    await expect(withStubUrl(async () => {
      const {sendSolanaPay} = require('../solana');
      return (sendSolanaPay as (s: string, t: SolanaPayTransfer, sig?: AbortSignal, cb?: (x: string) => void) => Promise<string>)(
        SEED_HEX, SOL_TRANSFER, undefined, x => seen.push(x),
      );
    })).rejects.toThrow();
    expect(seen).toEqual(['SigSpayUnknown']);
  });
});

describe('solana seam — getSolanaHistory (classified at the seam, never thrown raw)', () => {
  // R3 (spec 2026-09-09 §"What the app says…"): a failing history read must not reach the UI as a
  // raw throw the hook swallows. The seam classifies the cause at the transport boundary — the
  // refusal BRAND first (the endpoint answered, did not serve us), then the offline/unreachable
  // oracle (driven hermetically here through `__DPAY_TEST_SOLANA_CONNECTIVITY`, so no probe fetch
  // ever runs) — and answers it as a value the hook can mark the list stale with. The ONE throw
  // left is an ABORT, which must survive the seam untouched.
  type Hist = {kind: string; rows?: unknown[]; dropped?: number; failure?: string};
  const readHistory = (url: string, signal?: AbortSignal) => {
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<Hist> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = url;
      const {getSolanaHistory} = require('../solana');
      p = (getSolanaHistory as (a: string, s?: AbortSignal) => Promise<Hist>)(MERCHANT_ADDRESS, signal);
    });
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    return p!;
  };
  const setConnectivity = (v: 'offline' | 'online') => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'}).__DPAY_TEST_SOLANA_CONNECTIVITY = v;
  };

  afterEach(() => {
    delete (globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'}).__DPAY_TEST_SOLANA_CONNECTIVITY;
  });

  test('offline (RPC URL empty) answers offline — no network, no dynamic import', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => { called = true; return Promise.resolve({}); });
    const {getSolanaHistory} = require('../solana');
    const r = await (getSolanaHistory as (a: string) => Promise<Hist>)(MERCHANT_ADDRESS);
    expect(r).toEqual({kind: 'offline'});
    expect(called).toBe(false); // the offline inner loop never reaches the network module
  });

  test('a clean read answers history with the reader\'s rows/dropped shape', async () => {
    // Empty pages: the reader's PARSING has its own suite (solana-history.test.ts); here only the
    // RESULT ENVELOPE is under test — a discriminated 'history' value, not a bare SolanaHistory.
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => [],
    };
    const r = await readHistory('https://hist-clean.example');
    expect(r).toEqual({kind: 'history', rows: [], dropped: 0});
  });

  test('an endpoint that REFUSES is refused — the brand outranks the oracle, no probe needed', async () => {
    // HTTP 429 is the exact answer the shipped key gives with its quota spent; the rpc client
    // throws its branded refusal and the seam maps the brand to 'refused'.
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() =>
      Promise.resolve({ok: false, status: 429, headers: {get: () => null}, text: () => Promise.resolve('max usage reached')} as unknown as Response));
    const r = await readHistory('https://hist-refusing.example');
    expect(r).toEqual({kind: 'error', failure: 'refused'});
  });

  test('a plain transport failure while the phone is OFFLINE is offline', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => { throw new Error('Network request failed'); },
    };
    setConnectivity('offline');
    const r = await readHistory('https://hist-offline.example');
    expect(r).toEqual({kind: 'error', failure: 'offline'});
  });

  test('a plain transport failure while the phone is ONLINE is unreachable', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => { throw new Error('Network request failed'); },
    };
    setConnectivity('online');
    const r = await readHistory('https://hist-unreachable.example');
    expect(r).toEqual({kind: 'error', failure: 'unreachable'});
  });

  test('an ABORTED signal rethrows untouched — a cancellation is not a rail fact', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignaturesForAddress: () => { throw new Error('aborted by test'); },
    };
    const ctrl = new AbortController();
    ctrl.abort();
    // NOT a classified value: the raw rejection itself must cross the seam (the override below
    // proves classification was available and deliberately not taken).
    setConnectivity('offline');
    await expect(readHistory('https://hist-abort.example', ctrl.signal)).rejects.toThrow('aborted by test');
  });
});
