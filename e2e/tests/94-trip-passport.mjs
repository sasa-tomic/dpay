// Flow 94 — Trip Readiness passport (Trip Ready J5b): the private capability credential.
//
// The full passport journey in one live session, against the real app + relay. UX round 4
// (2026-08-23): readiness lives in exactly TWO surfaces — the home TripStrip (live entry)
// and the full-screen archive (the permanent record + celebration surface, opened from the
// strip or Settings). The Balances card is GONE (three-surfaces-one-fact was founder-flagged
// redundancy).
//   1. Onboard WITH the rehearsal driven in full (flow-90 pattern — unlike `onboardWallet`,
//      which skips it): recoverySaved (backup beat) + flowUnderstood (rehearsal mount) +
//      fundsReady (faucet funds during onboarding → decideFundsReady flips true in Wallet)
//      = 3 of the 4 PASSPORT stamps (walkthroughDone is journey chrome, not a slot).
//   2. The strip: 3 filled dots + the payment next-step phrase; taps open the ARCHIVE,
//      which shows 3 OF 4 filled slots and the ONE next-step hint naming a payment.
//   3. Incomplete contract: NO Done affordance anywhere.
//   4. ONE confirmed payment (flow-07 seam: real signing + real FakeLedger settle) awards
//      paymentTested → re-open the archive: the 4th slot filled + the TRIP READY capstone
//      (first observation of the complete page) → Done retires the home strip forever.
//   5. Persistence: the strip is GONE from home (complete + retired); the archive (Settings)
//      keeps all four stamps + the static TRIP READY mark forever.
//   6. The journey store persists tripReady + the passportCollapsed seen-marker.
//
// Selector contract: `trip-strip`, `trip-strip-dot-<key>[-filled]`, `passport-archive`,
// `passport-slot-<key>[-filled]`, `passport-count`, `passport-hint`, `trip-ready-capstone`,
// `btn-passport-done`, `btn-trip-readiness`, `btn-trip-strip`, `btn-passport-close`.
import {setup, assert, assertIncludes, skipWalkthroughIfPresent, getBalance, armPayScan} from '../harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from '../harness/wire.mjs';

