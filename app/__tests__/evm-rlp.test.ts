import {describe, expect, test} from '@jest/globals';
import {
  intToMinimalBe,
  minimalBeToInt,
  rlpDecode,
  rlpEncode,
  type RlpDecoded,
  type RlpItem,
} from '../evm/rlp';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const enc = (item: RlpItem): string => toHex(rlpEncode(item));

// Canonical vectors from the RLP specification (ethereum.org RLP docs — the same set the
// solidity/wiki references pin): short string, single byte, empty, long string (both length
// forms), integer-0-is-empty-string, and the nested list forms.
describe('evm/rlp — canonical encode vectors', () => {
  test('empty string → 0x80', () => {
    expect(enc(new Uint8Array(0))).toBe('80');
  });

  test('the empty string B byte 0x00 encodes as itself, NOT as integer 0', () => {
    expect(enc(new Uint8Array([0x00]))).toBe('00');
    // …while integer 0 IS the empty string:
    expect(enc(0n)).toBe('80');
    expect(enc(0)).toBe('80');
  });

  test('"dog" → 83646f67', () => {
    expect(enc(new Uint8Array([0x64, 0x6f, 0x67]))).toBe('83646f67');
  });

  test('single byte < 0x80 is its own encoding', () => {
    expect(enc(new Uint8Array([0x0f]))).toBe('0f');
  });

  test('56-byte string → long-string form (b8 + one length byte)', () => {
    // "Lorem ipsum dolor sit amet, consectetur adipisicing elit" — the spec's own example.
    const s = new TextEncoder().encode('Lorem ipsum dolor sit amet, consectetur adipisicing elit');
    expect(s.length).toBe(56);
    const out = enc(s);
    expect(out.slice(0, 4)).toBe('b838');
    expect(out.slice(4)).toBe(toHex(s));
  });

  test('1024-byte string → b9 + two length bytes', () => {
    const out = enc(new Uint8Array(1024).fill(0x61));
    expect(out).toBe('b90400' + '61'.repeat(1024));
  });

  test('integers: 15 → 0f, 1024 → 820400 (minimal big-endian)', () => {
    expect(enc(15n)).toBe('0f');
    expect(enc(1024n)).toBe('820400');
    expect(enc(1024)).toBe('820400');
  });

  test('empty list → c0', () => {
    expect(enc([])).toBe('c0');
  });

  test('["cat","dog"] → c88363617483646f67', () => {
    expect(enc([new Uint8Array([0x63, 0x61, 0x74]), new Uint8Array([0x64, 0x6f, 0x67])])).toBe(
      'c88363617483646f67',
    );
  });

  test('nested lists → c7c0c1c0c3c0c1c0', () => {
    // [ [], [[]], [ [], [[]] ] ] — the spec's own nested example.
    expect(enc([[], [[]], [[], [[]]]])).toBe('c7c0c1c0c3c0c1c0');
  });
});

describe('evm/rlp — decode', () => {
  const decode = (hex: string): RlpDecoded => rlpDecode(hexToBytes(hex));

  test('round-trips every canonical vector', () => {
    expect(decode('80')).toEqual(new Uint8Array(0));
    expect(decode('00')).toEqual(new Uint8Array([0x00]));
    expect(decode('83646f67')).toEqual(new Uint8Array([0x64, 0x6f, 0x67]));
    expect(decode('820400')).toEqual(new Uint8Array([0x04, 0x00]));
    expect(decode('c0')).toEqual([]);
    expect(decode('c88363617483646f67')).toEqual([
      new Uint8Array([0x63, 0x61, 0x74]),
      new Uint8Array([0x64, 0x6f, 0x67]),
    ]);
    expect(decode('c7c0c1c0c3c0c1c0')).toEqual([[], [[]], [[], [[]]]]);
  });

  test('list-of-lists round-trips through encode∘decode', () => {
    const item: RlpItem = [[1n, new Uint8Array([0xff])], [[[]]], 127n, [new Uint8Array(0), [1023n]]];
    const decoded = rlpDecode(rlpEncode(item));
    expect(rlpEncode(decoded as RlpItem)).toEqual(rlpEncode(item));
  });

  test('rejects trailing bytes (never decodes a prefix by accident)', () => {
    expect(() => rlpDecode(hexToBytes('83646f67ff'))).toThrow(/trailing/);
  });

  test('rejects truncated payloads', () => {
    expect(() => rlpDecode(hexToBytes('83646f'))).toThrow(/truncated/);
    expect(() => rlpDecode(hexToBytes('c8'))).toThrow();
    expect(() => rlpDecode(new Uint8Array(0))).toThrow(/end of input/);
  });
});

describe('evm/rlp — int helpers (shared with the tx signer)', () => {
  test('minimal big-endian: 0 → empty, leading zeros stripped', () => {
    expect(intToMinimalBe(0n)).toEqual(new Uint8Array(0));
    expect(intToMinimalBe(1n)).toEqual(new Uint8Array([1]));
    expect(intToMinimalBe(0x0100n)).toEqual(new Uint8Array([1, 0]));
  });

  test('minimalBeToInt is the inverse', () => {
    for (const v of [0n, 1n, 254n, 255n, 256n, 0xdeadbeefn, 2n ** 255n]) {
      expect(minimalBeToInt(intToMinimalBe(v))).toBe(v);
    }
  });
});
