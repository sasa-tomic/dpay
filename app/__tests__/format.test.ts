import { describe, test, expect } from '@jest/globals';
import { parseRequestQR, usd, short, fmtTime, fmtEstimate, ESTIMATE_DISPLAY_DECIMALS } from '../lib/format';

// The 2026-10-02 audit (fake-precision amounts that wobble): quote-derived estimates render
// CAPPED and marked, exact values stay internal. One formatter, one cap, the compact core's
// own truncate-toward-zero + "≈" honesty contract.
describe('fmtEstimate — the capped display for quote-derived amounts', () => {
  test('caps at ESTIMATE_DISPLAY_DECIMALS places and marks what it hides', () => {
    expect(ESTIMATE_DISPLAY_DECIMALS).toBe(4);
    // The audit's exact shape: 0.90211547 ICP measured at 8 decimals.
    expect(fmtEstimate('90211547', 8, 'ICP')).toBe('≈ 0.9021 ICP');
  });
  test('a value the cap does not cut renders clean, no marker', () => {
    expect(fmtEstimate('2100', 6, 'USDC')).toBe('0.0021 USDC');
  });
  test('trailing zeros trim; a sub-resolution estimate names the threshold, never a fake zero', () => {
    expect(fmtEstimate('4088560', 9, 'SOL')).toBe('≈ 0.004 SOL');
    expect(fmtEstimate('1', 8, 'ICP')).toBe('< 0.0001 ICP');
  });
});

describe('parseRequestQR', () => {
  test('plain base64url passes through (no |name suffix anymore)', () => {
    const b64 = 'YWJjZGVmZ2g'; // arbitrary base64url
    expect(parseRequestQR(b64)).toBe(b64);
  });

  test('trims surrounding whitespace', () => {
    expect(parseRequestQR('  abc123  ')).toBe('abc123');
  });

  test('defensively strips a stray |suffix (stale QR) but carries no name', () => {
    // The |name suffix is GONE from the wire; a stale QR is stripped so decodeRequest never sees it.
    expect(parseRequestQR('abc123|stale-name')).toBe('abc123');
  });

  test('no pipe → returns the whole trimmed string', () => {
    expect(parseRequestQR('plainvalue')).toBe('plainvalue');
  });
});

// Sanity: the existing format helpers are unaffected by the wire-format-v2 change.
// MC1 units 2-4: usd/fmtAsset now take a raw-u64 decimal STRING (formatted via the exact BigInt
// parser) — never a number.
describe('format helpers (unchanged shape)', () => {
  test('usd formats a raw-cent string', () => { expect(usd('2500')).toBe('∂25.00'); });
  test('short truncates hex', () => { expect(short('0123456789abcdef')).toBe('01234567…'); });
});

// 2026-08-21: history rows rendered 'undefined NaN, NaN' when a timestamp was missing or in the
// WRONG UNIT (the relay shipped ICRC-3 nanoseconds into a seconds contract). fmtTime now guards
// non-finite inputs and out-of-range dates instead of leaking _MONTHS[NaN].
describe('fmtTime — bad timestamps render an honest dash, never NaN text', () => {
  test('NaN / non-finite → dash', () => {
    expect(fmtTime(Number.NaN)).toBe('—');
    expect(fmtTime(Infinity)).toBe('—');
  });
  test('nanosecond-unit leak (1.78e18 ns) overflows Date → dash', () => {
    // The exact prod shape: ICRC-3 ns passed where seconds were promised.
    expect(fmtTime(1787293294089299225)).toBe('—');
  });
  test('a real seconds timestamp renders a real date label (not NaN)', () => {
    const out = fmtTime(Math.floor(Date.now() / 1000));
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('undefined');
    expect(out.length).toBeGreaterThan(0);
  });
});
