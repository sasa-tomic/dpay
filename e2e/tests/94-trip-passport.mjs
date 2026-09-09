// Flow 94 — Trip Readiness passport (Trip Ready J5b): the private capability credential.
//
// The full passport journey in one live session, against the real app + relay. UX round 4
// (2026-08-23): readiness lives in exactly TWO surfaces — the TripStrip (live entry, on the HOME
// tab only since 2026-09-08 — it was global chrome on all four tabs, a first-run progress meter
// telling the user on every screen that they owed the app something, X14) and the full-screen
// archive (the permanent record + celebration surface, opened from the strip or Settings).
//   1. Onboard WITH the first-run practice payment driven in full (unlike `onboardWallet`, which
//      leaves it): recoverySaved (backup beat) + flowUnderstood = 2 of the 4 PASSPORT stamps
//      (walkthroughDone is journey chrome, not a slot). fundsReady is NOT among
//      them, and that is the assertion of record for X13: the wallet holds practice money — ∂99.00
//      of it, the ∂1.00 having just been really spent — and FUNDS LOADED is a TRIP-readiness
//      claim, which practice money cannot support. (This also retires the D4 ∂0.00 pin: DEMO can
//      no longer decide the stamp at ANY amount, so draining to zero would prove nothing the first
//      step does not. D4's surviving half — the row dimming at ∂0.00 — is pinned in
//      app/__tests__/assetBalances.test.ts.)
//   2. A REAL asset is funded → the stamp flips LIVE, 2 OF 4 → 3 OF 4, without a reload: the
//      strip and the archive both re-decide from the balance map, never from a sticky flag.
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
import {setup, assert, assertIncludes, skipWalkthroughIfPresent, getBalance, accountOf, armPayScan, chooseHomeCurrencyIfPresent, selectDemoAsset, faucetAccount, waitForWallet} from '../harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from '../harness/wire.mjs';

