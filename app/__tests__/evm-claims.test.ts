// evm-claims.test.ts — the offline permit claim queue (D21/D22/D24/D25): wire codec round trips,
// offline sign + attach, the AsyncStorage claim queue + nonce cache, and the settle state machine
// (success, stale-nonce needsResign, deadline expiry, replay honesty) over an INJECTED rpc —
// zero network, per the offline inner-loop rule.
//
// The mock chain here is a small FUNCTIONAL state machine (balances, allowances, permit nonces,
// Transfer logs, receipts) that runs the token's own require/ecrecover logic via the module's
// exported recovery helper. It proves the settle STATE MACHINE; the wire-bytes-vs-real-node proof
// is e2e flow 215's job (live anvil through the relay pipe), not jest's.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {
  classifyEvmRevert,
  decodeSolidityRevertString,
  decideEvmPayerReceipt,
  enqueueEvmClaim,
  evmClaimsKey,
  hydrateEvmClaimRows,
  loadEvmClaims,
  MAX_EVM_CLAIMS,
  patchEvmClaim,
  recoverEvmClaimSigner,
  resetEvmNonce,
  resolveEvmTokenAddress,
  seedEvmNonce,
  settleEvmClaim,
  signEvmClaim,
  takeEvmNonce,
  type EvmClaimRow,
  type EvmPayV1,
  type EvmReqV1,
  type EvmRpcLike,
  type EvmSettleInput,
} from '../evm/claims';
import {TRANSFER_EVENT_TOPIC} from '../evm/abi';
import {clearEvmDevToken, setEvmDevToken} from '../evm/chains';
import {evmKeypairFromPrivate} from '../evm/identity';
import {keccak256} from '../evm/keccak';
import {rlpDecode, type RlpDecoded} from '../evm/rlp';
import {base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes} from '../lib/base64url';
import {bytesToHex, hexToBytes} from '../lib/format';
import {decodeEvmPay, decodeEvmReq, encodeEvmPay, encodeEvmReq, generateRid, isEvmReqExpired} from '../evm/qr';

