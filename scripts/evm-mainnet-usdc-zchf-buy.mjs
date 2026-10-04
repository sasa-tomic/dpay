#!/usr/bin/env node
// evm-mainnet-usdc-zchf-buy.mjs — the D31 funding leg: the EVM rail address buys ZCHF with the
// freshly CCTP-bridged USDC on Ethereum mainnet, through Uniswap V3 SwapRouter02 via the relay's
// production EVM pipe. Twin of evm-mainnet-zchf-buy.mjs (which buys with native ETH); this one
// pulls USDC directly. There is NO USDC/ZCHF pool, so it trades the V3 WETH hub as ONE
// exactOutput call over the REVERSED multihop path (ZCHF <- WETH <- USDC): the WETH hop stays
// pool-side, and SwapRouter02's per-leg payer (transferFrom msg.sender — the multicall
// delegatecall lesson) can never strand a mid-route token in the wallet. 2 rail txs: approve +
// swap. FAILS CLOSED before signing on any gate; a reverted buy is ledged, never retried blind.
import {execFileSync} from 'node:child_process';
import {
  rpc, ethCall, decodeUint256, signEip1559, sendRawRpc, deriveEvmKeypair, eip55,
  selector, addressWord, word32BE,
} from '../e2e/harness/evm/evm-core.mjs';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ZCHF = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'; // real ZCHF (catalog pin, 18 dec)
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // SwapRouter02 (Ethereum)
const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const FEE_USDC_WETH = 500;   // 0.05% USDC/WETH (deep)
const FEE_WETH_ZCHF = 3000;  // 0.3% ZCHF/WETH (pool 0x79dc…f083)
const TIP_GWEI = 10_000_000n; // 0.01 gwei priority — dust budget

const pipe = 'https://dpay.kalaj.org/api/v1/evm/rpc';
const w = (n) => word32BE(n).toString('hex');
const aw = (a) => addressWord(a).toString('hex');
const assert = (ok, msg) => { if (!ok) throw new Error(`usdc-zchf-buy: ${msg}`); };
const f3 = (t) => Buffer.from(t.slice(2), 'hex');
const feeB = (f) => Buffer.from([(f >> 16) & 0xff, (f >> 8) & 0xff, f & 0xff]);
// exactOutput paths run REVERSED: output token first, input token last
const pathOut = Buffer.concat([f3(ZCHF), feeB(FEE_WETH_ZCHF), f3(WETH), feeB(FEE_USDC_WETH), f3(USDC)]);

function railKey() {
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  assert(/^[0-9a-f]{64}$/i.test(seed), 'agent-key seed did not return 64 hex chars — refusing');
  const kp = deriveEvmKeypair(seed);
  seed.replace(/./g, '0');
  return kp;
}
const balOf = (token) => ethCall(pipe, token, '0x70a08231' + aw(RAIL), {timeoutMs: 20_000});

const arg = process.argv[2] ?? 'all';
const GO = process.argv.includes('--go');
const RESUME = arg === 'resume'; // leg2-only continuation after a leg1 crash (WETH already held)
const rail = railKey();
const RAIL = eip55(rail.address);
console.log(`[buy] rail ${RAIL} (GO=${GO})`);

assert(BigInt(await rpc(pipe, 'eth_chainId', [], {timeoutMs: 20_000})) === 1n, 'pipe is not Ethereum mainnet');
const usdcBal = BigInt(await balOf(USDC));
const zchfBal = BigInt(await balOf(ZCHF));
const ethWei = BigInt(await rpc(pipe, 'eth_getBalance', [RAIL, 'latest'], {timeoutMs: 20_000}));
console.log(`[buy] USDC ${Number(usdcBal) / 1e6} · ZCHF ${Number(zchfBal) / 1e18} · ETH ${Number(ethWei) / 1e18}`);
const wethHeld = BigInt(await balOf(WETH));
const amountInMax = RESUME ? 0n : (arg === 'all' ? usdcBal : BigInt(Math.round(Number(arg) * 1e6)));
assert(amountInMax <= usdcBal, `max ${amountInMax} > balance ${usdcBal}`);

