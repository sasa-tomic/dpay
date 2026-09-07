// Settle verification — the second, independent read of a confirmed transaction before the
// merchant's broadcast state machine may answer SETTLED (OPEN_ISSUES 6(b) pre-pilot hardening).
//
// `getSignatureStatuses` alone says "a transaction with this signature confirmed" — it does NOT
// say the confirmed body is the one this merchant verified. This module re-reads the transaction
// via `getTransaction` (json encoding) and recompiles its message to the legacy wire layout the
// canonical builders emit (`assembleMessage`: header(3) || compact-u16(N) || keys || blockhash ||
// instructions), then requires FULL-MESSAGE byte equality with the canonical message. Any
// well-formed difference — amount, recipient, memo, an extra instruction, a different blockhash —
// is a mismatch, because the canonical message already commits to every field that matters.
//
// PURE + TOTAL: no network, no react-native, no globals — runs under jest on the fast inner loop,
// and NEVER throws (every malformed input classifies as 'unverifiable', which the caller treats
// as "keep polling", never as a verdict). Three-verdict discipline: an unverifiable answer is
// NEVER promoted to a decline (RailOutcome, services/rail.ts).
import bs58 from 'bs58';
import type {SolanaTransactionDetail} from './rpc';
import {bytesEqual, encodeCompactU16} from './tx';
import {base64ToBytes} from '../lib/base64';

/** What the re-read of a confirmed transaction proves. Ordered by strength:
 *  - 'verified'      — the recompiled body is byte-equal to the canonical message AND meta.err is
 *                      null. The confirmed transfer IS this payment. SETTLED is justified.
 *  - 'onchain-error' — meta.err != null: the chain's own failure record for THIS signature.
 *                      Definitive — the fee was charged, the transfer did not execute.
 *  - 'mismatch'      — a well-formed, err-free confirmed body that is NOT the canonical message
 *                      (including a versioned/v0 or address-lookup-table claim — this rail signs
 *                      legacy only). Terminal doubt: the signature confirms a DIFFERENT
 *                      transaction. The merchant must not treat it as received, and the payer is
 *                      told honest pending (receipt code 3), never a decline.
 *  - 'unverifiable'  — null/malformed detail. NEVER a verdict; the caller keeps polling. */
export type SolSettleEvidence =
  | {kind: 'verified'}
  | {kind: 'onchain-error'}
  | {kind: 'mismatch'; reason: string}
  | {kind: 'unverifiable'; reason: string};

/** Byte length a compact-u16 encoding of `value` occupies (mirror of encodeCompactU16). */
function compactU16Len(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  return 3;
}

function isU8(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
}