// anvil's well-known keys #0 (payer) and #1 (merchant) — public and valueless.
const PAYER_KEY = hexToBytes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const MERCHANT_KEY = hexToBytes('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const payer = evmKeypairFromPrivate(PAYER_KEY);
const merchant = evmKeypairFromPrivate(MERCHANT_KEY);
const TOKEN = '0x' + '11'.repeat(20);
const CHAIN_ID = 31337;
const NOW = 1_800_000_000; // fixed unix seconds — the tests never read the wall clock
const NOW_MS = NOW * 1000;
const ZCHF = (n: bigint): string => (n * 10n ** 18n).toString(); // the wire spelling (req.amt)
const ZCHFn = (n: bigint): bigint => n * 10n ** 18n; // chain-side bigint amounts
const GWEI = 1_000_000_000n;
const GAS_UNITS = 50_000n;
const GAS_PRICE = 2n * GWEI;
const GAS_PER_TX = GAS_UNITS * GAS_PRICE; // what one mock tx burns

// ---------------------------------------------------------------------------
// The mock chain (functional EVM-lite)
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => bytesToHex(b);
const word = (v: bigint | number): string => BigInt(v).toString(16).padStart(64, '0');
const wordAddr = (data: Uint8Array, off: number): string => '0x' + hex(data.subarray(off + 12, off + 32));
const wordBig = (data: Uint8Array, off: number): bigint => BigInt('0x' + hex(data.subarray(off, off + 32)));

/** Solidity Error(string) revert payload (selector 0x08c379a0 + offset + length + body). */
function revertData(msg: string): string {
  const body = utf8ToBytes(msg);
  const padLen = Math.ceil(body.length / 32) * 32;
  return '0x08c379a0' + word(0x20) + word(body.length) + hex(body) + '00'.repeat(padLen - body.length);
}

function revertErr(msg: string): Error {
  const e = new Error(`VM Exception while processing transaction: revert ${msg}`) as Error & {data?: string};
  e.data = revertData(msg);
  return e;
}

function transportErr(): Error {
  const e = new Error('relay unreachable') as Error & {transport?: boolean};
  e.transport = true;
  return e;
}

interface MockLog {
  transactionHash: string;
  topics: string[];
  data: string;
}

function makeChain(opts: {nowSecs: number; from: string; receiptsVisible?: boolean}) {
  const eth = new Map<string, bigint>();
  const tokBalance = new Map<string, bigint>();
  const allowance = new Map<string, bigint>(); // `${owner}:${spender}`
  const nonces = new Map<string, bigint>();
  const txCount = new Map<string, number>();
  const receipts = new Map<string, {status: string}>();
  const logs: MockLog[] = [];
  const sent: Array<{txHash: string; selector: string}> = [];
  const domain = {kind: 'minimal' as const, chainId: CHAIN_ID, verifyingContract: TOKEN};
  const fromAddr = opts.from.toLowerCase();

  const simulatePermit = (data: Uint8Array): {owner: string; spender: string; value: bigint} => {
    const owner = wordAddr(data, 4);
    const spender = wordAddr(data, 36);
    const value = wordBig(data, 68);
    const deadline = wordBig(data, 100);
    const v = Number(wordBig(data, 132));
    if (deadline < BigInt(opts.nowSecs)) throw revertErr('PERMIT_DEADLINE_EXPIRED');
    const sig =
      '0x' + hex(data.subarray(164, 196)) + hex(data.subarray(196, 228)) + v.toString(16).padStart(2, '0');
    const msg = {owner, spender, value, deadline, nonce: nonces.get(owner.toLowerCase()) ?? 0n};
    const recovered = recoverEvmClaimSigner(domain, msg, sig);
    if (recovered === null || recovered.toLowerCase() !== owner.toLowerCase()) {
      throw revertErr('INVALID_SIGNER');
    }
    return {owner: owner.toLowerCase(), spender: spender.toLowerCase(), value};
  };

  const simulateTransferFrom = (data: Uint8Array): {from: string; to: string; value: bigint} => {
    const from = wordAddr(data, 4).toLowerCase();
    const to = wordAddr(data, 36).toLowerCase();
    const value = wordBig(data, 68);
    const allowed = allowance.get(`${from}:${fromAddr}`) ?? 0n;
    if (allowed < value) throw revertErr('ZCHF: insufficient allowance');
    if ((tokBalance.get(from) ?? 0n) < value) throw revertErr('ZCHF: insufficient balance');
    return {from, to, value};
  };

  const applyPermit = (p: {owner: string; spender: string; value: bigint}): void => {
    nonces.set(p.owner, (nonces.get(p.owner) ?? 0n) + 1n);
    allowance.set(`${p.owner}:${p.spender}`, p.value);
  };

  const applyTransferFrom = (t: {from: string; to: string; value: bigint}, txHash: string): void => {
    allowance.set(`${t.from}:${fromAddr}`, (allowance.get(`${t.from}:${fromAddr}`) ?? 0n) - t.value);
    tokBalance.set(t.from, (tokBalance.get(t.from) ?? 0n) - t.value);
    tokBalance.set(t.to, (tokBalance.get(t.to) ?? 0n) + t.value);
    logs.push({
      transactionHash: txHash,
      topics: [TRANSFER_EVENT_TOPIC, '0x' + word(BigInt(t.from)), '0x' + word(BigInt(t.to))],
      data: word(t.value),
    });
  };

  const rpc: EvmRpcLike = {
    ethCall: async (to, data, _from) => {
      void to;
      const sel = hex(data.subarray(0, 4));
      if (sel === 'd505accf') {
        simulatePermit(data);
        return '0x';
      }
      if (sel === '23b872dd') {
        simulateTransferFrom(data);
        return '0x';
      }
      if (sel === '7ecebe00') return '0x' + word(nonces.get(wordAddr(data, 4).toLowerCase()) ?? 0n);
      if (sel === '70a08231') return '0x' + word(tokBalance.get(wordAddr(data, 4).toLowerCase()) ?? 0n);
      throw new Error(`mock chain: unexpected ethCall selector ${sel}`);
    },
    ethGetBalance: async (address) => eth.get(address.toLowerCase()) ?? 0n,
    ethGetTransactionCount: async (address) => txCount.get(address.toLowerCase()) ?? 0,
    ethEstimateGas: async (tx) => {
      const sel = hex(tx.data.subarray(0, 4));
      if (sel === 'd505accf') simulatePermit(tx.data);
      if (sel === '23b872dd') simulateTransferFrom(tx.data);
      return GAS_UNITS;
    },
    ethGasPrice: async () => GAS_PRICE,
    ethMaxPriorityFeePerGas: async () => 100n,
    ethSendRawTransaction: async (raw) => {
      if (raw[0] !== 0x02) throw new Error('mock chain: only type-2 txs');
      const items = rlpDecode(raw.subarray(1)) as RlpDecoded[];
      const data = items[7] as Uint8Array;
      const sel = hex(data.subarray(0, 4));
      // A node's tx hash IS keccak256(raw) — settle computes the same and polls it.
      const txHash = '0x' + hex(keccak256(raw));
      sent.push({txHash, selector: sel});
      // Gas is always burned (a reverted tx still pays), and effects apply only on success —
      // the same semantics the real chain gives the settle path.
      eth.set(fromAddr, (eth.get(fromAddr) ?? 0n) - GAS_PER_TX);
      if (sel === 'd505accf') {
        try {
          applyPermit(simulatePermit(data));
          receipts.set(txHash, {status: '0x1'});
        } catch {
          receipts.set(txHash, {status: '0x0'}); // inclusion-time revert: no effects, gas burned
        }
      } else if (sel === '23b872dd') {
        try {
          applyTransferFrom(simulateTransferFrom(data), txHash);
          receipts.set(txHash, {status: '0x1'});
        } catch {
          receipts.set(txHash, {status: '0x0'});
        }
      } else {
        throw new Error(`mock chain: unexpected send selector ${sel}`);
      }
      txCount.set(fromAddr, (txCount.get(fromAddr) ?? 0) + 1);
      return txHash;
    },
    ethGetTransactionReceipt: async (txHash) =>
      opts.receiptsVisible === false ? null : (receipts.get(txHash) ?? null),
    ethGetLogs: async (filter) => logs.filter((l) => filter.topics.every((t, i) => l.topics[i] === t)),
  };

  return {
    rpc,
    sent,
    logs,
    fundEth: (addr: string, wei: bigint) => eth.set(addr.toLowerCase(), wei),
    fundToken: (addr: string, raw: bigint) => tokBalance.set(addr.toLowerCase(), raw),
    balanceOf: (addr: string) => tokBalance.get(addr.toLowerCase()) ?? 0n,
    ethWei: (addr: string) => eth.get(addr.toLowerCase()) ?? 0n,
    permitNonceOf: (addr: string) => nonces.get(addr.toLowerCase()) ?? 0n,
    allowanceOf: (owner: string, spender: string) =>
      allowance.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n,
    /** Consume one permit nonce on-chain (simulate the seed used elsewhere — the D22 staleness). */
    consumePermitNonce: (addr: string) =>
      nonces.set(addr.toLowerCase(), (nonces.get(addr.toLowerCase()) ?? 0n) + 1n),
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<EvmReqV1> = {}): EvmReqV1 {
  return {
    v: 1,
    rid: 'ab'.repeat(16),
    chainId: CHAIN_ID,
    token: 'ZCHF',
    to: merchant.address,
    amt: ZCHF(7n),
    iat: NOW,
    exp: NOW + 600,
    name: 'Kaffi Luzern',
    memo: 'tisch 4',
    ...overrides,
  };
}

const claimsKey = (): string => evmClaimsKey(merchant.address);

async function fullClaim(req: EvmReqV1, nonceSeed = 0): Promise<EvmPayV1> {
  await seedEvmNonce(payer.address, req.chainId, req.token, nonceSeed);
  const nonce = await takeEvmNonce(payer.address, req.chainId, req.token);
  const signed = signEvmClaim(PAYER_KEY, req, nonce);
  await enqueueEvmClaim(claimsKey(), {req, claim: signed.claim, nowMs: NOW_MS});
  return signed.claim;
}

function settle(chain: ReturnType<typeof makeChain>, req: EvmReqV1, claim: EvmPayV1, overrides: Partial<EvmSettleInput> = {}) {
  return settleEvmClaim({
    key: claimsKey(),
    merchantPrivateKey: MERCHANT_KEY,
    req,
    claim,
    tokenAddress: resolveEvmTokenAddress(req.chainId, req.token) ?? TOKEN,
    rpc: chain.rpc,
    nowMs: NOW_MS,
    pollMs: 1,
    settleDeadlineMs: 50,
    ...overrides,
  });
}

/** Sync codec calls throw; this captures their typed kind (or 'no-throw'/'no-kind'). */
const qrKind = (fn: () => unknown): string => {
  try {
    fn();
    return 'no-throw';
  } catch (e) {
    return (e as {kind?: string}).kind ?? 'no-kind';
  }
};

function fundedChain(merchantWei: bigint) {
  const chain = makeChain({nowSecs: NOW, from: merchant.address.toLowerCase()});
  chain.fundEth(merchant.address, merchantWei);
  chain.fundToken(payer.address, ZCHFn(100n));
  return chain;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  setEvmDevToken({chainId: CHAIN_ID, address: TOKEN, domainKind: 'minimal'});
});

afterEach(() => {
  clearEvmDevToken();
});

// ---------------------------------------------------------------------------
// 1. The wire codec (D21)
// ---------------------------------------------------------------------------

describe('evm/qr — evmreq/evmpay codec', () => {
  test('request round trips byte-exact (encode(decode(raw)) === raw)', () => {
    const req = makeReq();
    const uri = encodeEvmReq(req);
    expect(uri.startsWith('evmreq:v1?')).toBe(true);
    expect(uri.length).toBeLessThanOrEqual(2000);
    expect(encodeEvmReq(decodeEvmReq(uri))).toBe(uri);
    expect(decodeEvmReq(uri)).toEqual(req);
  });

  test('claim round trips byte-exact; sig is 0x + 130 lowercase hex', () => {
    const claim: EvmPayV1 = {
      v: 1,
      rid: 'ab'.repeat(16),
      owner: payer.address,
      deadline: NOW + 600,
      sig: '0x' + '9a'.repeat(64) + '1b',
    };
    const uri = encodeEvmPay(claim);
    expect(uri.startsWith('evmpay:v1?')).toBe(true);
    expect(uri.length).toBeLessThanOrEqual(2000);
    expect(encodeEvmPay(decodeEvmPay(uri))).toBe(uri);
    expect(decodeEvmPay(uri)).toEqual(claim);
  });

  test('canonical JSON key order is the frozen wire fact (harness-twin interop)', () => {
    const reqJson = bytesToUtf8(base64UrlToBytes(encodeEvmReq(makeReq()).slice('evmreq:v1?'.length))!);
    expect(Object.keys(JSON.parse(reqJson))).toEqual(
      ['v', 'rid', 'chainId', 'token', 'to', 'amt', 'iat', 'exp', 'name', 'memo'],
    );
    const payUri = encodeEvmPay({
      rid: 'ab'.repeat(16),
      owner: payer.address,
      deadline: NOW,
      sig: '0x' + '9a'.repeat(64) + '1c',
    });
    const payJson = bytesToUtf8(base64UrlToBytes(payUri.slice('evmpay:v1?'.length))!);
    expect(Object.keys(JSON.parse(payJson))).toEqual(['v', 'rid', 'owner', 'deadline', 'sig']);
  });

  test('wrong scheme / wrong version reject typed (bad-scheme)', () => {
    const uri = encodeEvmReq(makeReq());
    expect(qrKind(() => decodeEvmReq(uri.replace('evmreq:v1?', 'evmreq:v2?')))).toBe('bad-scheme');
    expect(qrKind(() => decodeEvmReq(uri.replace('evmreq:v1?', 'evmpay:v1?')))).toBe('bad-scheme');
    expect(qrKind(() => decodeEvmReq('solreq:v2?abc'))).toBe('bad-scheme');
  });

  test('non-canonical payloads reject: key reorder, padded base64, trailing junk', () => {
    const uri = encodeEvmReq(makeReq());
    const b64 = uri.slice('evmreq:v1?'.length);
    const obj = JSON.parse(bytesToUtf8(base64UrlToBytes(b64)!)) as Record<string, unknown>;
    // genuinely REORDER two keys (re-assigning an existing key keeps its position)
    const {v, rid, ...rest} = obj;
    const reordered = 'evmreq:v1?' + bytesToBase64Url(utf8ToBytes(JSON.stringify({rid, v, ...rest})));
    expect(qrKind(() => decodeEvmReq(reordered))).toBe('non-canonical');
    expect(qrKind(() => decodeEvmReq('evmreq:v1?' + b64 + '='))).toBe('bad-base64'); // padding
    expect(qrKind(() => decodeEvmReq(uri + 'x'))).toBe('bad-json'); // trailing junk byte
  });

  test('the 600s window is enforced at decode (D21: iat < exp <= iat + 600)', () => {
    expect(qrKind(() => encodeEvmReq(makeReq({exp: NOW + 601})))).toBe('bad-window');
    expect(qrKind(() => encodeEvmReq(makeReq({exp: NOW})))).toBe('bad-window');
    expect(encodeEvmReq(makeReq({exp: NOW + 600}))).toBeTruthy(); // the cap itself is legal
  });

  test('field rules: rid, token, address, amt, name/memo caps, sig shape', () => {
    expect(qrKind(() => encodeEvmReq(makeReq({rid: 'AB'.repeat(16)})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({token: 'zchf'})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({to: '0x1234'})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({amt: '0'})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({amt: '-5'})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({amt: '12.5'})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({name: 'x'.repeat(33)})))).toBe('bad-field');
    expect(qrKind(() => encodeEvmReq(makeReq({memo: 'x'.repeat(33)})))).toBe('bad-field');
    const badSig = (sig: string) =>
      qrKind(() => encodeEvmPay({rid: 'ab'.repeat(16), owner: payer.address, deadline: NOW, sig}));
    expect(badSig('0X' + '9a'.repeat(64) + '1b')).toBe('bad-field');
    expect(badSig('0x' + '9A'.repeat(64) + '1B')).toBe('bad-field');
    expect(badSig('0x' + '9a'.repeat(63) + '1b')).toBe('bad-field');
  });

  test('isEvmReqExpired: valid through the expiry second, gone one second later (D22.4)', () => {
    const req = makeReq();
    expect(isEvmReqExpired(req, req.exp)).toBe(false);
    expect(isEvmReqExpired(req, req.exp + 1)).toBe(true);
  });

  test('generateRid yields 32 lowercase hex; the test RNG seam is deterministic', () => {
    const seed = new Uint8Array(16).fill(7);
    (globalThis as unknown as {__DPAY_TEST_RNG?: unknown}).__DPAY_TEST_RNG = {
      getRandomValues: (a: Uint8Array) => (a.set(seed), a),
    };
    try {
      expect(generateRid()).toBe('07'.repeat(16));
      expect(generateRid()).toBe('07'.repeat(16));
    } finally {
      delete (globalThis as unknown as {__DPAY_TEST_RNG?: unknown}).__DPAY_TEST_RNG;
    }
    expect(generateRid()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateRid()).not.toBe(generateRid());
  });
});

// ---------------------------------------------------------------------------
// 2. Offline sign + attach (D21/D22)
// ---------------------------------------------------------------------------

describe('evm/claims — offline sign', () => {
  test('signs a minimal-domain permit offline and binds it rid + deadline', () => {
    const req = makeReq();
    const signed = signEvmClaim(PAYER_KEY, req, 3);
    expect(signed.claim.rid).toBe(req.rid);
    expect(signed.claim.deadline).toBe(req.exp);
    expect(signed.claim.owner).toBe(payer.address);
    expect(signed.claim.sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signed.nonceUsed).toBe(3);
    expect(signed.tokenAddress).toBe(TOKEN);
    expect(signed.claimUri).toBe(encodeEvmPay(signed.claim));
    expect(decodeEvmPay(signed.claimUri)).toEqual(signed.claim);
  });

  test('the attached signature recovers to the owner over the settle-submitted fields', () => {
    const req = makeReq();
    const signed = signEvmClaim(PAYER_KEY, req, 0);
    const recovered = recoverEvmClaimSigner(
      {kind: 'minimal', chainId: CHAIN_ID, verifyingContract: TOKEN},
      {owner: payer.address, spender: req.to, value: BigInt(req.amt), deadline: BigInt(req.exp), nonce: 0n},
      signed.claim.sig,
    );
    expect(recovered?.toLowerCase()).toBe(payer.address.toLowerCase());
  });

  test('signing is deterministic; a different nonce is a different permit (the staleness root)', () => {
    const req = makeReq();
    expect(signEvmClaim(PAYER_KEY, req, 0).claim.sig).toBe(signEvmClaim(PAYER_KEY, req, 0).claim.sig);
    const nonce1 = signEvmClaim(PAYER_KEY, req, 1).claim.sig;
    expect(signEvmClaim(PAYER_KEY, req, 0).claim.sig).not.toBe(nonce1);
    // a sig built for nonce 1 does NOT recover over the chain's nonce 0 — exactly why a stale
    // cached nonce reverts INVALID_SIGNER on-chain (D22.3)
    const recovered = recoverEvmClaimSigner(
      {kind: 'minimal', chainId: CHAIN_ID, verifyingContract: TOKEN},
      {owner: payer.address, spender: req.to, value: BigInt(req.amt), deadline: BigInt(req.exp), nonce: 0n},
      nonce1,
    );
    expect(recovered === null || recovered.toLowerCase() !== payer.address.toLowerCase()).toBe(true);
  });

  test('a chain with no token deployment refuses to sign (fail-closed, never a guessed domain)', () => {
    clearEvmDevToken();
    expect(() => signEvmClaim(PAYER_KEY, makeReq(), 0)).toThrow(/no ZCHF deployment/);
  });

  test('nonce cache: seeded take, optimistic bump, needsResign reset, per-key isolation (D22)', async () => {
    await seedEvmNonce(payer.address, CHAIN_ID, 'ZCHF', 5);
    expect(await takeEvmNonce(payer.address, CHAIN_ID, 'ZCHF')).toBe(5);
    expect(await takeEvmNonce(payer.address, CHAIN_ID, 'ZCHF')).toBe(6); // optimistic: no chain read
    await resetEvmNonce(payer.address, CHAIN_ID, 'ZCHF', 2); // the merchant's observed nonce
    expect(await takeEvmNonce(payer.address, CHAIN_ID, 'ZCHF')).toBe(2);
    await seedEvmNonce(payer.address, 42161, 'ZCHF', 9); // per (chain, token) keys are independent
    expect(await takeEvmNonce(payer.address, 42161, 'ZCHF')).toBe(9);
    expect(await takeEvmNonce(merchant.address, CHAIN_ID, 'ZCHF')).toBe(0); // fresh identity
  });
});

// ---------------------------------------------------------------------------
// 3. The claim queue (D23)
// ---------------------------------------------------------------------------

describe('evm/claims — the AsyncStorage queue', () => {
  const req = makeReq();
  const claim: EvmPayV1 = {
    v: 1,
    rid: req.rid,
    owner: payer.address,
    deadline: req.exp,
    sig: '0x' + '7b'.repeat(64) + '1b',
  };

  const rowOf = (req: EvmReqV1, c: EvmPayV1, createdAtMs: number): EvmClaimRow => ({
    req,
    claim: c,
    status: 'queued',
    txHash: null,
    permitNonce: -1,
    failReason: null,
    failDetail: null,
    attempts: 0,
    settledAtMs: null,
    createdAtMs,
  });

  test('enqueue → persist → rehydrate round trip', async () => {
    await enqueueEvmClaim(claimsKey(), {req, claim, nowMs: NOW_MS});
    const rows = await loadEvmClaims(claimsKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].req).toEqual(req);
    expect(rows[0].claim).toEqual(claim);
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].txHash).toBeNull();
    expect(rows[0].settledAtMs).toBeNull();
  });

  test('corrupt storage degrades to empty, never throws', async () => {
    await AsyncStorage.setItem(claimsKey(), 'not json at all');
    expect(await loadEvmClaims(claimsKey())).toEqual([]);
    await AsyncStorage.setItem(claimsKey(), JSON.stringify({schema: 99, rows: []}));
    expect(await loadEvmClaims(claimsKey())).toEqual([]);
    await AsyncStorage.setItem(claimsKey(), JSON.stringify({schema: 1, rows: 'nope'}));
    expect(await loadEvmClaims(claimsKey())).toEqual([]);
    expect(hydrateEvmClaimRows(undefined)).toEqual([]);
  });

  test('a corrupt row is dropped, its valid siblings kept; binding is re-checked in storage', async () => {
    const good = rowOf(makeReq(), claim, NOW_MS);
    const badShape = {...good, req: {...good.req, rid: 'ZZ'}};
    const badBinding = {...good, claim: {...claim, deadline: claim.deadline + 1}};
    const badStatus = {...good, claim: {...claim, rid: 'ef'.repeat(16)}, status: 'nonsense'};
    await AsyncStorage.setItem(claimsKey(), JSON.stringify({schema: 1, rows: [badShape, badBinding, badStatus, good]}));
    const rows = await loadEvmClaims(claimsKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].claim.rid).toBe(claim.rid);
  });

  test('rid is single-use: identical re-scan no-ops, settled rows are never overwritten', async () => {
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim, nowMs: NOW_MS});
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim, nowMs: NOW_MS + 1});
    expect(await loadEvmClaims(claimsKey())).toHaveLength(1);
    await patchEvmClaim(claimsKey(), claim.rid, {status: 'settled', txHash: '0x' + '99'.repeat(32), settledAtMs: NOW_MS});
    const different = {...claim, sig: '0x' + '7c'.repeat(64) + '1b'};
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim: different, nowMs: NOW_MS + 2});
    const rows = await loadEvmClaims(claimsKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('settled');
    expect(rows[0].claim.sig).toBe(claim.sig);
  });

  test('a re-signed claim (fresh nonce, same rid) adopts over needsResign (D22.3)', async () => {
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim, nowMs: NOW_MS});
    await patchEvmClaim(claimsKey(), claim.rid, {status: 'needsResign', failReason: 'nonce', permitNonce: 4});
    const resigned = {...claim, sig: '0x' + '5e'.repeat(64) + '1c'};
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim: resigned, nowMs: NOW_MS + 5});
    const rows = await loadEvmClaims(claimsKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].claim.sig).toBe(resigned.sig);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].attempts).toBe(0); // the retry guard resets for fresh evidence
    expect(rows[0].createdAtMs).toBe(NOW_MS); // first-seen order preserved for eviction
    // but a DIFFERENT claim over a non-needsResign row is refused (the existing row wins)
    await patchEvmClaim(claimsKey(), claim.rid, {status: 'unknown', txHash: '0x' + '31'.repeat(32)});
    await enqueueEvmClaim(claimsKey(), {req: makeReq(), claim, nowMs: NOW_MS + 6});
    expect((await loadEvmClaims(claimsKey()))[0].claim.sig).toBe(resigned.sig);
  });

  test(`cap: ${MAX_EVM_CLAIMS} rows, oldest-settled evicts first`, async () => {
    const rowsIn: EvmClaimRow[] = [];
    for (let i = 0; i < MAX_EVM_CLAIMS; i++) {
      const rid = i.toString(16).padStart(2, '0').repeat(16);
      rowsIn.push(rowOf(makeReq({rid}), {...claim, rid}, NOW_MS + i));
    }
    const settledOld: EvmClaimRow = {...rowsIn[0], status: 'settled', txHash: '0x01', settledAtMs: NOW_MS};
    const settledNew: EvmClaimRow = {...rowsIn[1], status: 'settled', txHash: '0x02', settledAtMs: NOW_MS + 10};
    await AsyncStorage.setItem(
      claimsKey(),
      JSON.stringify({schema: 1, rows: [settledOld, ...rowsIn.slice(2), settledNew]}),
    );
    const newRid = 'ff'.repeat(16);
    await enqueueEvmClaim(claimsKey(), {req: makeReq({rid: newRid}), claim: {...claim, rid: newRid}, nowMs: NOW_MS + 20});
    const rows = await loadEvmClaims(claimsKey());
    expect(rows).toHaveLength(MAX_EVM_CLAIMS);
    expect(rows.find((r) => r.claim.rid === settledOld.claim.rid)).toBeUndefined(); // oldest settled gone
    expect(rows.find((r) => r.claim.rid === settledNew.claim.rid)).toBeDefined(); // newer settled kept
    expect(rows.find((r) => r.claim.rid === newRid)).toBeDefined(); // the new claim kept
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(MAX_EVM_CLAIMS - 1); // no unsettled loss
  });
});

