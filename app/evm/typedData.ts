// EIP-712 typed structured data hashing — the generic encoder behind `eth_signTypedData_v4`.
// PURE module (no fetch, no react-native, no SDK imports): the same offline-testable shape as
// `permit.ts`, which it generalizes. `permit.ts`'s fixed EIP-2612 digest builders do not extend to
// arbitrary dApp payloads (WalletConnect Explorer listing QA requires `eth_signTypedData_v4`),
// so the FULL atomic grammar lives here:
//   - atomic types: address, bool, uint8..uint256, int8..int256, bytes1..bytes32
//   - dynamic types: bytes, string (hashed in place, per the spec)
//   - reference types: arrays (dynamic `T[]` and fixed `T[n]`, of atomics or of structs) and one
//     level of struct nesting (struct members are hashed recursively via hashStruct, which is also
//     what an array of structs needs — the spec's own recursion, unchanged)
//   - anything else is refused with a TypedDataError BEFORE any bytes are hashed (a silent wrong
//     encoding would produce a valid-looking signature over a different message).
//
// The hash chain is the spec's, verbatim (EIP-712 "Definition of hashStruct" / "encodeData"):
//   encodeType(T)  = `T(type name,...)` with referenced structs appended, sorted by name
//   typeHash(T)    = keccak256(encodeType(T))
//   encodeData(s)  = concat(enc(member) for members in declaration order, 32 bytes each)
//   hashStruct(s)  = keccak256(typeHash ‖ encodeData(s))
//   digest         = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
// Golden vectors (see __tests__/evm-typed-data.test.ts) are the EIP-712 spec's own example set,
// pinned verbatim from the published EIP text + its Example.js asset, plus an independently
// generated nested/arrays/dynamic vector.

import {secp256k1} from '@noble/curves/secp256k1';
import {hexToBytes, bytesToHex} from '../lib/format';
import {keccak256} from './keccak';
import {addressWord, uint256Word} from './abi';

/** One struct member of the `eth_signTypedData_v4` `types` map, exactly as the JSON RPC carries it. */
export interface TypedDataField {
  readonly name: string;
  readonly type: string;
}

/** The `types` map: struct name → ordered members. `EIP712Domain` must be present for signing. */
export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;

/** The full `eth_signTypedData_v4` param object (the EIP-712 TypedData JSON schema). Values are
 *  the loose JSON shapes dApps actually send: integers as number/bigint/decimal-or-0x-hex string,
 *  bytes and addresses as 0x-prefixed hex strings. */
export interface TypedData {
  readonly types: TypedDataTypes;
  readonly primaryType: string;
  readonly domain: Readonly<Record<string, unknown>>;
  readonly message: Readonly<Record<string, unknown>>;
}

/** Why a typed-data payload cannot be encoded. Brand-field carried (not `instanceof`): the module
 *  can be loaded twice (seam + sheet), and duplicated classes make instanceof lie — the same
 *  rationale as `evm/errors.ts`. `isTypedDataError` is the one supported test. */
export class TypedDataError extends Error {
  readonly dpayTypedData = true;
  constructor(message: string) {
    super(message);
    this.name = 'TypedDataError';
  }
}

export function isTypedDataError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayTypedData?: unknown}).dpayTypedData === true;
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

/** The struct types referenced by `primaryType` (transitively), primary FIRST then alphabetical —
 *  the EIP-712 encodeType rule. Type-level recursion (e.g. `List {uint256 value; List next;}`) is
 *  valid EIP-712 and terminates here via the `found` set; only a cyclical VALUE would loop, and the
 *  spec leaves that undefined (JS recursion exhausts the stack instead of mis-hashing). */
function structDependencies(types: TypedDataTypes, primaryType: string): string[] {
  const found: string[] = [];
  const visit = (name: string): void => {
    if (found.includes(name)) return;
    const members = types[name];
    if (members === undefined) return; // atomic — not a struct, nothing to collect
    found.push(name);
    for (const field of members) {
      for (const dep of memberStructNames(types, field.type)) visit(dep);
    }
  };
  visit(primaryType);
  const rest = found.filter((t) => t !== primaryType).sort();
  return [primaryType, ...rest];
}

/** The struct names a member type references directly (`Asset[]` → `Asset`, `Person` → `Person`). */
function memberStructNames(types: TypedDataTypes, type: string): string[] {
  const base = arrayElementType(type);
  return types[base] !== undefined ? [base] : [];
}

/** `T[]` / `T[n]` → `T`; a non-array type is returned unchanged. */
function arrayElementType(type: string): string {
  if (!type.endsWith(']')) return type;
  const open = type.indexOf('[');
  if (open <= 0) throw new TypedDataError(`malformed array type: ${type}`);
  return type.slice(0, open);
}

