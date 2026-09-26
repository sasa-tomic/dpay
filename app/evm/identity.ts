// SLIP-10 secp256k1 derivation for the EVM rail at the standard Ethereum path m/44'/60'/0'/0/0.
// PURE module — no network, no React, safe to static-import and unit-test.
//
// The Internet Computer identity seed (app/lib/types.ts `Identity.secretHex`, the SAME 32-byte
// seed solana/identity.ts derives from) is used as the BIP32/SLIP-10 master seed, so a single
// device backup recovers BOTH rails. The path uses the registered SLIP-44 coin type 60, so the
// derived key is recoverable in standard Ethereum wallets (MetaMask/Rabby) — same rationale as
// the Solana rail's coin type 501.
//
// Unlike ed25519, secp256k1 SLIP-10 permits NON-hardened children: the account level (m/44'/60'/0')
// is hardened (each apostrophe = +0x80000000) and the change/address tail (…/0/0) is non-hardened
// per BIP-44. Both branches are implemented because the SLIP-10 official test vectors exercise
// both — a hardened-only implementation could not even reproduce the spec.
//
// HMAC-SHA512 is hand-rolled on the (stable) sha512 primitive, copied verbatim from
// solana/identity.ts. We avoid noble's `hmac` module on purpose: the resolved version across this
// tree's node_modules disagrees with standard HMAC-SHA512 in its `create(hash, key, data)` 3-arg
// form, whereas sha512 itself is correct and stable. Standard RFC 2104 HMAC.

import {secp256k1} from '@noble/curves/secp256k1';
import {sha512} from '@noble/hashes/sha512';
import {utf8ToBytes} from '../lib/base64url';
import {bytesToHex, hexToBytes} from '../lib/format';
import {keccak256} from './keccak';

// "Bitcoin seed" as UTF-8 bytes — the SLIP-10 master HMAC key for secp256k1 (compatible with BIP-32).
const SLIP10_MASTER_KEY = new Uint8Array([
  0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20, 0x73, 0x65, 0x65, 0x64,
]);

// m/44'/60'/0'/0/0 — purpose, coin type and account hardened; change + address index not.
const HARDENED = 0x80000000;
export const EVM_DERIVATION_PATH = [44, 60, 0].map((i) => i + HARDENED).concat([0, 0]);

// The secp256k1 group order n — bounds for a legal private key / IL half.
const N = secp256k1.CURVE.n;

// RFC 2104 HMAC-SHA512 (byte-for-byte the solana/identity.ts helper; see the header note).
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
  // view held across another sha512 call would read stale bytes.
  return Uint8Array.from(sha512(outer));
}

/** A SLIP-10 node: the private key (IL) and the chain code (IR) — the two HMAC-SHA512 halves. */
export interface Slip10Node {
  readonly privateKey: Uint8Array;
  readonly chainCode: Uint8Array;
}

