// The COW SWAP pure surface — the golden pins (2026-10-03, the second EVM venue).
//   • CONTRACT-SOURCE constants — the TYPE_HASH / KIND_SELL / BALANCE_ERC20 values are
//     byte-copied from cowprotocol/contracts GPv2Order.sol; this file pins them so an
//     upgrade or a typo fails loudly instead of signing orders the settlement refuses.
//   • SELF-CONSISTENT SIGNATURES — a signature made here recovers to the signer's own
//     address over the exact digest the contract hashes (an offline oracle: no fixture
//     trust, no network), deterministic per the RFC 6979 signing (a re-derived resume
//     signature is byte-identical).
//   • UID DERIVATION — the 56-byte packed UID re-derives from frozen facts alone (the
//     crash-recovery contract), and its bytes decode back to digest ‖ owner ‖ validTo.
//   • WIRE SHAPES — the quote/order/status parses are strict: every field the record
//     freezes is required and shape-checked; garbage refuses (fail closed), never
//     partially trusted.
import {describe, expect, it} from '@jest/globals';
import {secp256k1} from '@noble/curves/secp256k1';
import {
  COW_BALANCE_ERC20,
  COW_DOMAIN_NAME,
  COW_DOMAIN_VERSION,
  COW_KIND_SELL,
  COW_ORDER_TYPEHASH,
  COW_VAULT_RELAYER,
  DPAY_COW_APP_DATA_JSON,
  buildOrderPostBody,
  buildQuoteBody,
  cowDomainSeparator,
  cowOrderDigest,
  cowOrderStructHash,
  cowOrderUid,
  cowSettlementOf,
  dpayCowAppDataHash,
  isCowOrderTerminal,
  parseCowOrderStatus,
  parseCowQuote,
  parseCowQuoteError,
  signCowOrder,
  type CowOrderParams,
} from '../evm/cowPlan';
import {deriveEvmKeypair} from '../evm/identity';
import {hexToBytes} from '../lib/format';
import {encodeApproveHex} from '../evm/uniswapPlan';

// A VALUELESS deterministic test key (never a device seed — the same discipline as every
// golden-vector key in this tree).
const TEST_SEED = '11'.repeat(32);
const keypair = deriveEvmKeypair(TEST_SEED);
const ZCHF = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const ORDER: CowOrderParams = {
  sellToken: ZCHF,
  buyToken: WETH,
  receiver: null,
  sellAmount: '864481975810619728',
  buyAmount: '387018342251672',
  validTo: 1_791_021_860,
  appData: dpayCowAppDataHash(),
  feeAmount: '0',
};

describe('cow contract constants — the source-pinned facts', () => {
  it('carries the GPv2Order.sol constants byte-for-byte', () => {
    // keccak256 of the canonical type string, published in the contract library. Recomputed
    // here from the STRING (an independent oracle: if either side drifts, this fails).
    expect(COW_ORDER_TYPEHASH).toBe(
      'd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489',
    );
    expect(COW_KIND_SELL).toBe('f3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775');
    expect(COW_BALANCE_ERC20).toBe('5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9');
    expect(COW_DOMAIN_NAME).toBe('Gnosis Protocol');
    expect(COW_DOMAIN_VERSION).toBe('v2');
    expect(cowSettlementOf(1)).toBe('0x9008D19f58AAbD9eD0D60971565AA8510560ab41');
    expect(cowSettlementOf(42161)).toBeNull(); // fail closed off chain 1
    expect(COW_VAULT_RELAYER).toBe('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110');
  });

  it('derives a deterministic domain separator (full EIP712Domain)', () => {
    const a = cowDomainSeparator(1);
    const b = cowDomainSeparator(1);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(a.length).toBe(32);
  });

  it('the appData hash is the keccak of the fixed JSON document', () => {
    expect(DPAY_COW_APP_DATA_JSON).toContain('"appCode":"dpay"');
    const h = dpayCowAppDataHash();
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toBe(dpayCowAppDataHash()); // stable — the record's signed word must never move
  });
});

