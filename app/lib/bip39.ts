// BIP-39 mnemonic codec — pure ENCODING of the 32-byte IC Ed25519 seed as 24 words. This is NOT
// BIP-39 seed-to-master-key PBKDF2 (that's only needed for BIP-32 Bitcoin wallets, which we don't
// use): the 32 bytes that `DpayCore.generateKeypair()` produces today are byte-identical to the 32
// bytes recovered from the mnemonic tomorrow, so the Ed25519 key, the SLIP-10 SOL derivation, the
// wire format, and AsyncStorage are all untouched. The mnemonic is just a human-readable
// serialization of the seed with a SHA-256 checksum appended (a single wrong word is caught at
// restore time instead of silently producing a wrong wallet — the whole point over raw hex).
//
// SHA-256 is SYNCHRONOUS via `@noble/hashes/sha256` (already a direct dep, RN-proven + jest-safe —
// see app/solana/spl.ts). Synchronous was chosen deliberately so `validateMnemonic` /
// `mnemonicToEntropy` can run inline in UI input handlers (Tasks B/C/D) without async ceremony.
import { sha256 } from '@noble/hashes/sha256';
import { ENGLISH_WORDLIST } from './bip39-wordlist';
import { hexToBytes } from './format';

export { ENGLISH_WORDLIST };

// BIP-39 maps a 32-byte entropy to 24 words: 256 entropy bits + an 8-bit SHA-256 checksum = 264
// bits = exactly 24 × 11-bit groups, each group an index into the 2048-word list. These constants
// pin the 256-bit shape (the only shape this wallet ever produces or accepts — 12/18-word phrases
// are rejected by `mnemonicToEntropy`).
const ENTROPY_BYTES = 32;
const ENTROPY_BITS = ENTROPY_BYTES * 8; // 256
const CHECKSUM_BITS = ENTROPY_BITS / 32; // 8 (= entropy length in bits / 32, per BIP-39)
const TOTAL_BITS = ENTROPY_BITS + CHECKSUM_BITS; // 264
const WORD_COUNT = TOTAL_BITS / 11; // 24
const WORD_MASK = (1 << 11) - 1; // 0b11111111111

// Precompute word → index once (the codec hot path on restore). Building this per call would be
// O(2048) per lookup; a Map makes `mnemonicToEntropy` O(24).
const WORD_TO_INDEX: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < ENGLISH_WORDLIST.length; i++) m.set(ENGLISH_WORDLIST[i], i);
  return m;
})();

// Pack a bit-array-like reader over a (bytes ++ checksum-bits) sequence: returns the `n`-bit
// unsigned integer starting at bit offset `bit`, MSB-first (BIP-39's convention).
function readBits(bytes: Uint8Array, bit: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const pos = bit + i;
    const byte = bytes[pos >>> 3]; // pos / 8
    const bitInByte = 7 - (pos & 7); // MSB-first within each byte
    v = (v << 1) | ((byte >>> bitInByte) & 1);
  }
  return v >>> 0;
}

// Write `n` bits of `value` into `out` starting at bit offset `bit`, MSB-first. Used to lay the
// 11-bit word indices back into a bitstream for entropy recovery.
function writeBits(out: Uint8Array, bit: number, n: number, value: number): void {
  for (let i = 0; i < n; i++) {
    const pos = bit + i;
    const bitInByte = 7 - (pos & 7);
    const bitValue = (value >>> (n - 1 - i)) & 1;
    if (bitValue) out[pos >>> 3] |= 1 << bitInByte;
    else out[pos >>> 3] &= ~(1 << bitInByte);
  }
}

/**
 * Encode 32 bytes of entropy as the 24-word BIP-39 mnemonic (256-bit entropy + 8-bit SHA-256
 * checksum). The entropy IS the IC Ed25519 seed — no derivation. Throws RangeError unless given
 * exactly 32 bytes (the only shape this wallet produces).
 */
