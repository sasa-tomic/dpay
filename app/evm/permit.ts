// EIP-2612 permit — the EIP-712 digest builder + signer that lets the wallet approve a spender
// with one offline signature instead of an approve transaction. PURE module.
//
// The struct hash and digest are the standard EIP-2612 flow:
//   structHash      = keccak256(PERMIT_TYPEHASH || abi.encode(owner, spender, value, nonce, deadline))
//   digest          = keccak256(0x1901 || domainSeparator || structHash)
// The Permit struct hash follows the EIP-2612 spec / Uniswap-V2 field order (value, NONCE,
// deadline) — that order is what deployed EIP-2612 tokens verify against; the permit FUNCTION's
// argument order (deadline before v) is different and lives in abi.ts's encodePermit.
//
// TWO domain kinds, and the kind is EXPLICIT at every call site (no default — signing over the
// wrong domain kind yields a valid-looking signature over a different message, i.e. a permit the
// token will always reject; the union type makes the compiler force the choice):
//   'minimal' — ERC20PermitLight (both REAL ZCHF deployments, Ethereum + Arbitrum One, and the
//               dev-chain MockZCHF): DOMAIN_SEPARATOR() =
//               keccak256(abi.encode(MINIMAL_DOMAIN_TYPEHASH, block.chainid, address(this))).
//               No name, no version — addendum 1 of the EVM-rail spec, on-chain-verified.
//   'full'    — the classic EIP-712 domain (name + version + chainId + verifyingContract), kept
//               for tokens that use the EIP-2612 "common choice" separator.
//
// Golden vector provenance (see __tests__/evm-permit.test.ts): the typehashes are published
// constants (EIP-712's EIP712Domain typehash; Uniswap V2's PERMIT_TYPEHASH); the minimal-domain
// separators are verified against the LIVE ZCHF DOMAIN_SEPARATOR() via eth_call (2026-09-26);
// the full worked 'full' digest is generated with the Foundry in this repo.

import {secp256k1} from '@noble/curves/secp256k1';
import {utf8ToBytes} from '../lib/base64url';
import {keccak256} from './keccak';
import {addressWord, uint256Word} from './abi';

/** The EIP-712 domain a token verifies permits against — the kind MUST be stated, never guessed. */
export type PermitDomain =
  | {
      /** ERC20PermitLight minimal domain: chainId + verifyingContract only. */
      readonly kind: 'minimal';
      readonly chainId: number;
      readonly verifyingContract: string; // 0x-prefixed 20-byte hex — the token itself
    }
  | {
      /** Classic EIP712Domain(string name,string version,uint256 chainId,address verifyingContract). */
      readonly kind: 'full';
      readonly name: string;
      readonly version: string;
      readonly chainId: number;
      readonly verifyingContract: string;
    };

export interface PermitMessage {
  readonly owner: string;
  readonly spender: string;
  readonly value: bigint; // allowance to grant (smallest units)
  readonly deadline: bigint; // unix seconds
  readonly nonce: bigint; // token nonces(owner) — replay protection
}

// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
// — the published EIP-712 domain typehash (EIP-712 spec, `Definition of the domain separator`).
const FULL_DOMAIN_TYPEHASH = new Uint8Array([
  0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d, 0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
  0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca, 0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f,
]);

// The ERC20PermitLight domain typehash — keccak256("bytes32,uint256,address" framing of the
// minimal domain; constant per the ERC20PermitLight source, verified against BOTH live ZCHF
// deployments' DOMAIN_SEPARATOR() via eth_call on 2026-09-26 (see the test's golden vectors).
export const MINIMAL_DOMAIN_TYPEHASH = new Uint8Array([
  0x47, 0xe7, 0x95, 0x34, 0xa2, 0x45, 0x95, 0x2e, 0x8b, 0x16, 0x89, 0x3a, 0x33, 0x6b, 0x85, 0xa3,
  0xd9, 0xea, 0x9f, 0xa8, 0xc5, 0x73, 0xf3, 0xd8, 0x03, 0xaf, 0xb9, 0x2a, 0x79, 0x46, 0x92, 0x18,
]);

// keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
// — Uniswap V2's published PERMIT_TYPEHASH, byte-identical in every canonical EIP-2612 token.
export const PERMIT_TYPEHASH = new Uint8Array([
  0x6e, 0x71, 0xed, 0xae, 0x12, 0xb1, 0xb9, 0x7f, 0x4d, 0x1f, 0x60, 0x37, 0x0f, 0xef, 0x10, 0x10,
  0x5f, 0xa2, 0xfa, 0xae, 0x01, 0x26, 0x11, 0x4a, 0x16, 0x9c, 0x64, 0x84, 0x5d, 0x61, 0x26, 0xc9,
]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The EIP-712 domain separator for this token deployment, per its stated kind. 32 bytes. */
export function buildDomainSeparator(domain: PermitDomain): Uint8Array {
  const chainAndToken = [uint256Word(BigInt(domain.chainId)), addressWord(domain.verifyingContract)];
  if (domain.kind === 'minimal') {
    return keccak256(concat(MINIMAL_DOMAIN_TYPEHASH, ...chainAndToken));
  }
  return keccak256(
    concat(
      FULL_DOMAIN_TYPEHASH,
      keccak256(utf8ToBytes(domain.name)),
      keccak256(utf8ToBytes(domain.version)),
      ...chainAndToken,
    ),
  );
}

/** keccak256(PERMIT_TYPEHASH || abi.encode(owner, spender, value, nonce, deadline)). */
export function permitStructHash(msg: PermitMessage): Uint8Array {
  return keccak256(
    concat(
      PERMIT_TYPEHASH,
      addressWord(msg.owner),
      addressWord(msg.spender),
      uint256Word(msg.value),
      uint256Word(msg.nonce),
      uint256Word(msg.deadline),
    ),
  );
}

/** The full EIP-2612 digest — the 32 bytes the owner's key signs. */
export function permitDigest(domain: PermitDomain, msg: PermitMessage): Uint8Array {
  return keccak256(
    concat(new Uint8Array([0x19, 0x01]), buildDomainSeparator(domain), permitStructHash(msg)),
  );
}

export interface SignedPermit {
  /** 27 or 28 — the ecrecover `v` EIP-2612's permit() takes as uint8. */
  readonly v: number;
  /** 32-byte signature halves, as the permit() bytes32 arguments take them. */
  readonly r: Uint8Array;
  readonly s: Uint8Array;
  /** r || s || v — the 65-byte (r, s, v) serialisation used by relayers and RPC helpers. */
  readonly serialized: Uint8Array;
}

/** Sign a permit digest with the owner's key over `domain` (kind explicit — see PermitDomain).
 *  Noble's sign is deterministic (RFC 6979) with low-s normalisation, so the same inputs always
 *  yield the same 65 bytes. */
export function signPermit(privateKey: Uint8Array, domain: PermitDomain, msg: PermitMessage): SignedPermit {
  const digest = permitDigest(domain, msg);
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
