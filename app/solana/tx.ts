// Hand-rolled Solana legacy (pre-v0) System Program Transfer transaction builder + signer.
// PURE module — no network. Byte-exact against @solana/web3.js v1 (golden vectors in
// __tests__/solana-tx.test.ts). Produces the serialized signed transaction bytes that
// `sendTransaction` accepts base64-encoded in its params array.
//
// Account ordering for a single System.transfer: [from(writable,signer,idx0),
// to(writable,nonsigner,idx1), SystemProgram(readonly,nonsigner,idx2)].

import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
// SystemInstruction::Transfer discriminator (bincode u32 LE = 2).
const TRANSFER_DISCRIMINATOR = 2;

// Solana compact-u16 (compact-array length): little-endian base-128 varint.
function encodeCompactU16(out: number[], value: number): void {
  let rem = value;
  while (true) {
    const element = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(element);
      return;
    }
    out.push(element | 0x80);
  }
}

function encodeU64LE(out: number[], value: bigint): void {
  for (let i = 0; i < 8; i++) {
    out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  }
}

function encodeU32LE(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function base58Decode32(address: string): Uint8Array {
  const bytes = bs58.decode(address);
  if (bytes.length !== 32) throw new Error(`expected 32-byte Solana pubkey, got ${bytes.length}`);
  return bytes;
}

const SYSTEM_PROGRAM_BYTES = base58Decode32(SYSTEM_PROGRAM_ADDRESS);

/**
 * Build the unsigned legacy message bytes for a System Program Transfer.
 * The message header encodes: 1 required signer signature, 0 readonly-signed, 1 readonly-unsigned
 * (the System Program account). Accounts are ordered writable-signers, writable-nonsigners, then
 * readonly accounts per Solana's message format.
 */
export function buildTransferMessage(
  fromPubkey: Uint8Array,
  toAddress: string,
  lamports: bigint,
  blockhash: Uint8Array,
): Uint8Array {
  const toPubkey = base58Decode32(toAddress);
  if (blockhash.length !== 32) throw new Error('blockhash must be 32 bytes');
  if (lamports < 0n) throw new Error('lamports must be non-negative');

  const out: number[] = [];
  // Header: numRequiredSignatures=1, numReadonlySignedAccounts=0, numReadonlyUnsignedAccounts=1.
  out.push(1, 0, 1);
  // Account keys: [from, to, SystemProgram].
  encodeCompactU16(out, 3);
  for (let i = 0; i < 32; i++) out.push(fromPubkey[i]);
  for (let i = 0; i < 32; i++) out.push(toPubkey[i]);
  for (let i = 0; i < 32; i++) out.push(SYSTEM_PROGRAM_BYTES[i]);
  // Recent blockhash.
  for (let i = 0; i < 32; i++) out.push(blockhash[i]);
  // One instruction: System.transfer.
  encodeCompactU16(out, 1);
  out.push(2); // program id index = SystemProgram (idx 2)
  encodeCompactU16(out, 2); // 2 account indices
  out.push(0, 1); // from(idx0), to(idx1)
  const data: number[] = [];
  encodeU32LE(data, TRANSFER_DISCRIMINATOR);
  encodeU64LE(data, lamports);
  encodeCompactU16(out, data.length);
  for (const b of data) out.push(b);

  return new Uint8Array(out);
}

/**
 * Sign a legacy message and return the serialized signed transaction:
 * compact-u16(1) || signature(64) || message. The signature is ed25519 over the message bytes.
 */
export function signTransaction(messageBytes: Uint8Array, seed: Uint8Array): Uint8Array {
  const signature = ed25519.sign(messageBytes, seed);
  const out = new Uint8Array(1 + 64 + messageBytes.length);
  out[0] = 0x01; // compact-u16(1) signature
  out.set(signature, 1);
  out.set(messageBytes, 65);
  return out;
}

/**
 * Build + sign a System Program Transfer in one call. Returns raw transaction bytes (base64 them
 * for `sendTransaction`).
 */
export function buildSignedTransfer(
  seed: Uint8Array,
  fromPubkey: Uint8Array,
  toAddress: string,
  lamports: bigint,
  blockhash: Uint8Array,
): Uint8Array {
  return signTransaction(buildTransferMessage(fromPubkey, toAddress, lamports, blockhash), seed);
}

export { base58Decode32, encodeCompactU16, encodeU32LE, encodeU64LE, SYSTEM_PROGRAM_BYTES };
