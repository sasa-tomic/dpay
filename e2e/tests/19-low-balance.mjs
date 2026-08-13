// Flow 19 — Low-balance scenarios (folded: offline review warning + online pre-submit gate).
//
// Two distinct insufficient-balance behaviors, both driven through the REAL app + REAL relay:
//   1. OFFLINE `review-lowbal` warning: when the payer is OFFLINE (online=false), the Pay review
//      screen shows an honest "Your local balance may not cover this — the merchant will verify."
//      for an amount exceeding the local balance (testID `review-lowbal`). This is the truthful
//      offline UX: the app can't check the ledger, so it warns instead of blocking. The merchant's
//      online verify is the real gate.
//   2. ONLINE pre-submit gate (C2): when ONLINE and the known balance can't cover the amount, the
//      review screen DISABLES btn-approve up front and shows a balance warning above it (testID
//      `review-lowbal`) — no doomed /pay submission. (The relay's InsufficientFunds→"Not enough
//      balance" surfacing stays unit-tested in payments.ts; the C1 "any error disables the button"
//      pattern is proven in flow 10.)
//
// Folds both into ONE test (speed: one onboarding, an offline pass, then an online pass). The
// offline pass uses the harness's guaranteed-dead relay port (ECONNREFUSED, the real failure mode)
// to force online=false; the online pass restores the good relay.
//
// Selector contract: `pay-amount`, `review-lowbal`, `btn-approve`, `btn-settings`,
// `settings-relay`, `btn-settings-close`.
import { setup, assert, onboardWallet, goOffline, setRelay, assertDisabled, waitForScanner } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const OVER_CENTS = 20_000; // ∂200.00 — exceeds the ∂100.00 faucet-funded balance

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '19',
  name: 'low-balance',
  journey: 'pay',
  covers: ['low-balance', 'insufficient', 'disabled-approve'],
  verifies: 'Insufficient funds: offline review-lowbal warning; online Approve disabled, \'Not enough balance\'.',
  timeoutMs: 15000,
};

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
    // Onboard against the GOOD relay (∂100 funded → balance known, online=true initially).
    console.log('[19-low-balance] onboarding…');
    await onboardWallet(driver, 'e2e-lowbal');

    // Point the app at a genuinely-dead relay so the next balance poll fails → online=false. The
    // review-lowbal guard is `!online && shownBalance != null && req.amount > shownBalance`.
    console.log('[19-low-balance] going offline (dead relay)…');
    await goOffline(driver);
    // Wait for the header's offline indicator ("~ DEMO approx." after D3) — proves online flipped to false.
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ DEMO approx.") once offline');

    // Scan a ∂200 request (> the ~∂100 local balance) → review screen renders the low-balance warning.
    console.log('[19-low-balance] scanning a ∂200 request while offline…');
    const offlineReq = buildReq();
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), offlineReq);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    await driver.findByTestID('review-lowbal', { timeoutMs: 4_000 });
    const lowbalTxt = await driver.readText('review-lowbal');
    assert(lowbalTxt.includes('local balance may not cover'),
      `review-lowbal should warn about coverage, got: "${lowbalTxt}"`);
    console.log(`[19-low-balance] ✓ offline review-lowbal shows: "${lowbalTxt}"`);

    // --- 2. ONLINE insufficient: client-side gate disables Approve + shows a warning (C2). --------
    // Cancel out of the first review to return to the scan phase, then restore the relay URL.
    console.log('[19-low-balance] cancelling first review, going back online…');
    await driver.click('btn-review-cancel', {timeoutMs: 5_000});
    await setRelay(driver, relayBaseURL);
    // Wait for the header to drop the offline indicator (online=true) before scanning.
    await driver.waitForText('balance', { timeoutMs: 8_000 });

    // Scan a ∂200 request while ONLINE + ∂100 balance. We KNOW online the balance can't cover it,
    // so the app now gates PRE-SUBMIT (no doomed /pay): it shows a balance warning above the button
    // AND disables btn-approve. (The relay's InsufficientFunds→"Not enough balance" surfacing stays
    // unit-tested in payments.ts; the C1 "any error disables the button" pattern is proven in 10.)
    const onlineReq = buildReq();
    await waitForScanner(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), onlineReq);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    // The online insufficient-balance warning now shows (re-uses review-lowbal as the balance note).
    await driver.findByTestID('review-lowbal', { timeoutMs: 5_000 });
    const lowbalOnlineTxt = await driver.readText('review-lowbal');
    assert(/balance/i.test(lowbalOnlineTxt), `review-lowbal should warn about balance, got: "${lowbalOnlineTxt}"`);
    // C2: btn-approve must be DISABLED (online + insufficient) — no doomed submit.
    await assertDisabled(driver, 'btn-approve', 'btn-approve must be disabled when online + balance insufficient (C2)');
    console.log(`[19-low-balance] ✓ online insufficient: gate shows "${lowbalOnlineTxt}" + btn-approve disabled (C2, no doomed submit)`);

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
