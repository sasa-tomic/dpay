// Semantic decoder for the WalletConnect Solana review surface (Track S step 3,
// docs/specs/2026-10-12-walletconnect-integration-plan.md). PURE module — no network, no React,
// no RN imports; safe to unit-test and to import from any surface.
//
// A dApp hands the wallet a SERIALIZED transaction (legacy or v0, base64 on the WC wire). The
// review sheet's job is the same law as the EVM side's WcRequestSheet calldata law: structured
// rows for the actions this wallet can decode honestly, and ANYTHING ELSE rendered raw behind
// an explicit unknown warning. Never guesses. An instruction is decoded only when its program
// id, data layout, AND account references all match the known shape exactly; the raw fallback
// carries the program id, account addresses, and data hex so the user sees exactly what would
// run.
//
// v0 caveat (the venue decoder's rule, restated): account/program indexes beyond the static
// key table resolve only through address-lookup tables — chain state the device cannot see.
// Such instructions fall to the raw fallback with `programId: null` rather than pretending to
// know. Also exposes `feePayer` + `signers` up front so the review can always show who pays
// fees and who must sign (the displayed-else-refuse law).
//
// Conformance: the v1 Solana method surface lives here too — the single list the namespace
// wiring may advertise, kept next to the decoder that serves it (advertised <= implemented).

import bs58 from 'bs58';
import {bytesToUtf8} from '../lib/base64url';
import {base58Decode32, bytesEqual, bytesToHex, decodeCompactU16, MEMO_PROGRAM_ADDRESS} from './tx';
import {SYSTEM_PROGRAM_ADDRESS} from './constants';
import {TOKEN_PROGRAM_ADDRESS} from './spl';

// ============================================================================
// Conformance — the v1 advertised method surface (plan §Track S step 4 + 6).
// ============================================================================

/** The only Solana chain id v1 advertises: mainnet-beta as CAIP-2 (plan §2.4). */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * The v1 Solana method surface: EXACTLY what the session proposal may advertise. The
 * advertised<=implemented law: a method joins this list only when its implementation has
 * landed. `solana_signAllTransactions` is deliberately OUT of v1 (batches are unsupported;
 * step 2 covers single-transaction multi-signer slots only) — it is pinned in
 * SOLANA_METHODS_OUTSIDE_V1 so a future edit must confront the plan's reason first.
 */
export const SOLANA_V1_METHODS = [
  'solana_getAccounts',
  'solana_requestAccounts',
  'solana_signMessage',
  'solana_signTransaction',
  'solana_signAndSendTransaction',
] as const;

export type SolanaV1Method = (typeof SOLANA_V1_METHODS)[number];

/** Solana methods explicitly excluded from v1, each with the plan's reason attached. */
export const SOLANA_METHODS_OUTSIDE_V1 = [
  {method: 'solana_signAllTransactions', reason: 'transaction batches unsupported in v1'},
] as const;

// ============================================================================
// Decoder
// ============================================================================

/** One decoded instruction. `unknown` is the raw fallback — the explicit not-decoded shape. */
export type WcSolanaInstruction =
  | {kind: 'systemTransfer'; programId: string; from: string; to: string; lamports: bigint}
  | {
      kind: 'splTransfer';
      programId: string;
      source: string;
      destination: string;
      owner: string;
      amount: bigint;
      /** Plain `transfer` does not name the mint — it is whatever account `source` holds. */
      mint: null;
    }
  | {
      kind: 'splTransferChecked';
      programId: string;
      source: string;
      mint: string;
      destination: string;
      owner: string;
      amount: bigint;
      decimals: number;
    }
  | {kind: 'memo'; programId: string; text: string | null; dataHex: string}
  | {
      kind: 'unknown';
      /** null ⇒ the program id sits behind an address-lookup table (not in the static keys). */
      programId: string | null;
      /** Account addresses in wire order; null = behind a lookup table. */
      accounts: readonly (string | null)[];
      dataHex: string;
      /** Machine-readable reason the instruction fell to the raw fallback (the sheet renders
       *  its own explicit-unknown copy; this names WHY, honestly). */
      warning: string;
    };

