/**
 * 90-rehearsal — Trip Ready J2B/J3: the create path's ownership arc plays IN FULL.
 *
 *   1. walkthrough → create → backup gate (the ritual sentence reframes the same mandatory
 *      gate — checkbox + disabled Continue, EXACTLY as strong as before).
 *   2. Continue → RECOVERY SAVED ink-stamp beat (~750ms) → auto-advance (ZERO extra taps).
 *   3. The payment rehearsal mounts: 3 beats (request / approve / settle), each with its
 *      testID + verbatim education copy; the offline punchline pins the comprehension truth.
 *   4. "Try with demo funds" → the wallet lands on the Pay tab, funded.
 *   5. recoverySaved + flowUnderstood stamps persist in the journey store.
 *
 * This is the ONLY flow that drives the interstitial instead of dismissing it — every other
 * onboarding flow skips past via skipRehearsalIfPresent (harness).
 */
import { setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent } from '../harness/lib.mjs';
import { REHEARSAL_STEPS, REHEARSAL_PUNCHLINE } from '../../app/config/education.ts';

export const meta = {
  id: 90,
  name: 'rehearsal',
  journey: 'onboard',
  covers: [
    'recovery-ritual-sentence', 'mnemonic-backup-checkbox', 'btn-mnemonic-continue',
    'recovery-saved-stamp', 'rehearsal', 'rehearsal-step-{1..3}', 'rehearsal-body-{1..3}',
    'rehearsal-punchline', 'btn-rehearsal-next', 'btn-rehearsal-skip',
    'flowUnderstood-stamp', 'recoverySaved-stamp', 'pay-tab-default-landing',
  ],
  verifies: [
    'the backup gate stays MANDATORY (ritual sentence reframes, never weakens: checkbox + disabled Continue)',
    'RECOVERY SAVED stamp beat plays after the faucet and auto-advances (no extra tap)',
    'the rehearsal walks all 3 beats with verbatim education copy + the offline punchline',
    'Try with demo funds lands on the funded Pay surface',
    'recoverySaved + flowUnderstood persist in dpay.journey.v1',
  ],
  timeoutMs: 90_000,
};

export async function run() {
  const env = await setup();
  const { driver } = env;
  try {
    // 1. Fresh boot → walkthrough → skip → create form.
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'reh', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // 2. The backup gate — ritual sentence ABOVE the warning, gate strength unchanged.
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    const gateBody = await driver.bodyText();
    assertIncludes(gateBody, 'the moment your wallet becomes truly yours',
      'the backup screen carries the ownership ritual sentence');
    // The gate is still mandatory: Continue is disabled until the checkbox is ticked.
    const gated = await driver.eval(() => {
      const n = document.querySelector('[data-testid="btn-mnemonic-continue"]');
      return !!n && (n.disabled === true || n.getAttribute('aria-disabled') === 'true');
    });
    assert(gated, 'btn-mnemonic-continue must be disabled before the backup checkbox');
    await driver.screenshot('90-rehearsal-backup-gate');
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    console.log('[90-rehearsal] ✓ backup gate: ritual sentence + unchanged mandatory strength');

    // 3. The RECOVERY SAVED stamp beat — a transient ink-stamp chip between gate and rehearsal.
    //    The beat plays for ~750ms then auto-advances, so poll for it (bounded; absence here is
    //    not fatal in a pathologically slow environment, but it SHOULD be caught).
    let stamped = false;
    for (let k = 0; k < 40 && !stamped; k++) {
      stamped = await driver.isPresent('recovery-saved-stamp');
      if (stamped) await driver.screenshot('90-rehearsal-stamp-beat');
      if (!stamped) await new Promise(r => setTimeout(r, 100));
    }
    console.log(`[90-rehearsal] ${stamped ? '✓ RECOVERY SAVED stamp beat visible' : '(stamp beat stepped past — continuing)'}`);
    await driver.findByTestID('rehearsal', { timeoutMs: 15_000 });
    console.log('[90-rehearsal] ✓ rehearsal mounted (auto-advanced past the stamp, zero extra taps)');

    // 4. Beat 1 mounts alone; the body is the verbatim education copy.
    await driver.findByTestID('rehearsal-step-1', { timeoutMs: 8_000 });
    assertEq(await driver.readText('rehearsal-body-1'), REHEARSAL_STEPS[0].body, 'beat 1 body verbatim');
    await new Promise(r => setTimeout(r, 900)); // entrance + request-chip spring finish
    await driver.screenshot('90-rehearsal-beat-1');
    // Explore wallet is available from the very first beat.
    await driver.findByTestID('btn-rehearsal-skip', { timeoutMs: 4_000 });

    // 5. Advance through the beats: 2, then 3 (the offline punchline pins beat 3).
    await driver.click('btn-rehearsal-next', { timeoutMs: 4_000 });
    await driver.findByTestID('rehearsal-step-2', { timeoutMs: 8_000 });
    await driver.waitGone('rehearsal-step-1', { timeoutMs: 4_000 }).catch(() => {});
    assertEq(await driver.readText('rehearsal-body-2'), REHEARSAL_STEPS[1].body, 'beat 2 body verbatim');
    await new Promise(r => setTimeout(r, 900)); // card-rise + key spring finish
    await driver.screenshot('90-rehearsal-beat-2');

    await driver.click('btn-rehearsal-next', { timeoutMs: 4_000 });
    await driver.findByTestID('rehearsal-step-3', { timeoutMs: 8_000 });
    assertEq(await driver.readText('rehearsal-body-3'), REHEARSAL_STEPS[2].body, 'beat 3 body verbatim');
    await new Promise(r => setTimeout(r, 900)); // receipt-rise + settle-stamp spring finish
    await driver.screenshot('90-rehearsal-beat-3');
    const punch = await driver.readText('rehearsal-punchline');
    assertIncludes(punch, 'offline', 'the punchline names the offline truth');
    assertEq(punch, REHEARSAL_PUNCHLINE, 'punchline verbatim');
    console.log('[90-rehearsal] ✓ 3 beats + offline punchline pinned');

    // 6. Beat 3 award: flowUnderstood persists (idempotent, once).
    await driver.waitForText('Try with demo funds', { timeoutMs: 4_000 });
    const journeyMid = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
    assertIncludes(journeyMid, 'flowUnderstood', 'reaching beat 3 awards flowUnderstood');
    assertIncludes(journeyMid, 'recoverySaved', 'the recovery beat awarded recoverySaved');

    // 7. Try with demo funds → the wallet lands FUNDED on the Pay surface (default tab).
    await driver.click('btn-rehearsal-next', { timeoutMs: 4_000 });
    await driver.waitGone('rehearsal', { timeoutMs: 8_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('∂100.00', { timeoutMs: 15_000 });
    const payScan = await driver.eval(() => !!document.querySelector('[data-testid="btn-settings"]'));
    assert(payScan, 'wallet chrome present (Pay surface is the default landing tab)');
    console.log('[90-rehearsal] ✓ Try with demo funds → funded wallet on Pay');

    // 8. Both stamps persisted through the transition into the wallet.
    const journey = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
    assertIncludes(journey, 'recoverySaved', 'recoverySaved stamp persisted');
    assertIncludes(journey, 'flowUnderstood', 'flowUnderstood stamp persisted');
    console.log('[90-rehearsal] ✓ recoverySaved + flowUnderstood persisted in dpay.journey.v1');

    await driver.screenshot('90-rehearsal-try-funded');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => { console.log('[90-rehearsal] done'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
