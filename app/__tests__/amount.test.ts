import { describe, test, expect } from '@jest/globals';
import {
  parseDecimalToUnits,
  cmpRaw,
  applyOffline,
  nettedWireRaw,
} from '../lib/amount';

// Mirrors `dpay_core::{parse_decimal_to_units, format_units_to_decimal}` and the Python FFI round-
// trip (`test_ffi.py` §9). The Rust core is canonical; this jest suite exercises the REAL TS module
// (the e2e cross-val `00-cross-val.mjs` adds the Rust-golden parity pin). Raw u64 is carried as a
// decimal-digit STRING everywhere — the whole point of MC1 is to never round a u64 through `number`.

describe('parseDecimalToUnits — exact BigInt (no Number loss)', () => {
  test('"8.4" at 18 decimals → 8.4e18 (would be WRONG via Number)', () => {
    // 8.4e18 > 2^53; parseFloat("8.4")*1e18 would not equal this. BigInt is exact.
    expect(parseDecimalToUnits('8.4', 18)).toEqual({ ok: true, raw: '8400000000000000000' });
  });

  test('2^53 + 1 — the canonical IEEE-754 loss probe', () => {
    // Number(9007199254740993) === 9007199254740992 (lossy); BigInt recovers the exact value.
    expect(parseDecimalToUnits('0.009007199254740993', 18)).toEqual({
      ok: true,
      raw: '9007199254740993',
    });
  });

  test('u64::MAX at 18 decimals parses exactly', () => {
    expect(parseDecimalToUnits('18.446744073709551615', 18)).toEqual({
      ok: true,
      raw: '18446744073709551615',
    });
  });

  test('decimals=2 (cents)', () => {
    expect(parseDecimalToUnits('84.00', 2)).toEqual({ ok: true, raw: '8400' });
    expect(parseDecimalToUnits('0.84', 2)).toEqual({ ok: true, raw: '84' });
    expect(parseDecimalToUnits('8.4', 2)).toEqual({ ok: true, raw: '840' });
  });

  test('decimals=0 integer', () => {
    expect(parseDecimalToUnits('42', 0)).toEqual({ ok: true, raw: '42' });
    expect(parseDecimalToUnits('0', 0)).toEqual({ ok: true, raw: '0' });
  });

  test('trims surrounding whitespace', () => {
    expect(parseDecimalToUnits('  8.4  ', 18)).toEqual({ ok: true, raw: '8400000000000000000' });
  });
});

describe('parseDecimalToUnits — leading-dot + trailing-dot (calculator-style)', () => {
  test('leading-dot ".5" at 2 decimals → 0.5 * 100 = 50', () => {
    expect(parseDecimalToUnits('.5', 2)).toEqual({ ok: true, raw: '50' });
  });
  test('leading-dot ".5" at 6 decimals → 500000', () => {
    expect(parseDecimalToUnits('.5', 6)).toEqual({ ok: true, raw: '500000' });
  });
  test('leading-dot ".1" at 18 decimals → 1e17', () => {
    expect(parseDecimalToUnits('.1', 18)).toEqual({ ok: true, raw: '100000000000000000' });
  });
  test('leading-dot ".01" at 8 decimals → 1000000', () => {
    expect(parseDecimalToUnits('.01', 8)).toEqual({ ok: true, raw: '1000000' });
  });
  test('trailing-dot "5." at 2 decimals → 5 * 100 = 500', () => {
    expect(parseDecimalToUnits('5.', 2)).toEqual({ ok: true, raw: '500' });
  });
  test('trailing-dot "5." at 0 decimals → 5 (empty fraction is OK)', () => {
    expect(parseDecimalToUnits('5.', 0)).toEqual({ ok: true, raw: '5' });
  });
  test('trailing-dot "0." at 6 decimals → 0', () => {
    expect(parseDecimalToUnits('0.', 6)).toEqual({ ok: true, raw: '0' });
  });
  test('a bare "." with no digits anywhere → not_a_number', () => {
    expect(parseDecimalToUnits('.', 2)).toEqual({ ok: false, err: 'not_a_number' });
  });
});