/** Everything the review surface needs from one serialized transaction. */
export type WcSolanaTx = {
  /** Account key[0] — whoever pays the network fee. Always shown, even when it is not the user
   *  (sponsored txs are displayed, then the user decides — never silently refused or accepted). */
  readonly feePayer: string;
  /** The required signers in wire order (account keys [0 .. requiredSignatures)). */
  readonly signers: readonly string[];
  readonly requiredSignatures: number;
  /** False ⇒ versioned (v0) message; only static keys are decoded (see the module note). */
  readonly legacy: boolean;
  readonly instructions: readonly WcSolanaInstruction[];
  /** True when at least one instruction fell to the raw fallback — the sheet must show the
   *  explicit unknown warning. */
  readonly hasUnknown: boolean;
};

const SYSTEM_PROGRAM_BYTES = base58Decode32(SYSTEM_PROGRAM_ADDRESS);
const TOKEN_PROGRAM_BYTES = base58Decode32(TOKEN_PROGRAM_ADDRESS);
const MEMO_PROGRAM_BYTES = base58Decode32(MEMO_PROGRAM_ADDRESS);

// Instruction discriminators. The System Program's is a bincode u32 LE; the Token Program's is
// a SINGLE u8 (its own convention — see spl.ts, which builds the same two instructions).
const SYSTEM_TRANSFER_DISCRIMINATOR = 2;
const TOKEN_IX_TRANSFER = 3;
const TOKEN_IX_TRANSFER_CHECKED = 12;

/** u64 LE read as an exact bigint (money-critical: never through JS `number`). */
function readU64LE(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

function readU32LE(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24);
}

/**
 * Decode a serialized Solana transaction (legacy or v0, with or without signature slots filled)
 * into the review surface's shape. Null on ANY malformed layout — pure + total, never throws.
 */
export function decodeWcSolanaTx(bytes: Uint8Array): WcSolanaTx | null {
  const sigCountDec = decodeCompactU16(bytes, 0);
  const sigCount = sigCountDec.value;
  if (sigCount < 1) return null;
  const msgStart = sigCountDec.next + 64 * sigCount;
  if (bytes.length <= msgStart) return null;
  const message = bytes.subarray(msgStart);

  let headerAt: number;
  let legacy: boolean;
  if ((message[0] & 0x80) !== 0) {
    if ((message[0] & 0x7f) !== 0) return null; // v0 only — later versions are not our contract
    headerAt = 1;
    legacy = false;
  } else {
    headerAt = 0;
    legacy = true;
  }
  if (message.length < headerAt + 3) return null;
  const requiredSignatures = message[headerAt];
  if (requiredSignatures < 1 || requiredSignatures !== sigCount) return null;

  const keysCountDec = decodeCompactU16(message, headerAt + 3);
  let off = keysCountDec.next;
  // 128 keys ≈ 4 KB of account table; the 1232-byte packet MTU physically caps real txs far
  // below it — anything larger is malformed (same cap as decodeVenueSwapTx).
  if (keysCountDec.value < requiredSignatures || keysCountDec.value > 128) return null;
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < keysCountDec.value; i++) {
    if (off + 32 > message.length) return null;
    accountKeys.push(message.subarray(off, off + 32));
    off += 32;
  }
  off += 32; // recent blockhash — skipped, the review surface does not display it
  if (off > message.length) return null;
  const ixCountDec = decodeCompactU16(message, off);
  off = ixCountDec.next;

  const keyAt = (index: number): Uint8Array | null =>
    index >= 0 && index < accountKeys.length ? accountKeys[index] : null;
  const key58 = (index: number): string | null => {
    const k = keyAt(index);
    return k == null ? null : bs58.encode(k);
  };

  const instructions: WcSolanaInstruction[] = [];
  for (let i = 0; i < ixCountDec.value; i++) {
    if (off >= message.length) return null;
    const programIdIndex = message[off++];
    const acctCountDec = decodeCompactU16(message, off);
    off = acctCountDec.next;
    const acctIndexes: number[] = [];
    for (let a = 0; a < acctCountDec.value; a++) {
      if (off >= message.length) return null;
      acctIndexes.push(message[off++]);
    }
    const dataLenDec = decodeCompactU16(message, off);
    off = dataLenDec.next;
    if (off + dataLenDec.value > message.length) return null;
    const data = message.subarray(off, off + dataLenDec.value);
    off += dataLenDec.value;
    instructions.push(decodeInstruction(keyAt, key58, programIdIndex, acctIndexes, data));
  }

  return {
    feePayer: bs58.encode(accountKeys[0]),
    signers: accountKeys.slice(0, requiredSignatures).map(bs58.encode),
    requiredSignatures,
    legacy,
    instructions,
    hasUnknown: instructions.some(ix => ix.kind === 'unknown'),
  };
}

