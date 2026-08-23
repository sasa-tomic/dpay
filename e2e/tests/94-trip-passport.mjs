// Flow 94 — Trip Readiness passport (Trip Ready J5b): the private capability credential.
//
// The full passport journey in one live session, against the real app + relay:
//   1. Onboard WITH the rehearsal driven in full (flow-90 pattern — unlike `onboardWallet`,
//      which skips it): recoverySaved (backup beat) + flowUnderstood (rehearsal beat 3) +
//      fundsReady (faucet funds during onboarding → decideFundsReady flips true in Wallet)
//      = 3 of the 4 PASSPORT stamps (walkthroughDone is journey chrome, not a slot): the
//      card shows 3 OF 4 filled slots and the ONE next-step hint naming a payment.
//   2. Incomplete contract: NO collapse affordance (no btn-passport-done anywhere).
//   3. ONE confirmed payment (flow-07 seam: real signing + real FakeLedger settle) awards
//      paymentTested → re-open Balances: the 4th slot filled + the TRIP READY capstone
//      (first observation of the complete page) → Done collapses the card forever.
//   4. Persistence: re-open Balances — the card is GONE (complete + collapsed).
//   5. The archive: Settings → btn-trip-readiness → the read-only passport shows all four
//      stamps + the static TRIP READY mark.
//   6. The journey store persists tripReady + the passportCollapsed seen-marker.
//
// Selector contract: `trip-passport`, `passport-slot-<key>[-filled]`, `passport-count`,
// `passport-hint`, `trip-ready-capstone`, `btn-passport-done`, `btn-trip-readiness`,
// `passport-archive`, `btn-passport-close`.
import {setup, assert, assertIncludes, skipWalkthroughIfPresent, getBalance} from '../harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from '../harness/wire.mjs';

export const meta = {
  id: '94',
  name: 'trip-passport',
  journey: 'onboard',
  covers: ['readiness', 'funds-ready', 'payment-tested', 'capstone', 'collapse', 'archive', 'persistence'],
  verifies: 'Trip readiness passport: 3/4 after onboarding → confirmed payment fills the 4th → TRIP READY capstone → Done collapses the card → Settings archive keeps it forever.',
  timeoutMs: 90_000,
};

/** Read + parse the persisted journey store (dpay.journey.v1) from page localStorage. */
async function readJourney(driver) {
  const raw = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
  return raw ? JSON.parse(raw) : null;
}

