#!/usr/bin/env node
// evm-mainnet-claim-settle.mjs — the D31 OFFLINE-PERMIT leg, merchant half: settle a REAL
// evmpay:v1 permit claim on Ethereum MAINNET through the dpay relay's production EVM pipe.
// The counterparty B (m/44'/60'/0'/0/1 of the IC float seed, decrypted IN-PROCESS, never
// printed) pays the settle gas and signs permit() + transferFrom() — exactly the mechanics
// app/evm/claims.ts settleEvmClaim drives, harness-side (flow-220's settleRaw over mainnet).
//
//   node scripts/evm-mainnet-claim-settle.mjs <reqUri> <claimUri> [relayBase]
//
// Honest outcomes only: preflight classify (free eth_call) → permit → transferFrom →
// balance deltas + decoded Transfer log. A REVERTED leg is reported and exits 2 — the
// caller ledgers the burned gas; never a silent retry (float rule).
import {execFileSync} from 'node:child_process';
import {
  rpc, ethCall, decodeUint256, signEip1559, sendRawRpc,
  encodePermit, encodeTransferFrom, encodeErc20BalanceOf, encodeErc20Nonces,
  decodeTransferLog, TRANSFER_TOPIC, deriveSlip10Secp256k1Node, eip55, evmAddressOf,
} from '../e2e/harness/evm/evm-core.mjs';
import {decodeEvmReq, decodeEvmPay} from '../e2e/harness/evm/qr.mjs';

const ZCHF_ETH = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const CHAIN_ID = 1n;
const TIP_GWEI = 500_000_000n; // 0.5 gwei priority
const RAIL = '0x18884BC8e867eEf401703b702097220bdAe27668';
const RAIL_B = '0xAa228406823f3816E04709DB4640009E6A0a2B56';
const HARDENED = 0x80000000;
const IDX1 = [44, 60, 0].map((i) => i + HARDENED).concat([0, 1]);

const assert = (ok, msg) => { if (!ok) throw new Error(`claim-settle: ${msg}`); };
const gwei = (w) => `${Number(w) / 1e9} gwei`;

/** B's key from the float seed — inside this process only. */
function railBKey() {
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  assert(/^[0-9a-f]{64}$/i.test(seed), 'agent-key seed did not return 64 hex chars — refusing');
  const leaf = deriveSlip10Secp256k1Node(Buffer.from(seed, 'hex'), IDX1);
  const privateKeyHex = leaf.privateKey.toString('hex');
  seed.replace(/./g, '0');
  const address = eip55(evmAddressOf(privateKeyHex));
  assert(address.toLowerCase() === RAIL_B.toLowerCase(), `derived B ${address} != the registered rail B — refusing`);
  return {privateKeyHex, address};
}