/** Classify ONE compiled instruction against the known shapes; anything that does not match
 *  EXACTLY falls to the raw fallback (never guesses). */
function decodeInstruction(
  keyAt: (index: number) => Uint8Array | null,
  key58: (index: number) => string | null,
  programIdIndex: number,
  acctIndexes: readonly number[],
  data: Uint8Array,
): WcSolanaInstruction {
  const programBytes = keyAt(programIdIndex);
  const accounts: (string | null)[] = acctIndexes.map(key58);
  const unknown = (warning: string): WcSolanaInstruction => ({
    kind: 'unknown',
    programId: key58(programIdIndex),
    accounts,
    dataHex: bytesToHex(data),
    warning,
  });

  if (programBytes == null) {
    return unknown('program id lives in an address-lookup table — not decodable from the bytes in hand');
  }
  const programId = bs58.encode(programBytes);

  if (bytesEqual(programBytes, MEMO_PROGRAM_BYTES)) {
    // Memo v2: no accounts, data IS the memo (UTF-8 by convention; not all bytes are text).
    let text: string | null = null;
    try {
      text = bytesToUtf8(data);
    } catch {
      text = null; // not valid UTF-8 — the hex is shown instead, never a mangled guess
    }
    return {kind: 'memo', programId, text, dataHex: bytesToHex(data)};
  }

  if (bytesEqual(programBytes, SYSTEM_PROGRAM_BYTES)) {
    // System.transfer: u32 LE discriminator(2) || u64 LE lamports — exactly 12 bytes; keys
    // [from, to]. Anything else about this program is not a shape we structure.
    if (data.length === 12 && readU32LE(data, 0) === SYSTEM_TRANSFER_DISCRIMINATOR && acctIndexes.length >= 2) {
      const from = key58(acctIndexes[0]);
      const to = key58(acctIndexes[1]);
      if (from != null && to != null) {
        return {kind: 'systemTransfer', programId, from, to, lamports: readU64LE(data, 4)};
      }
    }
    return unknown('system program instruction outside the known transfer shape');
  }

  if (bytesEqual(programBytes, TOKEN_PROGRAM_BYTES)) {
    // Token program discriminators are a single u8 (spl.ts documents the convention).
    if (data.length === 9 && data[0] === TOKEN_IX_TRANSFER && acctIndexes.length >= 3) {
      const source = key58(acctIndexes[0]);
      const destination = key58(acctIndexes[1]);
      const owner = key58(acctIndexes[2]);
      if (source != null && destination != null && owner != null) {
        return {kind: 'splTransfer', programId, source, destination, owner, amount: readU64LE(data, 1), mint: null};
      }
    }
    if (data.length === 10 && data[0] === TOKEN_IX_TRANSFER_CHECKED && acctIndexes.length >= 4) {
      const source = key58(acctIndexes[0]);
      const mint = key58(acctIndexes[1]);
      const destination = key58(acctIndexes[2]);
      const owner = key58(acctIndexes[3]);
      if (source != null && mint != null && destination != null && owner != null) {
        return {
          kind: 'splTransferChecked',
          programId,
          source,
          mint,
          destination,
          owner,
          amount: readU64LE(data, 1),
          decimals: data[9],
        };
      }
    }
    return unknown('token program instruction outside the known transfer shapes');
  }

  return unknown('program not decoded — review the raw data before signing');
}
