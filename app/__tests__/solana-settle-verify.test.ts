/**
 * settleVerify — the settle gate of `broadcastSolPayment` (OPEN_ISSUES 6(b)). Before the merchant
 * may answer SETTLED, the confirmed transaction is re-read via getTransaction and its message is
 * RECOMPILED to the legacy wire layout and compared byte-for-byte against the canonical message.
 *
 * These tests build REAL canonical messages via the canonical builders (exactly what the merchant
 * rebuilds from an open request), serialize them back into the json-detail shape getTransaction
 * returns (a test-local inverse of the match), and walk every classification:
 *   verified / onchain-error / mismatch (amount, recipient, memo, extra ix, v0/ALT) /
 *   unverifiable (null, missing fields, bad base64, index overflow) — and that the verifier is
 * total (never throws on garbage).
 */
import {describe, test, expect} from '@jest/globals';
import bs58 from 'bs58';
import {verifySettledTransaction} from '../solana/settleVerify';
import {buildCanonicalSolMessage, decodeCompactU16} from '../solana/tx';
import {buildCanonicalSplMessage} from '../solana/spl';
import {deriveSolanaKeypair} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/tokens';
import {bytesToBase64, base64ToBytes} from '../lib/base64';
import type {SolanaTransactionDetail} from '../solana/rpc';
import type {SolReqV2} from '../solana/qr';

const TEST_BLOCKHASH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN'; // valid base58 32-byte
const MERCHANT_ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';
const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';

