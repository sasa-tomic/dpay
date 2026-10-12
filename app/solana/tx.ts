// Hand-rolled Solana legacy (pre-v0) System Program Transfer transaction builder + signer.
// PURE module — no network. Byte-exact against @solana/web3.js v1 (golden vectors in
// __tests__/solana-tx.test.ts). Produces the serialized signed transaction bytes that
// `sendTransaction` accepts base64-encoded in its params array.
//
// Account ordering for a single System.transfer: [from(writable,signer,idx0),
// to(writable,nonsigner,idx1), SystemProgram(readonly,nonsigner,idx2)].

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';
import { utf8ToBytes } from '../lib/base64url';
import { encodeSolReq, type SolReqV2 } from './qr';
import { SYSTEM_PROGRAM_ADDRESS } from './constants';

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

// ============================================================================
// Generic message assembly — MOVED from nonce.ts (Phase 2 of the recent-blockhash rewrite).
// nonce.ts re-exports these so its existing consumers keep compiling unchanged; Phase 3 deletes
// the nonce builders and re-points callers directly here. These are the low-level primitives that
// produce the exact byte layout @solana/web3.js Message.compile emits.
// ============================================================================

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

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
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
  upsert(feePayer, true, true);

  let metas = Array.from(map.values());
  metas.sort((a, b) => {
    if (a.signer !== b.signer) return a.signer ? -1 : 1;
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    return bs58.encode(a.pubkey).localeCompare(bs58.encode(b.pubkey), 'en', LOCALE_OPTS);
  });

  const fpIndex = metas.findIndex(m => bytesEqual(m.pubkey, feePayer));
  if (fpIndex > 0) {
    const [fp] = metas.splice(fpIndex, 1);
    metas.unshift(fp);
  }

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
 * Build a System Program `transfer` instruction with optional extra READONLY account keys — the
 * Solana Pay `reference` mechanism. A merchant matches the payment to their sale by scanning for
 * transfers whose instruction carries the reference pubkey as an additional (non-signing,
 * non-writable) account key; the System Program itself ignores the extras, so the transfer is
 * identical to a plain one plus the matching key. Byte-exact against
 * @solana/web3.js `SystemProgram.transfer(...).keys.concat(references.map(...))`.
 */
export function buildSolTransferInstruction(
  fromPubkey: Uint8Array,
  toPubkey: Uint8Array,
  lamports: bigint,
  additionalKeys: Uint8Array[] = [],
): Instruction {
  if (lamports < 0n) throw new Error('lamports must be non-negative');
  const data: number[] = [];
  encodeU32LE(data, TRANSFER_DISCRIMINATOR);
  encodeU64LE(data, lamports);
  return {
    programId: SYSTEM_PROGRAM_BYTES,
    keys: [
      {pubkey: fromPubkey, signer: true, writable: true},
      {pubkey: toPubkey, signer: false, writable: true},
      ...additionalKeys.map(pubkey => ({pubkey, signer: false, writable: false})),
    ],
    data: new Uint8Array(data),
  };
}

// ============================================================================
// Phase 2 — Canonical recent-blockhash v2 transaction construction + STRICT verification.
// These build the {Memo, transfer} message that binds a SolReqV2 into the signed transaction, plus
// the money-critical verifier the merchant runs before broadcasting. See invariant #4/#5/#6 in
// 2026-08-12-solana-recent-blockhash-rewrite-plan.md.
// ============================================================================

export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PROGRAM_BYTES = base58Decode32(MEMO_PROGRAM_ADDRESS);

const HEX_DIGITS = '0123456789abcdef';

export function buildMemoInstruction(data: Uint8Array): Instruction {
  return { programId: MEMO_PROGRAM_BYTES, keys: [], data };
}

/**
 * The memo payload for a v2 request: the UTF-8 bytes of `dpay-solreq-v2:` + lowercase hex of the
 * SHA-256 of the canonical `solreq:v2?<payload>` URI. Domain-separated and stable across
 * Hermes/Node/browser (hand-rolled hex, no Buffer dependency).
 */
export function solreqMemoData(canonicalRequestUri: string): Uint8Array {
  const digest = sha256(utf8ToBytes(canonicalRequestUri));
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += HEX_DIGITS[digest[i] >> 4];
    hex += HEX_DIGITS[digest[i] & 0x0f];
  }
  return utf8ToBytes('dpay-solreq-v2:' + hex);
}

