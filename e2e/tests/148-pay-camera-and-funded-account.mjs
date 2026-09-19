// Flow 148 — the Pay tab stops being a dead end: the camera is not fund-gated, and the money the
// wallet already holds is named (UX swarm 2026-09-08, defects X3 + X1).
//
// The measured state this pins the fix for, reproduced here exactly: a wallet holding ∂100 of
// spendable practice money, with VCHF selected, answered "No VCHF available", showed a request to
// send crypto to a 63-character principal, and rendered NO camera at all — so a payer holding
// precisely the asset a merchant was asking for could not so much as READ the request, and the
// balance they could actually spend was named on no screen anywhere.
//
// Two properties, driven through the REAL app:
//
//   X3 — WHAT GATES THE CAMERA IS NOT FUNDS. The merchant's QR names its own settlement asset and
//        the IC rail pays THAT asset from THAT ledger, so the selected balance cannot decide
//        whether a request is readable. Proven end to end, not structurally: with VCHF selected
//        and zero VCHF, a ∂ DEMO request is scanned and SETTLES. The funding instruction survives
//        as a companion (`pay-fund` + its "Show my VCHF address" primary), it just no longer
//        stands in front of the lens.
//
//   X1 — THE GATE NAMES THE FUNDED ACCOUNT. The practice balance gets its own sentence (both
//        halves: a payment can be rehearsed with it, and it buys nothing from a real merchant) and
//        a one-tap switch that really selects it.
//
// Selector contract: `pay-fund`, `pay-fund-go`, `btn-start-scan`, `scan-cam-box`,
// `fund-sibling-holds`, `btn-fund-sibling-switch`, `active-asset-label`, `pay-amount`.
import {setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency, armPayScan} from '../harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from '../harness/wire.mjs';

const PAY_CENTS = 100; // ∂1.00 out of the faucet's ∂100.00

export const meta = {
  id: '148',
  name: 'pay-camera-and-funded-account',
  journey: 'pay',
  covers: ['fund-gate', 'scan', 'sign', 'settle', 'demo', 'honest-copy', 'zero-funds'],
  verifies: 'A zero balance on the SELECTED asset no longer hides the scanner: with VCHF selected and empty, the Pay tab still opens the camera and a DEMO request scanned there settles — while the fund instruction survives beside it and names the ∂100.00 practice balance, one tap away.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[148-pay-camera-and-funded-account] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    // A fresh wallet: ∂100.00 practice money from the faucet, and nothing else anywhere.
    await onboardWallet(driver, 'e2e-x1x3');

    // Select VCHF — a real asset this wallet holds none of. This IS the founder's reported state.
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-pay', {timeoutMs: 5_000});

    // ---- X1: the instruction survives AND the practice balance is finally named ---------------
    const panel = await driver.readText('pay-fund');
    assertIncludes(panel, 'No VCHF available', 'the fund instruction still states the lack');
    assertIncludes(panel, 'Show my VCHF address', 'and still carries the deposit route (the funnel is not lost)');
    const pointer = await driver.readText('fund-sibling-holds');
    assertIncludes(pointer, '∂100.00', 'the pointer names the practice balance the wallet actually holds');
    assertIncludes(pointer, 'Practise with it', 'and says what it is FOR');
    assertIncludes(pointer, 'cannot pay a real merchant', 'and what it is NOT — never an implied real balance');
    console.log(`[148-pay-camera-and-funded-account] ✓ pointer: ${pointer}`);

    // ---- X3: the camera is reachable, and one press really opens it --------------------------
    assert(await driver.isPresent('btn-start-scan'), 'the scan surface must stay reachable on a zero selected balance');
    await driver.click('btn-start-scan', {timeoutMs: 5_000});
    await driver.findByTestID('scan-cam-box', {timeoutMs: 8_000});
    const panelGone = await driver.isPresent('pay-fund');
    assert(!panelGone, 'once the payer arms the camera, the screen belongs to the lens');
    console.log('[148-pay-camera-and-funded-account] ✓ camera opens on a zero-balance selection');

    // ---- X3, the consequence: a request for an asset the wallet DOES hold settles -------------
    // The whole point of reading before checking. VCHF is still selected and still empty; the
    // request names DEMO, which is what the wallet holds, and the rail pays the REQUEST's asset.
    const bob = await generateKeypair();
    const requestQR = buildRequestQR(
      bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Cafe',
    );
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', {timeoutMs: 8_000});
    assert(await driver.waitForText('Paid', {timeoutMs: 15_000}),
      'a DEMO request scanned with VCHF selected must settle — the request names the asset, not the selection');
    await driver.screenshot('148-pay-camera-and-funded-account');
    console.log('[148-pay-camera-and-funded-account] ✓ ∂1.00 settled with an unfunded asset selected');

    // ---- X1: the one-tap switch is real ------------------------------------------------------
    await driver.click('btn-new', {timeoutMs: 5_000});
    await driver.click('tab-home', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.click('btn-fund-sibling-switch', {timeoutMs: 8_000});
    assertEq(await driver.readText('active-asset-label'), 'DEMO balance',
      'one tap on the pointer really selects the practice account');
    console.log('[148-pay-camera-and-funded-account] ✓ one tap switched to the practice account');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[148-pay-camera-and-funded-account] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[148-pay-camera-and-funded-account] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