export function entropyToMnemonic(entropy: Uint8Array): string[] {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new RangeError(`entropy must be ${ENTROPY_BYTES} bytes, got ${entropy.length}`);
  }
  const hash = sha256(entropy);
  // Append the first CHECKSUM_BITS of the SHA-256 digest as a 1-byte tail (8 bits fit exactly one
  // byte), then read 11-bit groups MSB-first.
  const stream = new Uint8Array(ENTROPY_BYTES + 1);
  stream.set(entropy, 0);
  stream[ENTROPY_BYTES] = hash[0]; // the high 8 bits of the digest = the BIP-39 checksum
  const words: string[] = new Array(WORD_COUNT);
  for (let i = 0; i < WORD_COUNT; i++) {
    const idx = readBits(stream, i * 11, 11) & WORD_MASK;
    words[i] = ENGLISH_WORDLIST[idx];
  }
  return words;
}

/**
 * Decode a 24-word mnemonic back to the 32-byte entropy. Validates every word is in the English
 * wordlist AND recomputes the SHA-256 checksum, throwing on any mismatch (a wrong word, wrong
 * order, or corrupted checksum). Returns the exact 32 bytes that produced the mnemonic.
 */
export function mnemonicToEntropy(words: string[]): Uint8Array {
  if (!Array.isArray(words) || words.length !== WORD_COUNT) {
    throw new Error(`mnemonic must be exactly ${WORD_COUNT} words, got ${words && words.length}`);
  }
  // Lay the 24 × 11-bit indices into a 33-byte (264-bit) MSB-first stream, then slice the first
  // 256 bits as entropy and the last 8 as the checksum.
  const stream = new Uint8Array(ENTROPY_BYTES + 1);
  for (let i = 0; i < WORD_COUNT; i++) {
    const idx = WORD_TO_INDEX.get(words[i]);
    if (idx === undefined) throw new Error(`unknown BIP-39 word: ${JSON.stringify(words[i])}`);
    writeBits(stream, i * 11, 11, idx);
  }
  const entropy = stream.slice(0, ENTROPY_BYTES);
  const expectedChecksum = stream[ENTROPY_BYTES] & 0xff;
  const actualChecksum = sha256(entropy)[0];
  if (actualChecksum !== expectedChecksum) {
    throw new Error('mnemonic checksum mismatch (a word is wrong or out of order)');
  }
  return entropy;
}

/**
 * Total validity predicate (count + every word in the list + checksum). Returns false for any
 * malformed input — never throws — so UI input handlers (Task C restore form) can call it inline
 * on every keystroke. Use `mnemonicToEntropy` directly when you want the thrown error.
 */
export function validateMnemonic(words: string[]): boolean {
  try {
    mnemonicToEntropy(words);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a fresh 24-word mnemonic from 32 cryptographically-random bytes. Uses the Web Crypto
 * `crypto.getRandomValues` (polyfilled by `react-native-get-random-values` on native, native on
 * web/Node — the same RNG `randNonceHex` in format.ts uses). The returned words encode the seed
 * directly; `DpayCore.keypairFromSecret(wordsToHex(words))` recovers the keypair.
 *
 * Production onboarding generates the keypair via FFI (`DpayCore.generateKeypair()` — Rust CSPRNG)
 * then derives the mnemonic from that seed via `hexToWords`. This function is kept as an FFI-free
 * alternative for future use (e.g., a JS-only recovery path).
 */
export function generateMnemonic(): string[] {
  const entropy = new Uint8Array(ENTROPY_BYTES);
  globalThis.crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy);
}

/** Convenience for the UI tasks (B/C/D): the 24 words as a space-separated string (clipboard). */
export function wordsToString(words: string[]): string {
  return words.join(' ');
}

/** Inverse of `wordsToString`: split a pasted mnemonic string on any whitespace into words. */
export function stringToWords(s: string): string[] {
  return s.trim().split(/\s+/).filter((w) => w.length > 0);
}

/** Convenience: the 32-byte entropy as 64 lowercase hex (the `secretHex` format AsyncStorage stores). */
export function wordsToHex(words: string[]): string {
  const bytes = mnemonicToEntropy(words);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convenience: 64-hex `secretHex` → the 24 words (e.g. to display an existing wallet's backup). */
export function hexToWords(hex: string): string[] {
  return entropyToMnemonic(hexToBytes(hex));
}
