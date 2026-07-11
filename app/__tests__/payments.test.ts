/**
 * Unit tests for the pure settlement-outcome logic. These are the money-critical branches that,
 * when wrong, made the app report failures on settled payments and successes on unsettled ones.
 * No react-native / native deps here, so this runs on the fast inner loop (`npx jest payments`).
 */
import {describe, it, expect} from '@jest/globals';
import {
  classifyPayHttp,
  receiptCodeFor,
  decidePayerReceipt,
  rejectionMessage,
  isNonceReused,
  RECEIPT_SETTLED,
  RECEIPT_REJECTED,
  RECEIPT_UNREACHABLE,
} from '../payments';

describe('classifyPayHttp', () => {
  it('2xx is settled', () => {
    expect(classifyPayHttp({ok: true, status: 200})).toBe('settled');
  });
  it('422 is a definitive rejection', () => {
    expect(classifyPayHttp({ok: false, status: 422})).toBe('rejected');
  });
  it('503 (ledger unavailable) is UNKNOWN, not a failure — the ledger may have committed', () => {
    expect(classifyPayHttp({ok: false, status: 503})).toBe('unknown');
  });
  it('500 and other non-2xx are unknown', () => {
    expect(classifyPayHttp({ok: false, status: 500})).toBe('unknown');
    expect(classifyPayHttp({ok: false, status: 0})).toBe('unknown');
  });
  it('a thrown fetch (null) is unknown — must be reconciled, never reported failed', () => {
    expect(classifyPayHttp(null)).toBe('unknown');
  });
});

describe('receiptCodeFor', () => {
  it('maps each outcome to the payer-facing code', () => {
    expect(receiptCodeFor('settled')).toBe(RECEIPT_SETTLED);
    expect(receiptCodeFor('rejected')).toBe(RECEIPT_REJECTED);
    expect(receiptCodeFor('unknown')).toBe(RECEIPT_UNREACHABLE);
  });
});

describe('decidePayerReceipt', () => {
  const NONCE = 'a1b2c3d4e5f600112233445566778899';

  it('settled receipt for the signed nonce → success', () => {
    expect(decidePayerReceipt({status: RECEIPT_SETTLED, nonceHex: NONCE}, NONCE)).toBe('success');
  });
  it('rejected receipt for the signed nonce → declined', () => {
    expect(decidePayerReceipt({status: RECEIPT_REJECTED, nonceHex: NONCE}, NONCE)).toBe('declined');
  });
  it('UNREACHABLE → pending, NOT declined (the fix for false "declined" reports)', () => {
    expect(decidePayerReceipt({status: RECEIPT_UNREACHABLE, nonceHex: NONCE}, NONCE)).toBe('pending');
  });
  it('a receipt for a DIFFERENT nonce is ignored (never believed for our payment)', () => {
    const other = '00000000000000000000000000000000';
    expect(decidePayerReceipt({status: RECEIPT_SETTLED, nonceHex: other}, NONCE)).toBe('ignore');
    expect(decidePayerReceipt({status: RECEIPT_REJECTED, nonceHex: other}, NONCE)).toBe('ignore');
  });
  it('nonce match is case-insensitive', () => {
    expect(decidePayerReceipt({status: RECEIPT_SETTLED, nonceHex: NONCE.toUpperCase()}, NONCE)).toBe('success');
  });
  it('no signed nonce → ignore (we have nothing to match against)', () => {
    expect(decidePayerReceipt({status: RECEIPT_SETTLED, nonceHex: NONCE}, '')).toBe('ignore');
  });
});

describe('rejectionMessage', () => {
  it('maps the relay policy errors to human lines', () => {
    expect(rejectionMessage('InsufficientFunds')).toBe('Not enough balance');
    expect(rejectionMessage('rejected: Expired')).toBe('The request expired');
    expect(rejectionMessage('OverCap')).toBe('Amount over the limit');
    expect(rejectionMessage('BadSignature')).toBe('Invalid signature');
    expect(rejectionMessage('anything else')).toBe('The ledger declined the payment');
    expect(rejectionMessage(null)).toBe('The ledger declined the payment');
  });
});

describe('isNonceReused', () => {
  it('detects the already-settled signal (not a real refusal)', () => {
    expect(isNonceReused('NonceReused')).toBe(true);
    expect(isNonceReused('rejected: NonceReused')).toBe(true);
    expect(isNonceReused('InsufficientFunds')).toBe(false);
    expect(isNonceReused(null)).toBe(false);
  });
});