/** Fixed-array length (`T[n]` → n) or null for a dynamic array. */
function fixedArrayLength(type: string): number | null {
  const open = type.indexOf('[');
  if (open === -1) return null;
  const close = type.endsWith(']') ? type.length - 1 : -1;
  const inside = type.slice(open + 1, close === -1 ? undefined : close);
  if (inside === '') return null; // dynamic T[]
  const n = Number(inside);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== inside) {
    throw new TypedDataError(`malformed fixed-array length in type: ${type}`);
  }
  return n;
}

/** Is this member type known to the EIP-712 grammar? Bare `uint`/`int` (ABI aliases) and fixed
 *  point types are NOT part of the standard ("there are no aliases uint and int") and are refused. */
function isKnownType(types: TypedDataTypes, type: string): boolean {
  if (type === 'address' || type === 'bool' || type === 'string' || type === 'bytes') return true;
  const atomic = /^(bytes([1-9]|[12]\d|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/;
  if (atomic.test(type)) return true;
  if (type.endsWith(']')) {
    return isKnownType(types, arrayElementType(type));
  }
  return types[type] !== undefined;
}

/** EIP-712 encodeType: `Primary(type name,...)DepA(...)DepB(...)` — primary first, dependencies
 *  alphabetical (the spec's canonical string, also what the golden vectors pin). */
export function encodeType(types: TypedDataTypes, primaryType: string): string {
  if (types[primaryType] === undefined) {
    throw new TypedDataError(`unknown primary type: ${primaryType}`);
  }
  let out = '';
  for (const name of structDependencies(types, primaryType)) {
    const members = types[name];
    out += `${name}(${members.map((f) => `${f.type} ${f.name}`).join(',')})`;
  }
  return out;
}

/** keccak256(encodeType(...)) — the constant `typeHash` of a struct type. */
export function typeHash(types: TypedDataTypes, primaryType: string): Uint8Array {
  return keccak256(utf8Bytes(encodeType(types, primaryType)));
}

/** Integers accept number / bigint / decimal-or-0x-hex string (the loose JSON shapes dApps send). */
function toBigInt(value: unknown, type: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypedDataError(`${type} value is not a safe integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value); // BigInt() parses both '0x'-hex and decimal strings natively
    } catch {
      throw new TypedDataError(`${type} value is not a valid integer string: ${JSON.stringify(value)}`);
    }
  }
  throw new TypedDataError(`${type} value must be number/bigint/hex-or-decimal string, got ${typeof value}`);
}

/** Big-endian 32-byte word for any uintN/intN member: unsigned range-checked in [0, 2^N),
 *  signed values sign-extended to 256 bits two's complement (the ABI integer rule). */
function integerWord(v: bigint, type: string): Uint8Array {
  const bits = Number(type.startsWith('uint') ? type.slice(4) : type.slice(3));
  if (type.startsWith('uint')) {
    if (v < 0n || v >= 1n << BigInt(bits)) throw new TypedDataError(`uint${bits} value out of range: ${v}`);
    return uint256Word(v);
  }
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (v < min || v > max) throw new TypedDataError(`int${bits} value out of range: ${v}`);
  return uint256Word(v < 0n ? v + (1n << 256n) : v);
}

/** UTF-8 bytes of a string, WITH astral-plane code points (surrogate pairs) — real UTF-8, which
 *  is what a Solidity `string` carries and what every other EIP-712 implementation hashes. The
 *  shared `lib/base64url.ts` codec is deliberately 3-byte-max (its QR payloads are BMP-only), so
 *  this module carries its own 12-line encoder rather than mis-hashing emoji et al. Pure JS: no
 *  TextEncoder/Buffer dependency (the RN blind-spot rule). */
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) as number;
    if (c > 0xffff) i++; // consume the low surrogate half of a pair
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** The raw bytes a dynamic `bytes`/`string` value carries (hashed in place per the spec). */
function dynamicBytes(value: unknown, type: string): Uint8Array {
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypedDataError(`string value must be a string, got ${typeof value}`);
    return utf8Bytes(value);
  }
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new TypedDataError(`bytes value must be 0x-hex string, got ${typeof value}`);
  }
  return hexToBytes(value);
}

/** One 32-byte word for an atomic member value. Only reached for types isKnownType routed here —
 *  never for structs (memberWord handles those) or arrays. */
function atomicWord(type: string, value: unknown): Uint8Array {
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new TypedDataError(`address value must be 0x + 40 hex chars, got ${typeof value}`);
    }
    return addressWord(value);
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new TypedDataError(`bool value must be boolean, got ${typeof value}`);
    return uint256Word(value ? 1n : 0n);
  }
  if (type === 'string' || type === 'bytes') {
    return uint256Word(BigInt('0x' + bytesToHex(keccak256(dynamicBytes(value, type)))));
  }
  if (type.startsWith('bytes')) {
    const n = Number(type.slice(5));
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new TypedDataError(`${type} value must be 0x-hex string, got ${typeof value}`);
    }
    const raw = hexToBytes(value);
    if (raw.length !== n) throw new TypedDataError(`${type} value must be exactly ${n} bytes, got ${raw.length}`);
    const word = new Uint8Array(32);
    word.set(raw, 0); // bytes1..bytes32 zero-pad at the END (ABI fixed-bytes rule)
    return word;
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    return integerWord(toBigInt(value, type), type);
  }
  throw new TypedDataError(`unknown value type: ${type}`);
}

/** EIP-712 encodeData: the members' 32-byte words in declaration order (typeHash NOT included —
 *  hashStruct prepends it, per the spec definition). Arrays encode as the keccak256 of their
 *  elements' concatenated element encodings; struct members encode as hashStruct(value). */
export function encodeData(types: TypedDataTypes, primaryType: string, value: Readonly<Record<string, unknown>>): Uint8Array {
  const members = types[primaryType];
  if (members === undefined) throw new TypedDataError(`unknown type: ${primaryType}`);
  const words: Uint8Array[] = [];
  for (const field of members) {
    const v = value[field.name];
    if (v === undefined) {
      throw new TypedDataError(`missing value for ${primaryType}.${field.name} (${field.type})`);
    }
    if (!isKnownType(types, field.type)) {
      throw new TypedDataError(`unknown value type: ${field.type} (member ${primaryType}.${field.name})`);
    }
    words.push(memberWord(types, field.type, v));
  }
  return concat(...words);
}

/** The 32-byte encoding of one member value (atomic word, dynamic hash, array hash, or struct hash). */
function memberWord(types: TypedDataTypes, type: string, v: unknown): Uint8Array {
  if (type.endsWith(']')) {
    if (!Array.isArray(v)) throw new TypedDataError(`array value for ${type} must be an array`);
    const fixed = fixedArrayLength(type);
    if (fixed !== null && v.length !== fixed) {
      throw new TypedDataError(`fixed array ${type} needs exactly ${fixed} elements, got ${v.length}`);
    }
    const elemType = arrayElementType(type);
    if (!isKnownType(types, elemType)) {
      throw new TypedDataError(`unknown value type: ${elemType} (element of ${type})`);
    }
    const packed = concat(...v.map((item) => memberWord(types, elemType, item)));
    return uint256Word(BigInt('0x' + bytesToHex(keccak256(packed))));
  }
  if (types[type] !== undefined) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new TypedDataError(`struct value for ${type} must be an object`);
    }
    return uint256Word(BigInt('0x' + bytesToHex(hashStruct(types, type, v as Readonly<Record<string, unknown>>))));
  }
  return atomicWord(type, v);
}

/** hashStruct: keccak256(typeHash ‖ encodeData) — 32 bytes. */
export function hashStruct(types: TypedDataTypes, primaryType: string, value: Readonly<Record<string, unknown>>): Uint8Array {
  return keccak256(concat(typeHash(types, primaryType), encodeData(types, primaryType, value)));
}

/** The EIP-712 domain separator: hashStruct of the `EIP712Domain` struct instance. 32 bytes. */
export function domainSeparator(types: TypedDataTypes, domain: Readonly<Record<string, unknown>>): Uint8Array {
  if (types.EIP712Domain === undefined) {
    throw new TypedDataError('types must declare EIP712Domain to sign');
  }
  return hashStruct(types, 'EIP712Domain', domain);
}

/** The 32-byte digest an `eth_signTypedData_v4` request asks the key to sign:
 *  keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)). */
export function typedDataDigest(data: TypedData): Uint8Array {
  return keccak256(
    concat(new Uint8Array([0x19, 0x01]), domainSeparator(data.types, data.domain), hashStruct(data.types, data.primaryType, data.message)),
  );
}

export interface TypedDataSignature {
  /** 27 or 28 — the `v` byte as `eth_signTypedData_v4` returns it. */
  readonly v: number;
  /** 0x-prefixed 32-byte signature halves. */
  readonly r: string;
  readonly s: string;
  /** r ‖ s ‖ v as ONE 0x-prefixed 65-byte hex string — the response shape `eth_signTypedData_v4`
   *  hands back to the dApp (bytes 0..32 r, 32..64 s, 64 v). */
  readonly serialized: string;
}

/** Sign a typed-data digest with the device key: deterministic (RFC 6979) low-s secp256k1, the
 *  same primitive `permit.ts` signs permits with. Returns the r‖s‖v hex shape the RPC response
 *  carries. The signing CALLER (the WalletConnect request dispatch) arrives with a later wave;
 *  this is the sign-ready structure it will call. */
export function signTypedData(privateKey: Uint8Array, data: TypedData): TypedDataSignature {
  const digest = typedDataDigest(data);
  const sig = secp256k1.sign(digest, privateKey);
  const v = 27 + sig.recovery;
  const r = '0x' + bytesToHex(uint256Word(sig.r));
  const s = '0x' + bytesToHex(uint256Word(sig.s));
  return {v, r, s, serialized: r + s.slice(2) + v.toString(16).padStart(2, '0')};
}
