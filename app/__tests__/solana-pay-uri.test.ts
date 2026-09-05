import {describe, test, expect} from '@jest/globals';
import bs58 from 'bs58';
import {buildSolanaPayUri, createSolanaPayReference} from '../solana/payUri';

const ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REF = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('buildSolanaPayUri', () => {
  test('reference only', () => {
    expect(buildSolanaPayUri(ADDR, {reference: REF})).toBe(`solana:${ADDR}?reference=${REF}`);
  });

  test('amount + reference (spec order: amount before reference)', () => {
    expect(buildSolanaPayUri(ADDR, {amount: '1.5', reference: REF})).toBe(
      `solana:${ADDR}?amount=1.5&reference=${REF}`,
    );
  });

  test('spl-token + reference', () => {
    expect(buildSolanaPayUri(ADDR, {splToken: MINT, reference: REF})).toBe(
      `solana:${ADDR}?spl-token=${MINT}&reference=${REF}`,
    );
  });

  test('all params in spec order: amount, spl-token, reference', () => {
    expect(buildSolanaPayUri(ADDR, {amount: '0.000000001', splToken: MINT, reference: REF})).toBe(
      `solana:${ADDR}?amount=0.000000001&spl-token=${MINT}&reference=${REF}`,
    );
  });

  test('no params', () => {
    expect(buildSolanaPayUri(ADDR, {})).toBe(`solana:${ADDR}`);
    expect(buildSolanaPayUri(ADDR)).toBe(`solana:${ADDR}`);
  });

  test('null params are omitted', () => {
    expect(buildSolanaPayUri(ADDR, {amount: null, splToken: null, reference: null})).toBe(`solana:${ADDR}`);
  });

  test('rejects a malformed recipient', () => {
    expect(() => buildSolanaPayUri('0x1234567890abcdef', {reference: REF})).toThrow(/recipient/);
    expect(() => buildSolanaPayUri('short', {reference: REF})).toThrow(/recipient/);
  });

  test('rejects a malformed spl-token', () => {
    expect(() => buildSolanaPayUri(ADDR, {splToken: 'not-a-mint!!', reference: REF})).toThrow(/spl-token/);
  });

  test('rejects a malformed reference', () => {
    expect(() => buildSolanaPayUri(ADDR, {reference: 'not-a-pubkey!!'})).toThrow(/reference/);
  });

  test('rejects non-decimal amounts', () => {
    for (const bad of ['1e9', '-1', '1.', '.5', '12a', '1 2']) {
      expect(() => buildSolanaPayUri(ADDR, {amount: bad, reference: REF})).toThrow(/amount/);
    }
  });

  test('rejects a non-string amount passed from JS', () => {
    expect(() => buildSolanaPayUri(ADDR, {amount: 1.5 as unknown as string, reference: REF})).toThrow(/amount/);
  });
});

describe('createSolanaPayReference', () => {
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  test('returns a valid base58 32-byte pubkey', () => {
    const ref = createSolanaPayReference();
    expect(BASE58.test(ref)).toBe(true);
    expect(bs58.decode(ref).length).toBe(32);
  });

  test('two references differ (fresh keypair per call)', () => {
    expect(createSolanaPayReference()).not.toBe(createSolanaPayReference());
  });

  test('the reference decodes to a real ed25519 public key (a Solana Pay reference keypair)', async () => {
    const {ed25519} = await import('@noble/curves/ed25519');
    const ref = createSolanaPayReference();
    expect(() => ed25519.ExtendedPoint.fromHex(bs58.decode(ref))).not.toThrow();
  });
});
