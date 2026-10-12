// EIP-191 personal_sign — the digest builder + device-key signer behind every "sign a message"
// request the EVM rail answers. PURE module — no network, no React, no component imports.
//
//   digest = keccak256(0x19 || "Ethereum Signed Message:\n" || ascii(len(message)) || message)
//
// where len is the message's BYTE length in ASCII decimal (EIP-191, the `personal_sign` form).
// The signature is the standard 65-byte r || s || v over that digest (v = 27 + recovery, low-s
// normalised) — exactly what wallets return for personal_sign and what verifiers ecrecover.
//
// First consumer: Mt Pelerin's address validation (app/ramp/mtpelerin.ts) — the raw 65 bytes go
// base64 into their widget's `hash` parameter over `MtPelerin-{code}`. Shared with W1: the
// walletkit responder answers third-party `personal_sign` requests through the same primitive.
//
// Golden vectors (see __tests__/evm-signing.test.ts): Mt Pelerin's PUBLISHED test vectors
// (developers.mtpelerin.com, "How to test", m/44'/60' seed-derived AND a standalone key). Noble's
// secp256k1 sign is deterministic (RFC 6979) with low-s normalisation, so our output is
// byte-identical to their ethers.js-generated fixtures — the tests pin their exact bytes.

import {secp256k1} from '@noble/curves/secp256k1';
import {utf8ToBytes} from '../lib/base64url';
import {bytesToBase64} from '../lib/base64';
import {keccak256} from './keccak';

// The fixed EIP-191 prefix, WITHOUT the variable length line: 0x19 (the EIP-191 version byte for
// personal_sign) || "Ethereum Signed Message:\n". The per-message ASCII decimal byte length is
// inserted between this prefix and the message itself.
const EIP191_PREFIX = utf8ToBytes('\x19Ethereum Signed Message:\n');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The 32-byte EIP-191 personal_sign digest over `message` (UTF-8 string or raw bytes). */
export function personalSignDigest(message: string | Uint8Array): Uint8Array {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
  const len = utf8ToBytes(String(msg.length)); // ASCII decimal of the message's BYTE length
  return keccak256(concat(EIP191_PREFIX, len, msg));
}

export interface SignedPersonalSign {
  /** 27 or 28 — the recovery param as personal_sign responses encode it. */
  readonly v: number;
  /** 32-byte signature halves (r, s), as raw byte views. */
  readonly r: Uint8Array;
  readonly s: Uint8Array;
  /** r || s || v — the 65-byte signature every personal_sign consumer expects. */
  readonly serialized: Uint8Array;
}

/** Sign the EIP-191 digest of `message` with `privateKey`. Deterministic (RFC 6979) + low-s, so
 *  the same inputs always yield the same 65 bytes — matching ethers/signMessage fixtures. */
export function signPersonal(privateKey: Uint8Array, message: string | Uint8Array): SignedPersonalSign {
  const digest = personalSignDigest(message);
  const sig = secp256k1.sign(digest, privateKey);
  const to32 = (x: bigint): Uint8Array => {
    const out = new Uint8Array(32);
    let v = x;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  };
  const v = 27 + sig.recovery;
  const r = to32(sig.r);
  const s = to32(sig.s);
  return {v, r, s, serialized: concat(r, s, new Uint8Array([v]))};
}

/** Sign `message` and return the raw 65 signature bytes base64-encoded (STANDARD alphabet, padded
 *  `+/=`) — the exact encoding Mt Pelerin's `hash` widget parameter takes for EVM. */
export function signPersonalBase64(privateKey: Uint8Array, message: string | Uint8Array): string {
  return bytesToBase64(signPersonal(privateKey, message).serialized);
}
