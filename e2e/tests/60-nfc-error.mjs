// Flow 60 — NFC tap ERROR + DECLINED phases (the failure modes flow 11's happy path doesn't cover).
//
// Flow 11 proves the happy phase transitions (listening → linking → exchanging → success). But the
// NFC transport has THREE terminal failure phases that a real tap can hit, none of which were covered:
//   - `error`    : a transport failure mid-tap (the phones separated, the radio glitched, the HCE
//                  service threw). `useNfcTapState` maps a `{type:'error', reason}` event to
//                  `finalize('error', reason)` — but ONLY if no outcome is committed yet (a transport
//                  error after the wire left the phone says nothing about whether the ledger settled;
//                  the hook deliberately does NOT overwrite a decided outcome with a false failure).
//   - `declined` : a fail-closed leg auto-declined the tap (one-press rule, founder directive
//                  2026-08-24: no review card exists anymore — an UNSUPPORTED asset or an EXPIRED
//                  request declines itself at validation/sign time, before any envelope builds).
//
// This flow drives the REAL NfcTap state machine (via the same `__DPAY_TEST_NFC_SESSION` seam flow
// 11 uses) through `error` and `declined`, asserting for each:
//   1. the honest status title renders ("Tap failed" / "Declined") — NEVER a fake "Paid ✓";
//   2. the `nfc-status` testID mounts (NfcTapView is the surface);
//   3. the payer's balance is UNCHANGED (no money moved on a failed/declined tap);
//   4. the Done button is reachable (terminal phase → the user escapes cleanly).
//
// The `error`-after-`settling` guard (the "don't overwrite a decided outcome" rule, line 112 of
// useNfcTapState) is also asserted: once `settling` fired (committed=true), a late `error` event is
// IGNORED — the phase stays on the settlement path, not a false failure. This is the subtle correctness
// property that separates an honest transport glitch from a real funds loss.
//
// Selector contract: `nfc-status` (the NfcTapView surface), `balance` (unchanged), the Done link
// (aria-label="Done" — terminal-phase Cancel flips its label).
import {setup, assert, onboardWallet, armNfcCard} from '../harness/lib.mjs';

