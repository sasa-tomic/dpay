// Flow 93 — functional tap-state motion (Trip Ready J5), both rails.
//
// Walks the NFC phases through the real event seams (IC: __DPAY_TEST_NFC_SESSION flow-11
// pattern; SOL: __DPAY_TEST_SOL_NFC_SESSION flow-47 pattern) and asserts EVERY phase keeps its
// textContent contract (the strings are e2e-pinned) while the new motion beats mount exactly
// when they should: listening breath, per-phase itinerary segments, the awaitingApproval key
// beat, the success passport stamp — and the HONESTY rule: pending shows NO stamp mark and NO
// campaign line anywhere.
//
// No real signing fires on the IC side (pure UI-phase proof, exactly flow 11); the SOL side
// stops before the request event (the reader halves of both rails are flow 86/87's job).
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '93',
  name: 'tap-motion',
  journey: 'nfc',
  covers: ['nfc-phases', 'event-bus', 'delight-motion', 'honesty-guard'],
  verifies: 'every NFC phase renders its pinned textContent + its own motion beat (breath/segments/key/stamp/ellipsis/shake); pending carries no stamp mark and no campaign line (honesty)',
  timeoutMs: 30_000,
};

const has = (driver, testID) => driver.eval((id) => document.querySelector(`[data-testid="${id}"]`) !== null, testID);

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] tap-state motion: IC + SOL rails`);
  const env = await setup();
  try {
    const { driver } = env;

    // ============================== IC rail (nfc-status) ======================================
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-nfc');
    await driver.findByTestID('pay-scan', {timeoutMs: 5_000});
    const icDispatch = (event) => driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event);

    // listening → the breathing ring mounts with the pinned copy (flow 11's "not-a-dpay-phone"
    // surface stays: NfcTap takes over ONLY on linking).
    await icDispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    assert(await driver.waitForText('Connecting', {timeoutMs: 4_000}), 'linking shows "Connecting…"');
    assert(await has(driver, 'tap-progress'), 'linking mounts the itinerary line');
    assert(await has(driver, 'tap-progress-seg-1'), 'linking lights segment 1');
    assert(!await has(driver, 'tap-progress-seg-2'), 'linking must not light segment 2');
    assert(!await has(driver, 'tap-success-stamp'), 'no success stamp while linking');
    await driver.screenshot('93-tap-motion-linking');

    await icDispatch({type: 'phase', role: 'card', phase: 'exchanging'});
    assert(await driver.waitForText('Communicating', {timeoutMs: 4_000}), 'exchanging shows "Communicating…"');
    assert(await has(driver, 'tap-progress-seg-2'), 'exchanging lights segment 2');
    assert(!await has(driver, 'tap-progress-seg-3'), 'exchanging must not light segment 3');

    // awaitingApproval → the quiet key beat (no spinner); line holds at 2.
    await icDispatch({type: 'phase', role: 'card', phase: 'awaitingApproval'});
    assert(await driver.waitForText('Authorizing', {timeoutMs: 4_000}), 'awaitingApproval shows "Authorizing…"');
    assert(await has(driver, 'tap-key-beat'), 'awaitingApproval mounts the key beat');
    assert(!await has(driver, 'tap-progress-seg-3'), 'awaitingApproval holds at 2 segments');
    await driver.screenshot('93-tap-motion-key');

    await icDispatch({type: 'phase', role: 'card', phase: 'settling'});
    assert(await driver.waitForText('Confirming', {timeoutMs: 4_000}), 'settling shows "Confirming…"');
    assert(await has(driver, 'tap-progress-seg-3'), 'settling lights segment 3');

    // success → the passport stamp mounts. No request ever fired, so formattedAmt is null and
    // computeTapStatus titles the card success 'Paid ✓' (the pinned contract; 'Done ✓' is only
    // the unused TAP_PHASES fallback). NO peak (this session is ONLINE — goOffline never ran).
    await icDispatch({type: 'phase', role: 'card', phase: 'success'});
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 4_000}), 'success shows "Paid ✓"');
    assert(await has(driver, 'tap-success-stamp'), 'success mounts the passport stamp');
    assert(!await has(driver, 'offline-peak'), 'no offline peak on an online session');
    assert(!await has(driver, 'tap-progress'), 'success clears the itinerary line');
    await driver.screenshot('93-tap-motion-success-ic');
    // Close the terminal view to re-arm for the pending walk (the ghost Done button — no testID).
    await driver.eval(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((b) => (b.textContent || '').includes('Done'))?.click();
    });

    // pending → deliberate STILLNESS: ellipsis pulse, NO stamp, NO campaign line, no line/breath.
    await icDispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    await icDispatch({type: 'phase', role: 'card', phase: 'pending'});
    assert(await driver.waitForText('Not confirmed', {timeoutMs: 4_000}), 'pending shows "Not confirmed"');
    assert(await has(driver, 'tap-ellipsis'), 'pending mounts the stillness ellipsis');
    assert(!await has(driver, 'tap-success-stamp'), 'HONESTY: pending must not carry the stamp mark');
    assert(!await has(driver, 'paid-stamp'), 'HONESTY: pending must not carry the paid stamp');
    assert(!await has(driver, 'offline-peak'), 'HONESTY: pending must not carry the peak');
    assert(!(await driver.bodyText()).includes('Roaming off'), 'HONESTY: no campaign line on pending');
    await driver.screenshot('93-tap-motion-pending');

    // declined → restrained shake-settle; still no stamp/campaign.
    await icDispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    await icDispatch({type: 'phase', role: 'card', phase: 'declined'});
    assert(await driver.waitForText('Declined', {timeoutMs: 4_000}), 'declined shows "Declined"');
    assert(await has(driver, 'tap-shake'), 'declined mounts the restrained shake-settle');
    assert(!await has(driver, 'tap-success-stamp'), 'HONESTY: declined must not carry the stamp mark');
    assert(!(await driver.bodyText()).includes('Roaming off'), 'HONESTY: no campaign line on declined');
    await driver.screenshot('93-tap-motion-declined');
    console.log(`[${meta.name}] ✓ IC rail: all phases + honesty guards`);

    // ============================== SOL rail (sol-nfc-status) ==================================
    // Same wallet → Balances → SOL (flow 47's selection path) → SOL scan arms SolNfcTap.
    // Dismiss the declined terminal view first (the ghost Done button — no testID, by design).
    await driver.eval(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((b) => (b.textContent || '').includes('Done'))?.click();
    });
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    const solDispatch = (event) => driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event);

    await solDispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    assert(await driver.waitForText('Connecting', {timeoutMs: 4_000}), 'SOL linking shows "Connecting…"');
    assert(await has(driver, 'tap-progress-seg-1'), 'SOL rail shares the itinerary line');
    await solDispatch({type: 'phase', role: 'card', phase: 'awaitingApproval'});
    assert(await driver.waitForText('Authorizing', {timeoutMs: 4_000}), 'SOL awaitingApproval shows "Authorizing…"');
    assert(await has(driver, 'tap-key-beat'), 'SOL rail shares the key beat');
    await solDispatch({type: 'phase', role: 'card', phase: 'success'});
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 4_000}), 'SOL success shows "Paid ✓"');
    assert(await has(driver, 'tap-success-stamp'), 'SOL success mounts the same passport stamp (parity)');
    assert(!await has(driver, 'offline-peak'), 'no peak on the SOL rail (SOL excluded — honest)');
    await driver.screenshot('93-tap-motion-success-sol');
    console.log(`[${meta.name}] ✓ SOL rail: motion parity + no peak`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${meta.name}] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[${meta.name}] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