// SLIP-10 secp256k1 child derivation over hardened (>= 0x80000000) and normal indices. Exported so
// the SLIP-10 official test vectors can assert master AND intermediate nodes directly against the
// reference, not just the leaf of one fixed path. Throws on the SLIP-10 invalid-key conditions
// (IL = 0, IL >= n, or the normal-derivation sum wrapping past n) — at a fixed path that is a
// derivation-code bug, never a runtime condition to recover from.
export function deriveSlip10Secp256k1Node(masterSeed: Uint8Array, indices: number[]): Slip10Node {
  let intermediate = hmacSha512(SLIP10_MASTER_KEY, masterSeed);
  let privKey = new Uint8Array(intermediate.subarray(0, 32)); // IL (copy: buffer reuse below)
  let chainCode = new Uint8Array(intermediate.subarray(32, 64)); // IR
  for (const index of indices) {
    const hardened = index >= HARDENED;
    // data = (0x00 || privKey | serP(privKey)) || index_be32 — 33 + 4 = 37 bytes in BOTH branches.
    const data = new Uint8Array(33 + 4);
    if (hardened) {
      data[0] = 0x00;
      data.set(privKey, 1);
    } else {
      data.set(secp256k1.getPublicKey(privKey, true), 0);
    }
    data[data.length - 4] = (index >>> 24) & 0xff;
    data[data.length - 3] = (index >>> 16) & 0xff;
    data[data.length - 2] = (index >>> 8) & 0xff;
    data[data.length - 1] = index & 0xff;
    intermediate = hmacSha512(chainCode, data);
    const parseIl = (bytes: Uint8Array): bigint => {
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      return v;
    };
    let ilInt = parseIl(intermediate.subarray(0, 32));
    // SLIP-10 step 5: an invalid IL (>= n, or the child key summing to 0) retries the HMAC with
    // Data = 0x01 || IR || ser32(i). Probability < 2^-127, but the loop is what the spec says.
    while (ilInt >= N || (ilInt + parseIl(privKey)) % N === 0n) {
      const retry = new Uint8Array(1 + 32 + 4);
      retry[0] = 0x01;
      retry.set(intermediate.subarray(32, 64), 1);
      retry.set(data.subarray(data.length - 4), 33);
      intermediate = hmacSha512(chainCode, retry);
      ilInt = parseIl(intermediate.subarray(0, 32));
    }
    // SLIP-10 step 6: the child key is (IL + parent) mod n in BOTH branches — unlike ed25519
    // (where the key IS IL), a secp256k1 key is a field element; hardening changes only the HMAC
    // data, never the combine rule. (Getting this wrong still matches the spec's chain codes —
    // which is exactly why the vectors pin private keys, not just chain codes.)
    ilInt = (ilInt + parseIl(privKey)) % N;
    privKey = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      privKey[i] = Number(ilInt & 0xffn);
      ilInt >>= 8n;
    }
    chainCode = new Uint8Array(intermediate.subarray(32, 64));
  }
  return {privateKey: privKey, chainCode};
}

/** EIP-55 mixed-case checksum form of a lowercase-hex address (with or without 0x). Per EIP-55:
 *  keccak256 the ASCII bytes of the 40-char lowercase hex body; a hex char is UPPERCASE where the
 *  corresponding digest nibble is >= 8. Only checks form — the checksum exists so a corrupted
 *  MIXED-CASE paste fails verification in lib/eip55.ts's `eip55ChecksumBad`. */
export function toChecksumAddress(address: string): string {
  const body = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(body)) {
    throw new Error(`not a 20-byte EVM address: ${address}`);
  }
  const digest = keccak256(utf8ToBytes(body));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = digest[i >> 1];
    const bit = (nibble >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const c = body[i];
    out += bit >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export interface EvmKeypair {
  /** 32-byte secp256k1 private key — the SLIP-10 leaf. Noble signs with this directly. */
  readonly privateKey: Uint8Array;
  /** 33-byte COMPRESSED public key (0x02/0x03 prefix) — the SLIP-10 serialised point. */
  readonly publicKey: Uint8Array;
  /** 64-byte UNCOMPRESSED public key with the 0x04 prefix dropped — the pre-image of the address. */
  readonly uncompressedPubKey: Uint8Array;
  /** 0x-prefixed lowercase 40-hex address: the LAST 20 bytes of keccak256(uncompressedPubKey). */
  readonly address: string;
}

function keypairFromPrivate(privKey: Uint8Array): EvmKeypair {
  // Defensive copies: noble may return views into shared/reused buffers, so materialise
  // independent arrays before anything else can touch them (house rule from solana/identity.ts).
  const publicKey = new Uint8Array(secp256k1.getPublicKey(privKey, true));
  const uncompressedPubKey = new Uint8Array(secp256k1.getPublicKey(privKey, false).subarray(1));
  const hash = keccak256(uncompressedPubKey);
  const addressBytes = new Uint8Array(hash.subarray(12)); // last 20 of 32
  return {
    privateKey: new Uint8Array(privKey),
    publicKey,
    uncompressedPubKey,
    address: '0x' + bytesToHex(addressBytes),
  };
}

/** Derive the EVM keypair from the IC identity seed at m/44'/60'/0'/0/0. */
export function deriveEvmKeypair(secretHex: string): EvmKeypair {
  const leaf = deriveSlip10Secp256k1Node(hexToBytes(secretHex), EVM_DERIVATION_PATH);
  return keypairFromPrivate(leaf.privateKey);
}

/** Recover the keypair straight from a raw 32-byte private key (anvil/foundry test keys, tests). */
export function evmKeypairFromPrivate(privKey: Uint8Array): EvmKeypair {
  if (privKey.length !== 32) throw new Error(`private key must be 32 bytes, got ${privKey.length}`);
  return keypairFromPrivate(privKey);
}
