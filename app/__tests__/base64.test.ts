/**
 * base64 — the SINGLE RFC 4648 implementation shared by `lib/base64url.ts` (URL-safe, unpadded)
 * and `solana/rpc.ts` (standard, padded). Pinned here so a future edit to the unified core can't
 * silently diverge the two alphabets. Covers:
 *   - encode/decode round-trip for both alphabets across lengths 0..7 (every padding case).
 *   - golden pins (cross-checked against Node Buffer for the standard alphabet, and against the
 *     canonical RFC 4648 test vectors for the URL-safe alphabet).
 *   - malformed-input rejection (`null` for URL-safe, throw for standard — the two contracts).
 */
import {describe, test, expect} from '@jest/globals';
import {bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes} from '../lib/base64';

const CASES: Array<{name: string; bytes: number[]; std: string; url: string}> = [
  {name: 'empty', bytes: [], std: '', url: ''},
  {name: 'one byte (0x00)', bytes: [0x00], std: 'AA==', url: 'AA'},
  {name: 'one byte (0xff)', bytes: [0xff], std: '/w==', url: '_w'},
  {name: 'two bytes', bytes: [0x01, 0x02], std: 'AQI=', url: 'AQI'},
  {name: 'three bytes', bytes: [0x01, 0x02, 0x03], std: 'AQID', url: 'AQID'},
  {name: 'four bytes', bytes: [0x01, 0x02, 0x03, 0x04], std: 'AQIDBA==', url: 'AQIDBA'},
  {name: 'five bytes', bytes: [0x01, 0x02, 0x03, 0x04, 0x05], std: 'AQIDBAU=', url: 'AQIDBAU'},
  {name: 'six bytes', bytes: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06], std: 'AQIDBAUG', url: 'AQIDBAUG'},
  {name: 'seven bytes', bytes: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07], std: 'AQIDBAUGBw==', url: 'AQIDBAUGBw'},
  {name: 'Man (RFC 4648 §10)', bytes: [77, 97, 110], std: 'TWFu', url: 'TWFu'},
  {name: 'Ma  (RFC 4648 §10)', bytes: [77, 97], std: 'TWE=', url: 'TWE'},
  {name: 'M   (RFC 4648 §10)', bytes: [77], std: 'TQ==', url: 'TQ'},
];

describe('base64 standard-alphabet (padded)', () => {
  for (const c of CASES) {
    test(`encode ${c.name} → "${c.std}"`, () => {
      expect(bytesToBase64(Uint8Array.from(c.bytes))).toBe(c.std);
    });
  }
  for (const c of CASES) {
    test(`decode "${c.std}" → ${c.name}`, () => {
      expect(Array.from(base64ToBytes(c.std))).toEqual(c.bytes);
    });
  }
  test('decode tolerates stripped padding (canonical unpadded form)', () => {
    expect(Array.from(base64ToBytes('AQIDBA'))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
  test('decode tolerates internal whitespace', () => {
    expect(Array.from(base64ToBytes('AQ ID\nBA'))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
  test('decode throws on a malformed string (bad char)', () => {
    expect(() => base64ToBytes('A!ID')).toThrow(/malformed base64/);
  });
  test('round-trip every length 0..32', () => {
    for (let len = 0; len <= 32; len++) {
      const bytes = Uint8Array.from({length: len}, (_, i) => (i * 37 + 11) & 0xff);
      const encoded = bytesToBase64(bytes);
      const decoded = base64ToBytes(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    }
  });
});

describe('base64url (URL-safe, unpadded)', () => {
  for (const c of CASES) {
    test(`encode ${c.name} → "${c.url}"`, () => {
      expect(bytesToBase64Url(Uint8Array.from(c.bytes))).toBe(c.url);
    });
  }
  for (const c of CASES) {
    test(`decode "${c.url}" → ${c.name}`, () => {
      expect(Array.from(base64UrlToBytes(c.url)!)).toEqual(c.bytes);
    });
  }
  test('decode tolerates trailing padding (canonical padded emitter round-trips)', () => {
    expect(Array.from(base64UrlToBytes('AQIDBA==')!)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
  test('the URL-safe alphabet is used (0xff → _w, not /w)', () => {
    expect(bytesToBase64Url(Uint8Array.from([0xff]))).toBe('_w');
  });
  test('decode returns null on a malformed string (no throw — the deeplink contract)', () => {
    expect(base64UrlToBytes('A!ID')).toBe(null);
  });
  test('decode returns null on impossible trailing length (rem=1)', () => {
    expect(base64UrlToBytes('A')).toBe(null);
  });
  test('round-trip every length 0..32', () => {
    for (let len = 0; len <= 32; len++) {
      const bytes = Uint8Array.from({length: len}, (_, i) => (i * 37 + 11) & 0xff);
      const encoded = bytesToBase64Url(bytes);
      const decoded = base64UrlToBytes(encoded);
      expect(Array.from(decoded!)).toEqual(Array.from(bytes));
    }
  });
});
