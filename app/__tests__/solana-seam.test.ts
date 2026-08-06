/**
 * The SOL seam (`app/solana.ts`) isolation boundary. With the default jest state
 * (`__DPAY_TEST_SOLANA_RPC_URL=''`, set in jest.setup.js), the network functions must NO-OP
 * (balance → null, send → throw) WITHOUT importing the network module — so the offline inner loop
 * never touches devnet. The "configured" path is then exercised by overriding the global inside an
 * isolated module registry (mirrors walletconnect.test.ts) with a mocked fetch.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {decodeSolPay} from '../solana/qr';
import type {SolReq} from '../solana/qr';
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
      getLatestBlockhash: () => ({value: {blockhash: STORED_NONCE, lastValidBlockHeight: 100}}),
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
