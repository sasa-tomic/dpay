import { describe, test, expect } from '@jest/globals';
import { padName32, trimName32, parseRequestQR, usd, short } from '../lib/format';

// padName32 / trimName32 mirror `dpay_core::pad_name` + the canister's lossy NUL-trim: fixed 32-byte
// fields, UTF-8, trailing-NUL padded, truncated to 32 bytes; empty = all zeros. These tests prove the
// round-trip + the boundary behaviors the wire-format-v2 name/memo fields rely on (N6/H3).
describe('padName32', () => {
  test('ASCII name → 32-byte NUL-padded hex', () => {
    // "Alice" = 41 6c 69 63 65, then 27 NUL bytes.
    expect(padName32('Alice')).toBe('416c696365' + '00'.repeat(27));
  });

  test('empty string → all zeros', () => {
    expect(padName32('')).toBe('00'.repeat(32));
  });

  test('exactly 32 bytes → no padding, no truncation', () => {
    const s32 = 'a'.repeat(32);
    expect(padName32(s32)).toBe('61'.repeat(32));
  });

  test('longer than 32 bytes → truncated to 32', () => {
    // 40 chars → only the first 32 bytes survive.
    expect(padName32('a'.repeat(40))).toBe('61'.repeat(32));
  });

  test('UTF-8 multibyte → encoded as UTF-8 bytes, then padded', () => {
    // "é" = c3 a9 (2 bytes); 30 NUL bytes follow.
    expect(padName32('é')).toBe('c3a9' + '00'.repeat(30));
  });

  test('truncates on BYTE boundary (never splits a multibyte char)', () => {
    // 32 'é' = 64 bytes; truncation keeps the first 32 bytes (16 full chars), dropping the rest.
    const hex = padName32('é'.repeat(32));
    expect(hex.length).toBe(64); // 32 bytes
    expect(hex).toBe('c3a9'.repeat(16));
  });
});

describe('trimName32', () => {
  test('NUL-padded hex → trimmed string', () => {
    expect(trimName32('416c696365' + '00'.repeat(27))).toBe('Alice');
  });

  test('all zeros → empty string', () => {
    expect(trimName32('00'.repeat(32))).toBe('');
  });

  test('trims at the FIRST NUL even if text resumes after it', () => {
    // "AB" + NUL + "CD" + NULs → "AB" (first NUL terminates).
    expect(trimName32('414200' + '4344' + '00'.repeat(26))).toBe('AB');
  });

  test('no NUL → decodes all 32 bytes', () => {
    expect(trimName32('61'.repeat(32))).toBe('a'.repeat(32));
  });

  test('round-trip: padName32 → trimName32 recovers the original (ASCII, short)', () => {
    for (const s of ['Alice', 'Bob', 'coffee', 'dinner', 'e2e-merchant']) {
      expect(trimName32(padName32(s))).toBe(s);
    }
  });

  test('round-trip: UTF-8 multibyte', () => {
    // "café" fits in 32 bytes (5 chars but only 5 bytes? no — é is 2 bytes → 5 bytes total).
    expect(trimName32(padName32('café'))).toBe('café');
  });

  test('round-trip at exactly 32 bytes', () => {
    const s32 = 'a'.repeat(32);
    expect(trimName32(padName32(s32))).toBe(s32);
  });

  test('truncation is lossy: a >32-byte string does NOT round-trip (truncated form does)', () => {
    const long = 'a'.repeat(40);
    const padded = padName32(long); // truncated to 32 bytes
    expect(trimName32(padded)).toBe('a'.repeat(32)); // the 32-byte truncation, not the original
    expect(trimName32(padded)).not.toBe(long);
  });

  test('golden name/memo hex round-trips (matches dfx/wire_layout.json)', () => {
    // from_name="Alice" / to_name="Bob" / memo="dinner" — the wire-layout golden values.
    expect(trimName32('416c696365' + '00'.repeat(27))).toBe('Alice');
    expect(trimName32('426f62' + '00'.repeat(29))).toBe('Bob');
    expect(trimName32('64696e6e6572' + '00'.repeat(26))).toBe('dinner');
    // request memo="coffee"
    expect(trimName32('636f66666565' + '00'.repeat(26))).toBe('coffee');
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
describe('format helpers (unchanged)', () => {
  test('usd formats cents', () => { expect(usd(2500)).toBe('Đ25.00'); });
  test('short truncates hex', () => { expect(short('0123456789abcdef')).toBe('01234567…'); });
});