let pipe = null;
try {
  const [reqUri, claimUri] = process.argv.slice(2);
  assert(reqUri && claimUri, 'usage: evm-mainnet-claim-settle.mjs <reqUri> <claimUri> [relayBase]');
  const relayBase = (process.argv[4] ?? 'http://127.0.0.1:8899').replace(/\/+$/, '');
  pipe = `${relayBase}/api/v1/evm/rpc`;
  const req = decodeEvmReq(reqUri);
  const claim = decodeEvmPay(claimUri);
  assert(req.rid === claim.rid && req.exp === claim.deadline, 'claim does not bind to the request (rid/deadline)');
  assert(req.to.toLowerCase() === RAIL_B.toLowerCase(), 'request beneficiary is not rail B');
  assert(req.chainId === 1, 'request chain is not mainnet');
  assert(claim.owner.toLowerCase() === RAIL.toLowerCase(), 'claim owner is not the rail');
  const amt = BigInt(req.amt);
  const nowSecs = Math.floor(Date.now() / 1000);
  assert(nowSecs <= req.exp, `request expired at unix ${req.exp} — a fresh QR is needed, no settle`);

  assert(BigInt(await rpc(pipe, 'eth_chainId', [], {timeoutMs: 20_000})) === CHAIN_ID, 'pipe is not chain 1');
  const b = railBKey();
  const zchfBefore = BigInt(await ethCall(pipe, ZCHF_ETH, encodeErc20BalanceOf(RAIL), {timeoutMs: 20_000}));
  const bZchfBefore = BigInt(await ethCall(pipe, ZCHF_ETH, encodeErc20BalanceOf(RAIL_B), {timeoutMs: 20_000}));
  const bEth = BigInt(await rpc(pipe, 'eth_getBalance', [RAIL_B, 'latest'], {timeoutMs: 20_000}));
  const head = await rpc(pipe, 'eth_getBlockByNumber', ['latest', false], {timeoutMs: 20_000});
  const baseFee = BigInt(head.baseFeePerGas);
  const maxFeePerGas = baseFee * 4n + TIP_GWEI;
  console.log(`[settle] rid ${req.rid} · ${Number(amt) / 1e18} ZCHF rail→B · B gas ${Number(bEth) / 1e18} ETH · base ${gwei(baseFee)}`);

  // split the 65-byte signature r||s||v
  const sigHex = claim.sig.replace(/^0x/, '');
  assert(sigHex.length === 130, 'claim sig is not 130 hex chars');
  const r = '0x' + sigHex.slice(0, 64);
  const s = '0x' + sigHex.slice(64, 128);
  const v = parseInt(sigHex.slice(128, 130), 16);
  assert(v === 27 || v === 28, `permit v ${v} is not 27/28`);
  const nonce = decodeUint256(await ethCall(pipe, ZCHF_ETH, encodeErc20Nonces(RAIL), {timeoutMs: 20_000}));
  console.log(`[settle] on-chain permit nonce: ${nonce}`);

  // one signed tx to the token, gas paid by B
  const settleLeg = async (data, label, gasLimit, attempts = 3) => {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const txNonce = BigInt(await rpc(pipe, 'eth_getTransactionCount', [RAIL_B, 'pending'], {timeoutMs: 20_000}));
        const {rawTx, txHash} = signEip1559({
          privHex: b.privateKeyHex, chainId: CHAIN_ID, nonce: txNonce,
          maxFeePerGas, maxPriorityFeePerGas: TIP_GWEI, gasLimit, to: ZCHF_ETH, value: 0n, data,
        });
        const t0 = Date.now();
        await sendRawRpc(pipe, rawTx, {timeoutMs: 30_000});
        for (;;) {
          const rec = await rpc(pipe, 'eth_getTransactionReceipt', [txHash], {timeoutMs: 20_000}).catch(() => null);
          if (rec != null) {
            const status = BigInt(rec.status);
            console.log(`[settle] ${label}: ${status === 1n ? 'ok' : 'REVERTED'} tx ${txHash} · gas ${rec.gasUsed} · ${Date.now() - t0}ms`);
            return {hash: txHash, status, gasUsed: BigInt(rec.gasUsed), effectiveGasPrice: BigInt(rec.effectiveGasPrice ?? maxFeePerGas), blockNumber: rec.blockNumber};
          }
          if (Date.now() - t0 > 180_000) throw new Error(`${label} receipt for ${txHash} never landed in 180s — record as unknown, DO NOT re-broadcast`);
          await new Promise((res) => setTimeout(res, 2_000));
        }
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('REVERTED') || msg.includes('never landed')) throw e; // a chain VERDICT or an unknown — no retry
        await new Promise((res) => setTimeout(res, 1_500)); // transport-shaped — bounded retry
      }
    }
    throw lastErr;
  };

  // PREFLIGHT (free): the permit eth_call classifies the claim before any gas is spent.
  const permitData = encodePermit(RAIL, req.to, amt, BigInt(claim.deadline), v, r, s);
  try {
    await ethCall(pipe, ZCHF_ETH, permitData, {timeoutMs: 30_000});
    console.log('[settle] permit preflight: accepted');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[settle] permit PREFLIGHT refused — no gas spent: ${msg}`);
    console.error('  (INVALID_SIGNER/nonce class = the payer signed a stale cached nonce → the honest');
    console.error('   needs-resign state; PERMIT_DEADLINE_EXPIRED = the window closed before settle)');
    process.exit(3);
  }
  const gasGateNeed = 2n * 120_000n * maxFeePerGas;
  assert(bEth >= gasGateNeed, `B gas ${bEth} < the settle gate ${gasGateNeed} (2 txs worst-case) — drip B first`);

  const permit = await settleLeg(permitData, 'permit', 120_000n);
  if (permit.status !== 1n) {
    console.error(JSON.stringify({stage: 'permit', tx: permit.hash, status: 'REVERTED', gasBurnedWei: (permit.gasUsed * permit.effectiveGasPrice).toString()}, null, 2));
    process.exit(2);
  }
  const tf = await settleLeg(encodeTransferFrom(RAIL, req.to, amt), 'transferFrom', 120_000n);
  if (tf.status !== 1n) {
    console.error(JSON.stringify({stage: 'transferFrom', tx: tf.hash, status: 'REVERTED', gasBurnedWei: (tf.gasUsed * tf.effectiveGasPrice).toString()}, null, 2));
    process.exit(2);
  }

  // verify: ZCHF moved rail→B exactly once, the permit nonce consumed. History-AWARE reads:
  // public frontends (publicnode) serve load-balanced nodes that lag the head by a block or two —
  // both settle runs' single-shot reads read PRE-transfer balances. Poll until the chain's own
  // arithmetic appears (bounded), never a one-shot verdict.
  const readState = async () => ({
    rail: BigInt(await ethCall(pipe, ZCHF_ETH, encodeErc20BalanceOf(RAIL), {timeoutMs: 20_000})),
    b: BigInt(await ethCall(pipe, ZCHF_ETH, encodeErc20BalanceOf(RAIL_B), {timeoutMs: 20_000})),
    nonce: decodeUint256(await ethCall(pipe, ZCHF_ETH, encodeErc20Nonces(RAIL), {timeoutMs: 20_000})),
  });
  let zchfAfter = 0n, bZchfAfter = 0n, nonceAfter = 0n, verified = false;
  for (let i = 0; i < 15 && !verified; i++) {
    ({rail: zchfAfter, b: bZchfAfter, nonce: nonceAfter} = await readState());
    verified = (zchfBefore - zchfAfter === amt) && (bZchfAfter - bZchfBefore === amt) && nonceAfter === nonce + 1n;
    if (!verified) await new Promise((res) => setTimeout(res, 3_000));
  }
  const logs = await rpc(pipe, 'eth_getLogs', [{
    fromBlock: tf.blockNumber, toBlock: 'latest',
    address: ZCHF_ETH, topics: [TRANSFER_TOPIC],
  }], {timeoutMs: 30_000}).catch(() => []);
  const moved = logs.map(decodeTransferLog).filter((d) => d != null
    && d.from.toLowerCase() === RAIL.toLowerCase() && d.to.toLowerCase() === RAIL_B.toLowerCase() && d.value === amt);
  console.log('\n[settle] PASS — record block:');
  console.log(JSON.stringify({
    chain: 'ethereum', rid: req.rid, rail: RAIL, railB: RAIL_B,
    amountRaw: amt.toString(),
    zchfRailDelta: (zchfBefore - zchfAfter).toString(),
    zchfBDelta: (bZchfAfter - bZchfBefore).toString(),
    permitNonceConsumed: nonceAfter === nonce + 1n,
    transferLogs: moved.map((d) => ({from: d.from, to: d.to, value: d.value.toString()})),
    permitTx: permit.hash, transferTx: tf.hash,
    gasBurnedWei: ((permit.gasUsed * permit.effectiveGasPrice) + (tf.gasUsed * tf.effectiveGasPrice)).toString(),
  }, null, 2));
  assert(verified, `balance deltas never appeared within the read window (rail ${zchfAfter}, B ${bZchfAfter}, nonce ${nonceAfter}) — the legs above carry the tx hashes; verify by those, never assume`);
  process.exitCode = 0;
} catch (e) {
  console.error(`[settle] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