export const meta = {
  id: '60',
  name: 'nfc-error',
  journey: 'nfc',
  covers: ['nfc-error', 'nfc-declined', 'nfc-phases', 'error-handling', 'no-fake-paid', 'terminal-escape', 'fail-closed'],
  verifies: 'NFC tap failure modes: a mid-tap transport error surfaces honest "Tap failed" (not Paid ✓); an unsupported-asset request auto-declines "Declined" + honest reason (fail-closed, no sign); a late error after settling is ignored (no false failure over a decided outcome).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[60-nfc-error] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts so the Pay screen arms the HCE
    // card (NfcTap is live + listening for seam-dispatched events).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[60-nfc-error] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-nfc-err');
    await driver.findByTestID('pay-scan', {timeoutMs: 5_000});

    // Helper: dispatch one NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };
    // Escape a terminal/non-terminal NfcTapView: the button flips its label to "Done" on a terminal
    // phase (success/declined/error/pending) and stays "Cancel" mid-flow (settling). Dispatching a
    // phase only QUEUES a React update, so reading the DOM in the same tick can still see the OLD
    // label — a race that only loses on a loaded machine. Poll for the EXPECTED label (bounded),
    // then click it; if it never arrives, return whichever label is present so the caller's assert
    // names what it actually saw.
    const clickNfcButton = async (expected) => {
      for (let i = 0; i < 40; i++) {
        const hit = await driver.eval((label) => {
          const btn = document.querySelector(`button[aria-label="${label}"]`);
          if (btn) { btn.click(); return label; }
          return null;
        }, expected);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      return driver.eval(() => {
        for (const label of ['Done', 'Cancel']) {
          if (document.querySelector(`button[aria-label="${label}"]`)) return label;
        }
        return null;
      });
    };

    // --- 1. TRANSPORT ERROR mid-tap (linking → error): honest "Tap failed", no fake Paid. -------
    console.log('[60-nfc-error] case 1: transport error mid-tap (linking → error)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    // The error event carries a reason; the hook surfaces it as the status sub-line.
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    const errTitle = await driver.waitForText('Tap failed', {timeoutMs: 5_000});
    assert(errTitle, 'a mid-tap transport error should surface the honest "Tap failed" status');
    const errBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(errBody), 'a failed tap must NEVER show "Paid ✓" (no false success)');
    assert(errBody.includes('Lost the radio link'), `the error reason should render as the sub-line. body excerpt:\n${errBody.slice(0, 400)}`);
    // The payer's balance is UNCHANGED — no money moved on a failed tap.
    const balAfterErr = await driver.readText('balance');
    assert(balAfterErr.includes('∂100.00'), `balance must be unchanged after a failed tap, got "${balAfterErr}"`);
    console.log('[60-nfc-error] ✓ transport error → "Tap failed" + reason, no debit, no fake Paid');
    // Escape the terminal view so the next case starts clean (Done re-arms the card).
    assert((await clickNfcButton('Done')) === 'Done', 'the Done button should be reachable after a terminal error');
    await driver.waitGone('nfc-status', {timeoutMs: 5_000});

    // --- 2. FAIL-CLOSED AUTO-DECLINE (unsupported asset — no review card to decline from). ------
    // A request carrying currency 99 (not in the catalog) auto-declines at validation: declineCard
    // fires + terminal "Declined" + "Unsupported asset (currency 99)". No sign ever fires (no wire).
    console.log('[60-nfc-error] case 2: unsupported-asset request auto-declines (fail-closed)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '5000', nonceHex: 'cd'.repeat(16),
      expiry: Math.floor(Date.now() / 1000) + 240, currency: 99,
    });
    const declTitle = await driver.waitForText('Declined', {timeoutMs: 5_000});
    assert(declTitle, 'an unsupported-asset request should auto-decline to the honest "Declined" status');
    const declBody = await driver.bodyText();
    assert(declBody.includes('Unsupported asset (currency 99)'), `the fail-closed reason should render. body excerpt:\n${declBody.slice(0, 400)}`);
    assert(!/\bPaid\b/.test(declBody), 'a declined tap must NEVER show "Paid ✓"');
    const wire = await driver.eval(() => window.__DPAY_TEST_NFC_APPROVED_WIRE);
    assert(wire == null, 'no wire may exist for a fail-closed decline (nothing signed)');
    const balAfterDecl = await driver.readText('balance');
    assert(balAfterDecl.includes('∂100.00'), `balance must be unchanged after a declined tap, got "${balAfterDecl}"`);
    console.log('[60-nfc-error] ✓ auto-decline → "Declined" + "Unsupported asset (currency 99)", no wire, no debit, no fake Paid');
    assert((await clickNfcButton('Done')) === 'Done', 'the Done button should be reachable after a decline');
    await driver.waitGone('nfc-status', {timeoutMs: 5_000});

    // --- 3. LATE error AFTER settling is IGNORED (no false failure over a decided outcome). -----
    // Once the wire left the phone (settling → committed=true), a transport error says nothing about
    // whether the ledger settled. useNfcTapState (line 112) deliberately IGNORES a late `error` so a
    // radio glitch can't mask a real success. We drive settling, fire a late error, and assert the
// phase does NOT flip to 'error' (settlement owns the outcome after envelope delivery).
    console.log('[60-nfc-error] case 3: late error after settling is ignored (no false failure)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('nfc-status', {timeoutMs: 4_000});
    await dispatch({type: 'phase', role: 'card', phase: 'exchanging'});
    await dispatch({type: 'phase', role: 'card', phase: 'settling'}); // committed=true
    await driver.waitForText('Confirming', {timeoutMs: 4_000});
    // Fire the late error — it MUST be ignored (committed=true).
    await dispatch({type: 'error', role: 'card', reason: 'should be ignored'});
    // STALE-ASSERTION FIX: a bare waitForText('Confirming') would resolve on the FIRST poll — catching
    // the pre-render DOM before the error's effect (if any) could flip the phase. The app is given
    // its turn in FRAMES, not milliseconds: React commits at most once per rendered frame, so ten
    // frames is ten chances for the bug to show itself — the same ten whether the host is idle or
    // saturated, whereas a 500ms sleep bought thirty chances on an idle box and possibly two on a
    // loaded one. Then we snapshot the post-flush DOM: if the bug existed (error overwrites the
    // decided phase), "Confirming" would be gone.
    await driver.settleFrames(10);
    const bodyAfterLate = await driver.bodyText();
    assert(bodyAfterLate.includes('Confirming'), 'a late error after settling must NOT overwrite the settlement path (no false "Tap failed")');
    assert(!bodyAfterLate.includes('should be ignored'), 'the late-error reason must NOT render (the error was ignored)');
    assert(!/Tap failed/.test(bodyAfterLate), 'a late error must NOT flip the status to "Tap failed"');
    console.log('[60-nfc-error] ✓ late error after settling ignored — settlement remains authoritative');
    assert((await clickNfcButton('Cancel')) === 'Cancel', 'the Cancel button should be reachable while settling');

    await driver.screenshot('60-nfc-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[60-nfc-error] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[60-nfc-error] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
