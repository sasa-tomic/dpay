/**
 * Flow 01 onboard — the jest twin of `e2e/tests/01-onboard.mjs` (M1 reference port: proves the
 * full-app mount over the REAL wasm core + the REAL test-helpers relay).
 *
 * New user enters a name → the app calls DpayCore.generateKeypair (the REAL wasm core), saves the
 * identity, best-effort funds via POST /api/v1/faucet → the wallet renders ∂100.00 + empty
 * history, with the custody honesty copy intact at create + backup.
 *
 * Not ported (browser-only): the screenshot. Trimmed: none — this is the full create path.
 */
import {describe, it, expect} from '@jest/globals';
import {mountApp} from '../harness/mount';
import {
  assertIncludes, chooseHomeCurrencyIfPresent, openBalances, selectDemoAsset,
  skipPracticeIfPresent, skipWalkthroughIfPresent, waitForEnabled, waitForWallet,
} from '../harness/lib';

const USERNAME = 'jest-alice';
const PLACEHOLDER = 'e.g. Alice';

describe('flow 01 — onboard', () => {
  it('create → faucet ∂100.00 → wallet renders balance + empty history + honesty copy', async () => {
    const m = await mountApp();

    // 1. First-run walkthrough (awards walkthroughDone) — skip it so the create form is reachable.
    await skipWalkthroughIfPresent(m);

    // 1a. The username input has no testID — find by placeholder (the flow-01 contract).
    await m.driver.typeByPlaceholder(PLACEHOLDER, USERNAME, {timeoutMs: 8000});

    // 1b. The create-button subtext never solicits money; DEMO is named valueless (M7).
    const onboardBody = m.driver.bodyText();
    assertIncludes(onboardBody, 'does not deposit, buy, or move any money', 'onboarding must state creation never moves money');
    assertIncludes(onboardBody, 'practice money with no cash value', 'onboarding must state DEMO is valueless');
    // 1c. Custody honesty: no account, key never leaves the phone.
    assertIncludes(onboardBody, 'No account', 'onboarding must state there is no dpay account');
    assertIncludes(onboardBody, 'never leaves this phone', 'onboarding must state the key stays on-device');

    // 2. Create → the REAL wasm core generates the keypair → the mnemonic backup gate.
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    const backupBody = m.driver.bodyText();
    assertIncludes(backupBody, 'not even dpay can recover them', 'backup screen must state recovery is impossible without the words');
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});

    // 3. The recovery-saved beat plays, then the practice payment — leave it.
    await skipPracticeIfPresent(m);
    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 10_000});

    // 4. The faucet funded ∂100.00 through the REAL relay (the wallet opens on the home currency,
    //    so the practice rail is selected explicitly).
    await selectDemoAsset(m);
    await openBalances(m);
    const funded = await m.driver.waitForText('∂100.00', {timeoutMs: 12_000});
    expect(funded).toBe(true);

    // 5. The username shows in the wallet header.
    assertIncludes(m.driver.bodyText(), USERNAME, 'wallet header shows the onboarded username');

    // 6. Empty history: no payments settled yet → the "Recent" card does not render.
    expect(m.driver.bodyText()).not.toContain('Recent');

    await m.unmount();
  }, 60_000);
});
