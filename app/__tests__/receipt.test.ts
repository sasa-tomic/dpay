/**
 * MC4 U5 — independently-authenticated receipt. Unit tests for the three-check `verifyOutcomeReceipt`:
 *   (1) KEY PIN   — receipt.pubkey must equal the pinned EXPECTED_RECEIPT_PUBKEY (the malicious-relay
 *                   close); a fabricated key+sig+claim that is internally valid is STILL rejected.
 *   (2) SIGNATURE — the Ed25519 sig verifies under the (now-trustworthy) pubkey.
 *   (3) BINDING   — when `auth` is passed, receipt {from,to,amount,currency,nonce} must match the
 *                   signed authorization the payer holds (defense-in-depth vs a stale relay returning
 *                   a different settled payment's receipt).
 *
 * `verifyReceiptSig` (the FFI/web-shim Ed25519 verify) is mocked so the pin + binding are exercised
 * INDEPENDENTLY of the signature math (the cross-val + e2e cover the real sig). The pin is read from
 * `__DPAY_TEST_RECEIPT_PUBKEY` at module-load (mirrors the POLL override pattern), so each test loads
 * `receipt.ts` inside `jest.isolateModules` with the desired pin set.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';

jest.mock('../services/native', () => ({
  // The mock fn is (re)wired inside `loadWithPin` so each isolated module load gets a fresh fn whose
  // return value tracks the module-level `sigReturns` (read at CALL time, so a test can flip it).
  DpayCore: {verifyReceiptSig: jest.fn()},
  DpayNfc: {},
}));

// What the mocked verifyReceiptSig resolves to. Read at call time so a test toggles it per-case.
let sigReturns = true;
beforeEach(() => { sigReturns = true; });

/** Load `receipt.ts` with the given pin baked into constants (re-evaluates the module). */
function loadWithPin(pin: string): (receipt: any, auth?: any) => Promise<boolean> {
  let verifyOutcomeReceipt!: (receipt: any, auth?: any) => Promise<boolean>;
  jest.isolateModules(() => {
    if (pin) {
      (globalThis as any).__DPAY_TEST_RECEIPT_PUBKEY = pin;
    } else {
      delete (globalThis as any).__DPAY_TEST_RECEIPT_PUBKEY;
    }
    // isolateModules gives the mock factory a fresh run → grab the fresh fn + wire its behavior.
    const native = require('../services/native');
    native.DpayCore.verifyReceiptSig = jest.fn().mockImplementation(() => Promise.resolve(sigReturns));
    verifyOutcomeReceipt = require('../services/receipt').verifyOutcomeReceipt;
  });
  return verifyOutcomeReceipt;
}

// Canonical receipt + auth fixtures. The receipt is "valid" only when the mock attests its sig.
const PIN = 'a'.repeat(64);            // the pinned expected key
const FROM = '11'.repeat(32);
const TO = '22'.repeat(32);
const AMOUNT = '2500';                  // raw-u64 decimal string (MC1 units 2-4)
const CURRENCY = 0;
const NONCE = 'ff'.repeat(16);

function goodReceipt(overrides: Record<string, unknown> = {}) {
  return {
    nonce: NONCE, from: FROM, to: TO, amount: AMOUNT, currency: CURRENCY,
    block_index: '7', settle_ts: '1800000120',
    receipt_sig: 'c'.repeat(128), pubkey: PIN,
    ...overrides,
  };
}
const matchingAuth = {from: FROM, to: TO, amount: AMOUNT, currency: CURRENCY, nonce: NONCE};

