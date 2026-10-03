// The COW SWAP PURE surface — the EIP-712 order encoder/signer, the order-UID derivation,
// and the order-API wire shapes. No network, no react-native: safe to static-import from
// convert prepare code and the jest pins (the seam discipline — the network module
// `evm/cow.ts` is the only thing that dials, and only through the relay's
// `/api/v1/cow/mainnet/*` pipes).
//
// The bytes are SOURCE-pinned (2026-10-03, cowprotocol/contracts GPv2Order.sol — the
// TYPE_HASH / KIND_SELL / BALANCE_ERC20 constants are the contract's own published values,
// byte-copied from the library source) and SELF-CONSISTENCY-pinned: a signature made here
// recovers to the signer's own address over the digest the settlement contract hashes.
// LIVE ORDER TRIP: UNPROVEN — the venue's own D31 follow-up (no live funds moved yet; the
// V3 adapter earned its note the same way).
//
// dpay never custodies: the device key signs, the venue's fee is the venue's own signed
// figure, and the order trades from the user's own wallet through the settlement contract.
import {secp256k1} from '@noble/curves/secp256k1';
import {utf8ToBytes} from '../lib/base64url';
import {addressWord, uint256Word} from './abi';
import {keccak256} from './keccak';
import {hex, word32} from './uniswapPlan';

// ── The contract's own constants (GPv2Order.sol, byte-copied from the source) ───────────────

/** keccak256("Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,
 *  uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,
 *  bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)") — the contract's
 *  published TYPE_HASH. */
export const COW_ORDER_TYPEHASH = 'd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489';

/** keccak256("sell") — the KIND_SELL marker (the contract hashes the string, not an enum). */
export const COW_KIND_SELL = 'f3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775';

/** keccak256("erc20") — the BALANCE_ERC20 marker (both balance fields take it). */
export const COW_BALANCE_ERC20 = '5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9';

/** The EIP-712 domain the settlement contract verifies orders under (docs.cow.fi; the
 *  domain is the protocol's identity, stable across every app that signs orders). */
export const COW_DOMAIN_NAME = 'Gnosis Protocol';
export const COW_DOMAIN_VERSION = 'v2';

/** The v2 settlement contract — the verifyingContract of the order domain, per chain.
 *  Same canonical address on every CoW deployment; dpay serves chain 1 only (the venue
 *  row's chain). Null = no CoW venue on that chain (fail closed). */
export function cowSettlementOf(chainId: number): string | null {
  return chainId === 1 ? '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' : null;
}

/** The VaultRelayer — the allowance spender the settlement pulls the sell token through.
 *  The approve leg targets THIS address (never the settlement contract itself). */
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

// ── The order (the struct the device signs) ─────────────────────────────────────────────────

/** One CoW order's complete signed data — GPv2Order.Data, all twelve fields. Amounts are
 *  raw smallest-unit decimal strings (uint256); `validTo` is absolute unix seconds (uint32);
 *  `appData` is a 0x + 64-hex bytes32. `kind`/balances are fixed for dpay's adapter: a
 *  fill-or-kill sell drawing and receiving plain ERC-20 balances. */