/** Decode a base58 string that must be exactly 32 bytes (a pubkey / recent blockhash). */
function decodeBase58_32(s: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(s);
    if (bytes.length !== 32) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Name the first section (header / account keys / recent blockhash / instructions) where two
 *  candidate legacy messages diverge — the mismatch reason a human can act on. */
function firstDifferingSection(recompiled: Uint8Array, canonical: Uint8Array, numAccounts: number): string {
  const keysStart = 3;
  const keysEnd = keysStart + compactU16Len(numAccounts) + 32 * numAccounts;
  const bhEnd = keysEnd + 32;
  const len = Math.min(recompiled.length, canonical.length);
  let off = 0;
  while (off < len && recompiled[off] === canonical[off]) off++;
  if (off < 3) return 'header';
  if (off < keysEnd) return 'account keys';
  if (off < bhEnd) return 'recent blockhash';
  return 'instructions';
}

/**
 * Verify a fetched transaction detail against the canonical message the merchant rebuilt and
 * Ed25519-verified BEFORE broadcasting. Pure + total — never throws. See `SolSettleEvidence` for
 * the classification contract.
 */
export function verifySettledTransaction(
  canonicalMessage: Uint8Array,
  detail: SolanaTransactionDetail | null,
): SolSettleEvidence {
  if (detail === null) {
    return {kind: 'unverifiable', reason: 'getTransaction returned null (unknown or pruned signature)'};
  }
  if (detail.meta == null) {
    return {kind: 'unverifiable', reason: 'transaction detail carries no meta'};
  }
  // The chain's own failure record outranks everything else: the signature exists, the fee was
  // charged, the transfer did not execute.
  if (detail.meta.err != null) {
    return {kind: 'onchain-error'};
  }

  try {
    const tx = detail.transaction;
    if (tx == null || typeof tx !== 'object') return {kind: 'unverifiable', reason: 'transaction envelope missing'};
    const msg = tx.message;
    if (msg == null || typeof msg !== 'object') return {kind: 'unverifiable', reason: 'message missing'};

    // Shape validation — any absent/malformed field is unverifiable, never a verdict.
    if (!Array.isArray(msg.accountKeys) || msg.accountKeys.length === 0) {
      return {kind: 'unverifiable', reason: 'accountKeys missing or empty'};
    }
    if (typeof msg.recentBlockhash !== 'string' || msg.recentBlockhash.length === 0) {
      return {kind: 'unverifiable', reason: 'recentBlockhash missing'};
    }
    const h = msg.header;
    if (
      h == null || typeof h !== 'object' ||
      !isU8(h.numRequiredSignatures) || !isU8(h.numReadonlySignedAccounts) || !isU8(h.numReadonlyUnsignedAccounts)
    ) {
      return {kind: 'unverifiable', reason: 'header missing or malformed'};
    }
    if (!Array.isArray(msg.instructions)) {
      return {kind: 'unverifiable', reason: 'instructions missing'};
    }

    // Versioned-transaction claims: this rail signs legacy messages only, so a v0 body (or an
    // address-lookup-table resolution claim) is a well-formed DIFFERENT transaction — mismatch.
    if (msg.version !== undefined && msg.version !== 'legacy') {
      return {kind: 'mismatch', reason: `versioned message (version=${String(msg.version)}) — the rail signs legacy only`};
    }
    if (msg.addressTableLookups !== undefined && msg.addressTableLookups !== null) {
      return {kind: 'mismatch', reason: 'addressTableLookups present — the rail signs legacy only'};
    }

    // Decode the account table + blockhash.
    const numAccounts = msg.accountKeys.length;
    const keyBytes: Uint8Array[] = [];
    for (const key of msg.accountKeys) {
      if (typeof key !== 'string') return {kind: 'unverifiable', reason: 'accountKey is not a string'};
      const bytes = decodeBase58_32(key);
      if (bytes === null) return {kind: 'unverifiable', reason: 'accountKey is not a 32-byte base58 pubkey'};
      keyBytes.push(bytes);
    }
    const bhBytes = decodeBase58_32(msg.recentBlockhash);
    if (bhBytes === null) return {kind: 'unverifiable', reason: 'recentBlockhash is not a 32-byte base58 value'};

    // Decode the instructions; every index must land inside the account table.
    const decodedIxs: {programIdIndex: number; accounts: number[]; data: Uint8Array}[] = [];
    for (const ix of msg.instructions) {
      if (ix == null || typeof ix !== 'object') return {kind: 'unverifiable', reason: 'instruction is not an object'};
      if (!isU8(ix.programIdIndex) || ix.programIdIndex >= numAccounts) {
        return {kind: 'unverifiable', reason: 'programIdIndex out of range'};
      }
      if (!Array.isArray(ix.accounts)) return {kind: 'unverifiable', reason: 'instruction accounts missing'};
      const accounts: number[] = [];
      for (const a of ix.accounts) {
        if (!isU8(a) || a >= numAccounts) return {kind: 'unverifiable', reason: 'account index out of range'};
        accounts.push(a);
      }
      if (typeof ix.data !== 'string') {
        return {kind: 'unverifiable', reason: 'instruction data missing'};
      }
      let data: Uint8Array;
      try {
        data = base64ToBytes(ix.data);
      } catch {
        return {kind: 'unverifiable', reason: 'instruction data is not valid base64'};
      }
      decodedIxs.push({programIdIndex: ix.programIdIndex, accounts, data});
    }

    // Recompile to the exact legacy wire layout `assembleMessage` emits.
    const out: number[] = [];
    out.push(h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts);
    encodeCompactU16(out, numAccounts);
    for (const k of keyBytes) for (let i = 0; i < 32; i++) out.push(k[i]);
    for (let i = 0; i < 32; i++) out.push(bhBytes[i]);
    encodeCompactU16(out, decodedIxs.length);
    for (const ix of decodedIxs) {
      out.push(ix.programIdIndex);
      encodeCompactU16(out, ix.accounts.length);
      for (const a of ix.accounts) out.push(a);
      encodeCompactU16(out, ix.data.length);
      for (const b of ix.data) out.push(b);
    }
    const recompiled = new Uint8Array(out);

    if (bytesEqual(recompiled, canonicalMessage)) {
      return {kind: 'verified'};
    }
    return {kind: 'mismatch', reason: `confirmed body differs from the canonical message (${firstDifferingSection(recompiled, canonicalMessage, numAccounts)})`};
  } catch (e) {
    return {kind: 'unverifiable', reason: `malformed transaction detail: ${e instanceof Error ? e.message : String(e)}`};
  }
}
