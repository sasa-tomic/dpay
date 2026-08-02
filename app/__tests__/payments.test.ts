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
  isReceiptForRequest,
  RECEIPT_SETTLED,
  RECEIPT_REJECTED,
  RECEIPT_UNREACHABLE,
  receiptClaimBytes,
  RECEIPT_CLAIM_LEN,
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

describe('isReceiptForRequest', () => {
  // PR1 (goods-fraud guard): the merchant (reader) path must bind a settled receipt to the request's
  // nonce BEFORE trusting its signature. A malicious relay can replay any past valid canister-signed
  // receipt for a DIFFERENT payment — without this check the merchant would release goods on a stale
  // receipt. Mirrors decidePayerReceipt's case-insensitive compare but operates on the raw receipt
  // object the relay/FakeLedger emits (nonce under the `nonce` key).
  const NONCE = 'a1b2c3d4e5f600112233445566778899';

  it('receipt nonce matching the request nonce → true', () => {
    expect(isReceiptForRequest({nonce: NONCE}, NONCE)).toBe(true);
  });
  it('receipt nonce for a DIFFERENT payment → false (the goods-fraud guard)', () => {
    const other = '00000000000000000000000000000000';
    expect(isReceiptForRequest({nonce: other}, NONCE)).toBe(false);
  });
  it('nonce match is case-insensitive (mirrors decidePayerReceipt)', () => {
    expect(isReceiptForRequest({nonce: NONCE.toUpperCase()}, NONCE)).toBe(true);
  });
  it('empty expected nonce → false (defensive — nothing to bind the receipt to)', () => {
    expect(isReceiptForRequest({nonce: NONCE}, '')).toBe(false);
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

describe('receiptClaimBytes', () => {
  // Mirrors dpay_core::ReceiptClaim::signing_bytes (FROZEN 108-byte LE layout). Asserting the exact
  // bytes for a fixed input is the drift-detector against the Rust core; a layout change here MUST
  // be matched in dpay-core + the canister + the FakeLedger or receipt verification breaks.
  it('produces the canonical 108-byte LE encoding (nonce|from|to|amount|currency|block|ts)', () => {
    const nonceHex = '2a'.repeat(16);
    const fromHex = '11'.repeat(32);
    const toHex = '22'.repeat(32);
    const b = receiptClaimBytes({
      nonceHex, fromHex, toHex, amount: '2500', currency: 0, blockIndex: '7', settleTs: '1800000120',
    });
    expect(b.length).toBe(RECEIPT_CLAIM_LEN);
    expect(RECEIPT_CLAIM_LEN).toBe(108);
    // nonce then from then to (raw bytes).
    expect(Array.from(b.slice(0, 16))).toEqual(Array.from({length: 16}, () => 0x2a));
    expect(Array.from(b.slice(16, 48))).toEqual(Array.from({length: 32}, () => 0x11));
    expect(Array.from(b.slice(48, 80))).toEqual(Array.from({length: 32}, () => 0x22));
    // amount 2500 LE u64 at offset 80.
    const dv = new DataView(b.buffer);
    expect(dv.getBigUint64(80, true)).toBe(2500n);
    // currency 0 LE u32 at offset 88.
    expect(dv.getUint32(88, true)).toBe(0);
    // block_index 7 LE u64 at offset 92.
    expect(dv.getBigUint64(92, true)).toBe(7n);
    // settle_ts at offset 100.
    expect(dv.getBigUint64(100, true)).toBe(1800000120n);
  });
});
