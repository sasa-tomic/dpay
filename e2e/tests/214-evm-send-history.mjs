// Flow 214 — EVM send + history (D28 / D15/D16): anvil-funded device sends ZCHF THROUGH the
// harness relay's evm proxy, the receipt confirms inclusion, the Transfer log carries the
// history row's raw material, and the balance drops by exactly the amount (+ gas on the ETH leg).
//
// LIVE (this skeleton): the full wire contract the send sheet will exercise, UI-independent —
//   1. staged device (deterministic seed) holds ZCHF + gas ETH on a scratch anvil;
//   2. the fee-quote primitives the sheet calls (baseFee + priority + eth_estimateGas) answer
//      through the relay pipe;
//   3. a raw EIP-1559 transfer built + signed with evm-core is broadcast THROUGH the pipe
//      (eth_sendRawTransaction), confirms by receipt, drops the sender's ZCHF by exactly the
//      amount and its ETH by ≥ 0 (gas), and pays the recipient exactly;
//   4. the decoded Transfer log (from/to/value) matches — the history row this flow's UI leg
//      will render.
// TODO(app-ui) — the legs that need the send sheet + the evm seam (owned by other streams):
//   - the sheet's fee line renders the estimate ("Fee ≈ …", attribution "estimate");
//   - the gas gate PASSES with the staged ETH, the device signs in-page, broadcast rides the
//     app's sendEvmTx path through the SAME pipe, "Sent · seen on Anvil" renders;
//   - the history row appears via the eth_getLogs poll with assetId evm:31337:ZCHF.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, signEip1559, sendRawRpc, encodeErc20Transfer, encodeErc20BalanceOf,
  decodeUint256, TRANSFER_TOPIC, decodeTransferLog, eip55, evmAddressOf,
} from '../harness/evm/evm-core.mjs';

