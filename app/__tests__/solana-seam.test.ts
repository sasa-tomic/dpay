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
import {buildCanonicalUsdcMessage, deriveAta, ASSOCIATED_TOKEN_PROGRAM_ADDRESS} from '../solana/spl';
import {deriveSolanaKeypair} from '../solana/identity';
import {utf8ToBytes} from '../lib/base64url';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../solana/payments';
import type {SolanaRpcStub} from '../solana/rpc';
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

describe('solana seam — offline (SOLANA_RPC_URL empty)', () => {
  test('getSolanaBalance returns null without any network', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {getSolanaBalance} = require('../solana');
    const bal = await getSolanaBalance('AnyAddress');
    expect(bal).toBeNull();
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
  test('getSolanaBalance fetches via the rpc client', async () => {
    const mock = jest.fn(() =>
      Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({result: {value: 2500000000}})} as unknown as Response),
    );
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
    // Override the seam constant inside an isolated module registry so SOLANA_RPC_URL is non-empty.
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
    let p: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://rpc.test';
      const {getSolanaBalance} = require('../solana');
      p = getSolanaBalance('AddrX');
    });
    const b = await p;
    expect(b).toBe('2500000000');
    expect(mock).toHaveBeenCalled();
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
// `getSolanaUsdcBalance` returns a discriminated union that distinguishes the four states the plan
// (invariant #10) requires stay distinct: offline (no/invalid config), absent (ATA missing — KNOWN
// zero/empty), balance (have an exact amount string), error (RPC failure — transient/unverifiable).
// `isSolanaRpcAvailable` exposes RPC availability independently from relay `online` (invariant #9).
// ============================================================================

// A "mainnet-like" stub URL — does NOT match the `/devnet|testnet/i` regex (the existing
// `withStubUrl` uses 'https://stub.test' which DOES match → USDC would be incoherent there). Used
// only for the USDC-balance tests so `solanaUsdcAvailable()` returns true.
function withStubMainnetUrl<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
  let p: Promise<T> | undefined;
  jest.isolateModules(() => {
    g.__DPAY_TEST_SOLANA_RPC_URL = 'https://sol.example';
    p = fn();
  });
  g.__DPAY_TEST_SOLANA_RPC_URL = '';
  return p!;
}

describe('solana seam — getSolanaUsdcBalance (Phase 2 honest balances)', () => {
  test('returns {kind:"offline"} when SOLANA_RPC_URL is empty (no network, no dynamic import)', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {getSolanaUsdcBalance} = require('../solana');
    const r = await (getSolanaUsdcBalance as (s: string) => Promise<{kind: string}>)(SEED_HEX);
    expect(r).toEqual({kind: 'offline'});
    expect(called).toBe(false);
  });

  test('returns {kind:"absent"} when accountExists returns false (ATA missing on-chain)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: null}),
    };
    const r = await withStubMainnetUrl(async () => {
      const {getSolanaUsdcBalance} = require('../solana');
      return (getSolanaUsdcBalance as (s: string) => Promise<{kind: string; amount?: string}>)(SEED_HEX);
    });
    expect(r).toEqual({kind: 'absent'});
    expect('amount' in r).toBe(false); // absent carries no amount
  });

  test('returns {kind:"balance", amount, decimals} when ATA exists + getTokenAccountBalance succeeds', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '1234567', decimals: 6, uiAmount: 1.234567}}),
    };
    const r = await withStubMainnetUrl(async () => {
      const {getSolanaUsdcBalance} = require('../solana');
      return (getSolanaUsdcBalance as (s: string) => Promise<{kind: string; amount?: string; decimals?: number}>)(SEED_HEX);
    });
    expect(r).toEqual({kind: 'balance', amount: '1234567', decimals: 6});
    expect(typeof (r as {amount?: string}).amount).toBe('string');
  });

  test('preserves a large amount as an exact string (>2^53 — proves no number path)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'tok', lamports: 1}}),
      getTokenAccountBalance: () => ({value: {amount: '10000000000000000', decimals: 6, uiAmount: null}}),
    };
    const r = await withStubMainnetUrl(async () => {
      const {getSolanaUsdcBalance} = require('../solana');
      return (getSolanaUsdcBalance as (s: string) => Promise<{kind: string; amount?: string}>)(SEED_HEX);
    });
    expect(r).toEqual({kind: 'balance', amount: '10000000000000000', decimals: 6});
  });

  test('returns {kind:"error"} when the accountExists RPC fails (transient/unverifiable)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => { throw new Error('RPC node degraded'); },
    };
    const r = await withStubMainnetUrl(async () => {
      const {getSolanaUsdcBalance} = require('../solana');
      return (getSolanaUsdcBalance as (s: string) => Promise<{kind: string}>)(SEED_HEX);
    });
    expect(r).toEqual({kind: 'error'});
  });

  test('returns {kind:"error"} when getTokenAccountBalance fails after existence confirmed', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'tok', lamports: 1}}),
      getTokenAccountBalance: () => { throw new Error('account decoder error'); },
    };
    const r = await withStubMainnetUrl(async () => {
      const {getSolanaUsdcBalance} = require('../solana');
      return (getSolanaUsdcBalance as (s: string) => Promise<{kind: string}>)(SEED_HEX);
    });
    expect(r).toEqual({kind: 'error'});
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
describe('solana seam — sendSpl (Phase 6 USDC direct send)', () => {
  test('throws offline error when SOLANA_RPC_URL is empty', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {sendSpl} = require('../solana');
    await expect((sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n)).rejects.toThrow('offline');
    expect(called).toBe(false);
  });

  test('throws a clear error when the sender ATA is missing (fail-closed)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      // Every ATA check returns null → device has no USDC account.
      getAccountInfo: () => ({value: null}),
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
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
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
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
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
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
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
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
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
    })).rejects.toThrow(/your wallet|USDC account/i); // not "recipient"
  });
});

