// Hand-rolled EVM transaction builder + signer — EIP-1559 (type 2) and legacy EIP-155. PURE
// module — no network, no React. Byte-exact against the EIP-155 spec's own signed example and
// functionally verified against Foundry anvil (golden vectors in __tests__/evm-tx.test.ts).
//
// Both flows are one call each (fields + private key in, signed wire bytes + txHash out):
//   type 2:   signing hash = keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
//             maxFeePerGas, gasLimit, to, value, data])); wire = 0x02 || rlp([payload…, yParity,
//             r, s]); txHash = keccak256(wire).
//   legacy:   signing hash = keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId,
//             0, 0])) — the EIP-155 9-field form; wire = rlp([nonce, gasPrice, gasLimit, to,
//             value, data, v, r, s]) with v = 35 + 2*chainId + parity (no type byte).
//
// r and s are encoded as MINIMAL big-endian integers (leading zeros stripped — they are integers
// in the signature list, not fixed 32-byte strings). Noble's sign is deterministic RFC 6979 with
// low-s normalisation, so the same fields + key always produce the same wire bytes and txHash.

import {secp256k1} from '@noble/curves/secp256k1';
import {bytesToHex, hexToBytes} from '../lib/format';
import {keccak256} from './keccak';
import {intToMinimalBe, rlpEncode, type RlpItem} from './rlp';

/** A 20-byte address in 0x-prefixed hex (any case) → bytes. Throws on anything else: the tx
 *  builder refuses to ship a malformed destination the node would reject after the fact. */
export function addressToBytes(address: string): Uint8Array {
  const b = hexToBytes(address);
  if (b.length !== 20) throw new Error(`EVM address must be 20 bytes, got ${b.length}: ${address}`);
  return b;
}

export interface Eip1559TxFields {
  readonly chainId: number;
  readonly nonce: number;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string; // 0x-prefixed 20-byte hex
  readonly value: bigint; // wei
  readonly data?: Uint8Array; // calldata; empty for a plain transfer
}

export interface LegacyTxFields {
  readonly chainId: number;
  readonly nonce: number;
  readonly gasPrice: bigint; // wei
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data?: Uint8Array;
}

export interface SignedEvmTx {
  /** The serialized signed transaction — `eth_sendRawTransaction`'s 0x-prefixed hex parameter. */
  readonly raw: Uint8Array;
  /** keccak256(raw) — the transaction's on-chain identity (eth_getTransactionByHash key). */
  readonly txHash: Uint8Array;
  /** The hash that was actually signed (debug/review surface; equals keccak of the payload). */
  readonly signingHash: Uint8Array;
  /** Type 2: the yParity (0/1). Legacy EIP-155: 35 + 2*chainId + parity. */
  readonly v: bigint;
  /** 32-byte big-endian signature halves (NOT minimal-encoded — that happens at RLP time). */
  readonly r: Uint8Array;
  readonly s: Uint8Array;
}

// Sign the 32-byte signing hash and split into (v-as-parity, r, s) 32-byte halves.
function signHash(signingHash: Uint8Array, privateKey: Uint8Array): {parity: bigint; r: Uint8Array; s: Uint8Array} {
  const sig = secp256k1.sign(signingHash, privateKey); // {r, s, recovery} — deterministic
  const to32 = (v: bigint): Uint8Array => {
    const hex = v.toString(16).padStart(64, '0');
    return hexToBytes(hex);
  };
  return {parity: BigInt(sig.recovery), r: to32(sig.r), s: to32(sig.s)};
}

// The minimal-integer payload the RLP signature slots carry (leading zeros stripped).
function sigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** Build + sign an EIP-1559 (type 2) transaction in one call.
 *
 *  The payload carries the EIP-2930 access-list FIELD as an always-empty list (the feature is
 *  unused here, but the field is part of the type-2 wire shape — omitting it yields a 10-element
 *  list the node refuses with "failed to decode transaction"; the empty `[]` element is what
 *  every reference client serialises). */
export function signEip1559Tx(fields: Eip1559TxFields, privateKey: Uint8Array): SignedEvmTx {
  const NO_ACCESS_LIST: RlpItem[] = [];
  const payload: RlpItem[] = [
    fields.chainId,
    fields.nonce,
    fields.maxPriorityFeePerGas,
    fields.maxFeePerGas,
    fields.gasLimit,
    addressToBytes(fields.to), // RLP: a 20-byte STRING — no word padding (that is ABI's job)
    fields.value,
    fields.data ?? new Uint8Array(0),
    NO_ACCESS_LIST,
  ];
  const signingHash = keccak256(new Uint8Array([0x02, ...rlpEncode(payload)]));
  const {parity, r, s} = signHash(signingHash, privateKey);
  const raw = new Uint8Array([
    0x02,
    ...rlpEncode([...payload, parity, intToMinimalBe(sigInt(r)), intToMinimalBe(sigInt(s))]),
  ]);
  return {raw, txHash: keccak256(raw), signingHash, v: parity, r, s};
}

/** Build + sign a legacy (pre-type-2) EIP-155 replay-protected transaction in one call. */
export function signLegacyTx(fields: LegacyTxFields, privateKey: Uint8Array): SignedEvmTx {
  const payload: RlpItem[] = [
    fields.nonce,
    fields.gasPrice,
    fields.gasLimit,
    addressToBytes(fields.to),
    fields.value,
    fields.data ?? new Uint8Array(0),
  ];
  // The EIP-155 signing payload: the 6 field elements + [chainId, 0, 0].
  const signingHash = keccak256(rlpEncode([...payload, fields.chainId, 0, 0]));
  const {parity, r, s} = signHash(signingHash, privateKey);
  const v = 35n + 2n * BigInt(fields.chainId) + parity;
  const raw = rlpEncode([...payload, v, intToMinimalBe(sigInt(r)), intToMinimalBe(sigInt(s))]);
  return {raw, txHash: keccak256(raw), signingHash, v, r, s};
}

/** 0x-prefixed lowercase hex of bytes — the spelling every RPC field expects (hexToBytes's twin
 *  for this rail; hand-rolled hex lives in lib/format but with a different calling surface). */
export function toHex0x(bytes: Uint8Array): string {
  return '0x' + bytesToHex(bytes);
}
