// EIP-55 mixed-case checksum validation for EVM destination addresses — pure, dependency-free,
// offline forever (no new package; the whole implementation is ~70 lines pinned by golden
// vectors from the EIP-55 spec itself in __tests__/eip55.test.ts).
//
// The checksum exists for exactly one failure mode: a MIXED-CASE address whose case was
// corrupted (a mistyped character in a hand-copied or badly-pasted address verifies against a
// DIFFERENT address — before this check, ConvertMode would happily sign a burn to it). An
// all-lowercase or all-uppercase address carries NO checksum information, so it is accepted as
// unchecksummed — forcing users to produce a checksummed form from a lowercase source would
// break every legitimate paste. This mirrors standard wallet practice (MetaMask's rule).
//
// The hash is keccak256 over the ASCII bytes of the lowercase hex address WITHOUT the 0x
// prefix; each address hex character must be UPPERCASE where the corresponding digest nibble
// is >= 8. Note this is the ORIGINAL Keccak padding (0x01 domain byte), not NIST SHA-3 (0x06).

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600] round constants (iota step). */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets for lane (x,y), flat-indexed x + 5y (row per y). */
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl(v: bigint, n: number): bigint {
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK64;
}

function keccakF(lanes: BigUint64Array): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) lanes[x + 5 * y] ^= d;
    }
    // rho + pi
    const b = new BigUint64Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lanes[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    // chi + iota
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        lanes[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & MASK64 & b[(x + 2) % 5 + 5 * y]);
      }
    }
    lanes[0] ^= RC[round];
  }
}

/** keccak256 (original Keccak padding) of `bytes` — 32 bytes out. */
export function keccak256(bytes: Uint8Array): Uint8Array {
  const RATE = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] = 0x01; // original Keccak domain byte (NIST SHA-3 would be 0x06)
  padded[padded.length - 1] |= 0x80;
  const lanes = new BigUint64Array(25);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      lanes[i] ^= view.getBigUint64(off + i * 8, true);
    }
    keccakF(lanes);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, lanes[i], true);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** True iff the mixed-case form of this address FAILS its own EIP-55 checksum. A shape-valid
 *  address with no case information (all-lower / all-upper / digits) is never "bad" — it
 *  simply carries no checksum to verify. Shape itself is not checked here. */
export function eip55ChecksumBad(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (!(/[a-f]/.test(body) && /[A-F]/.test(body))) return false;
  const digest = bytesToHex(keccak256(new TextEncoder().encode(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const wantUpper = parseInt(digest[i], 16) >= 8;
    const c = body[i];
    if (c !== (wantUpper ? c.toUpperCase() : c.toLowerCase())) return true;
  }
  return false;
}