export interface CowOrderParams {
  readonly sellToken: string;
  readonly buyToken: string;
  /** null = the owner receives (RECEIVER_SAME_AS_OWNER, the zero address word). */
  readonly receiver: string | null;
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly validTo: number;
  readonly appData: string;
  readonly feeAmount: string;
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

function bytes32Word(hex0x: string): string {
  const h = hex0x.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not a bytes32: ${hex0x}`);
  return h;
}

// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
// — the published EIP-712 domain typehash (the same constant app/evm/permit.ts carries).
const EIP712_DOMAIN_TYPEHASH = '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';

/** The settlement contract's EIP-712 domain separator for `chainId` — 32 bytes. */
export function cowDomainSeparator(chainId: number): Uint8Array {
  const settlement = cowSettlementOf(chainId);
  if (settlement == null) throw new Error(`cow: no venue on chain ${chainId}`);
  return keccak256(concat(
    hexToBytes(EIP712_DOMAIN_TYPEHASH),
    keccak256(utf8ToBytes(COW_DOMAIN_NAME)),
    keccak256(utf8ToBytes(COW_DOMAIN_VERSION)),
    uint256Word(BigInt(chainId)),
    addressWord(settlement),
  ));
}

/** keccak256(TYPE_HASH ‖ abi.encode(order)) — the struct hash (the contract's in-place
 *  416-byte hash: 12 static fields, one word each, markers as their keccak'd strings). */
export function cowOrderStructHash(o: CowOrderParams): Uint8Array {
  return keccak256(concat(
    hexToBytes(COW_ORDER_TYPEHASH),
    addressWord(o.sellToken),
    addressWord(o.buyToken),
    addressWord(o.receiver ?? '0x0000000000000000000000000000000000000000'),
    uint256Word(BigInt(o.sellAmount)),
    uint256Word(BigInt(o.buyAmount)),
    uint256Word(BigInt(o.validTo)),
    hexToBytes(bytes32Word(o.appData)),
    uint256Word(BigInt(o.feeAmount)),
    hexToBytes(COW_KIND_SELL),
    uint256Word(0n), // partiallyFillable: false
    hexToBytes(COW_BALANCE_ERC20),
    hexToBytes(COW_BALANCE_ERC20),
  ));
}

/** The EIP-712 signing digest — keccak256(0x1901 ‖ domainSeparator ‖ structHash). This is
 *  BOTH the bytes the device key signs AND the orderDigest the UID packs (the contract's
 *  own `hash` returns exactly this). */
export function cowOrderDigest(chainId: number, o: CowOrderParams): Uint8Array {
  return keccak256(concat(new Uint8Array([0x19, 0x01]), cowDomainSeparator(chainId), cowOrderStructHash(o)));
}

function hexToBytes(hex0x: string): Uint8Array {
  const h = hex0x.toLowerCase().replace(/^0x/, '');
  if (h.length % 2 !== 0) throw new Error(`odd hex length: ${hex0x}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The 56-byte packed order UID: orderDigest(32) ‖ owner(20) ‖ validTo(4 BE) — the venue's
 *  own identity for the order and the record's poll key. DETERMINISTIC: derivable from the
 *  frozen order facts alone, which is what makes a submitted-but-unpersisted order
 *  recoverable after a restart (the resume engine re-derives and polls it). */
export function cowOrderUid(chainId: number, o: CowOrderParams, owner: string): string {
  const digest = cowOrderDigest(chainId, o);
  const validTo = o.validTo;
  if (!Number.isInteger(validTo) || validTo < 0 || validTo > 0xffffffff) {
    throw new Error(`validTo out of uint32: ${validTo}`);
  }
  const out = new Uint8Array(56);
  out.set(digest, 0);
  out.set(addressWord(owner).subarray(12), 32);
  out[52] = (validTo >>> 24) & 0xff;
  out[53] = (validTo >>> 16) & 0xff;
  out[54] = (validTo >>> 8) & 0xff;
  out[55] = validTo & 0xff;
  return '0x' + Buffer.from(out).toString('hex');
}

export interface SignedCowOrder {
  /** 27 or 28 — the ecrecover v the API's 65-byte encoding carries last. */
  readonly v: number;
  readonly r: Uint8Array;
  readonly s: Uint8Array;
  /** r ‖ s ‖ v — the 65-byte serialization the order POST's `signature` field takes. */
  readonly serialized: Uint8Array;
}

/** Sign an order's EIP-712 digest with the trader's key (the device's SLIP-10 EVM key).
 *  Noble's sign is deterministic (RFC 6979) with low-s normalisation, so the same order
 *  facts always yield the same 65 bytes — a re-derived resume signature is byte-identical. */
export function signCowOrder(privateKey: Uint8Array, chainId: number, o: CowOrderParams): SignedCowOrder {
  const digest = cowOrderDigest(chainId, o);
  const sig = secp256k1.sign(digest, privateKey);
  const to32 = (x: bigint): Uint8Array => {
    const out = new Uint8Array(32);
    let v = x;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  };
  const v = 27 + sig.recovery;
  const r = to32(sig.r);
  const s = to32(sig.s);
  return {v, r, s, serialized: concat(r, s, new Uint8Array([v]))};
}

// ── The appData fact ────────────────────────────────────────────────────────────────────────

/** dpay's own appData document (the venue's standardized JSON format, appCode dpay). The
 *  ORDER struct hashes the keccak of these exact UTF-8 bytes, and the POST carries the
 *  JSON string itself (the hash form is deprecated upstream). Fixed string, so the signed
 *  appData word is derivable everywhere the record goes. */
export const DPAY_COW_APP_DATA_JSON = '{"version":"0.9.0","appCode":"dpay","metadata":{}}';

/** keccak256(UTF-8 bytes of DPAY_COW_APP_DATA_JSON), 0x-prefixed — the bytes32 the order
 *  struct hashes. */
export function dpayCowAppDataHash(): string {
  return '0x' + Buffer.from(keccak256(utf8ToBytes(DPAY_COW_APP_DATA_JSON))).toString('hex');
}

// ── The order-API wire shapes (strict parses — never defaulted) ─────────────────────────────

/** The quote ask the adapter sends (kind 'sell' from the total budget, absolute validTo). */
export interface CowQuoteRequest {
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmountBeforeFee: string; // the total the wallet may pull (raw units)
  readonly from: string;
  readonly validTo: number;
}

/** Build the POST /api/v1/quote body. `appData` rides as the JSON document (the hash form
 *  is deprecated upstream); `signingScheme` pins eip712 — the device signs, never presigns. */
export function buildQuoteBody(q: CowQuoteRequest): Record<string, unknown> {
  return {
    kind: 'sell',
    sellAmountBeforeFee: q.sellAmountBeforeFee,
    sellToken: q.sellToken.toLowerCase(),
    buyToken: q.buyToken.toLowerCase(),
    receiver: null,
    appData: DPAY_COW_APP_DATA_JSON,
    appDataHash: dpayCowAppDataHash(),
    validTo: q.validTo,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signingScheme: 'eip712',
    from: q.from.toLowerCase(),
  };
}

/** The venue's own quoted order parameters, decoded strictly off the response. */
export interface CowQuoteResult {
  /** The amount the settlement pulls for the trade itself (raw sell units). */
  readonly sellAmount: string;
  /** The venue's own buy-side figure (raw buy units) — the floor the slippage bps bite. */
  readonly buyAmount: string;
  /** The venue's own fee estimate (raw sell units) — displayed verbatim, never hidden.
   *  The modern orderbook rejects a nonzero SIGNED fee (`NonZeroFee`), so this figure is
   *  the honest cost estimate the review shows, not a field the order carries. */
  readonly feeAmount: string;
  /** The venue's own order expiry (absolute unix seconds, uint32) — the signed order and
   *  the UID derivation both take it from here. */
  readonly validTo: number;
  /** The venue's own volume-fee policy in bps when the response carries one. */
  readonly protocolFeeBps: string | null;
  /** The venue's own gas estimate for executing the trade (attribution, never a promise). */
  readonly gasAmount: string;
  readonly expiration: string;
}

function reqString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || !/^\d+$/.test(v)) {
    throw new Error(`cow quote: bad ${what}`);
  }
  return v;
}

