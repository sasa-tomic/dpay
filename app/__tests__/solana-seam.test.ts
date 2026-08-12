/**
 * The SOL seam (`app/solana.ts`) isolation boundary. With the default jest state
 * (`__DPAY_TEST_SOLANA_RPC_URL=''`, set in jest.setup.js), the network functions must NO-OP
 * (balance → null, send → throw) WITHOUT importing the network module — so the offline inner loop
 * never touches devnet. The "configured" path is then exercised by overriding the global inside an
 * isolated module registry (mirrors walletconnect.test.ts) with a mocked fetch.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {decodeSolPay} from '../solana/qr_v1';
import type {SolReq} from '../solana/qr_v1';
import {encodeSolReq, decodeSolReq} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {buildCanonicalSolMessage, verifySolPayment} from '../solana/tx';
import {buildCanonicalUsdcMessage} from '../solana/spl';
import {deriveSolanaKeypair} from '../solana/identity';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';
import type {SolanaRpcStub} from '../solana/rpc';

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
});

// --- fixtures (shared with the U1/U2 goldens) ---
const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const NONCE_ACCOUNT_ADDRESS = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';
const MERCHANT_ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const STORED_NONCE = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';

const SOL_REQ: SolReq = {
  v: 1, to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL',
  mint: null, toAta: null, exp: 1893456000, name: 'Test', memo: '',
};
const USDC_REQ: SolReq = {
  v: 1, to: MERCHANT_ADDRESS, amt: '1000000', cur: 'USDC',
  mint: USDC_MINT, toAta: MERCHANT_USDC_ATA, exp: 1893456000, name: 'Test', memo: '',
};

// --- stub helpers ---
import type Bs58 from 'bs58';
const bs58 = (require('bs58').default ?? require('bs58')) as typeof Bs58;

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

function buildNonceAccountData(authorityB58: string, nonceValueB58: string): string {
  const authority = bs58.decode(authorityB58);
  const nonceValue = bs58.decode(nonceValueB58);
  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 1, true);
  buf.set(authority, 8);
  buf.set(nonceValue, 40);
  dv.setBigUint64(72, 5000n, true);
  return bytesToBase64(buf);
}

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
});

// ============================================================================
// Offline-pay lifecycle — the U5 additions (signOffline / createNonce / broadcast / resync).
// ============================================================================

describe('solana seam — offline sign (PURE, no RPC)', () => {
  test('signOfflineSolPayment returns a decodable solpay: URI', () => {
    const {signOfflineSolPayment} = require('../solana');
    const uri = signOfflineSolPayment(SEED_HEX, SOL_REQ, NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    expect(uri.startsWith('solpay:v1?')).toBe(true);
    const decoded = decodeSolPay(uri);
    expect(decoded.cur).toBe('SOL');
    expect(decoded.to).toBe(MERCHANT_ADDRESS);
    expect(decoded.amt).toBe('2000000');
    expect(decoded.npub).toBe(NONCE_ACCOUNT_ADDRESS);
    expect(decoded.tx.length).toBeGreaterThan(64);
    expect(decoded.tx[0]).toBe(1); // compact-u16(1) — single signer
  });

  test('signOfflineSolPayment does not touch the network', () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {signOfflineSolPayment} = require('../solana');
    signOfflineSolPayment(SEED_HEX, SOL_REQ, NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    expect(called).toBe(false);
  });

  test('signOfflineSolPayment throws on wrong currency', () => {
    const {signOfflineSolPayment} = require('../solana');
    expect(() => signOfflineSolPayment(SEED_HEX, USDC_REQ, NONCE_ACCOUNT_ADDRESS, STORED_NONCE)).toThrow();
  });

  test('signOfflineSplPayment returns a decodable solpay: URI for USDC', () => {
    const {signOfflineSplPayment} = require('../solana');
    const uri = signOfflineSplPayment(SEED_HEX, USDC_REQ, NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    expect(uri.startsWith('solpay:v1?')).toBe(true);
    const decoded = decodeSolPay(uri);
    expect(decoded.cur).toBe('USDC');
    expect(decoded.npub).toBe(NONCE_ACCOUNT_ADDRESS);
    expect(decoded.tx[0]).toBe(1);
  });

  test('signOfflineSplPayment throws on SOL currency', () => {
    const {signOfflineSplPayment} = require('../solana');
    expect(() => signOfflineSplPayment(SEED_HEX, SOL_REQ, NONCE_ACCOUNT_ADDRESS, STORED_NONCE)).toThrow();
  });
});

describe('solana seam — online lifecycle offline guard', () => {
  test('createNonceAccount throws when offline', async () => {
    const {createNonceAccount} = require('../solana');
    await expect(createNonceAccount(SEED_HEX)).rejects.toThrow('offline');
  });

  test('broadcastSolPayment throws when offline', async () => {
    const {broadcastSolPayment} = require('../solana');
    await expect(broadcastSolPayment({
      v: 1, to: MERCHANT_ADDRESS, amt: '1', cur: 'SOL',
      npub: NONCE_ACCOUNT_ADDRESS, tx: new Uint8Array(65),
    })).rejects.toThrow('offline');
  });

  test('resyncNonce throws when offline', async () => {
    const {resyncNonce} = require('../solana');
    await expect(resyncNonce(NONCE_ACCOUNT_ADDRESS)).rejects.toThrow('offline');
  });
});

describe('solana seam — configured lifecycle (stub RPC)', () => {
  test('createNonceAccount returns address + value', async () => {
    const accountData = buildNonceAccountData(NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: STORED_NONCE, lastValidBlockHeight: 100}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'FakeSigBase58',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      getAccountInfo: () => ({
        value: {data: [accountData, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680},
      }),
    };
    const result = await withStubUrl(async () => {
      const {createNonceAccount} = require('../solana');
      return createNonceAccount(SEED_HEX) as Promise<{address: string; value: string}>;
    });
    expect(result.address.length).toBeGreaterThanOrEqual(32);
    expect(result.value).toBe(STORED_NONCE);
  });

  test('broadcastSolPayment settles and returns the advanced nonce', async () => {
    const accountData = buildNonceAccountData(NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => 'SettledSig',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      getAccountInfo: () => ({
        value: {data: [accountData, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680},
      }),
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment({
        v: 1, to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL',
        npub: NONCE_ACCOUNT_ADDRESS, tx: new Uint8Array(129),
      }) as Promise<{status: number; npub: string; nextNonce: string | null; sig: string | null}>;
    });
    expect(receipt.status).toBe(RECEIPT_SETTLED);
    expect(receipt.npub).toBe(NONCE_ACCOUNT_ADDRESS);
    expect(receipt.nextNonce).toBe(STORED_NONCE);
    expect(receipt.sig).toBe('SettledSig');
  });

  test('broadcastSolPayment classifies an InstructionError as rejected', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => {
        throw new Error('InstructionError: InsufficientFunds');
      },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment({
        v: 1, to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL',
        npub: NONCE_ACCOUNT_ADDRESS, tx: new Uint8Array(129),
      }) as Promise<{status: number}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
  });

  test('broadcastSolPayment classifies an unfunded-account "no record of a prior credit" as rejected (not unreachable)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => {
        throw new Error('solana rpc: Transaction simulation failed: Attempt to debit on account but found no record of a prior credit');
      },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment({
        v: 1, to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL',
        npub: NONCE_ACCOUNT_ADDRESS, tx: new Uint8Array(129),
      }) as Promise<{status: number}>;
    });
    expect(receipt.status).toBe(RECEIPT_REJECTED);
  });

  test('broadcastSolPayment classifies a network error as unreachable', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      sendTransaction: () => {
        throw new Error('network error: ECONNREFUSED');
      },
    };
    const receipt = await withStubUrl(async () => {
      const {broadcastSolPayment} = require('../solana');
      return broadcastSolPayment({
        v: 1, to: MERCHANT_ADDRESS, amt: '2000000', cur: 'SOL',
        npub: NONCE_ACCOUNT_ADDRESS, tx: new Uint8Array(129),
      }) as Promise<{status: number}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
  });

  test('resyncNonce returns the current nonce value', async () => {
    const accountData = buildNonceAccountData(NONCE_ACCOUNT_ADDRESS, STORED_NONCE);
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({
        value: {data: [accountData, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680},
      }),
    };
    const value = await withStubUrl(async () => {
      const {resyncNonce} = require('../solana');
      return resyncNonce(NONCE_ACCOUNT_ADDRESS) as Promise<string>;
    });
    expect(value).toBe(STORED_NONCE);
  });
});

// F4 — USDC ATA existence gate. The seam derives the device's USDC ATA (from the seed + USDC mint) and
// checks on-chain existence via getAccountInfo. Offline (RPC URL empty) it MUST no-op → null (never
// throws, never touches the network), mirroring getSolanaBalance. With a stub it returns the boolean.
describe('solana seam — checkUsdcAta (F4 ATA gate)', () => {
  test('returns null offline (no network) — mirrors getSolanaBalance', async () => {
    let called = false;
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(() => {
      called = true;
      return Promise.resolve({});
    });
    const {checkUsdcAta} = require('../solana');
    const result = await (checkUsdcAta as (s: string) => Promise<boolean | null>)(SEED_HEX);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test('returns true when the device ATA exists on-chain (stub)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
    };
    const result = await withStubUrl(async () => {
      const {checkUsdcAta} = require('../solana');
      return (checkUsdcAta as (s: string) => Promise<boolean | null>)(SEED_HEX);
    });
    expect(result).toBe(true);
  });

  test('returns false when the device ATA does NOT exist on-chain (stub returns null)', async () => {
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => ({value: null}),
    };
    const result = await withStubUrl(async () => {
      const {checkUsdcAta} = require('../solana');
      return (checkUsdcAta as (s: string) => Promise<boolean | null>)(SEED_HEX);
    });
    expect(result).toBe(false);
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
// Fail-closed: the device's source ATA + the recipient's ATA must BOTH exist on-chain
// (the Token program rejects transfers to a non-existent account — pre-checking saves
// the user a failed-fee confusion; a TOCTOU race is fine — the confirm path succeeds on
// re-submit). Reuses the byte-exact buildSplTransferInstruction (proven in solana-spl.test.ts).
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

  test('throws a clear error when the recipient ATA is missing (fail-closed)', async () => {
    // First getAccountInfo call (sender ATA) returns funded; second (recipient ATA) returns null.
    let calls = 0;
    (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
      getAccountInfo: () => {
        calls++;
        return calls === 1 ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}} : {value: null};
      },
    };
    await expect(withStubUrl(async () => {
      const {sendSpl} = require('../solana');
      return (sendSpl as (s: string, d: string, a: bigint) => Promise<string>)(SEED_HEX, MERCHANT_ADDRESS, 1_000_000n);
    })).rejects.toThrow(/recipient/i);
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

describe('solana seam — broadcastSolPaymentV2 (money-critical freshness state machine)', () => {
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(requestA, buildUri(requestA), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), payment, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(request, buildUri(request), garbage, new AbortController().signal) as Promise<{status: number; rid: string; sig: string}>;
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(
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
      const {broadcastSolPaymentV2} = require('../solana');
      return broadcastSolPaymentV2(
        request, buildUri(request), payment, new AbortController().signal,
        {confirmTimeoutMs: 50, pollMs: 5},
      ) as Promise<{status: number; rid: string; sig: string}>;
    });
    expect(receipt.status).toBe(RECEIPT_UNREACHABLE);
    expect(receipt.sig).toBe(sig);
  });
});
