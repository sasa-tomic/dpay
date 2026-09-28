// node-anvil tier, test 3 of 3 — the OFFLINE permit claim (e2e flow 220's service core), no
// browser: the payer's nonce leaves the AsyncStorage cache OFFLINE, the merchant settles through
// the pipe (permit + transferFrom mined against MockZCHF's MINIMAL domain), the Transfer log +
// consumed nonce + spent allowance are read DIRECT from the chain, a second settle of the same
// claim spends nothing, and the raced-permit path lands needs-resign → resetEvmNonce → a fresh
// signature that settles (the D22.3 re-sign, through the app's own queue adoption).
//
// KNOWN FIXTURE GAP (pinned by the characterization test below): the committed MockZCHF hashes
// Permit(value, deadline, nonce) while real ZCHF's ERC20PermitLight — and EIP-2612/OZ, and
// app/evm/permit.ts — hash Permit(value, nonce, deadline). The e2e flows never hit this because
// they never settle an app-signed permit against the mock; this tier does. Until the fixture is
// rebuilt in the canonical order, `signPermitMockOrder` (app crypto primitives, the mock's struct
// order) stands in for `signEvmPermitClaim`'s signature; everything around it (nonce cache,
// request, queue, settle engine, chain) is the app's own code.
import {expect, test, beforeAll} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {secp256k1} from '@noble/curves/secp256k1';
import {
  createEvmPaymentRequest,
  deriveEvmAddress,
  enqueueEvmClaim,
  evmClaimsKey,
  resetEvmNonce,
  seedEvmPermitNonces,
  settleEvmClaim,
  signEvmPermitClaim,
  type EvmKey,
  type EvmPayV1,
} from '../../evm';
import {addressWord, encodePermit, uint256Word} from '../../evm/abi';
import {decodeSolidityRevertString, loadEvmClaims, permitDomainFor, takeEvmNonce} from '../../evm/claims';
import {deriveEvmKeypair} from '../../evm/identity';
import {keccak256} from '../../evm/keccak';
import {toHex0x} from '../../evm/tx';
import {
  buildDomainSeparator,
  type PermitDomain,
  type PermitMessage,
  type SignedPermit,
} from '../../evm/permit';
import {bytesToHex, hexToBytes} from '../../lib/format';
import {utf8ToBytes} from '../../lib/base64url';
import {
  ANVIL_ACCOUNT_1,
  ANVIL_CHAIN_ID,
  ANVIL_DEPLOYER_PRIV,
  devSeed,
  allowanceRaw,
  ethBalanceRaw,
  fundEthDirect,
  fundZchfDirect,
  nodeAnvilEnv,
  permitNonceRaw,
  pollUntil,
  sendDirectTx,
  tokenBalanceRaw,
  transferLogsRaw,
  wireSeamToPipe,
  type NodeAnvilEnv,
} from './anvilEnv';

const ZCHF = (n: bigint): bigint => n * 10n ** 18n;
const MERCHANT_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH — the settle engine gates on 2 txs of worst-case fee

let env: NodeAnvilEnv;
let payerSecret: string;
let payer: string;
let merchantSecret: string;
let merchant: string;
let keys: EvmKey[];
let domain: PermitDomain;