// ---------------------------------------------------------------------------
// 4. Settle (D24)
// ---------------------------------------------------------------------------

describe('evm/claims — settleEvmClaim', () => {
  test('success: permit then transferFrom, sequential, and the money moves exactly (D24.2/3)', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('settled');
    expect(result.txHash).toBe(result.row.txHash);
    expect(result.row.status).toBe('settled');
    expect(result.row.settledAtMs).toBe(NOW_MS);
    // exactly two merchant txs, permit FIRST (sequential — a reverted permit must not burn twice)
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[0].selector).toBe('d505accf');
    expect(chain.sent[1].selector).toBe('23b872dd');
    // money: 100 → 93 payer, 0 → 7 merchant; the permit nonce consumed; allowance spent down
    expect(chain.balanceOf(payer.address)).toBe(ZCHFn(93n));
    expect(chain.balanceOf(merchant.address)).toBe(ZCHFn(7n));
    expect(chain.permitNonceOf(payer.address)).toBe(1n);
    expect(chain.allowanceOf(payer.address, merchant.address)).toBe(0n);
    // the merchant's ETH paid exactly 2 txs of gas
    expect(chain.ethWei(merchant.address)).toBe(10n ** 16n - 2n * GAS_PER_TX);
    // the payer's optimistic cache now sits one ahead of the chain — the D22 posture
    expect(await takeEvmNonce(payer.address, CHAIN_ID, 'ZCHF')).toBe(1);
  });

  test('re-scan + re-settle of a settled claim is an honest no-op (settle-first-wins, D24.4)', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    const first = await settle(chain, req, claim);
    expect(first.outcome).toBe('settled');
    const second = await settle(chain, req, claim);
    expect(second.outcome).toBe('settled');
    expect(second.txHash).toBe(first.txHash);
    expect(second.row.status).toBe('settled');
    expect(chain.sent).toHaveLength(2); // nothing new broadcast
    expect(chain.balanceOf(merchant.address)).toBe(ZCHFn(7n)); // no second spend
  });

  test('a settled chain with a lost queue still closes out via the Transfer log, spending nothing (D24.1)', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    const first = await settle(chain, req, claim);
    expect(first.outcome).toBe('settled');
    // the merchant's queue is lost (fresh storage key); the claim QR is handed over AGAIN
    const second = await settleEvmClaim({
      key: claimsKey() + '.recovered',
      merchantPrivateKey: MERCHANT_KEY,
      req,
      claim,
      tokenAddress: TOKEN,
      rpc: chain.rpc,
      nowMs: NOW_MS,
      pollMs: 1,
      settleDeadlineMs: 50,
    });
    expect(second.outcome).toBe('settled');
    expect(second.txHash).toBe(first.txHash); // the ORIGINAL payment, found on-chain
    expect(second.row.status).toBe('settled');
    expect(chain.sent).toHaveLength(2); // no new txs
    expect(chain.balanceOf(payer.address)).toBe(ZCHFn(93n)); // paid exactly once
  });

  test('stale permit nonce → the needsResign STATE with the on-chain nonce, no gas spent (D22.3)', async () => {
    const chain = fundedChain(10n ** 16n);
    // the seed was used elsewhere: the chain's nonce is 2 while the payer's cache still guesses 0
    chain.consumePermitNonce(payer.address);
    chain.consumePermitNonce(payer.address);
    const req = makeReq();
    const claim = await fullClaim(req); // signs nonce 0
    const result = await settle(chain, req, claim);

    expect(result.outcome).toBe('needs-resign');
    expect(result.observedNonce).toBe(2);
    expect(result.reason).toBe('nonce');
    expect(result.row.status).toBe('needsResign');
    expect(result.row.failReason).toBe('nonce');
    expect(result.row.permitNonce).toBe(2);
    expect(chain.sent).toHaveLength(0); // classified BEFORE any spend
    expect(chain.balanceOf(payer.address)).toBe(ZCHFn(100n)); // nothing moved

    // the payer's next online moment: reset to the chain's truth, re-sign the SAME rid fresh
    await resetEvmNonce(payer.address, CHAIN_ID, 'ZCHF', result.observedNonce ?? 0);
    const nonce = await takeEvmNonce(payer.address, CHAIN_ID, 'ZCHF');
    const resigned = signEvmClaim(PAYER_KEY, req, nonce).claim;
    expect(resigned.rid).toBe(req.rid);
    await enqueueEvmClaim(claimsKey(), {req, claim: resigned, nowMs: NOW_MS});
    const second = await settle(chain, req, resigned);
    expect(second.outcome).toBe('settled');
    expect(chain.balanceOf(merchant.address)).toBe(ZCHFn(7n));
  });

  test('an inclusion-time permit revert (the race) re-classifies from the chain, honestly', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    // the nonce is consumed right AFTER the gas quote passed: the tx reverts at inclusion
    const originalEstimate = chain.rpc.ethEstimateGas.bind(chain.rpc);
    let estimates = 0;
    chain.rpc.ethEstimateGas = async (tx) => {
      const out = await originalEstimate(tx);
      estimates += 1;
      if (estimates === 1) chain.consumePermitNonce(payer.address); // the race lands here
      return out;
    };
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('needs-resign');
    expect(result.row.status).toBe('needsResign');
    expect(result.observedNonce).toBe(1);
    expect(chain.sent).toHaveLength(1); // the permit was broadcast (and reverted on-chain)
  });

  test('a raced permit revert whose token would accept the permit NOW re-queues (never terminal), attempts-guarded', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    const realSend = chain.rpc.ethSendRawTransaction;
    const realReceipt = chain.rpc.ethGetTransactionReceipt;
    // Force one inclusion-time revert with NO token effect: gas burned, receipt 0x0, state
    // untouched — the post-revert re-classify eth_call then SUCCEEDS (the raced edge, the one
    // branch a terminal fail would get wrong: the claim is still live).
    const forceRevertOnce = () => {
      chain.rpc.ethSendRawTransaction = async (raw) => {
        const txHash = '0x' + hex(keccak256(raw)); // a node's tx hash IS keccak256(raw)
        chain.rpc.ethGetTransactionReceipt = async (h) =>
          h === txHash ? {status: '0x0'} : realReceipt(h);
        return txHash;
      };
    };
    forceRevertOnce();
    const first = await settle(chain, req, claim);
    expect(first.outcome).toBe('unknown');
    expect(first.row.status).toBe('queued'); // NOT terminal failed — the permit may still land
    expect(first.row.attempts).toBe(1);
    expect(first.txHash).toBe(first.row.txHash); // the reverted tx stays the reconcile handle
    expect(first.detail).toMatch(/re-queued/);
    // the same race, repeated, is bounded: the attempts guard ends in an honest terminal failure
    forceRevertOnce();
    expect((await settle(chain, req, claim)).outcome).toBe('unknown');
    forceRevertOnce();
    expect((await settle(chain, req, claim)).outcome).toBe('unknown');
    const fourth = await settle(chain, req, claim);
    expect(fourth.outcome).toBe('failed');
    expect(fourth.reason).toBe('rejected');
    expect(fourth.detail).toMatch(/attempts/);
    expect(chain.balanceOf(payer.address)).toBe(ZCHFn(100n)); // nothing moved through any of it
    // the racing chain was the ONLY thing failing: an honest chain settles the same claim bytes
    chain.rpc.ethSendRawTransaction = realSend;
    chain.rpc.ethGetTransactionReceipt = realReceipt;
    const freshReq = makeReq({rid: 'cd'.repeat(16)}); // the failed rid is terminal — a fresh one
    const freshClaim = await fullClaim(freshReq); // the permit nonce was never consumed on-chain
    const ok = await settle(chain, freshReq, freshClaim);
    expect(ok.outcome).toBe('settled');
    expect(chain.balanceOf(merchant.address)).toBe(ZCHFn(7n));
  });

  test('expired request refuses before any spend (D24.1)', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq({iat: NOW - 600, exp: NOW - 1});
    const claim = await fullClaim(req);
    expect(isEvmReqExpired(req, NOW)).toBe(true);
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('expired');
    expect(result.row.status).toBe('failed');
    expect(result.row.failReason).toBe('expired');
    expect(chain.sent).toHaveLength(0);
  });

  test('a claim that does not bind to the request is rejected before anything else', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    const wrongDeadline = {...claim, deadline: claim.deadline + 1};
    const result = await settle(chain, req, wrongDeadline);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('rejected');
    expect(result.detail).toMatch(/does not bind/);
    expect(chain.sent).toHaveLength(0);
  });

  test('the gas gate refuses with the instructive fix, before any broadcast (D24.1/D15.3)', async () => {
    const chain = fundedChain(10n ** 14n); // half of the 2x fee estimate the gate demands
    const req = makeReq();
    const claim = await fullClaim(req);
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('gas');
    expect(result.detail).toMatch(/receive ETH at/);
    expect(result.detail).toContain(merchant.address);
    expect(chain.sent).toHaveLength(0);
    expect(chain.balanceOf(payer.address)).toBe(ZCHFn(100n));
  });

  test('transport death at preflight leaves the claim queued and retryable (txHash null)', async () => {
    const chain = fundedChain(10n ** 16n);
    const req = makeReq();
    const claim = await fullClaim(req);
    chain.rpc.ethCall = async (_to, _data, _from) => {
      throw transportErr();
    };
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('unknown');
    expect(result.txHash).toBeNull();
    expect(result.row.status).toBe('queued'); // honest: nothing broadcast, nothing failed
    expect(chain.sent).toHaveLength(0);
  });

  test('a broadcast whose receipt never confirms preserves unknown with the hash (invariant #12)', async () => {
    const chain = makeChain({nowSecs: NOW, from: merchant.address.toLowerCase(), receiptsVisible: false});
    chain.fundEth(merchant.address, 10n ** 16n);
    chain.fundToken(payer.address, ZCHFn(100n));
    const req = makeReq();
    const claim = await fullClaim(req);
    const result = await settle(chain, req, claim);
    expect(result.outcome).toBe('unknown');
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/); // the real keccak of the broadcast bytes
    expect(result.txHash).toBe(chain.sent[0].txHash);
    expect(result.row.status).toBe('unknown');
    expect(result.row.txHash).toBe(result.txHash);
    expect(chain.sent).toHaveLength(1);
  });

  test('attempts guard: repeated unsettled attempts end in an honest terminal failure (D23)', async () => {
    const chain = makeChain({nowSecs: NOW, from: merchant.address.toLowerCase(), receiptsVisible: false});
    chain.fundEth(merchant.address, 10n ** 16n);
    chain.fundToken(payer.address, ZCHFn(100n));
    const req = makeReq();
    const claim = await fullClaim(req);
    // attempt 1: the permit lands on-chain but its receipt is never SEEN → unknown
    expect((await settle(chain, req, claim)).outcome).toBe('unknown');
    // attempts 2-3: the consumed permit now reverts INVALID_SIGNER on re-entry → the honest
    // needsResign state (the money did NOT move; the permit is burned)
    expect((await settle(chain, req, claim)).outcome).toBe('needs-resign');
    expect((await settle(chain, req, claim)).outcome).toBe('needs-resign');
    const fourth = await settle(chain, req, claim);
    expect(fourth.outcome).toBe('failed');
    expect(fourth.reason).toBe('rejected');
    expect(fourth.detail).toMatch(/attempts/);
    const fifth = await settle(chain, req, claim);
    expect(fifth.outcome).toBe('failed'); // terminal rows are idempotent, never re-spent
  });
});

