// Hand-rolled Solana durable-nonce instruction builders (legacy pre-v0 message format).
// PURE module — no network. Byte-exact against @solana/web3.js v1 (golden vectors in
// __tests__/solana-nonce.test.ts). Implements the two message shapes the offline-pay rail needs:
//   (1) CreateAccount + InitializeNonceAccount  — sets up the payer's durable nonce account.
//   (2) AdvanceNonceAccount(ix0) + Transfer       — the offline-signed, stale-blockhash-immune payment.
//
// Phase 2 of the recent-blockhash rewrite MOVED the generic message-assembly primitives
// (AccountMeta, Instruction, bytesEqual, assembleMessage) to tx.ts — the low-level primitives
// module that already owns base58Decode32/encodeCompactU16/encodeU64LE/ed25519. This file re-exports
// them so every existing consumer (spl.ts, App.tsx, solana.ts, nonce-test) keeps compiling
// UNCHANGED; Phase 3 deletes the nonce builders and re-points callers directly to tx.ts.

import {
  base58Decode32,
  encodeU32LE,
  encodeU64LE,
  SYSTEM_PROGRAM_BYTES,
  assembleMessage,
} from './tx';
import type { Instruction } from './tx';

// Re-export the moved assembly primitives so existing consumers keep compiling (Phase 3 deletes
// this re-export and re-points callers directly to ./tx).
export { assembleMessage, bytesEqual } from './tx';
export type { AccountMeta, Instruction } from './tx';

/** Durable nonce accounts are exactly 80 bytes (rent-exempt minimum = 890880 + 80*6960 = 1447680). */
export const NONCE_ACCOUNT_LENGTH = 80;

// Sysvar addresses referenced by nonce instructions. NOTE the digit `1` in `B1ock`/`Rent`-adjacent
// spellings — these are the real on-chain base58 addresses (a quirk of Solana's sysvar naming).
export const SYSVAR_RECENT_BLOCKHASHES_ADDRESS = 'SysvarRecentB1ockHashes11111111111111111111';
const SYSVAR_RENT_ADDRESS = 'SysvarRent111111111111111111111111111111111';

const SYSVAR_RECENT_BLOCKHASHES_BYTES = base58Decode32(SYSVAR_RECENT_BLOCKHASHES_ADDRESS);
const SYSVAR_RENT_BYTES = base58Decode32(SYSVAR_RENT_ADDRESS);

// System Program instruction discriminators (bincode u32 LE).
const IX_CREATE_ACCOUNT = 0;
const IX_INITIALIZE_NONCE = 6;
const IX_ADVANCE_NONCE = 4;
const IX_TRANSFER = 2;

/**
 * Build the CreateAccount + InitializeNonceAccount message for funding a durable nonce account.
 * Two signers: the authority (fee payer) and the new nonce account keypair. The nonce account is
 * created owned by the System Program and initialized with `authority` as the stored authority.
 */
export function buildCreateNonceAccountMessage(
  authority: Uint8Array,
  nonceAccount: Uint8Array,
  rentLamports: bigint,
  blockhash: Uint8Array,
): Uint8Array {
  if (rentLamports < 0n) throw new Error('rentLamports must be non-negative');

  // CreateAccount data: u32(0) || u64(lamports) || u64(space) || owner(SystemProgram).
  const createData: number[] = [];
  encodeU32LE(createData, IX_CREATE_ACCOUNT);
  encodeU64LE(createData, rentLamports);
  encodeU64LE(createData, BigInt(NONCE_ACCOUNT_LENGTH));
  for (let i = 0; i < 32; i++) createData.push(SYSTEM_PROGRAM_BYTES[i]);

  // InitializeNonceAccount data: u32(6) || authority(32).
  const initData: number[] = [];
  encodeU32LE(initData, IX_INITIALIZE_NONCE);
  for (let i = 0; i < 32; i++) initData.push(authority[i]);

  const instructions: Instruction[] = [
    {
      programId: SYSTEM_PROGRAM_BYTES,
      keys: [
        { pubkey: authority, signer: true, writable: true },
        { pubkey: nonceAccount, signer: true, writable: true },
      ],
      data: new Uint8Array(createData),
    },
    {
      programId: SYSTEM_PROGRAM_BYTES,
      keys: [
        { pubkey: nonceAccount, signer: false, writable: true },
        { pubkey: SYSVAR_RECENT_BLOCKHASHES_BYTES, signer: false, writable: false },
        { pubkey: SYSVAR_RENT_BYTES, signer: false, writable: false },
      ],
      data: new Uint8Array(initData),
    },
  ];
  return assembleMessage(authority, instructions, blockhash);
}

/**
 * Build the AdvanceNonceAccount(ix0) + Transfer(ix1) message for an offline-signed durable-nonce
 * payment. One signer (the authority / fee payer). `recentBlockhash` is the payer's stored nonce
 * VALUE (32 bytes) — not a live blockhash — which is what makes the signature stale-blockhash-immune.
 */
export function buildAdvanceAndTransferMessage(
  authority: Uint8Array,
  nonceAccount: Uint8Array,
  toAddress: string,
  lamports: bigint,
  storedNonce: Uint8Array,
): Uint8Array {
  if (lamports < 0n) throw new Error('lamports must be non-negative');
  const toPubkey = base58Decode32(toAddress);

  // AdvanceNonceAccount data: u32(4).
  const advanceData: number[] = [];
  encodeU32LE(advanceData, IX_ADVANCE_NONCE);

  // Transfer data: u32(2) || u64(lamports).
  const transferData: number[] = [];
  encodeU32LE(transferData, IX_TRANSFER);
  encodeU64LE(transferData, lamports);

  const instructions: Instruction[] = [
    {
      programId: SYSTEM_PROGRAM_BYTES,
      keys: [
        { pubkey: nonceAccount, signer: false, writable: true },
        { pubkey: SYSVAR_RECENT_BLOCKHASHES_BYTES, signer: false, writable: false },
        { pubkey: authority, signer: true, writable: true },
      ],
      data: new Uint8Array(advanceData),
    },
    {
      programId: SYSTEM_PROGRAM_BYTES,
      keys: [
        { pubkey: authority, signer: true, writable: true },
        { pubkey: toPubkey, signer: false, writable: true },
      ],
      data: new Uint8Array(transferData),
    },
  ];
  return assembleMessage(authority, instructions, storedNonce);
}