/** Parse POST /api/v1/quote's 200 body. STRICT: every field the record freezes is required
 *  and shape-checked — a venue answer that cannot be frozen is not a quote (fail closed,
 *  the shared error vocabulary), never partially trusted. */
export function parseCowQuote(body: unknown): CowQuoteResult {
  if (body == null || typeof body !== 'object') throw new Error('cow quote: bad body');
  const b = body as Record<string, unknown>;
  const q = b.quote;
  if (q == null || typeof q !== 'object') throw new Error('cow quote: no quote block');
  const quote = q as Record<string, unknown>;
  const sellToken = typeof quote.sellToken === 'string' ? quote.sellToken : '';
  const buyToken = typeof quote.buyToken === 'string' ? quote.buyToken : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(sellToken) || !/^0x[0-9a-fA-F]{40}$/.test(buyToken)) {
    throw new Error('cow quote: bad token addresses');
  }
  const validTo = quote.validTo;
  if (typeof validTo !== 'number' || !Number.isInteger(validTo)
    || validTo <= 0 || validTo > 0xffffffff) {
    throw new Error('cow quote: bad validTo');
  }
  const expiration = typeof b.expiration === 'string' ? b.expiration : '';
  if (expiration === '') throw new Error('cow quote: bad expiration');
  return {
    sellAmount: reqString(quote.sellAmount, 'sellAmount'),
    buyAmount: reqString(quote.buyAmount, 'buyAmount'),
    feeAmount: reqString(quote.feeAmount, 'feeAmount'),
    validTo,
    protocolFeeBps: typeof b.protocolFeeBps === 'string' && /^\d+$/.test(b.protocolFeeBps)
      ? b.protocolFeeBps
      : null,
    gasAmount: reqString(quote.gasAmount, 'gasAmount'),
    expiration,
  };
}