/**
 * Build the canonical SOL v2 message: {Memo(ix0), System.transfer(ix1)} with recentBlockhash =
 * request.bh. The memo binds every request field (recipient, amount, blockhash, rid, …); the
 * transfer commits to recipient + amount. The payer is the sole signer and fee payer.
 */
export function buildCanonicalSolMessage(payer: Uint8Array, request: SolReqV2): Uint8Array {
  const canonicalUri = encodeSolReq(request);
  const memoIx = buildMemoInstruction(solreqMemoData(canonicalUri));
  const transferData: number[] = [];
  encodeU32LE(transferData, TRANSFER_DISCRIMINATOR);
  encodeU64LE(transferData, BigInt(request.amt));
  const transferIx: Instruction = {
    programId: SYSTEM_PROGRAM_BYTES,
    keys: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: base58Decode32(request.to), signer: false, writable: true },
    ],
    data: new Uint8Array(transferData),
  };
  return assembleMessage(payer, [memoIx, transferIx], base58Decode32(request.bh));
}

/**
 * STRICT money-critical verifier. Decodes the single-signer legacy transaction, requires the signed
 * message to be BYTE-EQUAL to the canonical message rebuilt from the open request + payer pubkey,
 * and verifies the Ed25519 signature. NEVER throws across the UI boundary — every failure returns
 * `{ok:false, reason}`. The caller rebuilds `expectedMessage` via buildCanonicalSolMessage /
 * buildCanonicalSplMessage so this function stays currency-agnostic (and avoids a tx.ts↔spl.ts
 * circular import).
 */
export type SolVerifyResult = { ok: true; payer: string; signature: string } | { ok: false; reason: string };

export function verifySolPayment(
  expectedMessage: Uint8Array,
  payment: { tx: Uint8Array },
): SolVerifyResult {
  try {
    const sigCountDec = decodeCompactU16(payment.tx, 0);
    if (sigCountDec.value !== 1) return { ok: false, reason: 'signer-count' };
    const parts = extractSignedTxParts(payment.tx);
    if (!parts) return { ok: false, reason: 'malformed' };
    if (!bytesEqual(parts.message, expectedMessage)) return { ok: false, reason: 'message-mismatch' };
    if (!ed25519.verify(parts.signature, parts.message, parts.feePayer)) {
      return { ok: false, reason: 'bad-signature' };
    }
    return { ok: true, payer: bs58.encode(parts.feePayer), signature: bs58.encode(parts.signature) };
  } catch (e) {
    // THE MERCHANT'S DECLINE PATH. Every other `reason` above names something about the PAYMENT;
    // this one names something about US — a decoder that threw. Reported as a refusal (correct: an
    // unverifiable payment must never be accepted) but logged, because a bug in this file and a
    // genuinely bad payment used to be the same opaque word on a counter.
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`verifySolPayment: decoding a ${payment.tx.length}-byte payment threw — refusing it: ${detail}`);
    return { ok: false, reason: 'exception' };
  }
}

// ============================================================================
// Venue-built swap transactions (Jupiter / solana_amm venues, 2026-09-15).
//
// A venue does not hand the wallet a transfer to build — it hands the wallet the WHOLE
// transaction, pre-assembled around its route, and asks for one signature. The device's job is
// therefore not construction but VERIFICATION-then-signature, and the verification is the
// red-line surface (multi-venue readiness V9, the Solana analog of the IC beneficiary checks):
//
//   1. the fee payer is the user (account key[0] — whoever pays fees moves value; a venue
//      building a tx that spends someone else's fees is a mis-built or hostile tx);
//   2. for an SPL output, the destination token account present in the tx is the USER'S OWN
//      ATA for that mint (the beneficiary check — the swap must route the output to the user,
//      and the venue's tx names the destination account explicitly);
//   3. the ONLY required signature is the user's own. Track S (2026-10-12) generalized the
//      decode to multi-signer layouts so the WC path can name every slot, but the VENUE sign
//      path keeps the original red line: a route demanding another signer is something this
//      wallet cannot honestly execute — refused, never partial-signed. `signVenueSwapTx` only
//      signs co-signed txs when the caller passes `{allowCoSigners: true}` (the WC review
//      surface, after the sheet has displayed the fee payer).
//
// Fee payer (displayed-else-refuse law): the decode exposes `feePayer` explicitly so a caller
// can always SHOW who pays fees — a sponsored tx (someone else pays) must never be silently
// refused OR silently accepted; the review displays it and the user decides.
//
// Shapes: the request to Jupiter asks for a LEGACY transaction (`asLegacyTransaction`), so every
// account key is IN the bytes. A versioned (v0) reply is still decoded — static keys first,
// exactly as the wire format orders them — but a v0 reply whose beneficiary is NOT resolvable
// from the static keys is refused: this wallet does not sign what it cannot verify against the
// bytes in hand (address-lookup-table contents are chain state the device would have to trust
// blind). PURE module — no network, no throws across the verify path.
// ============================================================================

