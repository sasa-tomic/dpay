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

/** Decode a Solana compact-u16 (little-endian base-128 varint) starting at `offset`. Pure + total:
 *  a malformed/truncated input yields a best-effort value + offset (callers validate bounds before
 *  slicing — the verify path returns false on any out-of-bounds, never throws). The inverse of
 *  `encodeCompactU16`. Capped at 5 bytes (shift > 28) so a runaway input can't spin. */
export function decodeCompactU16(bytes: Uint8Array, offset: number): {value: number; next: number} {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length && shift <= 28) {
    const b = bytes[i];
    i++;
    value += (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return {value, next: i};
    shift += 7;
  }
  return {value, next: i};
}

/** Extract the fee-payer signature, the signed message, and the fee-payer public key from a
 *  serialized legacy Solana transaction. Returns null on any malformed layout (too short, zero-sig
 *  count, account table underflow). Pure + total — the verify path must NEVER throw.
 *
 *  Layout: compact-u16(sigCount) || sigCount*64 || message. The message's account table is
 *  header(3) || compact-u16(numAccounts) || account[0](32) || …; account[0] is the fee payer (the
 *  first signer), pinned to index 0 by Solana's message format — whose signature authorizes the
 *  transfer. Only the FIRST signature is verified (the offline-pay tx is single-signer); a
 *  multi-signer tx parses but only sig[0] is checked. */
export function extractSignedTxParts(signedTx: Uint8Array): {
  signature: Uint8Array;
  message: Uint8Array;
  feePayer: Uint8Array;
} | null {
  const sigCountDec = decodeCompactU16(signedTx, 0);
  const sigCount = sigCountDec.value;
  if (sigCount < 1) return null;
  const sigStart = sigCountDec.next;
  const msgStart = sigStart + 64 * sigCount;
  if (signedTx.length < msgStart + 4) return null;
  const signature = signedTx.subarray(sigStart, sigStart + 64);
  const message = signedTx.subarray(msgStart);
  const numAccountsDec = decodeCompactU16(message, 3);
  const firstKeyStart = numAccountsDec.next;
  const firstKeyEnd = firstKeyStart + 32;
  if (message.length < firstKeyEnd) return null;
  const feePayer = message.subarray(firstKeyStart, firstKeyEnd);
  return {signature, message, feePayer};
}

/** F3 — defense-in-depth: verify the fee-payer's ed25519 signature over the signed message, locally,
 *  BEFORE broadcasting. Returns true on a valid signature; false on ANY parse failure or mismatch
 *  (never throws). The on-chain broadcast is the authoritative gate (Solana rejects a bad sig
 *  anyway); this is the fast, local, pre-broadcast check that mirrors the IC receipt-verify posture
 *  and gives an immediate debug signal for a tampered/garbage tx.
 *
 *  Callers MUST treat `false` as NON-BLOCKING (log + still attempt broadcast): a parse edge case
 *  (e.g. a future versioned-tx format, or an e2e harness carrying placeholder bytes) must never
 *  strand a legitimate payment. The real correctness gate stays on-chain. */
export function verifySignedTransaction(signedTx: Uint8Array): boolean {
  const parts = extractSignedTxParts(signedTx);
  if (!parts) return false;
  try {
    return ed25519.verify(parts.signature, parts.message, parts.feePayer);
  } catch {
    return false;
  }
}