export async function run() {
  const start = Date.now();
  console.log('[94-trip-passport] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    // --- 1. Onboard WITH the rehearsal (flow-90 pattern): 3 of the 4 passport stamps. ----------
    console.log('[94-trip-passport] onboarding (walkthrough skip + backup beat + rehearsal driven in full)…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-passport', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    // (The RECOVERY SAVED ink-stamp beat auto-advances to the rehearsal — zero extra taps.)
    await driver.findByTestID('rehearsal', { timeoutMs: 15_000 });
    await driver.findByTestID('rehearsal-step-1', { timeoutMs: 8_000 });
    await new Promise(r => setTimeout(r, 900)); // entrance rise finish
    // (One-page rehearsal: all 3 steps mounted together — mounting awards flowUnderstood.)
    await driver.waitForText('Try with demo funds', { timeoutMs: 4_000 });
    await driver.click('btn-rehearsal-next', { timeoutMs: 4_000 }); // "Try with demo funds"
    await driver.waitGone('rehearsal', { timeoutMs: 8_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('Đ100.00', { timeoutMs: 15_000 }); // faucet funded → fundsReady

    const j1 = await readJourney(driver);
    assert(j1, 'journey store must exist after onboarding');
    for (const s of ['walkthroughDone', 'recoverySaved', 'flowUnderstood', 'fundsReady']) {
      assert(j1.stamps.includes(s), `journey must include ${s} after onboarding (got ${j1.stamps.join(',')})`);
    }
    assert(!j1.stamps.includes('paymentTested'), 'no payment yet → paymentTested must NOT be stamped');
    console.log('[94-trip-passport] ✓ journey after onboarding: 3 of 4 passport stamps (paymentTested left)');

    // --- The card in Balances: 3 filled slots + n/4 + the ONE next hint. ----------------------
    console.log('[94-trip-passport] opening Balances — the passport card…');
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.findByTestID('trip-passport', { timeoutMs: 5_000 });
    const countTxt = await driver.readText('passport-count');
    assertIncludes(countTxt, '3 OF 4', 'passport count after onboarding');
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady']) {
      await driver.findByTestID(`passport-slot-${key}-filled`, { timeoutMs: 3_000 });
    }
    await driver.findByTestID('passport-slot-paymentTested', { timeoutMs: 3_000 }); // empty
    // The ONE contextual next step names a payment (the only missing capability).
    const hint = await driver.readText('passport-hint');
    assertIncludes(hint.toLowerCase(), 'payment', 'next-step hint should name a payment (the only missing stamp)');
    // Incomplete NEVER collapses: no Done affordance exists.
    assert(!(await driver.isPresent('btn-passport-done')), 'incomplete passport must have NO collapse affordance');
    console.log('[94-trip-passport] ✓ card: 3 OF 4, payment hint, no collapse affordance');
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });

    // --- 2. ONE confirmed payment (flow-07 seam: real sign + real settle). -------------------
    console.log('[94-trip-passport] driving one confirmed payment (scan → approve → settled)…');
    const bob = await generateKeypair();
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', 'payee must start at 0');
    const requestQR = buildRequestQR(bob.publicHex, 2500, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payment must reach the confirmed Paid screen');
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobAfter) === '2500', `payee credited (got ${bobAfter})`);
    console.log('[94-trip-passport] ✓ confirmed payment settled (paymentTested awarded on the confirmed path)');

    // Leave the Paid screen (New payment resets PayMode to the scanner) before opening Balances.
    await driver.click('btn-new', { timeoutMs: 6_000 });

    // --- 3. Re-open Balances: the 4th slot filled + the TRIP READY capstone → Done. -----------
    console.log('[94-trip-passport] re-opening Balances — 4th stamp + capstone…');
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.findByTestID('passport-slot-paymentTested-filled', { timeoutMs: 5_000 });
    // The capstone plays on first observation of the complete page (the one-shot beat).
    await driver.findByTestID('trip-ready-capstone', { timeoutMs: 5_000 });
    const capstoneText = await driver.bodyText();
    assertIncludes(capstoneText.toUpperCase(), 'TRIP READY', 'capstone overlay must show TRIP READY');
    console.log('[94-trip-passport] ✓ 4th slot filled + TRIP READY capstone playing');

    // The press lifts (~1.4s) → Done appears → collapses the card forever.
    await driver.findByTestID('btn-passport-done', { timeoutMs: 10_000 });
    await driver.click('btn-passport-done', { timeoutMs: 4_000 });
    await driver.waitGone('trip-passport', { timeoutMs: 5_000 });
    console.log('[94-trip-passport] ✓ Done collapsed the card');

    // --- 4. Persistence: the card never comes back. -------------------------------------------
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    // Give the (async-loaded) journey a beat, then the card must be absent.
    await driver.waitForText('DEMO', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('trip-passport')), 'complete+collapsed passport must stay gone from Balances');
    console.log('[94-trip-passport] ✓ collapsed card stays gone on re-open');

    // --- 5. The archive: Settings → Trip readiness (the permanent home). ----------------------
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']) {
      await driver.findByTestID(`passport-slot-${key}-filled`, { timeoutMs: 3_000 });
    }
    const archiveBody = await driver.bodyText();
    assertIncludes(archiveBody.toUpperCase(), 'TRIP READY', 'archive must show the static TRIP READY mark');
    assertIncludes(archiveBody, 'no signal', 'archive keeps the promise line');
    assert(!(await driver.isPresent('btn-passport-done')), 'archive is read-only — no Done');
    console.log('[94-trip-passport] ✓ Settings archive: complete passport, static TRIP READY');
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // --- 6. Fresh boot with the finished journey: tripReady + collapsed persist; no card. -----
    console.log('[94-trip-passport] reloading (fresh boot of the finished journey)…');
    // Reload WITH the ?relay= param (same as setup) — the bare-`/` reload only works after the
    // relay URL has been persisted via Settings (flow 12's contract), which this flow never does.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    const j2 = await readJourney(driver);
    assert(j2.stamps.includes('paymentTested'), 'paymentTested persists across reload');
    assert(j2.stamps.includes('tripReady'), 'tripReady capstone stamp persists across reload');
    assert(j2.seen.includes('passportCollapsed'), 'passportCollapsed seen-marker persists across reload');
    await driver.click('balance', { timeoutMs: 6_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.waitForText('DEMO', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('trip-passport')), 'fresh boot of complete+collapsed journey → no card in Balances');
    // …but the archive still keeps the credential.
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    console.log('[94-trip-passport] ✓ fresh boot: no card, archive intact, stamps persisted');

    await driver.screenshot('94-trip-passport');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[94-trip-passport] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[94-trip-passport] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