beforeAll(async () => {
  env = nodeAnvilEnv();
  await AsyncStorage.clear();
  await wireSeamToPipe(env);
  payerSecret = devSeed('222 payer');
  payer = deriveEvmAddress(payerSecret);
  merchantSecret = devSeed('222 merchant');
  merchant = deriveEvmAddress(merchantSecret);
  keys = [{chainId: ANVIL_CHAIN_ID, token: 'ZCHF', tokenAddress: env.token, decimals: 18}];
  domain = permitDomainFor(ANVIL_CHAIN_ID);
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function to32(v: bigint): Uint8Array {
  return hexToBytes(v.toString(16).padStart(64, '0'));
}

/** Sign a permit over the DEV FIXTURE's struct order with the app's own crypto primitives.
 *  See the header: MockZCHF hashes (value, deadline, nonce); real ZCHF + app/evm/permit.ts hash
 *  (value, nonce, deadline). Vanishes when the fixture is rebuilt in the canonical order. */
function signPermitMockOrder(privateKey: Uint8Array, dom: PermitDomain, msg: PermitMessage): SignedPermit {
  const typehash = keccak256(utf8ToBytes('Permit(address owner,address spender,uint256 value,uint256 deadline,uint256 nonce)'));
  const structHash = keccak256(concat(
    typehash,
    addressWord(msg.owner),
    addressWord(msg.spender),
    uint256Word(msg.value),
    uint256Word(msg.deadline),
    uint256Word(msg.nonce),
  ));
  const digest = keccak256(concat(new Uint8Array([0x19, 0x01]), buildDomainSeparator(dom), structHash));
  const sig = secp256k1.sign(digest, privateKey); // deterministic RFC 6979, low-s normalized
  const v = 27 + sig.recovery;
  const r = to32(sig.r);
  const s = to32(sig.s);
  return {v, r, s, serialized: concat(r, s, new Uint8Array([v]))};
}

function claimOf(req: ReturnType<typeof createEvmPaymentRequest>['req'], signed: SignedPermit): EvmPayV1 {
  return {v: 1, rid: req.rid, owner: payer, deadline: req.exp, sig: '0x' + bytesToHex(signed.serialized)};
}

/** The payer's SLIP-10-derived EVM key (m/44'/60'/0'/0/0 over the device seed) — the same
 *  derivation signEvmPermitClaim performs internally; the bridge must sign with IT, never the
 *  raw seed bytes. */
function payerKey(secretHex: string): Uint8Array {
  return deriveEvmKeypair(secretHex).privateKey;
}

test('222 · offline nonce \u2192 merchant settle mines permit + transferFrom, exactly once', async () => {
  await fundZchfDirect(env.rpc, env.token, payer, ZCHF(100n));
  await fundEthDirect(env.rpc, merchant, MERCHANT_ETH_WEI);

  // D22.1: the online poll seeds the payer's permit-nonce cache from the chain (app path, pipe).
  const chainNonce0 = await permitNonceRaw(env.rpc, env.token, payer);
  await seedEvmPermitNonces(payerSecret, keys);

  // The merchant mints the request; the payer consumes the cached nonce OFFLINE (the sign path's
  // only await is AsyncStorage).
  const {req} = createEvmPaymentRequest({
    chainId: ANVIL_CHAIN_ID,
    token: 'ZCHF',
    to: merchant,
    amt: ZCHF(7n).toString(),
    name: 'Kaffi Luzern',
    memo: 'tisch 4',
  });
  const nonceUsed = await takeEvmNonce(payer, ANVIL_CHAIN_ID, 'ZCHF');
  expect(nonceUsed).toBe(Number(chainNonce0));

  // The signed claim (the mock-order bridge — see the header), queued through the app.
  const signed = signPermitMockOrder(payerKey(payerSecret), domain, {
    owner: payer,
    spender: merchant,
    value: ZCHF(7n),
    deadline: BigInt(req.exp),
    nonce: BigInt(nonceUsed),
  });
  const claim = claimOf(req, signed);
  await enqueueEvmClaim(evmClaimsKey(merchant), {req, claim});

  // The merchant settles: permit() then transferFrom(), the merchant's ETH pays gas.
  const res = await settleEvmClaim(merchantSecret, req, claim);
  expect(res.outcome).toBe('settled');
  expect(res.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

  // REAL chain state, read DIRECT: the delta exact, the permit nonce consumed, allowance spent.
  const [payerNow, merchantNow, nonceNow] = await pollUntil(
    'settle state',
    async () => [
      await tokenBalanceRaw(env.rpc, env.token, payer),
      await tokenBalanceRaw(env.rpc, env.token, merchant),
      await permitNonceRaw(env.rpc, env.token, payer),
    ] as const,
    ([p, , n]) => p === ZCHF(100n) - ZCHF(7n) && n === chainNonce0 + 1n,
  );
  expect(payerNow.toString()).toBe((ZCHF(100n) - ZCHF(7n)).toString());
  expect(merchantNow.toString()).toBe(ZCHF(7n).toString());
  expect(nonceNow.toString()).toBe((chainNonce0 + 1n).toString());
  // The permit's allowance was set and then consumed by transferFrom (DIRECT read).
  expect((await allowanceRaw(env.rpc, env.token, payer, merchant)).toString()).toBe('0');

  // The settle tx's own Transfer log, DIRECT: payer → merchant, exactly 7 ZCHF.
  const logs = await transferLogsRaw(env.rpc, env.token, '0x1');
  const moved = logs.find((l) => l.txHash.toLowerCase() === (res.txHash as string).toLowerCase());
  expect(moved).toBeDefined();
  expect(moved?.from.toLowerCase()).toBe(payer.toLowerCase());
  expect(moved?.to.toLowerCase()).toBe(merchant.toLowerCase());
  expect(moved?.amount.toString()).toBe(ZCHF(7n).toString());

  // The queue row the app persisted reads settled with the settle hash.
  const rows = await loadEvmClaims(evmClaimsKey(merchant));
  const row = rows.find((r) => r.claim.rid === req.rid);
  expect(row?.status).toBe('settled');
  expect(row?.txHash).toBe(res.txHash);

  // D24.4: a second settle of the SAME claim spends nothing (the settled row is idempotent).
  const res2 = await settleEvmClaim(merchantSecret, req, claim);
  expect(res2.outcome).toBe('settled');
  expect(res2.detail ?? '').toContain('already settled');
  expect((await tokenBalanceRaw(env.rpc, env.token, payer)).toString()).toBe((ZCHF(100n) - ZCHF(7n)).toString());
  expect((await tokenBalanceRaw(env.rpc, env.token, merchant)).toString()).toBe(ZCHF(7n).toString());
  expect((await ethBalanceRaw(env.rpc, merchant)) < MERCHANT_ETH_WEI).toBe(true); // only round 1 paid gas
}, 60_000);

test('222 · the raced permit: a stale-nonce claim needs-resigns, the re-sign settles', async () => {
  const payer2Secret = devSeed('222 payer2');
  const payer2 = deriveEvmAddress(payer2Secret);
  await fundZchfDirect(env.rpc, env.token, payer2, ZCHF(50n));

  await seedEvmPermitNonces(payer2Secret, keys);
  const cachedNonce = await permitNonceRaw(env.rpc, env.token, payer2);

  // THE RACE: while the payer is offline, that exact nonce is spent elsewhere (a harness-side
  // permit over the same token, signed with the payer's own key, mined DIRECT — gas from the
  // well-funded deployer, the PERMIT's signer stays the payer).
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const raced = signPermitMockOrder(payerKey(payer2Secret), domain, {
    owner: payer2,
    spender: ANVIL_ACCOUNT_1,
    value: ZCHF(3n),
    deadline,
    nonce: cachedNonce,
  });
  await sendDirectTx(
    env.rpc,
    ANVIL_DEPLOYER_PRIV,
    env.token,
    encodePermit(payer2, ANVIL_ACCOUNT_1, ZCHF(3n), deadline, raced.v, raced.r, raced.s),
    120_000n,
  );
  expect((await permitNonceRaw(env.rpc, env.token, payer2)).toString()).toBe((cachedNonce + 1n).toString());
  // The settle's stale-nonce diagnostic reads nonces(payer2) THROUGH the pipe (2s read cache):
  // outlive the TTL or it would answer the STALE pre-race value.
  await new Promise((r) => setTimeout(r, 2500));

  // The payer, still offline, consumes the now-STALE cached nonce and signs.
  const {req} = createEvmPaymentRequest({
    chainId: ANVIL_CHAIN_ID,
    token: 'ZCHF',
    to: merchant,
    amt: ZCHF(5n).toString(),
  });
  const staleNonce = await takeEvmNonce(payer2, ANVIL_CHAIN_ID, 'ZCHF');
  expect(staleNonce).toBe(Number(cachedNonce));
  const staleSigned = signPermitMockOrder(payerKey(payer2Secret), domain, {
    owner: payer2,
    spender: merchant,
    value: ZCHF(5n),
    deadline: BigInt(req.exp),
    nonce: BigInt(staleNonce),
  });
  const staleClaim = {v: 1 as const, rid: req.rid, owner: payer2, deadline: req.exp, sig: '0x' + bytesToHex(staleSigned.serialized)};
  await enqueueEvmClaim(evmClaimsKey(merchant), {req, claim: staleClaim});

  // The settle classifies the on-chain INVALID_SIGNER as the honest needs-resign STATE (never
  // terminal), carrying the TRUE on-chain nonce — and broadcasts nothing.
  const res = await settleEvmClaim(merchantSecret, req, staleClaim);
  expect(res.outcome).toBe('needs-resign');
  expect(res.reason).toBe('nonce');
  expect(res.observedNonce).toBe(Number(cachedNonce) + 1);
  expect(res.txHash).toBeNull();

  // D22.3: the report re-seeds the cache; the re-sign consumes the TRUE nonce and the app's own
  // queue adoption replaces the stale claim bytes (needsResign → fresh queued row).
  await resetEvmNonce(payer2, ANVIL_CHAIN_ID, 'ZCHF', res.observedNonce as number);
  const freshNonce = await takeEvmNonce(payer2, ANVIL_CHAIN_ID, 'ZCHF');
  expect(freshNonce).toBe(Number(cachedNonce) + 1);
  const freshSigned = signPermitMockOrder(payerKey(payer2Secret), domain, {
    owner: payer2,
    spender: merchant,
    value: ZCHF(5n),
    deadline: BigInt(req.exp),
    nonce: BigInt(freshNonce),
  });
  const freshClaim = {v: 1 as const, rid: req.rid, owner: payer2, deadline: req.exp, sig: '0x' + bytesToHex(freshSigned.serialized)};
  await enqueueEvmClaim(evmClaimsKey(merchant), {req, claim: freshClaim});

  const res2 = await settleEvmClaim(merchantSecret, req, freshClaim);
  expect(res2.outcome).toBe('settled');

  // REAL chain: the re-signed claim moved exactly 5 ZCHF, the nonce advanced once more.
  const [payer2Now, merchantNow, nonceNow] = await pollUntil(
    're-signed settle state',
    async () => [
      await tokenBalanceRaw(env.rpc, env.token, payer2),
      await tokenBalanceRaw(env.rpc, env.token, merchant),
      await permitNonceRaw(env.rpc, env.token, payer2),
    ] as const,
    ([p]) => p === ZCHF(50n) - ZCHF(5n),
  );
  expect(payer2Now.toString()).toBe((ZCHF(50n) - ZCHF(5n)).toString());
  expect(merchantNow.toString()).toBe((ZCHF(7n) + ZCHF(5n)).toString());
  expect(nonceNow.toString()).toBe((cachedNonce + 2n).toString());
}, 60_000);

test('222 · CHARACTERIZATION: the app\u2019s canonical permit order vs the MockZCHF fixture', async () => {
  // Pins the fixture gap the bridge above works around. The app signs Permit(value, NONCE,
  // deadline) — the EIP-2612 spec text, OpenZeppelin, and real ZCHF's ERC20PermitLight
  // (verified against the Frankencoin contracts source, 2026-09-28). The committed MockZCHF
  // hashes Permit(value, deadline, NONCE), so an APP-signed permit is correctly rejected BY THE
  // MOCK ONLY. When the fixture is rebuilt in the canonical order this test goes RED: delete
  // signPermitMockOrder, settle through signEvmPermitClaim, and drop this test.
  const payer3Secret = devSeed('222 payer3');
  await fundZchfDirect(env.rpc, env.token, deriveEvmAddress(payer3Secret), ZCHF(10n));
  await seedEvmPermitNonces(payer3Secret, keys);
  const {req} = createEvmPaymentRequest({
    chainId: ANVIL_CHAIN_ID,
    token: 'ZCHF',
    to: merchant,
    amt: ZCHF(1n).toString(),
  });
  const {claim} = await signEvmPermitClaim(payer3Secret, req);

  // Decode the app signature and preflight the permit DIRECT against the mock: the mock's
  // ecrecover sees a different struct hash and reverts INVALID_SIGNER.
  const sig = hexToBytes(claim.sig);
  const v = sig[64];
  const call = await (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(env.rpc, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{
          to: env.token,
          data: toHex0x(encodePermit(claim.owner, req.to, BigInt(req.amt), BigInt(claim.deadline), v, sig.slice(0, 32), sig.slice(32, 64))),
        }, 'latest']}),
        signal: ctrl.signal,
      });
      return (await r.json()) as {result?: string; error?: {data?: string; message?: string}};
    } finally {
      clearTimeout(timer);
    }
  })();
  expect(call.result).toBeUndefined();
  expect(decodeSolidityRevertString(call.error?.data ?? '')).toBe('INVALID_SIGNER');
}, 60_000);