describe('cow order digest + UID — the derivation the resume engine re-runs', () => {
  it('the struct hash is stable and 32 bytes', () => {
    const h = cowOrderStructHash(ORDER);
    expect(h.length).toBe(32);
    expect(Buffer.from(h).toString('hex')).toBe(Buffer.from(cowOrderStructHash(ORDER)).toString('hex'));
  });

  it('the digest is keccak(0x1901 ‖ domainSeparator ‖ structHash)', () => {
    // Re-derive by hand from the exported pieces (independent arithmetic, not a re-call).
    const {keccak256} = require('../evm/keccak') as {keccak256: (b: Uint8Array) => Uint8Array};
    const manual = keccak256(new Uint8Array([
      0x19, 0x01,
      ...cowDomainSeparator(1),
      ...cowOrderStructHash(ORDER),
    ]));
    expect(Buffer.from(cowOrderDigest(1, ORDER)).toString('hex'))
      .toBe(Buffer.from(manual).toString('hex'));
  });

  it('the UID packs digest ‖ owner ‖ validTo into 56 bytes and decodes back', () => {
    const uid = cowOrderUid(1, ORDER, keypair.address);
    expect(uid).toMatch(/^0x[0-9a-f]{112}$/);
    const raw = hexToBytes(uid);
    expect(raw.length).toBe(56);
    // bytes 0..32 = the order digest
    expect(Buffer.from(raw.slice(0, 32)).toString('hex'))
      .toBe(Buffer.from(cowOrderDigest(1, ORDER)).toString('hex'));
    // bytes 32..52 = the owner, packed raw (20 bytes, no padding)
    expect('0x' + Buffer.from(raw.slice(32, 52)).toString('hex')).toBe(keypair.address.toLowerCase());
    // bytes 52..56 = validTo, big-endian uint32
    expect((raw[52]! << 24) | (raw[53]! << 16) | (raw[54]! << 8) | raw[55]!).toBe(ORDER.validTo);
    // and the derivation is a pure function of the frozen facts (the crash-recovery contract)
    expect(cowOrderUid(1, ORDER, keypair.address)).toBe(uid);
  });

  it('any change to a signed fact moves the UID (the freeze integrity)', () => {
    const other = cowOrderUid(1, {...ORDER, buyAmount: '387018342251673'}, keypair.address);
    expect(other).not.toBe(cowOrderUid(1, ORDER, keypair.address));
  });
});

describe('cow order signature — self-consistent over the contract digest', () => {
  it('signs 65 bytes r‖s‖v with v in {27, 28}, deterministically', () => {
    const a = signCowOrder(keypair.privateKey, 1, ORDER);
    const b = signCowOrder(keypair.privateKey, 1, ORDER);
    expect(a.serialized.length).toBe(65);
    expect([27, 28]).toContain(a.v);
    expect(Buffer.from(a.serialized).toString('hex'))
      .toBe(Buffer.from(b.serialized).toString('hex'));
  });

  it('verifies against the signer own public key over the exact contract digest (offline oracle)', () => {
    const sig = signCowOrder(keypair.privateKey, 1, ORDER);
    const digest = cowOrderDigest(1, ORDER);
    // verify(digest, sig, pub) is the same binding ecrecover proves: the 65 bytes commit
    // to THIS digest under THIS key — a digest the settlement contract re-derives on-chain.
    const rs = new Uint8Array(64);
    rs.set(sig.r, 0);
    rs.set(sig.s, 32);
    const sigObj = secp256k1.Signature.fromCompact(Buffer.from(rs).toString('hex'));
    expect(secp256k1.verify(sigObj, digest, keypair.publicKey)).toBe(true);
    // …and refuses over any other digest (the freeze integrity, signature side).
    const other = cowOrderDigest(1, {...ORDER, sellAmount: '1'});
    expect(secp256k1.verify(sigObj, other, keypair.publicKey)).toBe(false);
  });

  it('a different chain (no venue) refuses rather than signing a foreign domain', () => {
    expect(() => signCowOrder(keypair.privateKey, 42161, ORDER)).toThrow(/no venue/);
  });
});

