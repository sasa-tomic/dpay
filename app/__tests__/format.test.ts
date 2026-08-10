import { describe, test, expect } from '@jest/globals';
import { parseRequestQR, usd, short } from '../lib/format';

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
