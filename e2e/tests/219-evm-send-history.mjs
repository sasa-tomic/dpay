// Flow 219 — EVM send + history (D28 / D15/D16) through the REAL app: anvil-funded device sends
// ZCHF from the send sheet THROUGH the harness relay's evm proxy, the receipt confirms
// inclusion ("Sent · seen on <chain>"), the balance drops by exactly the amount (+ gas on the
// ETH leg), and the eth_getLogs poll renders the history row.
//
// LIVE:
//   1. the app boots on its own onboarded identity; the DERIVED device address is funded
//      through the harness ladder (500 ZCHF + 0.001 ETH gas);
//   2. the send sheet quotes the fee from the chain's own arithmetic BEFORE the amount commits
//      ("Fee ≈ … (estimate)"), the gas gate passes with the staged ETH, and the device signs
//      in-page; the broadcast rides the app's sendErc20 through the SAME pipe;
//   3. the terminal shows the honest inclusion state and the tx hash;
//   4. the Transactions tab renders the outgoing row (amount + counterparty) from the
//      eth_getLogs Transfer walk — the UI half of the D16 history poll.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, eip55, evmAddressOf, encodeErc20BalanceOf, decodeUint256,
} from '../harness/evm/evm-core.mjs';
import {ANVIL_ACCOUNT_0_PRIV, fundEth, transferToken} from '../harness/evm/anvil.mjs';
import {
  setup, onboardWallet, accountOf, selectEvmAsset, waitForEnabled,
} from '../harness/lib.mjs';

export const meta = {
  id: '219',
  name: 'evm-send-history',
  journey: 'pay',
  covers: ['evm-send', 'evm-gas-quote', 'evm-receipt', 'evm-transfer-log', 'relay-evm-pipe'],
  verifies: 'EVM send + history through the real app: the send sheet quotes the chain\'s own fee before the amount commits, the gas gate passes on staged ETH, the device signs in-page and broadcasts THROUGH the harness relay\'s evm proxy, the terminal shows the honest inclusion state with the tx hash, the ZCHF balance drops by exactly the amount (gas on the ETH leg), and the eth_getLogs poll renders the history row.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[219] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const DEVICE_ZCHF = ZCHF(500);
const SEND_AMOUNT = ZCHF(42);
const DEVICE_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH of gas — comfortable headroom over the quote
const RECIPIENT = eip55(evmAddressOf('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')); // anvil #1

export async function run() {
  const start = Date.now();
  console.log('[219-evm-send-history] staging the relay pipe + anvil, booting the app…');
  const env = await stagePipe({recipients: []});
  const app = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
  const {driver} = app;
  try {
    await onboardWallet(driver, 'evm-219');
    const id = await accountOf(driver);
    const device = deriveEvmKeypair(id.secretHex);
    console.log(`[219-evm-send-history] device ${device.address} ← ${DEVICE_ZCHF} raw ZCHF + ${DEVICE_ETH_WEI} wei gas`);
    await fundEth(env.anvil.rpcUrl, device.address, DEVICE_ETH_WEI);
    await transferToken(env.anvil.rpcUrl, env.anvil.tokenAddress, ANVIL_ACCOUNT_0_PRIV, device.address, DEVICE_ZCHF);

    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const token = env.anvil.tokenAddress;
    const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);

    // 1. staged state, read through the pipe (the poll cache gives reads 2s of staleness).
    const deadline0 = Date.now() + 15_000;
    for (;;) {
      const z = await balanceOf(device.address);
      const e = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
      if (z === DEVICE_ZCHF && e === DEVICE_ETH_WEI) break;
      if (Date.now() > deadline0) throw new Error(`staged state never landed: ZCHF ${z} ETH ${e}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const ethBefore = DEVICE_ETH_WEI;
    console.log('[219-evm-send-history]  ✓ staged: device funded through the harness ladder');

    // 2. the SEND SHEET: destination + amount, fee quote rendered BEFORE the amount commits.
    await selectEvmAsset(driver, 'evm-zchf-anvil');
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.findByTestID('evm-send-amount-input', {timeoutMs: 5_000});
    await driver.type('evm-send-address-input', RECIPIENT, {timeoutMs: 5_000});
    await driver.type('evm-send-amount-input', '42', {timeoutMs: 5_000});
    await driver.findByTestID('evm-send-review', {timeoutMs: 8_000});
    // The gas gate PASSES (staged ETH) and the fee line renders the chain's own estimate —
    // wait out the debounce + the quote round trip.
    const feeDeadline = Date.now() + 15_000;
    for (;;) {
      const fee = await driver.eval(() => {
        const el = document.querySelector('[data-testid="evm-send-review-fee"]');
        return el ? el.textContent.trim() : '';
      });
      if (/≈ .+\(estimate\)/.test(fee)) { console.log(`[219-evm-send-history]  ✓ fee line: ${fee}`); break; }
      if (Date.now() > feeDeadline) throw new Error(`fee line never rendered an estimate, got "${fee}"`);
      await new Promise((r) => setTimeout(r, 250));
    }

    // The confirm enables when the destination resolves, the raw amount parses (uint256 width —
    // 42 ZCHF at 18 decimals), and the balance poll has answered at least once (the stale-ok
    // gate: a KNOWN figure gates only a real over-spend). Wait out the first EVM poll.
    await driver.waitForTestID?.('evm-send-review', {timeoutMs: 8_000});
    await waitForEnabled(driver, 'btn-evm-send-confirm', {timeoutMs: 30_000});
    await driver.click('btn-evm-send-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('evm-send-hash', {timeoutMs: 30_000});
    const body = await driver.bodyText();
    assert(/Sent · seen on /.test(body), `the terminal should read "Sent · seen on <chain>", got: "${body.slice(0, 160)}"`);
    const hash = await driver.eval(() => document.querySelector('[data-testid="evm-send-hash"]')?.textContent?.trim());
    assert(typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash), `the terminal must carry the tx hash, got ${hash}`);
    console.log(`[219-evm-send-history]  ✓ sent through the pipe: ${hash} ("Sent · seen on")`);

    // 4. balances: ZCHF moves by exactly the amount; ETH drops (gas).
    const deadline = Date.now() + 15_000;
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
    console.log('[219-evm-send-history]  ✓ balances: ZCHF -42.00 exact, ETH dropped by gas');

    // 5. the history row (the eth_getLogs poll → the Transactions tab): the outgoing 42 ZCHF
    //    transfer with the recipient as counterparty.
    await driver.click('tab-transactions', {timeoutMs: 5_000});
    const histDeadline = Date.now() + 30_000;
    for (;;) {
      const txt = await driver.bodyText();
      if (/42\.00\s*ZCHF/.test(txt) && txt.includes('0x709979')) {
        console.log('[219-evm-send-history]  ✓ history row rendered from the Transfer log poll');
        break;
      }
      if (Date.now() > histDeadline) throw new Error(`history row never rendered (looking for "42.00 ZCHF" + 0x709979), got: ${txt.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await app.stop();
    await env.stop();
  }
  console.log(`[219-evm-send-history] PASS (${Date.now() - start}ms)`);
}
