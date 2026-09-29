/**
 * Flow 94 trip-passport — the jest twin of `e2e/tests/94-trip-passport.mjs`. (TripPassport.test.tsx
 * pins the strip component; this ports the full journey walk over the real wallet + relay.)
 *
 * Onboard WITH the practice payment made → 2 of 4 stamps (practice money earns NO fundsReady, X13);
 * the strip is Home-only and reads 2 OF 4 with the hint naming practice; a REAL VCHF balance flips
 * fundsReady live (3 OF 4, hint names a payment, still no Done); one confirmed scan-payment awards
 * paymentTested; the strip retires itself the moment readiness completes; the Settings archive
 * plays the TRIP READY capstone → Done; and a fresh boot keeps the record with no strip.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {mountApp} from '../harness/mount';
import {scaled as budgetScaled} from '../harness/budget';
import {
  accountOf, armPayScan, assertIncludes, chooseHomeCurrencyIfPresent, DpayCore, faucetAccount,
  generateKeypair, getBalance, openBalances, selectDemoAsset, skipWalkthroughIfPresent,
  waitForEnabled, waitForWallet,
} from '../harness/lib';
import {freshContext} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};

type Journey = {stamps: string[]; seen: string[]} | null;
async function readJourney(): Promise<Journey> {
  const raw = await AsyncStorage.getItem('dpay.journey.v1');
  return raw ? JSON.parse(raw) as Journey : null;
}

function randNonceHex(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

hermeticDescribe('flow 94 — trip-passport', () => {
  it('2 OF 4 after a paying first run (practice earns nothing) → real funds flip 3 OF 4 live → one payment completes it → capstone, Done, persisted', async () => {
    await freshContext();
    const m = await mountApp();

    // --- 1. Onboard WITH the practice payment made: 2 of the 4 passport stamps. ---------------
    await skipWalkthroughIfPresent(m);
    await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-passport', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    // (The RECOVERY SAVED ink-stamp beat auto-advances to practice — zero extra taps.)
    // The payment is MADE, not skipped: this flow's subject is what the passport says about a
    // wallet that has done everything first run offers.
    await m.driver.findByTestID('practice', {timeoutMs: 15_000});
    await m.driver.click('btn-practice-review', {timeoutMs: 8000});
    await m.driver.click('btn-approve', {timeoutMs: 8000});
    await m.driver.findByTestID('practice-outcome', {timeoutMs: 30_000});
    await m.driver.click('btn-practice-continue', {timeoutMs: 8000});
    await m.driver.waitGone('practice', {timeoutMs: 8000});
    await chooseHomeCurrencyIfPresent(m);
    await selectDemoAsset(m);
    await waitForWallet(m, {timeoutMs: 10_000});
    // ∂99.00, not ∂100.00: the practice payment really spent a franc of play money. The balance
    // figure lives on the accounts route (the pay scanner carries no balance text).
    await openBalances(m);
    expect(await m.driver.waitForText('∂99.00', {timeoutMs: 15_000})).toBe(true);

    const j1 = await readJourney();
    expect(j1).not.toBeNull();
    for (const s of ['walkthroughDone', 'recoverySaved', 'flowUnderstood']) {
      expect(j1!.stamps.includes(s)).toBe(true);
    }
    // X13 — the assertion of record: practice money is valueless by construction, so a FUNDS
    // LOADED stamp over it would be a claim the app has not verified (anti-scam rule R4).
    expect(j1!.stamps.includes('fundsReady')).toBe(false);
    // …and the practice payee is not a counterparty, so the FIRST PAYMENT slot stays open.
    expect(j1!.stamps.includes('paymentTested')).toBe(false);

    // --- 2. The strip (HOME ONLY since 2026-09-08): 2 filled dots; 2 OF 4; next step = FUNDS. --
    expect(m.driver.isPresent('trip-strip')).toBe(false);
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.findByTestID('trip-strip', {timeoutMs: 5000});
    for (const key of ['recoverySaved', 'flowUnderstood']) {
      await m.driver.findByTestID(`trip-strip-dot-${key}-filled`, {timeoutMs: 3000});
    }
    expect(m.driver.isPresent('trip-strip-dot-fundsReady-filled')).toBe(false);
    await m.driver.findByTestID('trip-strip-dot-paymentTested', {timeoutMs: 3000}); // empty
    await m.driver.click('btn-trip-strip', {timeoutMs: 4000});
    await m.driver.findByTestID('passport-archive', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('passport-count'), '2 of 4', 'archive count after onboarding');
    assertIncludes(m.driver.readText('passport-hint').toLowerCase(), 'practice',
      'the next-step hint names what does NOT count, so the user is not sent to the faucet again');
    expect(m.driver.isPresent('btn-passport-done')).toBe(false);
    await m.driver.click('btn-passport-close', {timeoutMs: 4000});

    // --- 2b. Fund a REAL asset → the stamp flips LIVE (no reload): 2 OF 4 → 3 OF 4. ------------
    const meNow = await accountOf(m);
    const seeded = await faucetAccount(meNow!.publicHex, 500_000_000, {currency: 7});
    expect(seeded.ok).toBe(true);
    await m.driver.findByTestID('trip-strip-dot-fundsReady-filled', {timeoutMs: 15_000});
    await m.driver.click('btn-trip-strip', {timeoutMs: 4000});
    await m.driver.findByTestID('passport-archive', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('passport-count'), '3 of 4', 'a real balance flips the archive to 3 OF 4');
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady']) {
      await m.driver.findByTestID(`passport-slot-${key}-filled`, {timeoutMs: 3000});
    }
    await m.driver.findByTestID('passport-slot-paymentTested', {timeoutMs: 3000}); // empty
    assertIncludes(m.driver.readText('passport-hint').toLowerCase(), 'payment',
      'next-step hint should name a payment (the only missing stamp)');
    expect(m.driver.isPresent('btn-passport-done')).toBe(false);
    await m.driver.click('btn-passport-close', {timeoutMs: 4000});
    // Back to the Pay surface before anything arms it (the archive is a full-screen modal).
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 8000});

    // --- 3. ONE confirmed payment (real sign + real settle; one-press auto-sign). --------------
    const bob = await generateKeypair();
    expect(Number(await getBalance(bob.publicHex, 0))).toBe(0);
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, '2500', randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob', '');
    await armPayScan(m); // pay-intent gate: arm the scan surface (no-op when already armed)
    type ScanFn = (qr: string) => void;
    (globalThis as unknown as {__DPAY_TEST_SCAN?: ScanFn}).__DPAY_TEST_SCAN!(requestQR);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);
    expect(await getBalance(bob.publicHex, 0)).toBe('2500');
    // Leave the Paid screen before opening the strip.
    await m.driver.click('btn-new', {timeoutMs: 6000});

    // --- 4. The strip is GONE the moment readiness completes; Settings → archive → capstone. ---
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.waitGone('trip-strip', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-trip-strip')).toBe(false);
    // The strip retires on the OPTIMISTIC in-memory award; the archive re-reads the PERSISTED
    // store — so the durable fact is what gets waited on, not the disappearance.
    let persisted = '';
    for (let i = 0; i < 200 && !persisted.includes('paymentTested'); i++) {
      persisted = (await AsyncStorage.getItem('dpay.journey.v1')) ?? '';
      if (!persisted.includes('paymentTested')) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    expect(persisted.includes('paymentTested')).toBe(true);
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-trip-readiness', {timeoutMs: 4000});
    await m.driver.findByTestID('passport-slot-paymentTested-filled', {timeoutMs: 5000});
    // The capstone plays on first observation of the complete page (the one-shot beat).
    await m.driver.findByTestID('trip-ready-capstone', {timeoutMs: 5000});
    assertIncludes(m.driver.bodyText().toUpperCase(), 'TRIP READY', 'capstone overlay must show TRIP READY');
    // The press lifts (~2.2s) → Done appears → closes the archive.
    await m.driver.findByTestID('btn-passport-done', {timeoutMs: 10_000});
    await m.driver.click('btn-passport-done', {timeoutMs: 4000});
    await m.driver.waitGone('passport-archive', {timeoutMs: 5000});
    await m.driver.waitGone('trip-strip', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // --- 5. Persistence: the strip never comes back; the archive keeps the record. -------------
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    expect(m.driver.isPresent('trip-strip')).toBe(false);
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-trip-readiness', {timeoutMs: 4000});
    await m.driver.findByTestID('passport-archive', {timeoutMs: 5000});
    for (const key of ['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']) {
      await m.driver.findByTestID(`passport-slot-${key}-filled`, {timeoutMs: 3000});
    }
    const archiveBody = m.driver.bodyText();
    assertIncludes(archiveBody.toUpperCase(), 'TRIP READY', 'archive must show the static TRIP READY mark');
    assertIncludes(archiveBody, 'no signal', 'archive keeps the promise line');
    await m.driver.click('btn-passport-close', {timeoutMs: 4000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // --- 6. Fresh boot with the finished journey: tripReady + retired persist; no strip. --------
    await m.remount();
    const j2 = await readJourney();
    expect(j2!.stamps.includes('paymentTested')).toBe(true);
    expect(j2!.stamps.includes('tripReady')).toBe(true);
    expect(j2!.seen.includes('passportCollapsed')).toBe(true);
    // A fresh boot lands on HOME (2026-09-08), which is exactly where the strip WOULD render.
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 8000});
    expect(m.driver.isPresent('trip-strip')).toBe(false);
    // …but the archive still keeps the credential.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-trip-readiness', {timeoutMs: 4000});
    await m.driver.findByTestID('passport-archive', {timeoutMs: 5000});

    await m.unmount();
  }, 150_000);
});
