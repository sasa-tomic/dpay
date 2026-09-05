import {describe, test, expect} from '@jest/globals';
import bs58 from 'bs58';
import {buildSolanaPayUri, createSolanaPayReference, parseSolanaPayUri} from '../solana/payUri';

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

describe('parseSolanaPayUri — a merchant QR this wallet must be able to PAY', () => {
  test('round-trip: what buildSolanaPayUri emits, parseSolanaPayUri reads back', () => {
    const uri = buildSolanaPayUri(ADDR, {amount: '1.5', splToken: MINT, reference: REF});
    expect(parseSolanaPayUri(uri)).toEqual({
      ok: true,
      request: {recipient: ADDR, amount: '1.5', splToken: MINT, references: [REF], label: null, message: null, memo: null},
    });
  });

  test('the full spec: every parameter, in whatever order the merchant printed', () => {
    const uri = `solana:${ADDR}?spl-token=${MINT}&message=Order%2042&reference=${REF}&label=Coffee%20Bar&amount=0.001&memo=order-42`;
    expect(parseSolanaPayUri(uri)).toEqual({
      ok: true,
      request: {recipient: ADDR, amount: '0.001', splToken: MINT, references: [REF], label: 'Coffee Bar', message: 'Order 42', memo: 'order-42'},
    });
  });

  test('reference may repeat — the standard allows one-or-more, and all are kept in order', () => {
    const second = createSolanaPayReference();
    const parsed = parseSolanaPayUri(`solana:${ADDR}?amount=1&reference=${REF}&reference=${second}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.references).toEqual([REF, second]);
  });

  test('an UPPERCASE scheme parses — QR encoders uppercase', () => {
    const parsed = parseSolanaPayUri(`SOLANA:${ADDR}?amount=1`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.recipient).toBe(ADDR);
  });

  test('a bare solana:ADDR (no query) parses with every optional absent', () => {
    expect(parseSolanaPayUri(`solana:${ADDR}`)).toEqual({
      ok: true,
      request: {recipient: ADDR, amount: null, splToken: null, references: [], label: null, message: null, memo: null},
    });
  });

  test('the amount-less receive QR this wallet itself emits parses to a reviewable request', () => {
    // The read-back contract: the receive tab's own QR is `solana:<addr>?reference=<ref>` — no
    // amount. Parsing must succeed so the review (which owns amount entry) can open.
    const uri = buildSolanaPayUri(ADDR, {reference: createSolanaPayReference()});
    const parsed = parseSolanaPayUri(uri);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.amount).toBeNull();
  });

  test('whitespace around the code is tolerated (camera payloads carry it)', () => {
    const parsed = parseSolanaPayUri(`  solana:${ADDR}?amount=1  `);
    expect(parsed.ok).toBe(true);
  });

  test.each([
    ['a valueless parameter', `solana:${ADDR}?amount`],
    ['an empty piece', `solana:${ADDR}?amount=1&`],
    ['a piece with no =', `solana:${ADDR}?amount=1&label`],
    ['an empty key', `solana:${ADDR}?amount=1&=2`],
    ['a repeated non-reference parameter', `solana:${ADDR}?amount=1&amount=2`],
    ['a broken %-escape', `solana:${ADDR}?label=Caf%e9`],
    ['the transaction-request form (a URL body)', `solana:https://pay.example/tx`],
  ])('malformed-uri: %s', (_label, uri) => {
    expect(parseSolanaPayUri(uri)).toEqual({ok: false, reason: 'malformed-uri'});
  });

  test.each([
    ['not base58 at all', 'solana:0OIlI1l0O'],
    ['base58 charset but wrong length', `solana:${'2'.repeat(31)}`],
  ])('bad-recipient: %s', (_label, uri) => {
    expect(parseSolanaPayUri(uri)).toEqual({ok: false, reason: 'bad-recipient'});
  });

  test.each(['1e9', '-1', '1.', '.5', '12a', '0', '0.000', '1 2'])('bad-amount: %s', amount => {
    const parsed = parseSolanaPayUri(`solana:${ADDR}?amount=${amount}`);
    expect(parsed).toEqual({ok: false, reason: 'bad-amount'});
  });

  test('bad-spl-token names the parameter, not the code', () => {
    expect(parseSolanaPayUri(`solana:${ADDR}?spl-token=not-a-mint!!`)).toEqual({ok: false, reason: 'bad-spl-token'});
  });

  test('bad-reference names the parameter, not the code', () => {
    expect(parseSolanaPayUri(`solana:${ADDR}?reference=not-a-pubkey!!`)).toEqual({ok: false, reason: 'bad-reference'});
  });

  test('unexpected-parameter carries WHICH parameter — the refusal names it', () => {
    expect(parseSolanaPayUri(`solana:${ADDR}?amount=1&residual=1`)).toEqual({ok: false, reason: 'unexpected-parameter', param: 'residual'});
  });

  test('memo-too-long: a memo past the 64-byte instruction budget is refused at scan, not broadcast', () => {
    expect(parseSolanaPayUri(`solana:${ADDR}?memo=${'a'.repeat(64)}`).ok).toBe(true);
    expect(parseSolanaPayUri(`solana:${ADDR}?memo=${'a'.repeat(65)}`)).toEqual({ok: false, reason: 'memo-too-long'});
    // Bytes, not characters: two-byte UTF-8 halves the character budget.
    expect(parseSolanaPayUri(`solana:${ADDR}?memo=${encodeURIComponent('é'.repeat(32))}`).ok).toBe(true);
    expect(parseSolanaPayUri(`solana:${ADDR}?memo=${encodeURIComponent('é'.repeat(33))}`).ok).toBe(false);
  });
});
