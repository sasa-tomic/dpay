// Hand-rolled Solana durable-nonce instruction builders (legacy pre-v0 message format).
// PURE module — no network. Byte-exact against @solana/web3.js v1 (golden vectors in
// __tests__/solana-nonce.test.ts). Implements the two message shapes the offline-pay rail needs:
//   (1) CreateAccount + InitializeNonceAccount  — sets up the payer's durable nonce account.
//   (2) AdvanceNonceAccount(ix0) + Transfer       — the offline-signed, stale-blockhash-immune payment.
//
// Account ordering follows @solana/web3.js Message.compile exactly: unique accounts are sorted by
// (isSigner desc, isWritable desc, base58 localeCompare asc) then the fee-payer is pinned to index 0;
// the table is then split into a contiguous signer block followed by nonsigners. See golden parse notes.

import bs58 from 'bs58';
import {
  base58Decode32,
  encodeCompactU16,
  encodeU32LE,
  encodeU64LE,
  SYSTEM_PROGRAM_BYTES,
} from './tx';

/** Durable nonce accounts are exactly 80 bytes (rent-exempt minimum = 890880 + 80*6960 = 1447680). */
export const NONCE_ACCOUNT_LENGTH = 80;

// Sysvar addresses referenced by nonce instructions. NOTE the digit `1` in `B1ock`/`Rent`-adjacent
// spellings — these are the real on-chain base58 addresses (a quirk of Solana's sysvar naming).
export const SYSVAR_RECENT_BLOCKHASHES_ADDRESS = 'SysvarRecentB1ockHashes11111111111111111111';
export const SYSVAR_RENT_ADDRESS = 'SysvarRent111111111111111111111111111111111';

const SYSVAR_RECENT_BLOCKHASHES_BYTES = base58Decode32(SYSVAR_RECENT_BLOCKHASHES_ADDRESS);
const SYSVAR_RENT_BYTES = base58Decode32(SYSVAR_RENT_ADDRESS);

// System Program instruction discriminators (bincode u32 LE).
const IX_CREATE_ACCOUNT = 0;
const IX_INITIALIZE_NONCE = 6;
const IX_ADVANCE_NONCE = 4;
const IX_TRANSFER = 2;

// The collator @solana/web3.js uses to break ties within an account-key bucket.
const LOCALE_OPTS = {
  sensitivity: 'variant' as const,
  numeric: false,
  caseFirst: 'lower' as const,
};

/** An account reference inside an instruction (mirrors @solana/web3.js AccountMeta). */
export interface AccountMeta {
  pubkey: Uint8Array;
  signer: boolean;
  writable: boolean;
}

/** A compiled instruction: a program id, its ordered account references, and opaque data. */
export interface Instruction {
  programId: Uint8Array;
  keys: AccountMeta[];
  data: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Assemble a legacy Solana message from a fee payer, an ordered instruction list, and a recent
 * blockhash. Produces the exact byte layout @solana/web3.js Message.compile emits, including the
 * account-key sort (signer, writable, base58-localeCompare) and the contiguous signer block.
 */
export function assembleMessage(
  feePayer: Uint8Array,
  instructions: Instruction[],
  blockhash: Uint8Array,
): Uint8Array {
  if (blockhash.length !== 32) throw new Error('blockhash must be 32 bytes');

  // Collect unique accounts with OR-merged signer/writable flags (keyed by base58 string).
  const order: string[] = [];
  const map = new Map<string, AccountMeta>();
  const upsert = (pubkey: Uint8Array, signer: boolean, writable: boolean): void => {
    const b58 = bs58.encode(pubkey);
    const existing = map.get(b58);
    if (existing) {
      existing.signer = existing.signer || signer;
      existing.writable = existing.writable || writable;
    } else {
      map.set(b58, { pubkey, signer, writable });
      order.push(b58);
    }
  };
  for (const ix of instructions) {
    for (const k of ix.keys) upsert(k.pubkey, k.signer, k.writable);
    upsert(ix.programId, false, false);
  }
  // The fee payer is always a writable signer.
  upsert(feePayer, true, true);

  let metas = Array.from(map.values());
  metas.sort((a, b) => {
    if (a.signer !== b.signer) return a.signer ? -1 : 1;
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    return bs58.encode(a.pubkey).localeCompare(bs58.encode(b.pubkey), 'en', LOCALE_OPTS);
  });

  // Pin the fee payer to the front of the (already signer-first) table.
  const fpIndex = metas.findIndex(m => bytesEqual(m.pubkey, feePayer));
  if (fpIndex > 0) {
    const [fp] = metas.splice(fpIndex, 1);
    metas.unshift(fp);
  }

  // Split into a contiguous signer block followed by nonsigners, counting header fields.
  const signedKeys: AccountMeta[] = [];
  const unsignedKeys: AccountMeta[] = [];
  let numReadonlySigned = 0;
  let numReadonlyUnsigned = 0;
  for (const m of metas) {
    if (m.signer) {
      signedKeys.push(m);
      if (!m.writable) numReadonlySigned++;
    } else {
      unsignedKeys.push(m);
      if (!m.writable) numReadonlyUnsigned++;
    }
  }
  const accountKeys = signedKeys.concat(unsignedKeys);
  const numRequiredSignatures = signedKeys.length;

  const indexOf = (pubkey: Uint8Array): number => {
    for (let i = 0; i < accountKeys.length; i++) {
      if (bytesEqual(accountKeys[i].pubkey, pubkey)) return i;
    }
    throw new Error('internal: account key missing from table');
  };

  const out: number[] = [];
  out.push(numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned);
  encodeCompactU16(out, accountKeys.length);
  for (const k of accountKeys) for (let i = 0; i < 32; i++) out.push(k.pubkey[i]);
  for (let i = 0; i < 32; i++) out.push(blockhash[i]);
  encodeCompactU16(out, instructions.length);
  for (const ix of instructions) {
    out.push(indexOf(ix.programId));
    encodeCompactU16(out, ix.keys.length);
    for (const k of ix.keys) out.push(indexOf(k.pubkey));
    encodeCompactU16(out, ix.data.length);
    for (const b of ix.data) out.push(b);
  }
  return new Uint8Array(out);
}

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