// ---------------------------------------------------------------------------
// 5. Receipt decision (D25) + revert classification
// ---------------------------------------------------------------------------

describe('evm/claims — decideEvmPayerReceipt', () => {
  const rid = 'ab'.repeat(16);
  const tx = '0x' + 'AB'.repeat(31) + 'cd';

  test('settled + both bindings → success', () => {
    expect(decideEvmPayerReceipt({status: 0, rid, sig: tx}, rid, tx)).toEqual({outcome: 'success'});
  });

  test('rejected → declined; unknown codes → honest pending, never a false decline', () => {
    expect(decideEvmPayerReceipt({status: 1, rid, sig: tx}, rid, tx)).toEqual({outcome: 'declined'});
    expect(decideEvmPayerReceipt({status: 2, rid, sig: tx}, rid, tx)).toEqual({outcome: 'pending'});
    expect(decideEvmPayerReceipt({status: 9, rid, sig: tx}, rid, tx)).toEqual({outcome: 'pending'});
  });

  test('hex case is display noise: compared lowercase-normalized on BOTH sides, explicitly', () => {
    expect(decideEvmPayerReceipt({status: 0, rid, sig: tx.toLowerCase()}, rid, tx.toUpperCase())).toEqual({
      outcome: 'success',
    });
  });

  test('a receipt for another payment is ignored; no expected hash → rid-only binding', () => {
    expect(decideEvmPayerReceipt({status: 0, rid: 'ff'.repeat(16), sig: tx}, rid, tx)).toEqual({outcome: 'ignore'});
    expect(decideEvmPayerReceipt({status: 0, rid, sig: '0x' + '11'.repeat(32)}, rid, tx)).toEqual({outcome: 'ignore'});
    expect(decideEvmPayerReceipt({status: 0, rid, sig: tx}, rid, null)).toEqual({outcome: 'success'});
  });
});

