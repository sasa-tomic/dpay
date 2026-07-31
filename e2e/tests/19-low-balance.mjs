// Flow 19 — Low-balance scenarios (folded: offline review warning + online "Not enough balance").
//
// Two distinct insufficient-balance behaviors, both driven through the REAL app + REAL relay:
//   1. OFFLINE `review-lowbal` warning: when the payer is OFFLINE (online=false), the Pay review
//      screen shows an honest "Your local balance may not cover this — the merchant will verify."
//      for an amount exceeding the local balance (testID `review-lowbal`). This is the truthful
//      offline UX: the app can't check the ledger, so it warns instead of blocking. The merchant's
//      online verify is the real gate.
//   2. ONLINE "Not enough balance": when ONLINE, approving a payment that exceeds the ledger balance
//      submits to /api/v1/pay, the FakeLedger rejects with `InsufficientFunds`, and the app surfaces
//      "Not enough balance" in the review error (testID `review-err`) — NOT a crash, NOT a silent
//      drop to the QR screen, NOT a fake success.
//
// Folds both into ONE test (speed: one onboarding, an offline pass, then an online pass). The
// offline pass uses the harness's guaranteed-dead relay port (ECONNREFUSED, the real failure mode)
// to force online=false; the online pass restores the good relay.
//
// Selector contract: `pay-amount`, `review-lowbal`, `review-err`, `btn-approve`, `btn-settings`,
// `settings-relay`, `btn-settings-close`.
import { setup, assert, onboardWallet, pickFreePort } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const OVER_CENTS = 20_000; // $200.00 — exceeds the $100.00 faucet-funded balance

export async function run() {
  const start = Date.now();
  console.log('[19-low-balance] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // A second wallet (the payee named on the request). Generated in-test; no browser needed.
    const bob = await generateKeypair();
    const buildReq = () => {
      const nonce = randNonceHex();
      const expiry = Math.floor(Date.now() / 1000) + 600;
      return buildRequestQR(bob.publicHex, OVER_CENTS, nonce, expiry, 0, 'merchant');
    };

    // --- 1. OFFLINE review-lowbal: payer offline, amount > local balance → warning shows. --------
    // Onboard against the GOOD relay ($100 funded → balance known, online=true initially).
    console.log('[19-low-balance] onboarding…');
    await onboardWallet(driver, 'e2e-lowbal');

    // Point the app at a genuinely-dead relay so the next balance poll fails → online=false. The
    // review-lowbal guard is `!online && shownBalance != null && req.amount > shownBalance`.
    const deadPort = await pickFreePort();
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;
    console.log(`[19-low-balance] going offline (dead relay ${DEAD_RELAY})…`);
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    // Wait for the header's offline indicator ("~ approx.") — proves online flipped to false.
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ approx.") once offline');

    // Scan a $200 request (> the ~$100 local balance) → review screen renders the low-balance warning.
    console.log('[19-low-balance] scanning a $200 request while offline…');
    const offlineReq = buildReq();
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), offlineReq);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    await driver.findByTestID('review-lowbal', { timeoutMs: 4_000 });
    const lowbalTxt = await driver.readText('review-lowbal');
    assert(lowbalTxt.includes('local balance may not cover'),
      `review-lowbal should warn about coverage, got: "${lowbalTxt}"`);
    console.log(`[19-low-balance] ✓ offline review-lowbal shows: "${lowbalTxt}"`);

    // --- 2. ONLINE "Not enough balance": restore the good relay, approve an over-balance pay. -----
    // Restore the good relay URL; the balance poll reconnects → online=true again.
    console.log('[19-low-balance] going back online + approving an over-balance pay…');
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.type('settings-relay', relayBaseURL, { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    // Wait for the header to drop the offline indicator (online=true) before approving.
    await driver.waitForText('balance', { timeoutMs: 8_000 });

    // Scan a fresh $200 request + Approve → the FakeLedger rejects InsufficientFunds (20000 > 10000).
    const onlineReq = buildReq();
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), onlineReq);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    // While online, the low-balance warning must NOT show (the merchant will verify online).
    assert(!(await driver.isPresent('review-lowbal')),
      'review-lowbal must NOT show while online (the merchant verifies online)');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    // The app surfaces the relay's InsufficientFunds as "Not enough balance" in review-err.
    await driver.findByTestID('review-err', { timeoutMs: 10_000 });
    const errTxt = await driver.readText('review-err');
    assert(/not enough balance/i.test(errTxt),
      `review-err should say "Not enough balance", got: "${errTxt}"`);
    console.log(`[19-low-balance] ✓ online over-balance pay surfaces: "${errTxt}" (no crash, no silent drop)`);

    await driver.screenshot('19-low-balance');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[19-low-balance] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[19-low-balance] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
