// Minimal ABI encoder for exactly what the EVM rail calls: the ERC-20 surface (transfer /
// transferFrom / balanceOf / allowance) and EIP-2612 permit, plus the two decoders the wallet
// reads back (a uint256 return word, an ERC-20 Transfer log). PURE module.
//
// Only STATIC types appear here — address (left-padded to 32), uint256/uint8 (left-padded),
// bool (0/1) and bytes32 (verbatim) — so one 32-byte word per argument, no head/tail offset
// machinery, no dynamic bytes/string. A function call is selector(4) || args; the selector is the
// FIRST 4 BYTES of keccak256 of the canonical signature string, e.g. transfer(address,uint256)
// → a9059cbb. Selectors are COMPUTED from those canonical signatures, so every caller-visible
// constant (a9059cbb, 70a08231, 23b872dd, dd62ed3e, d505accf) doubles as a golden check that the
// keccak here and the signature strings here are the canonical ones.

import {bytesToHex} from '../lib/format';
import {utf8ToBytes} from '../lib/base64url';
import {keccak256} from './keccak';
import {addressToBytes} from './tx';

/** First 4 bytes of keccak256 of the canonical signature — the function selector. */
export function functionSelector(signature: string): Uint8Array {
  return new Uint8Array(keccak256(utf8ToBytes(signature)).subarray(0, 4));
}

/** One ABI word: uint256/uint8/bool value, left-padded to 32 bytes. Throws past 2^256-1 — a value
 *  that cannot ride an ABI word must refuse at the boundary, not wrap silently. */
export function uint256Word(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 256n) throw new Error(`value out of uint256 range: ${v}`);
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** One ABI word: an address, left-padded to 32 bytes (the 20 bytes ride in the low half). */
export function addressWord(address: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(addressToBytes(address), 12);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function call(selector: Uint8Array, ...words: Uint8Array[]): Uint8Array {
  return concat(selector, ...words);
}

const SELECTOR_TRANSFER = functionSelector('transfer(address,uint256)');
const SELECTOR_BALANCE_OF = functionSelector('balanceOf(address)');
const SELECTOR_TRANSFER_FROM = functionSelector('transferFrom(address,address,uint256)');
const SELECTOR_ALLOWANCE = functionSelector('allowance(address,address)');
const SELECTOR_PERMIT = functionSelector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)');

/** calldata for `transfer(address to,uint256 amount)`. */
export function encodeTransfer(to: string, amount: bigint): Uint8Array {
  return call(SELECTOR_TRANSFER, addressWord(to), uint256Word(amount));
}

/** calldata for `balanceOf(address owner)`. */
export function encodeBalanceOf(owner: string): Uint8Array {
  return call(SELECTOR_BALANCE_OF, addressWord(owner));
}

/** calldata for `transferFrom(address from,address to,uint256 amount)`. */
export function encodeTransferFrom(from: string, to: string, amount: bigint): Uint8Array {
  return call(SELECTOR_TRANSFER_FROM, addressWord(from), addressWord(to), uint256Word(amount));
}

/** calldata for `allowance(address owner,address spender)`. */
export function encodeAllowance(owner: string, spender: string): Uint8Array {
  return call(SELECTOR_ALLOWANCE, addressWord(owner), addressWord(spender));
}

/** calldata for ERC-2612 `permit(address owner,address spender,uint256 value,uint256 deadline,
 *  uint8 v,bytes32 r,bytes32 s)` — the argument order of the FUNCTION (deadline before v), which
 *  is not the order of the EIP-712 struct inside (see permit.ts). r/s are the 32-byte sig halves. */
export function encodePermit(
  owner: string,
  spender: string,
  value: bigint,
  deadline: bigint,
  v: number,
  r: Uint8Array,
  s: Uint8Array,
): Uint8Array {
  return call(
    SELECTOR_PERMIT,
    addressWord(owner),
    addressWord(spender),
    uint256Word(value),
    uint256Word(deadline),
    uint256Word(BigInt(v)),
    uint256Word(bytesWord(r, 'r')),
    uint256Word(bytesWord(s, 's')),
  );
}

function bytesWord(b: Uint8Array, name: string): bigint {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** Decode a uint256 ABI return word (0x-prefixed or bare hex) — balanceOf/allowance returns.
 *  Accepts a shorter-than-64-char tail (some RPCs trim leading zeros); rejects anything else. */
export function decodeUint256(hex: string): bigint {
  const h = hex.toLowerCase().replace(/^0x/, '');
  if (h.length === 0 || h.length > 64) throw new Error(`not a uint256 word (${h.length} chars)`);
  return BigInt('0x' + h);
}

// keccak256("Transfer(address,address,uint256)") — topic0 of every standard ERC-20 transfer log.
export const TRANSFER_EVENT_TOPIC = toHex0x(keccak256(utf8ToBytes('Transfer(address,address,uint256)')));

export interface TransferLog {
  readonly from: string; // 0x-prefixed lowercase
  readonly to: string;
  readonly amount: bigint; // raw smallest units
}

/** Parse a standard ERC-20 Transfer log: topic0 = Transfer(…), topics[1] = from, topics[2] = to,
 *  data = the amount word. Returns null for ANY other shape (an ERC-721 Transfer has the tokenId
 *  in topics[3] and a different signature, and non-Transfer topics are other events entirely) —
 *  callers filter logs by topic0 and must never see a wrongly-parsed row instead. */
export function decodeTransferLog(data: string, topics: string[]): TransferLog | null {
  if (topics.length !== 3 || topics[0].toLowerCase() !== TRANSFER_EVENT_TOPIC) return null;
  const fromTopic = topics[1].toLowerCase().replace(/^0x/, '');
  const toTopic = topics[2].toLowerCase().replace(/^0x/, '');
  const dataHex = data.toLowerCase().replace(/^0x/, '');
  if (fromTopic.length !== 64 || toTopic.length !== 64 || dataHex.length !== 64) return null;
  return {
    from: '0x' + fromTopic.slice(24),
    to: '0x' + toTopic.slice(24),
    amount: BigInt('0x' + dataHex),
  };
}

/** bytesToHex here only to keep the module's surface symmetrical with its decoder inputs. */
function toHex0x(bytes: Uint8Array): string {
  return '0x' + bytesToHex(bytes);
}