// ============================================================================
// createUsdcAta — the receiver-side one-tap USDC account setup (2026-08-14). One
// real AssociatedTokenProgram.createIdempotent instruction, signed LOCALLY with the
// device key, paid by the device's own SOL (rent + fee pre-checked against the
// ESTIMATE; the chain enforces the real value). Mirrors the sendSpl stub shape.
// ============================================================================
describe('solana seam — createUsdcAta (receiver-side one-tap setup)', () => {
  test('throws offline when SOLANA_RPC_URL is empty (no network import)', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {createUsdcAta} = require('../solana');
    await expect((createUsdcAta as (s: string) => Promise<string>)(SEED_HEX)).rejects.toThrow('not available');
    expect(called).toBe(false);
  });

  test('throws a friendly insufficient-SOL error (honest cost pre-check, no broadcast)', async () => {
    let balanceCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getBalance: () => { balanceCalls++; return {value: 1000000}; }, // 0.001 SOL < rent+fee
      sendTransaction: () => { throw new Error('must not broadcast'); },
    };
    await expect(withStubUrl(async () => {
      const {createUsdcAta} = require('../solana');
      return (createUsdcAta as (s: string) => Promise<string>)(SEED_HEX);
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
      const {createUsdcAta} = require('../solana');
      return (createUsdcAta as (s: string) => Promise<string>)(SEED_HEX);
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
      const {createUsdcAta} = require('../solana');
      return (createUsdcAta as (s: string) => Promise<string>)(SEED_HEX);
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
      const {createUsdcAta} = require('../solana');
      return (createUsdcAta as (s: string) => Promise<string>)(SEED_HEX);
    })).rejects.toThrow('rpc exploded mid-confirm');
  });
});

describe('solana seam — isSolanaRpcAvailable (independent of relay online)', () => {
  test('returns false when SOLANA_RPC_URL is empty (offline inner loop)', () => {
    const {isSolanaRpcAvailable} = require('../solana');
    expect((isSolanaRpcAvailable as () => boolean)()).toBe(false);
  });

  test('returns true when SOLANA_RPC_URL is non-empty', () => {
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
    const message = buildCanonicalUsdcMessage(publicKey, request);
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
      : buildCanonicalUsdcMessage(publicKey, request);
    const verify = verifySolPayment(message, payment);
    if (!verify.ok) throw new Error('test fixture: payment failed to verify');
    return {payment, sig: verify.signature};
  }

  test('happy path: freshness OK + sendTransaction returns verified sig + confirmed → SETTLED', async () => {
    const request = solReqV2();
    const {payment, sig} = signAndExtractSig(request);
    let sendCalls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB = {
      isBlockhashValid: () => ({context: {slot: request.slot + 1}, value: true}),
      getBlockHeight: () => request.lvh - 10,
      sendTransaction: () => { sendCalls++; return sig; },
      getSignatureStatuses: () => ({context: {slot: request.slot + 100}, value: [{confirmationStatus: 'confirmed'}]}),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_SETTLED);
    expect(receipt.rid).toBe(request.rid);
    expect(receipt.sig).toBe(sig);
    expect(sendCalls).toBe(1);
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

  test('offline (SOLANA_RPC_URL empty) throws without any network', async () => {
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