describe('evm/claims — revert classification (typed, no string-prefix assumptions)', () => {
  test('Error(string) payloads decode and map to typed kinds', () => {
    expect(decodeSolidityRevertString(revertData('PERMIT_DEADLINE_EXPIRED'))).toBe('PERMIT_DEADLINE_EXPIRED');
    expect(classifyEvmRevert(revertErr('PERMIT_DEADLINE_EXPIRED'))).toMatchObject({kind: 'expired', transport: false});
    expect(classifyEvmRevert(revertErr('INVALID_SIGNER'))).toMatchObject({kind: 'invalid-signer'});
    expect(classifyEvmRevert(revertErr('INVALID_NONCE'))).toMatchObject({kind: 'nonce'});
    expect(classifyEvmRevert(revertErr('ZCHF: insufficient allowance'))).toMatchObject({kind: 'insufficient-funds'});
    expect(classifyEvmRevert(revertErr('ZCHF: insufficient balance'))).toMatchObject({kind: 'insufficient-funds'});
    expect(classifyEvmRevert(revertErr('Some other custom text'))).toMatchObject({
      kind: 'string',
      message: 'Some other custom text',
    });
  });

  test('opaque data and transport failures stay distinguishable', () => {
    const panic = new Error('');
    (panic as Error & {data?: string}).data = '0x4e487b71' + '00'.repeat(31); // Panic(uint256)
    expect(classifyEvmRevert(panic)).toMatchObject({kind: 'opaque', transport: false});
    expect(classifyEvmRevert(transportErr())).toMatchObject({kind: 'string', transport: true});
  });
});
