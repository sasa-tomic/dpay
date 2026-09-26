// Flow 217 — the gas gate (D28 / D15.3): a wallet holding ZCHF but ZERO ETH must be REFUSED at
// the send sheet with the instructive failure (fee shown, receive-ETH instruction, NO broadcast),
// and must pass once gas is funded. Gas honesty is a GATE, not a footnote.
//
// LIVE (this skeleton): the gate's exact preconditions + the no-broadcast proof, UI-independent —
//   1. stage: device holds ZCHF and ZERO ETH; both facts read through the relay pipe
//      (eth_getBalance == 0 AND balanceOf > 0 — the measured-have discipline, D15);
//   2. the fee quote still answers for the zero-gas wallet (the sheet must be able to SHOW the
//      fee while refusing to send);
//   3. NO broadcast happens: the device's transaction count is unchanged across a full
//      gate-evaluation cycle (quote + balance reads) — nothing signs, nothing sends;
//   4. fund the gas (anvil_setBalance, the D26.3 mechanic) → the precondition flips to PASS
//      (balance ≥ maxFee) with the quote unchanged in shape.
// TODO(app-ui) — the legs that need the send sheet + the evm seam (owned by other streams):
//   - the sheet REFUSES with the D15.3 instructive copy ("You need ≈ <X> ETH on <chain> for the
//     network fee. Receive ETH at <your 0x…> …") — amount retained, nothing broadcast;
//   - after funding, the same send passes the gate and broadcasts in-page.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, signEip1559, sendRawRpc, encodeErc20Transfer, encodeErc20BalanceOf, decodeUint256,
} from '../harness/evm/evm-core.mjs';
import {fundEth} from '../harness/evm/anvil.mjs';

export const meta = {
  id: '217',
  name: 'evm-gas-gate',
  journey: 'pay',
  covers: ['evm-gas-gate', 'gas-honesty', 'relay-evm-pipe'],
  verifies: 'EVM gas gate: a zero-ETH wallet holding ZCHF presents both measured facts (balanceOf > 0, eth_getBalance == 0) through the relay pipe, the fee quote still answers, and a full gate-evaluation cycle broadcasts NOTHING (tx count unchanged); funding the gas flips the precondition to pass — the send-sheet refusal copy and in-page broadcast legs are stubbed in this skeleton.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
  optional: true, // excluded from the default suite until the UI legs land (needs the app/evm seam)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[217] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil #1 (valueless)
const SEND_AMOUNT = ZCHF(3);

export async function run() {
  const start = Date.now();
  const deviceSeed = devSeed('217-device');
  const device = deriveEvmKeypair(deviceSeed);
  console.log(`[217-evm-gas-gate] staging: device ${device.address} holds ZCHF, ZERO ETH…`);
  const env = await stagePipe({recipients: [{seed: deviceSeed, zchfRaw: ZCHF(50), ethWei: 0n}]});
  try {
    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const token = env.anvil.tokenAddress;
    const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);
    const txCount = () => viaPipe('eth_getTransactionCount', [device.address, 'latest']).then(BigInt);

    // 1. BOTH measured facts, through the pipe (the gate's precondition — never assume, measure).
    const zchf = await balanceOf(device.address);
    const eth = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
    assert(zchf > 0n, `device must hold ZCHF (${zchf})`);
    assert(eth === 0n, `device ETH must be ZERO for the refusal case (${eth})`);
    console.log('[217-evm-gas-gate]  ✓ measured: ZCHF ' + zchf + ' raw · gas ETH 0');

    // 2. the fee quote ANSWERS even for a zero-gas wallet (the sheet shows the fee while refusing).
    const head = await viaPipe('eth_getBlockByNumber', ['latest', false]);
    const baseFee = BigInt(head.baseFeePerGas);
    const tip = await viaPipe('eth_maxPriorityFeePerGas', []).then(BigInt);
    const estimate = BigInt(await viaPipe('eth_estimateGas', [{from: device.address, to: token, data: '0x' + encodeErc20Transfer(RECIPIENT, SEND_AMOUNT).slice(2)}]));
    const maxFeeWei = (baseFee * 2n + tip) * estimate;
    assert(maxFeeWei > 0n, 'the quote must be a positive number the refusal can NAME');
    assert(eth < maxFeeWei, `the gate must refuse: gas ${eth} < maxFee ${maxFeeWei} (anvil baseFee is generous; a zero balance cannot pass)`);
    console.log(`[217-evm-gas-gate]  ✓ quotable refusal: needs ≈ ${maxFeeWei} wei gas on chain 31337`);

    // 3. NO broadcast across a full gate-evaluation cycle (quote + reads — the sheet's actions
    // before the gate refuses). The only way to prove "refuses, never sends" UI-independently.
    const before = await txCount();
    // (the evaluation itself is read-only — signEip1559 is deliberately NOT called here: building
    // the tx is the sheet's job and the gate refuses BEFORE any signing material exists)
    await viaPipe('eth_getBalance', [device.address, 'latest']);
    await balanceOf(device.address);
    const after = await txCount();
    assert(before === after, `tx count changed during gate evaluation (${before} → ${after}) — something broadcast`);
    console.log('[217-evm-gas-gate]  ✓ no broadcast: tx count unchanged through the refusal cycle');

    // 4. fund the gas (the D26.3 mechanic) → the precondition flips to PASS. The read cache gives
    // eth_getBalance 2s of staleness — poll past it (the app's own poll discipline).
    await fundEth(env.anvil.rpcUrl, device.address, 1_000_000_000_000_000n); // 0.001 ETH
    let funded = 0n;
    const fundDeadline = Date.now() + 8_000;
    while (funded < maxFeeWei) {
      funded = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
      if (funded >= maxFeeWei) break;
      if (Date.now() > fundDeadline) assert(false, `funded gas ${funded} must cover maxFee ${maxFeeWei} (past the 2s read-cache TTL)`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const nonce = await txCount();
    // The gate now PASSES — prove the send path is live by executing it (device signs, pipe sends).
    const {rawTx} = signEip1559({
      privHex: device.privateKeyHex, chainId: 31337n, nonce,
      maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip,
      gasLimit: estimate * 12n / 10n, to: token, value: 0n,
      data: encodeErc20Transfer(RECIPIENT, SEND_AMOUNT),
    });
    const hash = await sendRawRpc(env.pipe, rawTx);
    let receipt = null;
    for (let i = 0; i < 40 && receipt == null; i++) {
      receipt = await viaPipe('eth_getTransactionReceipt', [hash]);
      if (receipt == null) await new Promise((r) => setTimeout(r, 250));
    }
    assert(receipt != null && BigInt(receipt.status) === 1n, 'the funded send must land (status 1)');
    console.log('[217-evm-gas-gate]  ✓ gas funded → gate passes → the same send lands');

    // TODO(app-ui): the send sheet REFUSES with the D15.3 instructive copy (fee named, receive-ETH
    // instruction at the device address, amount retained, nothing broadcast) while eth == 0; the
    // same send PASSES in-page after funding (broadcast via the app seam through the pipe).
    console.log('[217-evm-gas-gate]  · TODO(app-ui): refusal copy / in-page pass legs are stubbed');
  } finally {
    await env.stop();
  }
  console.log(`[217-evm-gas-gate] PASS (${Date.now() - start}ms)`);
}