/** The venue's own quote-refusal verdict (HTTP 400): {errorType enum, description}. */
export interface CowQuoteError {
  readonly errorType: string;
  readonly description: string;
}

export function parseCowQuoteError(body: unknown): CowQuoteError | null {
  if (body == null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.errorType !== 'string' || b.errorType.length === 0) return null;
  return {
    errorType: b.errorType,
    description: typeof b.description === 'string' ? b.description : '',
  };
}

/** Build the POST /api/v1/orders body from the FROZEN order facts + the 65-byte signature.
 *  `feeAmount` is always "0": the modern orderbook rejects a positive signed fee
 *  (`NonZeroFee`, crates/orderbook/src/order_validation.rs) — the venue's cost rides the
 *  quote's own figures and the buy-side protocol fee, never a signed legacy field.
 *  `fullBalanceCheck` makes the venue verify allowance + balance at submission, so a
 *  missing approve fails HERE (honest, before anything waits) instead of at settlement. */
export function buildOrderPostBody(args: {
  order: CowOrderParams;
  signatureHex: string; // 0x + 130 hex (65 bytes r‖s‖v)
  from: string;
}): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(args.signatureHex)) {
    throw new Error('cow order: signature must be 0x + 130 hex (65 bytes r‖s‖v)');
  }
  return {
    sellToken: args.order.sellToken.toLowerCase(),
    buyToken: args.order.buyToken.toLowerCase(),
    receiver: args.order.receiver,
    sellAmount: args.order.sellAmount,
    buyAmount: args.order.buyAmount,
    validTo: args.order.validTo,
    appData: DPAY_COW_APP_DATA_JSON,
    appDataHash: dpayCowAppDataHash(),
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signingScheme: 'eip712',
    signature: args.signatureHex,
    from: args.from.toLowerCase(),
    quoteId: null,
    fullBalanceCheck: true,
  };
}

// ── The order-status poll ───────────────────────────────────────────────────────────────────

/** The venue's own order-status vocabulary (GET /api/v1/orders/{uid}; the orderbook's
 *  OrderStatus enum). */
export type CowOrderStatus = 'presignaturePending' | 'open' | 'fulfilled' | 'cancelled' | 'expired';

export interface CowOrderStatusBody {
  readonly uid: string;
  readonly status: CowOrderStatus;
  /** The realized figures, present and shape-checked ONLY on a fulfilled answer — the
   *  done line's realized numbers (raw units). */
  readonly executedSellAmount: string | null;
  readonly executedBuyAmount: string | null;
  readonly executedFeeAmount: string | null;
}

export function isCowOrderTerminal(s: CowOrderStatus): boolean {
  return s === 'fulfilled' || s === 'cancelled' || s === 'expired';
}

/** Parse GET /api/v1/orders/{uid}'s 200 body. STRICT: the status must be one of the
 *  venue's own enum values — an unknown status is a shape failure (fail closed), never
 *  silently treated as pending. */
export function parseCowOrderStatus(body: unknown): CowOrderStatusBody {
  if (body == null || typeof body !== 'object') throw new Error('cow status: bad body');
  const b = body as Record<string, unknown>;
  const uid = typeof b.uid === 'string' ? b.uid : '';
  if (!/^0x[0-9a-f]{112}$/.test(uid)) throw new Error('cow status: bad uid');
  const status = b.status;
  if (status !== 'presignaturePending' && status !== 'open' && status !== 'fulfilled'
    && status !== 'cancelled' && status !== 'expired') {
    throw new Error(`cow status: unknown status ${String(status)}`);
  }
  const executed = (v: unknown): string | null =>
    typeof v === 'string' && /^\d+$/.test(v) ? v : null;
  return {
    uid,
    status,
    executedSellAmount: status === 'fulfilled' ? executed(b.executedSellAmount) : null,
    executedBuyAmount: status === 'fulfilled' ? executed(b.executedBuyAmount) : null,
    executedFeeAmount: status === 'fulfilled' ? executed(b.executedFeeAmount) : null,
  };
}

// ── re-exports (the encoders the approve/unwrap legs share with the V3 adapter) ─────────────
export {hex, word32};
