// Minimal RLP (Ethereum's Recursive Length Prefix) — the one codec every EVM transaction is
// defined over. PURE module. Encode covers exactly what the rail needs: byte strings (Uint8Array),
// non-negative integers (bigint/number, encoded as MINIMAL big-endian — 0 becomes the empty string
// per the spec), and arbitrarily nested lists. Decode is the strict inverse; the schema (which
// payload element is an integer vs a byte string) is the caller's knowledge, as in every RLP lib.
//
// Length rules pinned by the spec (ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/):
//   byte string: 1 byte < 0x80 → itself; <= 55 bytes → 0x80+len; else 0xb7+lenOf(len), len < 2^64.
//   list:        payload <= 55 bytes → 0xc0+len; else 0xf7+lenOf(len).
// Encoding is therefore canonical BY CONSTRUCTION (there is exactly one encoding per value);
// rlpDecode additionally refuses trailing bytes so callers can never decode a prefix by accident.

export type RlpItem = Uint8Array | bigint | number | RlpItem[];
export type RlpDecoded = Uint8Array | RlpDecoded[];

function beBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error('RLP integers must be non-negative');
  if (v === 0n) return new Uint8Array(0); // integer 0 == the empty byte string
  const out: number[] = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(out);
}

function encodeLength(offset: number, len: number, out: number[]): void {
  if (len <= 55) {
    out.push(offset + len);
  } else {
    const lenBytes = beBytes(BigInt(len));
    if (lenBytes.length > 8) throw new Error('RLP length >= 2^64 is not encodable');
    out.push(offset + 55 + lenBytes.length);
    for (const b of lenBytes) out.push(b);
  }
}

function encodeInto(item: RlpItem, out: number[]): void {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) {
      out.push(item[0]); // single byte < 0x80 is its own encoding
    } else {
      encodeLength(0x80, item.length, out);
      for (const b of item) out.push(b);
    }
  } else if (typeof item === 'bigint' || typeof item === 'number') {
    encodeInto(beBytes(BigInt(item)), out);
  } else if (Array.isArray(item)) {
    const payload: number[] = [];
    for (const child of item) encodeInto(child, payload);
    encodeLength(0xc0, payload.length, out);
    for (const b of payload) out.push(b);
  } else {
    throw new Error(`RLP cannot encode ${typeof item}`);
  }
}

/** Encode one RLP item (bytes, integer, or nested list). */
export function rlpEncode(item: RlpItem): Uint8Array {
  const out: number[] = [];
  encodeInto(item, out);
  return new Uint8Array(out);
}

// Decode one item starting at `off`; returns [item, nextOffset]. Pure + total on the happy path,
// throws on malformed input (a truncated/oversized payload is a programming error here — the
// money-critical surfaces that must not throw use their own defensive wrappers).
function decodeAt(bytes: Uint8Array, off: number): [RlpDecoded, number] {
  if (off >= bytes.length) throw new Error('RLP: unexpected end of input');
  const p = bytes[off];
  if (p < 0x80) return [new Uint8Array([p]), off + 1]; // single byte
  if (p <= 0xb7) {
    // short string: next p-0x80 bytes are the payload
    const len = p - 0x80;
    if (off + 1 + len > bytes.length) throw new Error('RLP: truncated string');
    return [bytes.slice(off + 1, off + 1 + len), off + 1 + len];
  }
  if (p <= 0xbf) {
    // long string: next p-0xb7 bytes are the payload length
    const lenOfLen = p - 0xb7;
    let len = 0;
    for (let i = 0; i < lenOfLen; i++) len = len * 256 + bytes[off + 1 + i];
    const start = off + 1 + lenOfLen;
    if (start + len > bytes.length) throw new Error('RLP: truncated long string');
    return [bytes.slice(start, start + len), start + len];
  }
  // list: 0xc0..0xff — decode children until the payload is consumed
  let payloadLen: number;
  let start: number;
  if (p <= 0xf7) {
    payloadLen = p - 0xc0;
    start = off + 1;
  } else {
    const lenOfLen = p - 0xf7;
    payloadLen = 0;
    for (let i = 0; i < lenOfLen; i++) payloadLen = payloadLen * 256 + bytes[off + 1 + i];
    start = off + 1 + lenOfLen;
  }
  if (start + payloadLen > bytes.length) throw new Error('RLP: truncated list');
  const items: RlpDecoded[] = [];
  let cur = start;
  while (cur < start + payloadLen) {
    const [child, next] = decodeAt(bytes, cur);
    items.push(child);
    cur = next;
  }
  if (cur !== start + payloadLen) throw new Error('RLP: list payload over-run');
  return [items, start + payloadLen];
}

/** Decode a complete RLP payload. Throws if bytes are malformed or carry trailing data. */
export function rlpDecode(bytes: Uint8Array): RlpDecoded {
  const [item, next] = decodeAt(bytes, 0);
  if (next !== bytes.length) throw new Error('RLP: trailing bytes after payload');
  return item;
}

/** Minimal big-endian bytes of a non-negative integer — the shared notion of "integer payload"
 *  for RLP (0 → empty) and the tx builder's signature r/s fields. */
export function intToMinimalBe(v: bigint): Uint8Array {
  return beBytes(v);
}

/** Inverse of `intToMinimalBe` — big-endian bytes to a bigint. */
export function minimalBeToInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
