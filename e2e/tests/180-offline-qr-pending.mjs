// Flow 180 — offline QR hand-off twin of 179: the payer scans a payment request while offline,
// the one-press auto-sign prepares the envelope, and — with no relay to submit to — the app hands
// the payer a QR to show the merchant instead. Pressing "Paid" (the hand-off) must render the
// payment locally EXACTLY like the NFC tap does: a pending row headlining the gross, the balance
// deducted by that gross. The discard twin ("not paid") is unit-pinned (the retraction removes the
// record); this flow pins the hand-off that KEEPS it.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances, armPayScan, selectCurrency,
  faucetAccount, accountOf, goOffline,
} from '../harness/lib.mjs';
import { buildRequestQR, generateKeypair, randNonceHex } from '../harness/wire.mjs';

const CURRENCY = 8; // ICP — real ledger, real catalog fee, GROSS ≠ WIRE
const SEED = 210000001;
const PAY = 100000001;
const FEE = 10000;
const WIRE = PAY - FEE; // the request carries the netted wire (flow 95's arithmetic)

export const meta = {
  id: '180',
  name: 'offline-qr-pending',
  journey: 'offline',
  covers: ['offline', 'pay', 'pending', 'balances', 'history'],
  verifies: 'An offline QR hand-off (scan → auto-sign → "Paid" press) renders a pending row headlining the gross and deducts exactly that gross from the balance.',
  timeoutMs: 60_000,
};

export async function run() {
  const start = Date.now();
  console.log('[180-offline-qr-pending] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-offline-qr');
    const merchant = await generateKeypair();

    const payer = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 10_000 }), 'the header must show the funded ICP balance before the offline leg');

    // keepGateway (the flow-20 offline hand-off premise): offline here = RELAY-dead (balance +
    // history polls fail → online flips false → the QR fall-through + approx. eyebrow), while the
    // IC gateway stays alive — the camera sign path stamps its value envelope from the certified
    // IC clock (icp.ts refuses to sign value envelopes on an unreachable clock; only the NFC
    // prepare, which stamps at the request's own expiry, signs under a dead gateway too — flow 179
    // pins that harder case).
    await goOffline(driver, { keepGateway: true });
    assert(await driver.waitForText('approx.', { timeoutMs: 8_000 }), 'the offline eyebrow must appear');
    console.log('[180-offline-qr-pending] ✓ offline (dead relay retargeted, eyebrow shown)');

    // --- Scan the merchant's request while offline → one-press sign → QR hand-off. -------------
    const nonceHex = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(merchant.publicHex, String(WIRE), nonceHex, expiry, CURRENCY, 'Café Sunrise');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);

    // Offline: no submit happens — the app shows the envelope QR + the honest confirm row.
    await driver.findByTestID('btn-paid', { timeoutMs: 6_000 });
    assert(await driver.waitForText('1.00000001 ICP', { timeoutMs: 4_000 }), 'the hand-off screen must show the GROSS total (wire + fallback fee)');
    console.log('[180-offline-qr-pending] ✓ offline scan fell through to the QR hand-off (gross shown)');

    // The hand-off press. This is "I showed the merchant my envelope" — payment assumed done.
    await driver.click('btn-paid', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-new', { timeoutMs: 5_000 }); // the paid screen (pending) is up
    await driver.click('btn-new', { timeoutMs: 4_000 });
    console.log('[180-offline-qr-pending] ✓ "Paid" pressed, paid screen dismissed');

    // --- The local ledger: pending row + gross deduction. --------------------------------------
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 6_000 });
    const home = await driver.bodyText();
    assertIncludes(home, '\u22121.00000001 ICP', 'the pending home row headlines the GROSS (U+2212)');
    assertIncludes(home, 'Café Sunrise', 'the merchant name from the request rides the row');
    console.log('[180-offline-qr-pending] ✓ pending activity row on Home (gross + merchant name)');

    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    await driver.waitForText('RECENT', { timeoutMs: 5_000 });
    await driver.findByTestID('hist-pending-0', { timeoutMs: 5_000 });
    assertIncludes(await driver.bodyText(), '\u22121.00000001 ICP', 'the Ledger row carries the same gross headline');
    console.log('[180-offline-qr-pending] ✓ Ledger pending row');

    await openBalances(driver);
    assert(await driver.waitForText('1.1 ICP', { timeoutMs: 6_000 }), 'the ICP row must read the deducted balance (2.10000001 − 1.00000001)');
    console.log('[180-offline-qr-pending] ✓ ICP balance deducted by the gross');

    await driver.screenshot('180-offline-qr-pending');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[180-offline-qr-pending] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[180-offline-qr-pending] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