export const meta = {
  id: '214',
  name: 'evm-send-history',
  journey: 'pay',
  covers: ['evm-send', 'evm-gas-quote', 'evm-receipt', 'evm-transfer-log', 'relay-evm-pipe'],
  verifies: 'EVM send + history: a funded device\'s raw EIP-1559 ZCHF transfer broadcasts THROUGH the harness relay\'s evm proxy, confirms by receipt, moves exactly the amount (gas on the ETH leg), and the decoded Transfer log carries the history row (from/to/value); the send-sheet fee line, gas-gate pass, in-app signature and history-row render are stubbed in this skeleton.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
  optional: true, // excluded from the default suite until the UI legs land (needs the app/evm seam)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[214] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const DEVICE_ZCHF = ZCHF(500);
const SEND_AMOUNT = ZCHF(42);
const DEVICE_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH of gas — comfortable headroom over the quote
const RECIPIENT = eip55(evmAddressOf('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')); // anvil #1

export async function run() {
  const start = Date.now();
  const deviceSeed = devSeed('214-device');
  const device = deriveEvmKeypair(deviceSeed);
  console.log(`[214-evm-send-history] staging: device ${device.address} ← ${DEVICE_ZCHF} raw ZCHF + ${DEVICE_ETH_WEI} wei gas…`);
  const env = await stagePipe({
    recipients: [{seed: deviceSeed, zchfRaw: DEVICE_ZCHF, ethWei: DEVICE_ETH_WEI}],
  });
  try {
    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const token = env.anvil.tokenAddress;
    const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);

    // 1. staged state, read through the pipe.
    const chainId = await viaPipe('eth_chainId', []);
    assert(BigInt(chainId) === 31337n, `chain must be 31337, got ${chainId}`);
    const zchfBefore = await balanceOf(device.address);
    assert(zchfBefore === DEVICE_ZCHF, `device ZCHF ${zchfBefore} != staged ${DEVICE_ZCHF}`);
    const ethBefore = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
    assert(ethBefore === DEVICE_ETH_WEI, `device ETH ${ethBefore} != staged ${DEVICE_ETH_WEI}`);

    // 2. the fee-quote primitives the send sheet consumes (D15.2), through the pipe.
    const head = await viaPipe('eth_getBlockByNumber', ['latest', false]);
    const baseFee = BigInt(head.baseFeePerGas);
    const tip = await viaPipe('eth_maxPriorityFeePerGas', []).then(BigInt);
    const gasData = '0x' + encodeErc20Transfer(RECIPIENT, SEND_AMOUNT).slice(2);
    const estimate = BigInt(await viaPipe('eth_estimateGas', [{from: device.address, to: token, data: gasData}]));
    const maxFeeWei = (baseFee * 2n + tip) * estimate;
    assert(estimate > 0n && maxFeeWei > 0n, 'fee quote must be positive');
    assert(maxFeeWei < ethBefore, 'the staged gas must cover the quote — this is the gate passing');
    console.log(`[214-evm-send-history]  ✓ quote through the pipe: est ${estimate} gas · maxFee ≤ ${maxFeeWei} wei`);

    // 3. build + sign + broadcast THROUGH the pipe (the exact bytes the app's send path produces).
    const nonce = BigInt(await viaPipe('eth_getTransactionCount', [device.address, 'pending']));
    const {rawTx, txHash} = signEip1559({
      privHex: device.privateKeyHex, chainId: 31337n, nonce,
      maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip,
      gasLimit: estimate * 12n / 10n, to: token, value: 0n,
      data: encodeErc20Transfer(RECIPIENT, SEND_AMOUNT),
    });
    // sendRawRpc tolerates the once-observed spurious anvil decode failure by resending the
    // IDENTICAL bytes (dedup-safe); the receipt poll then works either way.
    const sentHash = await sendRawRpc(env.pipe, rawTx);
    assert(sentHash.toLowerCase() === txHash.toLowerCase(), `node hash ${sentHash} != locally computed ${txHash}`);
    let receipt = null;
    for (let i = 0; i < 40 && receipt == null; i++) {
      receipt = await viaPipe('eth_getTransactionReceipt', [sentHash]);
      if (receipt == null) await new Promise((r) => setTimeout(r, 250));
    }
    assert(receipt != null, 'receipt never landed within 10s');
    assert(BigInt(receipt.status) === 1n, `send reverted (receipt status ${receipt.status})`);
    console.log(`[214-evm-send-history]  ✓ sent through the pipe: ${sentHash} (block ${BigInt(receipt.blockNumber)})`);

    // 4. balances: ZCHF moves by exactly the amount; ETH drops (gas); poll past the 2s read TTL.
    const deadline = Date.now() + 8_000;
    for (;;) {
      const zchfAfter = await balanceOf(device.address);
      const paid = await balanceOf(RECIPIENT);
      if (zchfAfter === DEVICE_ZCHF - SEND_AMOUNT && paid === SEND_AMOUNT) break;
      if (Date.now() > deadline) {
        assert(zchfAfter === DEVICE_ZCHF - SEND_AMOUNT, `device ZCHF ${zchfAfter} != ${DEVICE_ZCHF - SEND_AMOUNT}`);
        assert(paid === SEND_AMOUNT, `recipient ZCHF ${paid} != ${SEND_AMOUNT}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const ethAfter = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
    assert(ethAfter < ethBefore, `device ETH must drop by gas (${ethBefore} → ${ethAfter})`);
    console.log('[214-evm-send-history]  ✓ balances: ZCHF -42.00 exact, ETH dropped by gas');

    // 5. the history row's raw material: the Transfer log, decoded.
    const logs = await viaPipe('eth_getLogs', [{
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
      address: token, topics: [TRANSFER_TOPIC],
    }]);
    const row = logs.map(decodeTransferLog).find((d) => d != null && d.from.toLowerCase() === device.address.toLowerCase());
    assert(row != null, 'no outgoing Transfer log in the tx block');
    assert(row.to.toLowerCase() === RECIPIENT.toLowerCase() && row.value === SEND_AMOUNT, 'decoded Transfer (from/to/value) must match the send');
    console.log(`[214-evm-send-history]  ✓ history material: Transfer(${row.from.slice(0, 10)}… → ${row.to.slice(0, 10)}…, ${row.value})`);

    // TODO(app-ui): the send sheet legs — fee line render, gas-gate pass, in-app signature,
    // "Sent · seen on Anvil" state, and the history row (assetId evm:31337:ZCHF) via the
    // eth_getLogs poll. The wire contract above is exactly what those legs drive.
    console.log('[214-evm-send-history]  · TODO(app-ui): send-sheet / receipt-state / history-row legs are stubbed');
  } finally {
    await env.stop();
  }
  console.log(`[214-evm-send-history] PASS (${Date.now() - start}ms)`);
}