describe('cmpRaw — BigInt compare (no lexicographic trap)', () => {
  test('"9" < "10" (lexicographic string compare would get this WRONG)', () => {
    expect(cmpRaw('9', '10')).toBe(-1);
  });
  test('equal', () => {
    expect(cmpRaw('100', '100')).toBe(0);
  });
  test('greater', () => {
    expect(cmpRaw('11', '10')).toBe(1);
  });
  test('big values compare by magnitude, not length-first-as-string', () => {
    expect(cmpRaw('18446744073709551615', '18446744073709551614')).toBe(1);
    expect(cmpRaw('9007199254740993', '9007199254740992')).toBe(1);
  });
  test('throws TypeError on non-digit input (debuggable, no silent NaN)', () => {
    expect(() => cmpRaw('abc', '10')).toThrow(TypeError);
    expect(() => cmpRaw('9', '')).toThrow(TypeError);
  });
});

// MC5 — currency-keyed offline deduction. The offline QR/NFC hand-off debits the LOCAL view of the
// payer's balance per-currency (a ckBTC offline pay must reduce the ckBTC displayed balance, NOT the
// DEMO ∂ balance). `applyOffline` is the pure helper Wallet uses to render every shown balance: it
// subtracts the per-currency raw-u64 `offlineSpent[currency]` from the polled balance, guarded by
// cmpRaw so it never goes below 0 (the wayward refund case can over-subtract; the guard catches it).
// Keys NOT in the map ⇒ '0' spent ⇒ balance unchanged. A null balance stays null (unknown).
describe('applyOffline — currency-keyed offline deduction (MC5)', () => {
  test('null balance stays null (unknown stays unknown)', () => {
    expect(applyOffline(null, {}, 0)).toBeNull();
    expect(applyOffline(null, {0: '100'}, 0)).toBeNull();
  });
  test('balance with no entry for this currency is unchanged', () => {
    expect(applyOffline('1000', {}, 0)).toBe('1000');
    expect(applyOffline('1000', {1: '500'}, 0)).toBe('1000');
  });
  test('deducts the currency-0 entry from a currency-0 balance', () => {
    expect(applyOffline('10000', {0: '2500'}, 0)).toBe('7500');
  });
  test('MC5 KEY ASSERTION: a currency-1 offline spend does NOT reduce the DEMO (currency-0) balance', () => {
    // The bug: a ckBTC offline pay was reducing the DEMO ∂ header. Per-currency keying must ISOLATE
    // the deduction to its own asset.
    expect(applyOffline('10000', {1: '50000'}, 0)).toBe('10000');
    // And the mirror: a currency-0 spend does NOT reduce a currency-1 balance.
    expect(applyOffline('60000', {0: '2500'}, 1)).toBe('60000');
  });
  test('deducts the currency-1 entry from a currency-1 balance (ckBTC offline pay reduces ckBTC)', () => {
    expect(applyOffline('60000', {1: '50000'}, 1)).toBe('10000');
  });
  test('deducts a currency-2 entry from a currency-2 balance (ckUSDC)', () => {
    expect(applyOffline('5000000', {2: '2500000'}, 2)).toBe('2500000');
  });
  test('cmpRaw-guarded: never goes below 0 (the refund-over-subtract case)', () => {
    // If the map somehow exceeds the balance (e.g. a refund that overshot via the reducer), the
    // display clamps at 0 rather than rendering a negative raw string. Mirrors the DEMO shownBalance
    // guard that existed pre-MC5.
    expect(applyOffline('100', {0: '5000'}, 0)).toBe('0');
    expect(applyOffline('100', {1: '999999'}, 1)).toBe('0');
  });
  test('refund restored: an entry reduced by a negative markOfflinePaid restores the balance', () => {
    // The reducer sums BigInt(amount) under the key, so a refund ("-50000") reduces the entry. Here
    // we simulate the post-refund map state and confirm the balance comes back.
    const afterRefund = {1: '0'}; // 50000 spent, then -50000 refund → 0
    expect(applyOffline('60000', afterRefund, 1)).toBe('60000');
  });
  test('exact BigInt math: 2^53+1 boundary deducts exactly (no Number loss)', () => {
    // The deduction must use BigInt throughout — a Number-based path would lose precision above 2^53.
    expect(applyOffline('9007199254740993', {0: '1'}, 0)).toBe('9007199254740992');
  });
});

