/**
 * Unit tests for the pure settlement-outcome logic. These are the money-critical branches that,
 * when wrong, made the app report failures on settled payments and successes on unsettled ones.
 * No react-native / native deps here, so this runs on the fast inner loop (`npx jest payments`).
 */
import {describe, it, expect} from '@jest/globals';
import {
  receiptCodeFor,
  decidePayerReceipt,
  RECEIPT_SETTLED,
  RECEIPT_REJECTED,
  RECEIPT_UNREACHABLE,
} from '../payments';

// (classifyPayHttp / rejectionMessage / isNonceReused / withdrawRejectionMessage /
// isReceiptForRequest / RECEIPT_CLAIM_LEN retired with the facade rail — rejection classification
// on the IC rail lives in services/rail.ts transferRejectionMessage/ingressRejectMessage.)

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