export const meta = {
  id: '94',
  name: 'trip-passport',
  journey: 'onboard',
  covers: ['readiness', 'funds-ready', 'payment-tested', 'capstone', 'collapse', 'archive', 'persistence', 'trip-strip'],
  verifies: 'Trip readiness: home TripStrip 3/4 after onboarding → confirmed payment fills the 4th → archive TRIP READY capstone → Done retires the strip → Settings archive keeps it forever.',
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
    await driver.waitForText('∂100.00', { timeoutMs: 15_000 }); // faucet funded → fundsReady

    const j1 = await readJourney(driver);
    assert(j1, 'journey store must exist after onboarding');
    for (const s of ['walkthroughDone', 'recoverySaved', 'flowUnderstood', 'fundsReady']) {
      assert(j1.stamps.includes(s), `journey must include ${s} after onboarding (got ${j1.stamps.join(',')})`);
    }
    assert(!j1.stamps.includes('paymentTested'), 'no payment yet → paymentTested must NOT be stamped');
    console.log('[94-trip-passport] ✓ journey after onboarding: 3 of 4 passport stamps (paymentTested left)');

    // --- 2. The strip (home): 3 filled dots; taps open the ARCHIVE (3 OF 4 + payment hint). ---
    console.log('[94-trip-passport] home TripStrip → archive (3 OF 4)…');
    await driver.findByTestID('trip-strip', { timeoutMs: 5_000 });
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady']) {
      await driver.findByTestID(`trip-strip-dot-${key}-filled`, { timeoutMs: 3_000 });
    }
    await driver.findByTestID('trip-strip-dot-paymentTested', { timeoutMs: 3_000 }); // empty
    await driver.click('btn-trip-strip', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    const countTxt = await driver.readText('passport-count');
    assertIncludes(countTxt, '3 OF 4', 'archive count after onboarding');
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady']) {
      await driver.findByTestID(`passport-slot-${key}-filled`, { timeoutMs: 3_000 });
    }
    await driver.findByTestID('passport-slot-paymentTested', { timeoutMs: 3_000 }); // empty
    // The ONE contextual next step names a payment (the only missing capability).
    const hint = await driver.readText('passport-hint');
    assertIncludes(hint.toLowerCase(), 'payment', 'next-step hint should name a payment (the only missing stamp)');
    // Incomplete NEVER retires: no Done affordance exists.
    assert(!(await driver.isPresent('btn-passport-done')), 'incomplete passport must have NO Done affordance');
    console.log('[94-trip-passport] ✓ archive: 3 OF 4, payment hint, no Done affordance');
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });

    // --- 3. ONE confirmed payment (flow-07 seam: real sign + real settle). -------------------
    console.log('[94-trip-passport] driving one confirmed payment (scan → auto-sign → settled)…');
    const bob = await generateKeypair();
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', 'payee must start at 0');
    const requestQR = buildRequestQR(bob.publicHex, 2500, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);
    // One-press rule (2026-08-24): the scan AUTO-SIGNS — no review, no Approve click.
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payment must reach the confirmed Paid screen');
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobAfter) === '2500', `payee credited (got ${bobAfter})`);
    console.log('[94-trip-passport] ✓ confirmed payment settled (paymentTested awarded on the confirmed path)');

    // Leave the Paid screen (New payment resets PayMode to the scanner) before opening the strip.
    await driver.click('btn-new', { timeoutMs: 6_000 });

    // --- 4. The strip is GONE the moment readiness completes (founder rule 2026-08-23: "when
    //        fully done, the bar disappears"); the archive is reached via Settings → Trip
    //        readiness: 4th stamp + TRIP READY capstone → Done. --------------------------------
    console.log('[94-trip-passport] Settings → archive: 4th stamp + capstone…');
    // The live journey seam pushed the award; the strip must have retired IMMEDIATELY
    // (not held open until the capstone was seen — the old collapse-marker rule is gone).
    await driver.waitGone('trip-strip', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('btn-trip-strip')), 'complete journey must retire the home strip with no Done press');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-slot-paymentTested-filled', { timeoutMs: 5_000 });
    // The capstone plays on first observation of the complete page (the one-shot beat).
    await driver.findByTestID('trip-ready-capstone', { timeoutMs: 5_000 });
    const capstoneText = await driver.bodyText();
    assertIncludes(capstoneText.toUpperCase(), 'TRIP READY', 'capstone overlay must show TRIP READY');
    console.log('[94-trip-passport] ✓ 4th slot filled + TRIP READY capstone playing');

    // The press lifts (~2.2s) → Done appears → closes the archive.
    await driver.findByTestID('btn-passport-done', { timeoutMs: 10_000 });
    await driver.click('btn-passport-done', { timeoutMs: 4_000 });
    await driver.waitGone('passport-archive', { timeoutMs: 5_000 }); // Done closes the archive
    await driver.waitGone('trip-strip', { timeoutMs: 5_000 }); // …and the strip stays gone
    console.log('[94-trip-passport] ✓ Done closed the archive; strip stays retired');
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // --- 5. Persistence: the strip never comes back; the archive (Settings) keeps the record. -
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('trip-strip')), 'complete+retired strip must stay gone');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']) {
      await driver.findByTestID(`passport-slot-${key}-filled`, { timeoutMs: 3_000 });
    }
    const archiveBody = await driver.bodyText();
    assertIncludes(archiveBody.toUpperCase(), 'TRIP READY', 'archive must show the static TRIP READY mark');
    assertIncludes(archiveBody, 'no signal', 'archive keeps the promise line');
    console.log('[94-trip-passport] ✓ Settings archive: complete passport, static TRIP READY');
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // --- 6. Fresh boot with the finished journey: tripReady + retired persist; no strip. ------
    console.log('[94-trip-passport] reloading (fresh boot of the finished journey)…');
    // Reload WITH the ?relay= param (same as setup) — the bare-`/` reload only works after the
    // relay URL has been persisted via Settings (flow 12's contract), which this flow never does.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    const j2 = await readJourney(driver);
    assert(j2.stamps.includes('paymentTested'), 'paymentTested persists across reload');
    assert(j2.stamps.includes('tripReady'), 'tripReady capstone stamp persists across reload');
    assert(j2.seen.includes('passportCollapsed'), 'passportCollapsed seen-marker persists across reload');
    await driver.waitForText('∂100.00', { timeoutMs: 8_000 });
    assert(!(await driver.isPresent('trip-strip')), 'fresh boot of complete+retired journey → no strip');
    // …but the archive still keeps the credential.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    console.log('[94-trip-passport] ✓ fresh boot: no strip, archive intact, stamps persisted');

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