/** What the decoder recovered from a venue-built (unsigned) transaction. */
export type DecodedVenueTx = {
  /** The exact message bytes to sign (everything after the signature slots). */
  readonly message: Uint8Array;
  /** Offset of signature slot 0 (the fee payer's slot) inside the ORIGINAL bytes. */
  readonly sigSlotOffset: number;
  /** Static account keys in wire order; key[0] is the fee payer. */
  readonly accountKeys: readonly Uint8Array[];
  /** False ⇒ versioned (v0) message — static keys only; see the section note. */
  readonly legacy: boolean;
  /** numRequiredSignatures from the message header — how many leading account keys must sign. */
  readonly requiredSignatures: number;
  /** Every signature slot offset in wire order; slot i belongs to `signers[i]`. */
  readonly sigSlotOffsets: readonly number[];
  /** The required signers in wire order — accountKeys[0 .. requiredSignatures). */
  readonly signers: readonly Uint8Array[];
  /** The fee payer (account key[0], spelled out so callers never re-derive "key[0] is it"). */
  readonly feePayer: Uint8Array;
};

/** Decode a venue-built unsigned transaction. Accepts multi-signer layouts (wire sigCount must
 *  equal the message header's numRequiredSignatures, both >= 1). Null on ANY malformed layout —
 *  pure + total. */
export function decodeVenueSwapTx(bytes: Uint8Array): DecodedVenueTx | null {
  const sigCountDec = decodeCompactU16(bytes, 0);
  const sigCount = sigCountDec.value;
  if (sigCount < 1) return null;
  const sigSlotOffset = sigCountDec.next;
  const msgStart = sigSlotOffset + 64 * sigCount;
  if (bytes.length <= msgStart) return null;
  const message = bytes.subarray(msgStart);

  let headerAt: number;
  let legacy: boolean;
  if ((message[0] & 0x80) !== 0) {
    // Versioned: [version|0x80, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned].
    if ((message[0] & 0x7f) !== 0) return null; // v0 only — later versions are not our contract
    headerAt = 1;
    legacy = false;
  } else {
    headerAt = 0;
    legacy = true;
  }
  if (message.length < headerAt + 3) return null;
  const requiredSignatures = message[headerAt];
  // The wire's signature-slot count and the header's required-signature count are the SAME
  // number in any well-formed tx; a mismatch means the bytes do not parse honestly.
  if (requiredSignatures < 1 || requiredSignatures !== sigCount) return null;
  const keysCountDec = decodeCompactU16(message, headerAt + 3);
  let off = keysCountDec.next;
  if (keysCountDec.value < requiredSignatures || keysCountDec.value > 128) return null;
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < keysCountDec.value; i++) {
    if (off + 32 > message.length) return null;
    accountKeys.push(message.subarray(off, off + 32));
    off += 32;
  }
  const sigSlotOffsets: number[] = [];
  for (let i = 0; i < sigCount; i++) sigSlotOffsets.push(sigSlotOffset + 64 * i);
  return {
    message,
    sigSlotOffset,
    accountKeys,
    legacy,
    requiredSignatures,
    sigSlotOffsets,
    signers: accountKeys.slice(0, requiredSignatures),
    feePayer: accountKeys[0],
  };
}

/** The beneficiary verdict for a venue swap tx — checked BEFORE the device signs anything. */
export type VenueTxBeneficiary =
  | { ok: true }
  | { ok: false; reason: 'fee-payer' | 'beneficiary' };