describe('verifyOutcomeReceipt — (1) key pin: the malicious-relay close', () => {
  test('a wrong-key receipt is rejected EVEN WHEN the signature mock attests it valid', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true; // the relay forged an internally-valid key+sig+claim
    const attackerReceipt = goodReceipt({pubkey: 'b'.repeat(64)}); // ≠ pinned key
    expect(await verify(attackerReceipt)).toBe(false);
  });

  test('pinned key + valid sig → accepted', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt())).toBe(true);
  });

  test('empty pin (dev/unpinned fallback) trusts the embedded key + valid sig → accepted', async () => {
    const verify = loadWithPin('');
    sigReturns = true;
    // Any pubkey verifies under the empty-pin dev fallback (the current/e2e behavior preserved).
    expect(await verify(goodReceipt({pubkey: 'b'.repeat(64)}))).toBe(true);
  });

  test('empty pin + invalid sig → rejected (signature still enforced in dev mode)', async () => {
    const verify = loadWithPin('');
    sigReturns = false;
    expect(await verify(goodReceipt({pubkey: 'b'.repeat(64)}))).toBe(false);
  });

  test('pinned key but invalid sig → rejected (pin alone is not enough)', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = false;
    expect(await verify(goodReceipt())).toBe(false);
  });

  test('mixed-case pin still matches a different-case key (case-insensitive hex compare)', async () => {
    // The relay emits lowercase hex via `hex::encode`; a prod pin baked in mixed case must still
    // match the receipt's key. A case-sensitive compare would fail-closed ("Couldn't verify") on
    // EVERY receipt for a mixed-case pin — not a security hole, but operationally fragile. Precedent:
    // decidePayerReceipt already lower-cases its nonce compare. Covered both directions.
    const upperPin = 'A'.repeat(64); // same 32 bytes as PIN ('a'.repeat(64)), uppercased
    // (a) pin UPPER, receipt key LOWER → accepted
    const verifyUpper = loadWithPin(upperPin);
    sigReturns = true;
    expect(await verifyUpper(goodReceipt({pubkey: 'a'.repeat(64)}))).toBe(true);
    // (b) pin LOWER, receipt key UPPER → accepted
    const verifyLower = loadWithPin('a'.repeat(64));
    sigReturns = true;
    expect(await verifyLower(goodReceipt({pubkey: 'A'.repeat(64)}))).toBe(true);
  });
});

describe('verifyOutcomeReceipt — (2)+(3) signature + full-auth binding', () => {
  test('pinned + matching auth + valid sig → accepted', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt(), matchingAuth)).toBe(true);
  });

  test('amount mismatch (receipt ≠ auth) → rejected even with valid sig + pin', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({amount: '9999'}), matchingAuth)).toBe(false);
  });

  test('amount compares by magnitude, not lexicographically ("9999" vs "10000")', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    // A receipt for 9999 must not match an auth for 10000; a lexicographic compare would rank
    // "9999" > "10000" and could mislead — cmpRaw (BigInt) gets the equality check right.
    expect(await verify(goodReceipt({amount: '9999'}), {...matchingAuth, amount: '10000'})).toBe(false);
    expect(await verify(goodReceipt({amount: '10000'}), {...matchingAuth, amount: '10000'})).toBe(true);
  });

  test('from mismatch → rejected', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({from: '33'.repeat(32)}), matchingAuth)).toBe(false);
  });

  test('to mismatch → rejected', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({to: '44'.repeat(32)}), matchingAuth)).toBe(false);
  });

  test('currency mismatch → rejected', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({currency: 1}), matchingAuth)).toBe(false);
  });

  test('nonce mismatch → rejected (the stale-relay-returns-different-payment defense)', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({nonce: '00'.repeat(16)}), matchingAuth)).toBe(false);
  });

  test('no auth passed → binding skipped (back-compat), pin + sig still enforced', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt())).toBe(true);
  });
});

describe('verifyOutcomeReceipt — malformed inputs (never throws, never a fake true)', () => {
  test('missing receipt / non-object → false', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(null)).toBe(false);
    expect(await verify(undefined)).toBe(false);
    expect(await verify('not-an-object')).toBe(false);
  });

  test('missing sig or pubkey strings → false', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    expect(await verify(goodReceipt({receipt_sig: undefined}))).toBe(false);
    expect(await verify(goodReceipt({pubkey: 123}))).toBe(false);
  });

  test('a non-digit amount in the receipt is rejected, not a thrown crash', async () => {
    const verify = loadWithPin(PIN);
    sigReturns = true;
    // cmpRaw throws on non-digit; verifyOutcomeReceipt must translate that to `false`, not throw.
    expect(await verify(goodReceipt({amount: 'not-a-number'}), matchingAuth)).toBe(false);
  });
});
