// Flow 179 — offline NFC hand-off: the payer taps UNCONFIRMED (no merchant result arrives), and
// the wallet must still show the payment locally: a pending activity row headlining the GROSS
// (wire + fee — the account moves both, founder 2026-09-14), the balance deducted by that gross,
// and NO other asset touched. The pending record outbox (2026-09-15) makes the old ephemeral
// deduction restart-proof; this flow pins the in-session half. The restart half is flow 181, the
// reconciliation half is flow 182, and the QR twin is flow 180.
//
// The tap ends in an error terminal ON PURPOSE: that is the honest unknown-outcome case (the
// merchant's phone may well have submitted the envelope). Unlike a REJECTED result — which refunds
// at once — the record must SURVIVE the terminal, because nothing yet says it will not settle.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances, armNfcCard, selectCurrency,
  faucetAccount, accountOf, goOffline,
} from '../harness/lib.mjs';
import { nfcPhaseWalk, openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair, randNonceHex } from '../harness/wire.mjs';

const CURRENCY = 8; // ICP — a real ledger with a real catalog fee, so GROSS ≠ WIRE here
const SEED = 210000001; // 2.10000001 ICP — covers the price
const PAY = 100000001; // the PRICE (wire + fee)
const FEE = 10000; // ICP catalog fee — knowable OFFLINE via the ledger-fee fallback
const WIRE = PAY - FEE; // 99990001 — what the request carries and the rail moves

export const meta = {
  id: '179',
  name: 'offline-nfc-pending',
  journey: 'offline',
  covers: ['offline', 'nfc', 'pending', 'balances', 'history'],
  verifies: 'An unconfirmed offline NFC tap renders a pending row headlining the gross and deducts exactly that gross from the balance; no other asset moves.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[179-offline-nfc-pending] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // The web app must treat NFC as available (default 'unknown' → NfcTap never mounts).
    const nfcSeam = await driver.addInitScript(() => { globalThis.__DPAY_TEST_NFC_STATUS = 'ready'; });

    await onboardWallet(driver, 'e2e-offline-nfc');
    await driver.removeInitScript(nfcSeam);
    const merchant = await generateKeypair(); // only the recipient pubkey is needed offline

    // --- Fund ICP, wait for the header to carry it, then go genuinely offline. ------------------
    // (Funding + the offline retarget + the eyebrow pin are flows 96 and 13's contracts; here
    // they are just the road to the state under test.)
    const { relayBaseURL } = env;
    const payer = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 10_000 }), 'the header must show the funded ICP balance before the offline leg');

    await goOffline(driver);
    assert(await driver.waitForText('approx.', { timeoutMs: 8_000 }), 'the offline eyebrow must appear (flow 13\'s marker)');
    console.log('[179-offline-nfc-pending] ✓ offline (dead relay retargeted, eyebrow shown)');

    // --- The tap: request → auto-sign → unconfirmed. -------------------------------------------
    const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };
    await nfcPhaseWalk(driver, dispatch, ['linking'], { statusId: 'nfc-status', text: null });

    const nowSecs = Math.floor(Date.now() / 1000);
    const nonceHex = randNonceHex();
    await dispatch({
      type: 'request', role: 'card',
      toHex: merchant.publicHex, amount: String(WIRE), nonceHex,
      expiry: nowSecs + 240, currency: CURRENCY,
    });
    // The status line rides the GROSS once the fee fallback answered (offline → catalog fee).
    assert(await driver.waitForText('Communicating', { timeoutMs: 6_000 }), 'a payable request auto-signs straight to exchanging');
    assert(await driver.waitForText('Paying 1.00000001 ICP', { timeoutMs: 4_000 }), 'the tap\'s amount line must headline the GROSS (wire + fallback fee), not the bare wire');
    console.log('[179-offline-nfc-pending] ✓ tap auto-signed, status line shows the gross');

    // Unknown outcome: the transport dies. The record must SURVIVE this terminal.
    await dispatch({ type: 'error', role: 'card', reason: 'e2e: unconfirmed tap' });
    assert(await driver.waitForText('Tap failed', { timeoutMs: 5_000 }), 'the honest error terminal appears');
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]');
      if (btn) btn.click();
    });
    await driver.waitGone('nfc-status', { timeoutMs: 5_000 });
    console.log('[179-offline-nfc-pending] ✓ tap ended unconfirmed (error terminal dismissed)');

    // --- The local ledger: pending row + gross deduction, nothing else moved. ------------------
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 6_000 });
    const home = await driver.bodyText();
    assertIncludes(home, '\u22121.00000001 ICP', 'the pending home row headlines the GROSS (U+2212)');
    console.log('[179-offline-nfc-pending] ✓ pending activity row on Home, gross headline');

    await openHistory(driver, { recentMs: 5_000 });
    await driver.findByTestID('hist-pending-0', { timeoutMs: 5_000 });
    const ledger = await driver.bodyText();
    assertIncludes(ledger, '\u22121.00000001 ICP', 'the Ledger row carries the same gross headline');
    assertIncludes(ledger, '\u2212 0.0001 ICP fees', 'the device-saved fee annotation rides the row');
    console.log('[179-offline-nfc-pending] ✓ Ledger pending row + fee annotation');

    // The balance: deducted by the GROSS (2.10000001 − 1.00000001 = 1.10), DEMO untouched.
    await openBalances(driver);
    assert(await driver.waitForText('1.1 ICP', { timeoutMs: 6_000 }), 'the ICP row must read the deducted balance');
    assertIncludes(await driver.bodyText(), '\u2202100.00', 'the DEMO row must be untouched (per-currency isolation)');
    console.log('[179-offline-nfc-pending] ✓ ICP balance deducted by the gross; DEMO row unchanged');

    await driver.screenshot('179-offline-nfc-pending');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[179-offline-nfc-pending] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[179-offline-nfc-pending] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
