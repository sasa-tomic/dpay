// Flow 116 — the two things a cashier's screen must never get wrong about a live charge.
//
// 1. OUT OF CONTACT IS NOT UNPAID. When the till cannot be reached the screen says exactly that and
//    keeps the code up. The alternative — rendering silence as "waiting for the payment", or worse
//    as an absence of one — is how a shop hands goods to someone who has not paid, or accuses
//    someone who has. The relay itself never downgrades a failed ledger read into "not paid"
//    (`crates/dpay-relay/src/till.rs`), and this is the same discipline one hop further out.
//
// 2. A MIS-KEYED TOTAL CAN BE TAKEN BACK. Cancel signs a `cents = 0` request on the merchant's own
//    key, the relay voids the charge, and the screen ends the code with the next action. The
//    "Charge cancelled" state IS the relay's answer — the app only reports it after a 200 whose
//    body says `cancelled` (`services/till.ts`), so this assertion is about the round trip and not
//    about optimism.
//
// Offline here is the real thing the harness uses everywhere else: the app is retargeted at a port
// nothing listens on, so the poll meets a genuine connection refusal rather than a stubbed one.
//
// Selector contract: `btn-code-till`, `amount-input`, `btn-till-ring-up`, `till-qr`,
// `till-status`, `btn-till-cancel`, `till-ended`, `till-ended-go`.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, goOffline, setRelay,
} from '../harness/lib.mjs';

export const meta = {
  id: '116',
  name: 'till-offline-cancel',
  journey: 'pay',
  covers: ['till', 'merchant-till', 'offline', 'unknown-outcome', 'honest-instructions', 'cancel-charge', 'fail-closed'],
  verifies: 'A live till charge whose relay goes unreachable renders "can’t check" — the code stays up, the screen never says unpaid and never claims the sale, and it recovers to waiting the moment the relay answers again. Cancelling then signs a cents = 0 request on the merchant’s own key; the relay voids the charge and the screen ends the code with "nothing is owed" and the next action, from which the counter reopens.',
  timeoutMs: 60_000,
};

export async function run() {
  const start = Date.now();
  console.log('[116-till-offline-cancel] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;
    await onboardWallet(driver, 'e2e-till-offline');

    console.log('[116-till-offline-cancel] ringing up CHF 4.50…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.click('btn-code-till', { timeoutMs: 4_000 });
    await driver.type('amount-input', '4.50', { timeoutMs: 4_000 });
    await driver.click('btn-till-ring-up', { timeoutMs: 4_000 });
    await driver.findByTestID('till-qr', { timeoutMs: 15_000 });
    assertIncludes(await driver.readText('till-status'), 'Waiting for the payment', 'a reachable till waits');

    // --- 1. out of contact ----------------------------------------------------------------------
    console.log('[116-till-offline-cancel] killing the relay under a live charge…');
    await goOffline(driver);
    assert(await driver.waitForText('Can’t check this charge right now', { timeoutMs: 20_000 }),
      `an unreachable till must say so. screen:\n${(await driver.bodyText()).slice(0, 600)}`);
    const offline = await driver.bodyText();
    // The two sentences that would be lies, and the code that must stay on screen.
    assert(!/unpaid/i.test(offline) || /does NOT mean it is unpaid/.test(offline),
      `"unpaid" may only appear inside the denial of it:\n${offline.slice(0, 600)}`);
    assert(!offline.includes('Waiting for the payment'), 'silence must not be rendered as waiting');
    assert(!offline.includes('Paid'), 'and certainly not as a sale');
    assert(await driver.isPresent('till-qr'), 'the code stays up: our ignorance does not stop a customer paying');
    await driver.screenshot('116-till-cant-check');

    // --- 2. and back ----------------------------------------------------------------------------
    console.log('[116-till-offline-cancel] relay back → the screen recovers…');
    await setRelay(driver, relayBaseURL);
    assert(await driver.waitForText('Waiting for the payment', { timeoutMs: 20_000 }),
      'the screen returns to waiting once the till answers again');

    // --- 3. the mis-keyed total, taken back ------------------------------------------------------
    console.log('[116-till-offline-cancel] cancelling the charge…');
    await driver.click('btn-till-cancel', { timeoutMs: 4_000 });
    await driver.findByTestID('till-ended', { timeoutMs: 20_000 });
    const ended = await driver.readText('till-ended');
    assertIncludes(ended, 'Charge cancelled', 'the end state names what happened');
    assertIncludes(ended, 'Nothing is owed', 'and what it means for the customer standing there');
    assert(!(await driver.isPresent('till-qr')), 'a cancelled charge shows no payable code');
    await driver.screenshot('116-till-cancelled');

    // …and the counter reopens from the panel itself.
    await driver.click('till-ended-go', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-till-ring-up', { timeoutMs: 6_000 });

    console.log(`[116-till-offline-cancel] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('116-till-offline-cancel RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