// find the ZCHF target: full mode = what the max USDC pays for (exactOutput reversed-path probes);
// resume mode = what the ALREADY-HELD WETH pays for (leg2-only continuation after a leg1 crash)
let zchfTarget;
let requiredIn = 0n;
if (RESUME) {
  assert(wethHeld > 10n ** 15n, `resume: WETH ${wethHeld} too small — run the full buy instead`);
  const qi = '0x' + selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))').replace(/^0x/, '')
    + aw(WETH) + aw(ZCHF) + w(wethHeld) + w(FEE_WETH_ZCHF) + '0'.repeat(64);
  const out = decodeUint256((await ethCall(pipe, QUOTER, qi, {timeoutMs: 30_000})).slice(0, 66));
  zchfTarget = out * 99n / 100n;
  console.log(`[buy] resume: ${Number(wethHeld) / 1e18} WETH -> ${Number(out) / 1e18} ZCHF quoted, target ${Number(zchfTarget) / 1e18}`);
} else {
  const qIn = async (amountOut) => {
    const d = '0x' + selector('quoteExactOutput(bytes,uint256)').replace(/^0x/, '')
      + w(0x40) + w(amountOut) + w(pathOut.length) + pathOut.toString('hex') + '0'.repeat((Math.ceil(pathOut.length / 32) * 32 - pathOut.length) * 2);
    return decodeUint256((await ethCall(pipe, QUOTER, d, {timeoutMs: 30_000})).slice(0, 66));
  };
  zchfTarget = 7_800_000_000_000_000_000n;
  requiredIn = await qIn(zchfTarget);
  if (requiredIn > (amountInMax * 995n) / 1000n) {
    zchfTarget = zchfTarget * (amountInMax * 995n) / requiredIn / 1000n * 1000n / 1000n; // scale down ~proportionally
    requiredIn = await qIn(zchfTarget);
  }
  console.log(`[buy] quote: ${Number(zchfTarget) / 1e18} ZCHF <- ${Number(requiredIn) / 1e6} USDC (max spend ${Number(amountInMax) / 1e6})`);
  assert(requiredIn <= amountInMax, `quote needs ${requiredIn} > max ${amountInMax}`);
}
assert(zchfTarget >= 1_500_000_000_000_000_000n, 'target < 1.5 ZCHF — the CoW floor; refusing');

// swap calldata — TWO exactOutputSingle txs (the D31-proven static 7-tuple; the multihop dynamic
// tuple encoding is avoided entirely): leg1 buys the WETH the leg2 quote needs, leg2 sweeps the
// exact WETH balance into ZCHF (amountInMaximum = balanceOf read post-leg1, so no WETH dust).
const eos = (p) => '0x' + selector('exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))').replace(/^0x/, '')
  + aw(p.tokenIn) + aw(p.tokenOut) + w(p.fee) + aw(p.recipient) + w(p.amountOut) + w(p.amountInMaximum) + '0'.repeat(64);
const WETH_OUT = 3_520_000_000_000_000n; // ~9.49 USDC at the probed price, ~7.79 ZCHF out of leg2
const leg1Data = eos({tokenIn: USDC, tokenOut: WETH, fee: FEE_USDC_WETH, recipient: RAIL, amountOut: WETH_OUT, amountInMaximum: amountInMax});
const leg2DataOf = (wethBal) => eos({tokenIn: WETH, tokenOut: ZCHF, fee: FEE_WETH_ZCHF, recipient: RAIL, amountOut: zchfTarget, amountInMaximum: wethBal});

// gas budget: approve + swap must fit the dust and leave the later legs headroom.
// The allowance decides the approve leg honestly BEFORE the gate: covered = 0, else cold ~60k.
const allowance = BigInt(await ethCall(pipe, USDC, '0xdd62ed3e' + aw(RAIL) + aw(ROUTER), {timeoutMs: 20_000}));
const head = await rpc(pipe, 'eth_getBlockByNumber', ['latest', false], {timeoutMs: 20_000});
const base = BigInt(head.baseFeePerGas);
const effGas = base + TIP_GWEI;
// resume: the WETH approve is measurable NOW (an approve estimate needs no allowance) — use it
let APPROVE_EST = RESUME
  ? await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: WETH, data: '0x095ea7b3' + aw(ROUTER) + w(wethHeld)}, 'latest'], {timeoutMs: 30_000})
      .then((r) => BigInt(r)).catch(() => 50_000n)
  : (allowance >= amountInMax ? 0n : 60_000n);
const LATER_LEGS = RESUME ? 100_000n : 120_000n; // the CoW approve + the app's WETH unwrap, measured ~100k
// when the allowance already covers the swap, its EXACT estimate can gate the budget;
// otherwise fall back to the worst-case shape
const SWAP_EST = RESUME ? 250_000n : 380_000n; // worst-case per mode
let swapEst = SWAP_EST;
if (APPROVE_EST === 0n && !RESUME) {
  swapEst = await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: ROUTER, data: leg1Data}, 'latest'], {timeoutMs: 30_000})
    .then((r) => BigInt(r)).catch(() => SWAP_EST);
  if (swapEst !== SWAP_EST) console.log(`[buy] exact leg1 estimate (allowance present): ${swapEst}`);
}
const need = (APPROVE_EST + swapEst + (RESUME ? 0n : SWAP_EST / 2n) + LATER_LEGS) * effGas; // full mode: leg1 exact + leg2 worst-case
console.log(`[buy] budget: (${APPROVE_EST} approve [allowance ${allowance}] + ${swapEst} swap + 120k later) x ${Number(effGas) / 1e9} gwei = ${Number(need) / 1e18} ETH (have ${Number(ethWei) / 1e18})`);
assert(ethWei > need, `gas budget: need ${need}, have ${ethWei} — shrink or stop`);