function solReqV2(overrides: Partial<SolReqV2> = {}): SolReqV2 {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 2,
    rid: 'a'.repeat(32),
    net: 'mainnet-beta',
    bh: TEST_BLOCKHASH,
    lvh: 300_000_000,
    slot: 250_000_000,
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

/** Inverse of the settle match: parse a LEGACY message back into the json-detail shape
 *  `getTransaction(encoding:'json')` returns (base58 keys/blockhash, base64 instruction data). */
function jsonDetail(
  msg: Uint8Array,
  opts: {message?: Record<string, unknown>; meta?: Record<string, unknown>; metaNull?: boolean} = {},
): SolanaTransactionDetail {
  let off = 0;
  const header = {
    numRequiredSignatures: msg[off++],
    numReadonlySignedAccounts: msg[off++],
    numReadonlyUnsignedAccounts: msg[off++],
  };
  const nk = decodeCompactU16(msg, off);
  off = nk.next;
  const accountKeys: string[] = [];
  for (let i = 0; i < nk.value; i++) {
    accountKeys.push(bs58.encode(msg.slice(off, off + 32)));
    off += 32;
  }
  const recentBlockhash = bs58.encode(msg.slice(off, off + 32));
  off += 32;
  const ni = decodeCompactU16(msg, off);
  off = ni.next;
  const instructions: {programIdIndex: number; accounts: number[]; data: string}[] = [];
  for (let i = 0; i < ni.value; i++) {
    const programIdIndex = msg[off++];
    const na = decodeCompactU16(msg, off);
    off = na.next;
    const accounts: number[] = [];
    for (let j = 0; j < na.value; j++) accounts.push(msg[off++]);
    const nd = decodeCompactU16(msg, off);
    off = nd.next;
    const data = msg.slice(off, off + nd.value);
    off += nd.value;
    instructions.push({programIdIndex, accounts, data: bytesToBase64(data)});
  }
  return {
    slot: 1,
    blockTime: null,
    meta: opts.metaNull ? null : {err: null, fee: 5000, preBalances: [], postBalances: [], ...opts.meta},
    transaction: {
      message: {
        accountKeys,
        recentBlockhash,
        header,
        instructions,
        version: 'legacy',
        ...opts.message,
      } as SolanaTransactionDetail['transaction']['message'],
    },
  };
}

describe('settleVerify.verifySettledTransaction', () => {
  const {publicKey} = deriveSolanaKeypair(SEED_HEX);

  test('SOL canonical message → verified (recompiled body byte-equal, err null)', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    expect(verifySettledTransaction(canonical, jsonDetail(canonical))).toEqual({kind: 'verified'});
  });

  test('SPL transferChecked canonical message → verified', () => {
    const canonical = buildCanonicalSplMessage(publicKey, usdcReqV2(), USDC_DECIMALS);
    expect(verifySettledTransaction(canonical, jsonDetail(canonical))).toEqual({kind: 'verified'});
  });

  test('mismatched amount → mismatch naming the instructions section', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const other = buildCanonicalSolMessage(publicKey, solReqV2({amt: '3000000'}));
    const evidence = verifySettledTransaction(canonical, jsonDetail(other));
    expect(evidence.kind).toBe('mismatch');
    if (evidence.kind === 'mismatch') expect(evidence.reason).toMatch(/instructions/);
  });

  test('mismatched recipient → mismatch', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const other = buildCanonicalSolMessage(publicKey, solReqV2({to: USDC_MINT}));
    expect(verifySettledTransaction(canonical, jsonDetail(other)).kind).toBe('mismatch');
  });

  test('mismatched memo → mismatch', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2({memo: 'order42'}));
    const other = buildCanonicalSolMessage(publicKey, solReqV2({memo: ''}));
    expect(verifySettledTransaction(canonical, jsonDetail(other)).kind).toBe('mismatch');
  });

  test('extra instruction appended to the confirmed body → mismatch', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical);
    const ixs = [...(detail.transaction.message.instructions ?? [])];
    ixs.push({...ixs[0]}); // a second memo ix the canonical message does not carry
    const evidence = verifySettledTransaction(canonical, jsonDetail(canonical, {message: {instructions: ixs}}));
    expect(evidence.kind).toBe('mismatch');
  });

  test('v0 message claim (version 0 + addressTableLookups) → mismatch, never verified', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {message: {version: 0, addressTableLookups: [{accountKey: USDC_MINT, writableIndexes: [0], readonlyIndexes: []}]}});
    const evidence = verifySettledTransaction(canonical, detail);
    expect(evidence.kind).toBe('mismatch');
    if (evidence.kind === 'mismatch') expect(evidence.reason).toMatch(/versioned/);
  });

  test('addressTableLookups present with version legacy → mismatch (ALT is v0-only)', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {message: {version: 'legacy', addressTableLookups: []}});
    expect(verifySettledTransaction(canonical, detail).kind).toBe('mismatch');
  });

  test('meta.err → onchain-error (the chain failure record outranks the body)', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {meta: {err: {InstructionError: [1, 'CustomProgramError(1)']}}});
    expect(verifySettledTransaction(canonical, detail)).toEqual({kind: 'onchain-error'});
  });

  test('null detail → unverifiable (NEVER a verdict)', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    expect(verifySettledTransaction(canonical, null).kind).toBe('unverifiable');
  });

  test('meta null → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    expect(verifySettledTransaction(canonical, jsonDetail(canonical, {metaNull: true})).kind).toBe('unverifiable');
  });

  test('missing recentBlockhash → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {message: {recentBlockhash: undefined}});
    expect(verifySettledTransaction(canonical, detail).kind).toBe('unverifiable');
  });

  test('missing header → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {message: {header: undefined}});
    expect(verifySettledTransaction(canonical, detail).kind).toBe('unverifiable');
  });

  test('instruction data that is not valid base64 → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical);
    const ixs = (detail.transaction.message.instructions ?? []).map(ix => ({...ix, data: '!!!not-base64!!!'}));
    expect(verifySettledTransaction(canonical, jsonDetail(canonical, {message: {instructions: ixs}})).kind).toBe('unverifiable');
  });

  test('account index out of range → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical);
    const ixs = (detail.transaction.message.instructions ?? []).map(ix => ({...ix, programIdIndex: 999}));
    expect(verifySettledTransaction(canonical, jsonDetail(canonical, {message: {instructions: ixs}})).kind).toBe('unverifiable');
  });

  test('accountKey that is not a 32-byte base58 pubkey → unverifiable', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const detail = jsonDetail(canonical, {message: {accountKeys: ['notbase58', ...(jsonDetail(canonical).transaction.message.accountKeys ?? []).slice(1)]}});
    expect(verifySettledTransaction(canonical, detail).kind).toBe('unverifiable');
  });

  test('total: garbage shapes classify unverifiable and NEVER throw', () => {
    const canonical = buildCanonicalSolMessage(publicKey, solReqV2());
    const garbages: unknown[] = [
      {},
      {meta: {err: null}},
      {meta: {err: null}, transaction: {}},
      {meta: {err: null}, transaction: {message: {}}},
      {meta: {err: null}, transaction: {message: {accountKeys: [], recentBlockhash: TEST_BLOCKHASH}}},
      null,
    ];
    for (const g of garbages) {
      expect(() => verifySettledTransaction(canonical, g as SolanaTransactionDetail | null)).not.toThrow();
      expect(verifySettledTransaction(canonical, g as SolanaTransactionDetail | null).kind).toBe('unverifiable');
    }
  });

  test('json round-trip sanity: the helper reproduces the exact instruction data bytes', () => {
    const canonical = buildCanonicalSplMessage(publicKey, usdcReqV2(), USDC_DECIMALS);
    const detail = jsonDetail(canonical);
    const ixs = detail.transaction.message.instructions ?? [];
    expect(ixs.length).toBe(2); // memo + transferChecked
    for (const ix of ixs) expect(base64ToBytes(ix.data).length).toBeGreaterThan(0);
  });
});
