/**
 * Flows 19 + 159 — the jest twins of `e2e/tests/19-low-balance.mjs` and `e2e/tests/159-lowbal-recovers.mjs`.
 *
 * Flow 19 (folded, one onboarding): OFFLINE insufficient still SIGNS (the truthful offline UX — the
 * merchant's verify is the real gate; the device-clock stamp hand-off QR goes up), while ONLINE
 * insufficient blocks BEFORE any envelope exists (`review-lowbal` names the block, no sign control
 * exists at all — C2, no doomed submit). Flow 159: the refusal is not a dead end — money arriving
 * mid-review clears the note and surfaces a DELIBERATE `btn-approve` (never a silent re-sign),
 * and the press pays the payee exactly.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, armPayScan, assert, assertIncludes, faucetAccount, generateKeypair, getBalance,
  goOffline, onboardWallet, setRelay, waitForScanner,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';
import {DpayCore} from '../harness/lib';
import {scanSeam} from './local';

const OVER_CENTS = '20000'; // ∂200.00 — exceeds the ∂100.00 faucet-funded balance
const TOP_UP_CENTS = 20_000; // credited mid-review in flow 159

function buildOverRequest(payeeHex: string): Promise<string> {
  const nonce = 'cd'.repeat(16);
  const expiry = Math.floor(Date.now() / 1000) + 600;
  return DpayCore.encodeRequest(payeeHex, OVER_CENTS, nonce, expiry, 0, 'merchant', '');
}

describe('flow 19 — low balance: offline signs with the hand-off, online blocks the sign', () => {
  it('offline ∂200 > ∂100 signs to the hand-off QR; online ∂200 shows the honest block', async () => {
    const bob = await generateKeypair();

    // Onboard against the GOOD relay (∂100 funded → balance known, online=true initially).
    const m = await onboardWallet('jest-lowbal');

    // --- 1. OFFLINE insufficient: dead relay + dead IC gateway → the sign still fires. -----------
    await goOffline(m);
    assert(await m.driver.waitForText('approx.', {timeoutMs: 8000}),
      'the header should show the offline indicator ("~ DEMO approx.") once offline');

    const offlineReq = await buildOverRequest(bob.publicHex);
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(offlineReq);
    // The sign completes without any network (the dead gateway fails fast) → the hand-off QR.
    await m.driver.findByTestID('btn-paid', {timeoutMs: 8000});
    await m.driver.findByTestID('btn-notpaid', {timeoutMs: 4000});
    expect(m.driver.isPresent('review-err')).toBe(false);

    // --- 2. ONLINE insufficient: blocked before any envelope exists. ------------------------------
    await m.driver.click('btn-notpaid', {timeoutMs: 5000});
    await setRelay(m, relayBaseURL());
    // The honest online-restored predicate: the offline indicator is GONE (the e2e twin waited for
    // the word "balance"; the indicator's absence is the same fact, expressed robustly).
    await m.driver.waitForFunction(() => !m.driver.bodyText().includes('approx.'),
      {timeoutMs: 8000, label: 'the offline indicator cleared after the relay was restored'});

    const onlineReq = await buildOverRequest(bob.publicHex);
    await waitForScanner(m);
    await m.driver.settleFrames(1);
    scanSeam()(onlineReq);
    await m.driver.findByTestID('pay-amount', {timeoutMs: 5000});
    await m.driver.findByTestID('review-lowbal', {timeoutMs: 5000});
    const note = m.driver.readText('review-lowbal');
    assertIncludes(note, 'Not enough balance to cover this payment.', 'review-lowbal should state the online block');
    expect(m.driver.isPresent('btn-approve')).toBe(false); // C2: no sign control exists at all
    expect(m.driver.isPresent('btn-paid')).toBe(false); // no offline hand-off for a blocked payment
    await m.driver.findByTestID('btn-review-cancel', {timeoutMs: 4000});
    await m.driver.click('btn-review-cancel', {timeoutMs: 4000});

    await m.unmount();
  }, 150_000);
});

describe('flow 159 — lowbal-recovers: the refusal clears when the poll reads enough', () => {
  it('∂200 arrives mid-review → the note clears, Approve appears, the press pays exactly', async () => {
    const bob = await generateKeypair();
    expect(await getBalance(bob.publicHex, 0)).toBe('0');

    const m = await onboardWallet('jest-lowbal-recover');
    const me = await accountOf(m);
    assert(me !== null && typeof me.publicHex === 'string', 'the onboarded identity must carry a publicHex');

    // --- 1. ONLINE + insufficient: refused, nothing signed, no sign control. ---------------------
    const requestQR = await buildOverRequest(bob.publicHex);
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    await m.driver.findByTestID('pay-amount', {timeoutMs: 5000});
    await m.driver.findByTestID('review-lowbal', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('review-lowbal'), 'Not enough balance to cover this payment.',
      'the online refusal must state the block, not the offline warning');
    expect(m.driver.isPresent('btn-approve')).toBe(false);

    // --- 2. The money arrives while the review is on screen (credited on the RELAY only — the
    //        review holds the selection lock, so the app's own top-up is out of reach). ----------
    const credited = await faucetAccount(me.publicHex, TOP_UP_CENTS);
    assert(credited.ok, `crediting the payer must succeed, got ${credited.status}`);

    // --- 3. The refusal clears and the payer gets a DELIBERATE press. ----------------------------
    await m.driver.findByTestID('btn-approve', {timeoutMs: 12_000});
    expect(m.driver.isPresent('review-lowbal')).toBe(false);
    await m.driver.findByTestID('pay-amount', {timeoutMs: 2000}); // still on the review — no silent re-sign

    // --- 4. The deliberate press pays. ------------------------------------------------------------
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    expect(await m.driver.waitForText('Paid', {timeoutMs: 15_000})).toBe(true);
    expect(await getBalance(bob.publicHex, 0)).toBe(String(TOP_UP_CENTS));

    await m.unmount();
  }, 150_000);
});
