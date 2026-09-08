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
import {setup, assert, assertIncludes, skipWalkthroughIfPresent, getBalance, accountOf, armPayScan, chooseHomeCurrencyIfPresent, selectDemoAsset } from '../harness/lib.mjs';
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
    // Entrance rise finish, in FRAMES not milliseconds (flow 90's idiom): `rehearsal-body-3` holds
    // the longest `Animated` delay on the page, so its coming to rest means the whole rise is over.
    await driver.waitAtRest('rehearsal-body-3', { timeoutMs: 8_000 });
    // (One-page rehearsal: all 3 steps mounted together — mounting awards flowUnderstood.)
    await driver.waitForText('Choose my currency', { timeoutMs: 4_000 });
    await driver.click('btn-rehearsal-next', { timeoutMs: 4_000 }); // "Choose my currency"
    await driver.waitGone('rehearsal', { timeoutMs: 8_000 });
    await chooseHomeCurrencyIfPresent(driver);
    // The wallet opens on the chosen CURRENCY; this flow is about the DEMO rail, so say so.
    await selectDemoAsset(driver);
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
    // …and wait for the wallet's Pay surface to be BACK before anything tries to arm it. The
    // archive is a full-screen modal; `armPayScan` below polls for the gate button and gives up
    // saying "no gate button pressed" — which is true, and says nothing about the Pay tab, because
    // the archive was still on screen (observed RED, 2026-09-01).
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

    // --- 7. D4 pin: a wallet holding ∂0.00 must NOT wear FUNDS LOADED. ------------------------
    // `fundsReady` is decided from the LIVE balance map (decideFundsReady over buildAssetBalances),
    // and `demoView` used to report ANY demo amount — 0 included — as a funded 'ok', so an empty
    // wallet stamped itself and the strip's third dot filled (measured 2026-09-08; spec §0 D4).
    // The stamp is one-way, so the decision can only be observed again on a wallet that has money
    // to lose and a journey that has not yet earned it: pay the balance to zero, roll the journey
    // back to the two stamps that do not depend on money, and reload into a live re-decision.
    console.log('[94-trip-passport] D4: draining to ∂0.00 and re-deciding fundsReady…');
    // Step 6 left the archive open inside Settings; close both and wait for the Pay surface to be
    // back before arming it (the same full-screen-modal trap step 2 documents).
    await driver.click('btn-passport-close', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 8_000 });
    const me = await accountOf(driver);
    const rest = await getBalance(relayBaseURL, me.publicHex, 0);
    assert(Number(rest) > 0, `the payer must still hold demo funds to drain (got ${rest})`);
    const sink = await generateKeypair();
    const drainQR = buildRequestQR(sink.publicHex, Number(rest), randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Sink');
    await armPayScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, drainQR);
    await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(String(await getBalance(relayBaseURL, me.publicHex, 0)) === '0', 'the payer must be drained to exactly 0');
    await driver.click('btn-new', { timeoutMs: 6_000 });

    // Roll the journey back to what a never-funded wallet would hold, then reload so the strip and
    // the funds decision both run fresh against the (now empty) balances.
    await driver.eval(() => {
      const now = Date.now();
      localStorage.setItem('dpay.journey.v1', JSON.stringify({
        stamps: ['walkthroughDone', 'recoverySaved', 'flowUnderstood'],
        at: {walkthroughDone: now, recoverySaved: now, flowUnderstood: now},
        seen: [],
      }));
    });
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    await selectDemoAsset(driver);
    await driver.waitForText('∂0.00', { timeoutMs: 15_000 });
    await driver.findByTestID('trip-strip', { timeoutMs: 5_000 });
    // The two money-independent capabilities stay filled; FUNDS LOADED does not, and must not fill
    // on any later poll either — the wallet is empty and the app has to say so.
    for (const key of ['recoverySaved', 'flowUnderstood']) {
      await driver.findByTestID(`trip-strip-dot-${key}-filled`, { timeoutMs: 3_000 });
    }
    await driver.findByTestID('trip-strip-dot-fundsReady', { timeoutMs: 3_000 });
    assert(!(await driver.isPresent('trip-strip-dot-fundsReady-filled')),
      'a wallet holding ∂0.00 must NOT fill the FUNDS LOADED dot (D4)');
    const j3 = await readJourney(driver);
    assert(!j3.stamps.includes('fundsReady'), `an empty wallet must not stamp fundsReady (got ${j3.stamps.join(',')})`);
    console.log('[94-trip-passport] ✓ D4: ∂0.00 leaves FUNDS LOADED unfilled and unstamped');

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
