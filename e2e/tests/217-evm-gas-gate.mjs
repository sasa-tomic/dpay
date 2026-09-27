// Flow 217 — the gas gate (D28 / D15.3) through the REAL app: a wallet holding ZCHF but ZERO
// ETH is REFUSED at the send sheet with the instructive failure (fee named, the payer's own 0x
// address — with its QR — to receive gas at, amount retained, NO broadcast), and the SAME send
// passes in-page once the gas is funded. Gas honesty is a GATE, not a footnote.
//
// LIVE:
//   1. stage: the onboarded device holds 50 ZCHF and ZERO ETH; both facts read through the relay
//      pipe (the measured-have discipline, D15);
//   2. the send sheet still quotes the fee for the zero-gas wallet (the sheet SHOWS the fee while
//      refusing to send);
//   3. confirm → the gas honesty gate refuses BEFORE any signing material exists: the gate
//      surface renders the instructive copy + the payer's own address, and the device's
//      transaction count is UNCHANGED (nothing broadcast);
//   4. fund the gas (anvil_setBalance) → "Funded? Try again" re-runs the SAME send in-page → it
//      passes the gate, broadcasts through the pipe, and confirms.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, eip55, evmAddressOf, encodeErc20BalanceOf, decodeUint256,
} from '../harness/evm/evm-core.mjs';
import {ANVIL_ACCOUNT_0_PRIV, fundEth, transferToken} from '../harness/evm/anvil.mjs';
import {
  setup, onboardWallet, accountOf, selectEvmAsset, waitForEnabled,
} from '../harness/lib.mjs';

export const meta = {
  id: '217',
  name: 'evm-gas-gate',
  journey: 'pay',
  covers: ['evm-gas-gate', 'gas-honesty', 'relay-evm-pipe'],
  verifies: 'EVM gas gate through the real app: a zero-ETH wallet holding ZCHF still gets the chain\'s own fee quote, the send sheet REFUSES with the instructive D15.3 gate (fee named, the payer\'s own 0x address + QR to receive gas at, nothing broadcast — tx count unchanged), and after the gas is funded the same send passes in-page and lands through the relay pipe.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[217] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil #1 (valueless)
const SEND_AMOUNT = ZCHF(3);

export async function run() {
  const start = Date.now();
  console.log('[217-evm-gas-gate] staging the relay pipe + anvil, booting the app…');
  const env = await stagePipe({recipients: []});
  const app = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
  const {driver} = app;
  try {
    await onboardWallet(driver, 'evm-217');
    const id = await accountOf(driver);
    const device = deriveEvmKeypair(id.secretHex);
    // ZCHF only — ZERO gas. The refusal case, measured (never assumed).
    await transferToken(env.anvil.rpcUrl, env.anvil.tokenAddress, ANVIL_ACCOUNT_0_PRIV, device.address, ZCHF(50));
    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const token = env.anvil.tokenAddress;
    const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);
    const txCount = () => viaPipe('eth_getTransactionCount', [device.address, 'latest']).then(BigInt);

    const eth = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
    assert(eth === 0n, `device ETH must be ZERO for the refusal case (${eth})`);
    console.log('[217-evm-gas-gate]  ✓ measured: ZCHF funded · gas ETH 0');

    // The send sheet: destination + amount, review up, confirm enabled (the token balance is known).
    await selectEvmAsset(driver, 'evm-zchf-anvil');
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.type('evm-send-address-input', RECIPIENT, {timeoutMs: 5_000});
    await driver.type('evm-send-amount-input', '3', {timeoutMs: 5_000});
    await driver.findByTestID('evm-send-review', {timeoutMs: 8_000});
    await waitForEnabled(driver, 'btn-evm-send-confirm', {timeoutMs: 30_000});

    // The fee line answers even for a zero-gas wallet (the sheet shows the fee while refusing).
    const feeDeadline = Date.now() + 15_000;
    for (;;) {
      const fee = await driver.eval(() => document.querySelector('[data-testid="evm-send-review-fee"]')?.textContent?.trim() ?? '');
      if (/≈ .+\(estimate\)/.test(fee)) { console.log(`[217-evm-gas-gate]  ✓ quotable refusal: fee line "${fee}"`); break; }
      if (Date.now() > feeDeadline) throw new Error(`fee line never rendered, got "${fee}"`);
      await new Promise((r) => setTimeout(r, 250));
    }

    // CONFIRM → the gate refuses BEFORE anything is signed or broadcast.
    const before = await txCount();
    await driver.click('btn-evm-send-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('evm-send-gasgate', {timeoutMs: 30_000});
    const gateBody = (await (await driver.findByTestID('evm-send-gasgate-body')).evaluate((n) => (n.textContent ?? '').trim()));
    assert(/network fee/.test(gateBody) && /ETH/.test(gateBody), `the gate copy must name the fee + the gas coin, got "${gateBody}"`);
    const gateAddr = (await (await driver.findByTestID('evm-send-gasgate-addr')).evaluate((n) => (n.textContent ?? '').trim()));
    assert(gateAddr.toLowerCase() === device.address.toLowerCase(), `the gate must name the payer's own address, got "${gateAddr}"`);
    assert(!(await driver.isPresent('evm-send-hash')), 'nothing may broadcast past the gate');
    const after = await txCount();
    assert(before === after, `tx count changed during the refusal (${before} → ${after}) — something broadcast`);
    console.log('[217-evm-gas-gate]  ✓ refused with the instructive gate · tx count unchanged (nothing broadcast)');

    // The amount is RETAINED: the gate's back returns to the form with the same review.
    await driver.click('btn-evm-send-gasgate-back', {timeoutMs: 5_000});
    const retained = await driver.eval(() => document.querySelector('[data-testid="evm-send-amount-input"]')?.value ?? '');
    assert(retained === '3', `the amount must survive the refusal, got "${retained}"`);

    // Fund the gas → the SAME send passes the gate and lands in-page. The relay caches reads
    // for 2s: poll past the TTL or the sheet's gate would re-read the STALE zero.
    await fundEth(env.anvil.rpcUrl, device.address, 1_000_000_000_000_000n); // 0.001 ETH
    const fundDeadline = Date.now() + 15_000;
    for (;;) {
      const funded = decodeUint256(await viaPipe('eth_getBalance', [device.address, 'latest']));
      if (funded > 0n) break;
      if (Date.now() > fundDeadline) throw new Error('funded gas never landed on anvil');
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 3_000)); // outlive the 2s read-cache TTL
    await driver.click('btn-evm-send-confirm', {timeoutMs: 5_000});
    try {
      await driver.findByTestID('evm-send-hash', {timeoutMs: 45_000});
    } catch (e) {
      const money = driver.consoleLog.filter(x => /money: evm/.test(x.text)).map(x => x.text.slice(0, 200));
      const bodyNow = await driver.eval(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 400));
      throw new Error(`the funded send never reached the terminal (body: ${bodyNow}; console: ${money.slice(-4).join(' || ')})`);
    }
    const body = await driver.bodyText();
    assert(/Sent · seen on /.test(body), 'the funded send should confirm with "Sent · seen on <chain>"');
    const paid = await balanceOf(RECIPIENT);
    assert(paid === SEND_AMOUNT, `recipient ${paid} != ${SEND_AMOUNT} — the funded send must land exactly`);
    console.log('[217-evm-gas-gate]  ✓ gas funded → the same send passes the gate → "Sent · seen on", 3.00 ZCHF delivered');
  } finally {
    await app.stop();
    await env.stop();
  }
  console.log(`[217-evm-gas-gate] PASS (${Date.now() - start}ms)`);
}