if (!GO) { console.log('[buy] DRY RUN (add --go to broadcast)'); process.exit(0); }

let nonceSeq = BigInt(await rpc(pipe, 'eth_getTransactionCount', [RAIL, 'pending'], {timeoutMs: 20_000}));
const maxFeePerGas = base + base / 5n + TIP_GWEI; // ~1.2x base + tip; a low cap just waits for calm gas
async function sendTx(label, gasLimit, to, data) {
  assert(gasLimit * maxFeePerGas <= ethWei - 5_000_000_000_000n, `${label}: gasLimit*maxFee ${gasLimit * maxFeePerGas} would exceed balance ${ethWei}`);
  const {rawTx, txHash} = signEip1559({
    privHex: rail.privateKeyHex, chainId: 1n, nonce: nonceSeq++,
    maxFeePerGas, maxPriorityFeePerGas: TIP_GWEI, gasLimit, to, value: 0n, data,
  });
  const t0 = Date.now();
  await sendRawRpc(pipe, rawTx, {timeoutMs: 30_000});
  for (;;) {
    const rec = await rpc(pipe, 'eth_getTransactionReceipt', [txHash], {timeoutMs: 20_000}).catch(() => null);
    if (rec) {
      const status = BigInt(rec.status);
      console.log(`[buy] ${label}: status ${status} gas ${BigInt(rec.gasUsed)} tx ${txHash} (${Date.now() - t0}ms)`);
      if (status !== 1n) { console.error(`[buy] ${label} REVERTED — ledger the gas, do NOT retry unchanged: ${txHash}`); process.exit(2); }
      return txHash;
    }
    if (Date.now() - t0 > 180_000) throw new Error(`${label}: receipt for ${txHash} never landed in 180s — record as unknown, DO NOT rebroadcast`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// least-authority approve: skip when the allowance already covers the max (rerun-safe)
let approveTx = `allowance already ${allowance}`;
if (allowance < amountInMax) {
  const est = BigInt(await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: USDC, data: '0x095ea7b3' + aw(ROUTER) + w(amountInMax)}, 'latest'], {timeoutMs: 30_000}));
  approveTx = await sendTx('approve', est + 40_000n, USDC, '0x095ea7b3' + aw(ROUTER) + w(amountInMax));
}
// leg1: USDC -> WETH (to self) — SKIPPED in resume mode (the WETH is already held from the crash)
let swapTx1 = 'resume: leg1 already landed (WETH held)';
if (!RESUME) {
  const estLeg1 = BigInt(await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: ROUTER, data: leg1Data}, 'latest'], {timeoutMs: 30_000}));
  swapTx1 = await sendTx('swap-leg1-usdc-weth', estLeg1 + 30_000n, ROUTER, leg1Data);
}
const wethBal = BigInt(await balOf(WETH));
console.log(`[buy] WETH held after leg1: ${Number(wethBal) / 1e18}`);
// leg2 pulls WETH from the rail: WETH needs its own router allowance (USDC's doesn't cover it)
const wethAllowance = BigInt(await ethCall(pipe, WETH, '0xdd62ed3e' + aw(RAIL) + aw(ROUTER), {timeoutMs: 20_000}));
let wethApproveTx = `WETH allowance already ${wethAllowance}`;
if (wethAllowance < wethBal) {
  const estWa = BigInt(await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: WETH, data: '0x095ea7b3' + aw(ROUTER) + w(wethBal)}, 'latest'], {timeoutMs: 30_000}));
  wethApproveTx = await sendTx('approve-weth', estWa + 40_000n, WETH, '0x095ea7b3' + aw(ROUTER) + w(wethBal));
}
const leg2Data = leg2DataOf(wethBal);
const estLeg2 = BigInt(await rpc(pipe, 'eth_estimateGas', [{from: RAIL, to: ROUTER, data: leg2Data}, 'latest'], {timeoutMs: 30_000}));
const swapTx2 = await sendTx('swap-leg2-weth-zchf', estLeg2 + 30_000n, ROUTER, leg2Data);
const wethLeft = BigInt(await balOf(WETH));
const usdcAfter = BigInt(await balOf(USDC));
const zchfAfter = BigInt(await balOf(ZCHF));
console.log('\n[buy] PASS — record:');
console.log(JSON.stringify({
  rail: RAIL, approveTx, swapTx: [swapTx1, wethApproveTx, swapTx2], wethLeft: wethLeft.toString(),
  zchfTarget: zchfTarget.toString(), quotedIn: requiredIn.toString(), amountInMax: amountInMax.toString(),
  usdcLeft: usdcAfter.toString(),
  zchfBefore: zchfBal.toString(), zchfOut: (zchfAfter - zchfBal).toString(),
}, null, 2));