export const meta = {
  id: '94',
  name: 'trip-passport',
  journey: 'onboard',
  covers: ['readiness', 'funds-ready', 'payment-tested', 'capstone', 'collapse', 'archive', 'persistence', 'trip-strip'],
  verifies: 'Trip readiness: practice money alone leaves FUNDS LOADED unfilled (2/4); funding a real asset flips it live to 3/4; a confirmed payment fills the 4th → archive TRIP READY capstone → Done retires the strip → the Settings archive keeps it forever; the strip renders on Home ONLY.',
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

    // --- 1. Onboard WITH the practice payment made: 2 of the 4 passport stamps. ---------------
    console.log('[94-trip-passport] onboarding (walkthrough skip + backup beat + a real practice payment)…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-passport', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    // (The RECOVERY SAVED ink-stamp beat auto-advances to practice — zero extra taps.)
    // The payment is MADE, not skipped: this flow's subject is what the passport says about a
    // wallet that has done everything first run offers, and a settled practice payment is one of
    // those things.
    await driver.findByTestID('practice', { timeoutMs: 15_000 });
    await driver.click('btn-practice-review', { timeoutMs: 8_000 });
    await driver.click('btn-approve', { timeoutMs: 8_000 });
    await driver.findByTestID('practice-outcome', { timeoutMs: 30_000 });
    await driver.click('btn-practice-continue', { timeoutMs: 8_000 });
    await driver.waitGone('practice', { timeoutMs: 8_000 });
    await chooseHomeCurrencyIfPresent(driver);
    // The wallet opens on the chosen CURRENCY; this flow is about the DEMO rail, so say so.
    await selectDemoAsset(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
    // ∂99.00, not ∂100.00: the practice payment really spent a franc of play money.
    await driver.waitForText('∂99.00', { timeoutMs: 15_000 });

    const j1 = await readJourney(driver);
    assert(j1, 'journey store must exist after onboarding');
    for (const s of ['walkthroughDone', 'recoverySaved', 'flowUnderstood']) {
      assert(j1.stamps.includes(s), `journey must include ${s} after onboarding (got ${j1.stamps.join(',')})`);
    }
    // X13 — the assertion of record. The wallet is holding ∂100.00 right now and it is NOT
    // trip-ready: practice money is valueless by construction, so a FUNDS LOADED stamp over it
    // would be a claim the app has not verified (anti-scam rule R4).
    assert(!j1.stamps.includes('fundsReady'), `practice money alone must NOT stamp fundsReady (got ${j1.stamps.join(',')})`);
    // …and the practice payee is not a counterparty, so the FIRST PAYMENT slot stays open. This is
    // the line that makes "one payment to go" true after a first run that made a payment.
    assert(!j1.stamps.includes('paymentTested'), 'no payment yet → paymentTested must NOT be stamped');
    console.log('[94-trip-passport] ✓ journey after onboarding: 2 of 4 — practice money earns no FUNDS LOADED');

    // --- 2. The strip (HOME ONLY since 2026-09-08): 2 filled dots; the archive says 2 OF 4 and
    //        its next step names the missing FUNDS. -----------------------------------------
    console.log('[94-trip-passport] TripStrip is Home-only, and reads 2 OF 4…');
    assert(!(await driver.isPresent('trip-strip')), 'the strip must NOT render on the Pay tab (X14)');
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('trip-strip', { timeoutMs: 5_000 });
    for (const key of ['recoverySaved', 'flowUnderstood']) {
      await driver.findByTestID(`trip-strip-dot-${key}-filled`, { timeoutMs: 3_000 });
    }
    assert(!(await driver.isPresent('trip-strip-dot-fundsReady-filled')),
      'a wallet holding only practice money must leave the FUNDS LOADED dot unfilled (X13)');
    await driver.findByTestID('trip-strip-dot-paymentTested', { timeoutMs: 3_000 }); // empty
    await driver.click('btn-trip-strip', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('passport-count'), '2 OF 4', 'archive count after onboarding');
    const fundsHint = await driver.readText('passport-hint');
    assertIncludes(fundsHint.toLowerCase(), 'practice',
      'the next-step hint names what does NOT count, so the user is not sent to the faucet again');
    assert(!(await driver.isPresent('btn-passport-done')), 'incomplete passport must have NO Done affordance');
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    console.log('[94-trip-passport] ✓ strip on Home only, 2 OF 4, hint names practice money');

    // --- 2b. Fund a REAL asset → the stamp flips LIVE (no reload): 2 OF 4 → 3 OF 4, and the
    //         next step becomes the payment. ------------------------------------------------
    console.log('[94-trip-passport] funding the home rail (VCHF) → fundsReady must flip live…');
    const meNow = await accountOf(driver);
    const seeded = await faucetAccount(relayBaseURL, meNow.publicHex, 500_000_000, { currency: 7 });
    assert(seeded.ok, `seeding VCHF must succeed, got ${seeded.status}: ${JSON.stringify(seeded.body)}`);
    await driver.findByTestID('trip-strip-dot-fundsReady-filled', { timeoutMs: 15_000 });
    await driver.click('btn-trip-strip', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('passport-count'), '3 OF 4', 'a real balance flips the archive to 3 OF 4');
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady']) {
      await driver.findByTestID(`passport-slot-${key}-filled`, { timeoutMs: 3_000 });
    }
    await driver.findByTestID('passport-slot-paymentTested', { timeoutMs: 3_000 }); // empty
    // The ONE contextual next step now names a payment (the only missing capability).
    const hint = await driver.readText('passport-hint');
    assertIncludes(hint.toLowerCase(), 'payment', 'next-step hint should name a payment (the only missing stamp)');
    assert(!(await driver.isPresent('btn-passport-done')), 'incomplete passport must STILL have NO Done affordance');
    console.log('[94-trip-passport] ✓ real funds flipped it live: 3 OF 4, payment hint, no Done');
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    // …and wait for the wallet's Pay surface to be BACK before anything tries to arm it. The
    // archive is a full-screen modal; `armPayScan` below polls for the gate button and gives up
    // saying "no gate button pressed" — which is true, and says nothing about the Pay tab, because
    // the archive was still on screen (observed RED, 2026-09-01).
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 8_000 });

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
    // Observed on HOME, the one surface that renders it at all (X14) — asserting it on the Pay
    // tab would pass for the wrong reason.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.waitGone('trip-strip', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('btn-trip-strip')), 'complete journey must retire the home strip with no Done press');
    // …but the strip retires on the OPTIMISTIC in-memory award, while the archive below is a
    // FRESH `useJourney()` that re-reads the PERSISTED store when it mounts. Opening it before
    // that write lands renders a stale 3-of-4 page which no later notify ever corrects (the live
    // seam only pushes on a subsequent persist) — a permanent RED for that run, and one the host's
    // load decides. So the durable fact is what gets waited on, not the disappearance.
    await driver.waitForFunction(
      () => (localStorage.getItem('dpay.journey.v1') ?? '').includes('paymentTested'),
      { timeoutMs: 10_000, label: 'the paymentTested stamp reached the PERSISTED journey store' },
    );
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
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
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
    // A fresh boot lands on HOME (2026-09-08), which is exactly where the strip WOULD render.
    await driver.findByTestID('home-headline-amount', { timeoutMs: 8_000 });
    assert(!(await driver.isPresent('trip-strip')), 'fresh boot of complete+retired journey → no strip');
    // …but the archive still keeps the credential.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness', { timeoutMs: 4_000 });
    await driver.findByTestID('passport-archive', { timeoutMs: 5_000 });
    console.log('[94-trip-passport] ✓ fresh boot: no strip, archive intact, stamps persisted');

    // --- 7. The ∂0.00 / practice-money negative is STEP 1, not a drain. -----------------------
    // It used to live here as a D4 pin: drain the wallet to ∂0.00, roll the journey back, reload,
    // and check FUNDS LOADED stayed unfilled. That test is dead, because the thing it guarded
    // against cannot happen any more at ANY practice amount — `decideFundsReady` skips the
    // practice rail outright (X13), and step 1 above observes exactly that state for free, on a
    // wallet holding a FULL ∂100.00 rather than an empty one. D4's surviving half — the ∂0.00 row
    // dimming instead of rendering at full colour — is a pure decision and is pinned in
    // app/__tests__/assetBalances.test.ts. Draining here would also be impossible now: this wallet
    // holds real VCHF from step 2b, which is what makes it trip-ready in the first place.
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 8_000 });

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
