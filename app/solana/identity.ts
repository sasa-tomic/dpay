// SLIP-10 ed25519 derivation for Solana at the standard BIP44 path m/44'/501'/0'/0'.
// PURE module — no network, no React, safe to static-import and unit-test.
//
// The Internet Computer identity seed (app/lib/types.ts `Identity.secretHex`, a 32-byte Ed25519
// seed emitted by DpayCore.generateKeypair) is used as the BIP32/SLIP-10 master seed. A separate
// Solana key is derived so a single device backup recovers BOTH rails, while the Solana key stays
// recoverable in standard wallets (Phantom/Solflare) because the path is the registered SLIP-44
// coin type 501.
//
// SLIP-10 for ed25519 only permits hardened (0x80000000+) derivations: the private key IS the
// 32-byte curve seed (the IL half of each HMAC-SHA512 step); there is no public-key arithmetic.

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import bs58 from 'bs58';
import { hexToBytes } from '../lib/format';

// HMAC-SHA512 hand-rolled on the (stable) sha512 primitive. We avoid noble's `hmac` module on
// purpose: the resolved version across this tree's node_modules disagrees with standard
// HMAC-SHA512 in its `create(hash, key, data)` 3-arg form, whereas sha512 itself is correct and
// stable (verified against the SLIP-0010 ed25519 official test vector). Standard RFC 2104 HMAC.

// "ed25519 seed" as UTF-8 bytes — the SLIP-10 master HMAC key.
const SLIP10_MASTER_KEY = new Uint8Array([
  0x65, 0x64, 0x32, 0x35, 0x35, 0x31, 0x39, 0x20, 0x73, 0x65, 0x65, 0x64,
]);

// m/44'/501'/0'/0' — every level hardened (44, 501, 0, 0 + 0x80000000).
const SOL_DERIVATION_PATH = [44, 501, 0, 0].map((i) => i + 0x80000000);

export interface SolanaKeypair {
  /** 32-byte ed25519 seed — the SLIP-10 leaf private key. Noble signs with this directly. */
  readonly seed: Uint8Array;
  /** 32-byte ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** base58-encoded public key — the Solana account address. */
  readonly address: string;
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockLen = 128; // SHA-512 block size
  const normKey = key.length > blockLen ? sha512(key) : key;
  const pad = new Uint8Array(blockLen);
  pad.set(normKey);
  const inner = new Uint8Array(blockLen + data.length);
  const outer = new Uint8Array(blockLen + 64);
  for (let i = 0; i < blockLen; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  inner.set(data, blockLen);
  const innerHash = sha512(inner);
  outer.set(innerHash, blockLen);
  // Copy out: some resolved @noble/hashes versions return a shared output buffer, so a `subarray`
  // view held across another sha512 call (e.g. ed25519.getPublicKey) would read stale bytes.
  return Uint8Array.from(sha512(outer));
}

// SLIP-10 ed25519 child derivation over arbitrary hardened indices. Returns the 32-byte leaf
// private key (the ed25519 seed). Exported so the SLIP-0010 official test vector can assert master
// and intermediate nodes directly against the reference, not just the leaf of one fixed path.
export function deriveSlip10Ed25519(masterSeed: Uint8Array, hardenedIndices: number[]): Uint8Array {
  let intermediate = hmacSha512(SLIP10_MASTER_KEY, masterSeed);
  let privKey = intermediate.subarray(0, 32); // IL
  let chainCode = intermediate.subarray(32, 64); // IR
  for (const index of hardenedIndices) {
    // data = 0x00 || privKey(32) || index_be32
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(privKey, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    intermediate = hmacSha512(chainCode, data);
    privKey = intermediate.subarray(0, 32);
    chainCode = intermediate.subarray(32, 64);
  }
  return privKey;
}

export function deriveSolanaKeypair(secretHex: string): SolanaKeypair {
  const derived = deriveSlip10Ed25519(hexToBytes(secretHex), SOL_DERIVATION_PATH);
  // Defensive copy: the returned leaf is a view into an HMAC output buffer that ed25519's internal
  // sha512 may overwrite, so materialise an independent 32-byte seed before key derivation.
  const seed = new Uint8Array(32);
  seed.set(derived);
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, address: bs58.encode(publicKey) };
}

export function deriveSolanaAddress(secretHex: string): string {
  return deriveSolanaKeypair(secretHex).address;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Is this a well-formed Solana address? Base58 charset + the length a 32-byte pubkey encodes to
// (32–44 chars), and then the DECODE ITSELF: exactly 32 bytes, which is the same check
// `base58Decode32` (solana/tx.ts) applies when it builds the transaction.
//
// The decode is what makes the guard mean something. Charset+length alone accepts a 33-character
// base58 string, which is not an address at all: the user typed an amount, pressed Confirm, and got
// "expected 32-byte Solana pubkey, got 24" out of the transaction builder — a refusal arriving from
// the wrong layer, after the commit, in the codec's words (founder rule 2026-08-29: the error path
// instructs, where the user still has something to fix). Deciding it here puts the refusal under
// the field being typed.
//
// The cheap pre-checks stay in front: they are what keeps a half-typed address from throwing on
// every keystroke. Still a WELL-FORMEDNESS test — it does NOT verify on-chain existence.
export function isValidSolanaAddress(addr: string): boolean {
  const a = addr.trim();
  if (a.length < 32 || a.length > 44) return false;
  for (let i = 0; i < a.length; i++) {
    if (!BASE58_ALPHABET.includes(a[i])) return false;
  }
  try {
    return bs58.decode(a).length === 32;
  } catch {
    // A decode throw IS the answer to "is this valid" — this is a predicate, not a dropped failure.
    return false;
  }
}

// 9 decimals: 1 SOL = 1_000_000_000 lamports. Centralised so callers never hard-code it.
export const SOL_DECIMALS = 9;
export const SOL_UNIT = 'SOL';