describe('rejections — typed err codes matching Rust AmountError', () => {
  test('empty → "empty"', () => {
    expect(parseDecimalToUnits('', 2)).toEqual({ ok: false, err: 'empty' });
    expect(parseDecimalToUnits('   ', 2)).toEqual({ ok: false, err: 'empty' });
  });

  test('non-numeric → "not_a_number"', () => {
    expect(parseDecimalToUnits('abc', 2)).toEqual({ ok: false, err: 'not_a_number' });
    expect(parseDecimalToUnits('1.2.3', 2)).toEqual({ ok: false, err: 'not_a_number' });
    expect(parseDecimalToUnits('.', 2)).toEqual({ ok: false, err: 'not_a_number' });
    expect(parseDecimalToUnits('+5', 2)).toEqual({ ok: false, err: 'not_a_number' });
  });

  test('negative → "negative" (regardless of magnitude/shape)', () => {
    expect(parseDecimalToUnits('-1', 2)).toEqual({ ok: false, err: 'negative' });
    expect(parseDecimalToUnits('-0.01', 2)).toEqual({ ok: false, err: 'negative' });
    expect(parseDecimalToUnits('-abc', 2)).toEqual({ ok: false, err: 'negative' });
  });

  test('too many fractional digits → "too_many_decimals"', () => {
    expect(parseDecimalToUnits('1.5', 0)).toEqual({ ok: false, err: 'too_many_decimals' });
    expect(parseDecimalToUnits('0.1234567890123456789', 18)).toEqual({
      ok: false,
      err: 'too_many_decimals',
    });
  });

  test('overflow → "overflow" (value > u64::MAX or decimals > MAX_DECIMALS)', () => {
    expect(parseDecimalToUnits('99999999999999999999999999999', 0)).toEqual({
      ok: false,
      err: 'overflow',
    });
    expect(parseDecimalToUnits('1', 19)).toEqual({ ok: false, err: 'overflow' });
    expect(parseDecimalToUnits('1', -1 as unknown as number)).toEqual({ ok: false, err: 'overflow' });
  });
});

// The payee-quoted wire under the exact-price rule (founder 2026-09-12: if something costs $1,
// the customer pays exactly $1 — the merchant pays the fees). `nettedWireRaw` is the p2p
// request's half of what the dpay till does at quote time (`till_raw_units` in the relay): the
// wire carries price − fee, so the payer — who pays the wire verbatim — moves their account by
// exactly the price. An unknowable fee nets nothing (the payer then pays price+fee, honestly
// displayed); a price that does not clear the fee refuses the request outright — a zero/negative
// wire is money nonsense.
describe('nettedWireRaw — payee-quoted fee netting (exact-price rule, 2026-09-12)', () => {
  test('fee null → wire = price verbatim (DEMO / fee unknowable — never a guessed number)', () => {
    expect(nettedWireRaw('2500', null)).toEqual({ok: true, wireRaw: '2500'});
  });

  test('fee < price → wire = price − fee (exact BigInt)', () => {
    // VCHF at 8 decimals: a 1.00 request, 0.0001 ledger fee → the payer pays exactly 0.9999.
    expect(nettedWireRaw('100000000', '10000')).toEqual({ok: true, wireRaw: '99990000'});
  });

  test('fee ≥ price → refused — no zero/negative wire can exist', () => {
    expect(nettedWireRaw('10000', '10000')).toEqual({ok: false, err: 'fee_covers_price'});
    expect(nettedWireRaw('9999', '10000')).toEqual({ok: false, err: 'fee_covers_price'});
  });

  test('exact BigInt math: 2^53+1 boundary nets exactly (no Number loss)', () => {
    expect(nettedWireRaw('9007199254740993', '1')).toEqual({ok: true, wireRaw: '9007199254740992'});
  });

  test('throws TypeError on non-digit input (debuggable, no silent NaN)', () => {
    expect(() => nettedWireRaw('abc', '10')).toThrow(TypeError);
    expect(() => nettedWireRaw('100', 'x')).toThrow(TypeError);
  });
});