/** Red-line check (see the section note): the user is the fee payer AND — for an SPL output —
 *  the user's own ATA for the output mint is one of the tx's static account keys. For a native
 *  (unwrapped-SOL) output the destination IS the fee payer, so check 1 already covers it. */
export function verifyVenueSwapTxBeneficiaries(
  decoded: DecodedVenueTx,
  user: { pubkey: Uint8Array; outAta: Uint8Array | null },
): VenueTxBeneficiary {
  if (decoded.accountKeys.length < 1) return { ok: false, reason: 'fee-payer' };
  if (!bytesEqual(decoded.accountKeys[0], user.pubkey)) return { ok: false, reason: 'fee-payer' };
  if (user.outAta != null) {
    const found = decoded.accountKeys.some(k => bytesEqual(k, user.outAta as Uint8Array));
    if (!found) return { ok: false, reason: 'beneficiary' };
  }
  return { ok: true };
}

/** Options for `signVenueSwapTx`. */
export type VenueSignOptions = {
  /** Allow txs whose required-signer set includes keys OTHER than the device's: the device signs
   *  its own slot(s) and the remaining slots are left exactly as received (a dApp co-signer fills
   *  them). Default false — the venue swap path keeps its "refused, never partial-signed" red
   *  line. The WC review surface opts in AFTER the sheet has displayed the fee payer. */
  readonly allowCoSigners?: boolean;
};

/**
 * Sign a venue-built transaction in place: the slot(s) whose pubkey matches the device key get
 * the Ed25519 signature over the (untouched) message; every other signature slot is preserved
 * byte-for-byte (a partially co-signed tx arrives with its co-signers' signatures in place).
 * Refuses (returns null) when the device key is NOT one of the required signers — this wallet
 * never signs a tx it is not a party to — and, unless `allowCoSigners` is set, when the tx needs
 * more signatures than the device alone can supply. Returns the raw signed bytes for broadcast,
 * the base58 signature (the tx's on-chain identity — Solana dedups resubmission by it), the fee
 * payer's base58 address, the device's signer position, and whether ALL required slots now hold
 * signatures (false ⇒ someone else must still co-sign before broadcast). The original `bytes`
 * are never mutated.
 */
export function signVenueSwapTx(
  bytes: Uint8Array,
  seed: Uint8Array,
  opts: VenueSignOptions = {},
): {
  raw: Uint8Array;
  signature: string;
  feePayer: string;
  signerIndex: number;
  requiredSignatures: number;
  fullySigned: boolean;
} | null {
  const decoded = decodeVenueSwapTx(bytes);
  if (decoded == null) return null;
  const devicePubkey = ed25519.getPublicKey(seed);
  const signerIndex = decoded.signers.findIndex(s => bytesEqual(s, devicePubkey));
  if (signerIndex < 0) return null; // not a required signer: never sign
  if (decoded.requiredSignatures > 1 && opts.allowCoSigners !== true) return null;
  const signature = ed25519.sign(decoded.message, seed);
  const raw = new Uint8Array(bytes.length);
  raw.set(bytes);
  raw.set(signature, decoded.sigSlotOffsets[signerIndex]);
  // fullySigned: every required slot holds a nonzero signature after our write. A zero slot is
  // an unfilled co-signer (fresh wire bytes are zeroed there by convention).
  const slotIsZero = (at: number): boolean => {
    for (let j = 0; j < 64; j++) if (raw[at + j] !== 0) return false;
    return true;
  };
  let fullySigned = true;
  for (let i = 0; i < decoded.requiredSignatures; i++) {
    if (slotIsZero(decoded.sigSlotOffsets[i])) fullySigned = false;
  }
  return {
    raw,
    signature: bs58.encode(signature),
    feePayer: bs58.encode(decoded.feePayer),
    signerIndex,
    requiredSignatures: decoded.requiredSignatures,
    fullySigned,
  };
}

/** Lowercase hex of a byte array — hand-rolled (Hermes-safe, no Buffer), the solreqMemoData
 *  spelling factored out for reuse (the convert record stores the signed tx as hex). */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_DIGITS[bytes[i] >> 4];
    hex += HEX_DIGITS[bytes[i] & 0x0f];
  }
  return hex;
}

/** Inverse of `bytesToHex` — even-length, lowercase-hex input only; null otherwise. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX_DIGITS.indexOf(hex[i * 2]);
    const lo = HEX_DIGITS.indexOf(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}