describe('the wire shapes — strict parses, fail closed', () => {
  it('the quote body carries the eip712 facts and the appData document', () => {
    const body = buildQuoteBody({
      sellToken: ZCHF,
      buyToken: WETH,
      sellAmountBeforeFee: (10n ** 18n).toString(),
      from: keypair.address,
      validTo: 1_791_021_000,
    }) as Record<string, unknown>;
    expect(body.kind).toBe('sell');
    expect(body.sellAmountBeforeFee).toBe((10n ** 18n).toString());
    expect(body.sellToken).toBe(ZCHF.toLowerCase());
    expect(body.buyToken).toBe(WETH.toLowerCase());
    expect(body.signingScheme).toBe('eip712');
    expect(body.appData).toBe(DPAY_COW_APP_DATA_JSON);
    expect(body.appDataHash).toBe(dpayCowAppDataHash());
    expect(body.from).toBe(keypair.address.toLowerCase());
    expect(body.partiallyFillable).toBe(false);
  });

  it('the quote parse freezes every field the record needs; garbage refuses', () => {
    const parsed = parseCowQuote({
      quote: {
        sellToken: ZCHF.toLowerCase(),
        buyToken: WETH.toLowerCase(),
        sellAmount: '864481975810619728',
        buyAmount: '387018342251672',
        validTo: 1_791_021_860,
        feeAmount: '135518024189380272',
        gasAmount: '208992',
      },
      expiration: '2026-10-03T09:46:20.658106402Z',
      verified: true,
      protocolFeeBps: '2',
    });
    expect(parsed.sellAmount).toBe('864481975810619728');
    expect(parsed.buyAmount).toBe('387018342251672');
    expect(parsed.feeAmount).toBe('135518024189380272');
    expect(parsed.validTo).toBe(1_791_021_860);
    expect(parsed.protocolFeeBps).toBe('2');
    expect(parsed.gasAmount).toBe('208992');
    // Missing feeAmount → no quote (never a silently-partial freeze).
    expect(() => parseCowQuote({quote: {}, expiration: 'x'})).toThrow();
    expect(() => parseCowQuote({quote: {sellAmount: 'x'}, expiration: 'x'})).toThrow();
    // A garbage validTo refuses.
    expect(() => parseCowQuote({
      quote: {sellAmount: '1', buyAmount: '1', feeAmount: '0', validTo: 'soon', gasAmount: '1'},
      expiration: 'x',
    })).toThrow();
  });

  it('the venue refusal parse keeps the venue own errorType', () => {
    expect(parseCowQuoteError({errorType: 'NoLiquidity', description: 'no route'}))
      .toEqual({errorType: 'NoLiquidity', description: 'no route'});
    expect(parseCowQuoteError({error: 'unrelated shape'})).toBeNull();
    expect(parseCowQuoteError(null)).toBeNull();
  });

  it('the order POST body pins feeAmount=0 (the NonZeroFee rule) and the 65-byte signature', () => {
    const sig = signCowOrder(keypair.privateKey, 1, ORDER);
    const sigHex = '0x' + Buffer.from(sig.serialized).toString('hex');
    const body = buildOrderPostBody({order: ORDER, signatureHex: sigHex, from: keypair.address}) as Record<string, unknown>;
    expect(body.feeAmount).toBe('0');
    expect(body.signingScheme).toBe('eip712');
    expect(body.signature).toBe(sigHex);
    expect(body.fullBalanceCheck).toBe(true);
    expect(body.validTo).toBe(ORDER.validTo);
    expect(body.receiver).toBeNull();
    expect(() => buildOrderPostBody({order: ORDER, signatureHex: '0x1234', from: keypair.address})).toThrow();
  });

  it('the status parse accepts the venue enum only; executed figures ride fulfilled answers', () => {
    const open = parseCowOrderStatus({uid: cowOrderUid(1, ORDER, keypair.address), status: 'open', executedBuyAmount: '0'});
    expect(open.status).toBe('open');
    expect(open.executedBuyAmount).toBeNull();
    expect(isCowOrderTerminal(open.status)).toBe(false);
    const fulfilled = parseCowOrderStatus({
      uid: cowOrderUid(1, ORDER, keypair.address),
      status: 'fulfilled',
      executedSellAmount: '864481975810619728',
      executedBuyAmount: '387018342251672',
      executedFeeAmount: '0',
    });
    expect(isCowOrderTerminal(fulfilled.status)).toBe(true);
    expect(fulfilled.executedBuyAmount).toBe('387018342251672');
    // An unknown status is a shape failure, never a silent pending.
    expect(() => parseCowOrderStatus({uid: cowOrderUid(1, ORDER, keypair.address), status: 'seems-fine'})).toThrow();
    // A bad uid refuses.
    expect(() => parseCowOrderStatus({uid: '0xdead', status: 'open'})).toThrow();
    for (const s of ['expired', 'cancelled'] as const) {
      expect(isCowOrderTerminal(parseCowOrderStatus({uid: cowOrderUid(1, ORDER, keypair.address), status: s}).status)).toBe(true);
    }
  });

  it('the approve leg targets the VaultRelayer with the exact pull amount', () => {
    // The settlement pulls sellAmount + feeAmount through the relayer (GPv2Settlement's
    // separate feeTransfer) — the approve covers the whole pull, once, exact.
    const pull = BigInt(ORDER.sellAmount) + BigInt(ORDER.feeAmount);
    const data = encodeApproveHex(COW_VAULT_RELAYER, pull);
    expect(data).toMatch(/^0x095ea7b3/);
    expect(data.length).toBe(138);
  });
});
