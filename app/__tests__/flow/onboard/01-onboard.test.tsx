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
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {mountApp} from '../harness/mount';
import {
  accountOf, assertIncludes, chooseHomeCurrencyIfPresent, openBalances, selectDemoAsset,
  skipPracticeIfPresent, skipWalkthroughIfPresent, waitForEnabled, waitForWallet, onboardWallet,
} from '../harness/lib';
import {freshContext} from './helpers';

const USERNAME = 'jest-alice';
const PLACEHOLDER = 'e.g. Alice';

hermeticDescribe('flow 01 — onboard', () => {
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

hermeticDescribe('flow 02 — faucet', () => {
  it('funds ∂100 once; a second top-up inside the cooldown is refused verbatim and credits nothing', async () => {
    await freshContext();
    const m = await onboardWallet('jest-faucet');

    // The accounts route hosts the demo faucet. Onboarding spent this account's top-up.
    await openBalances(m);
    await m.driver.findByTestID('btn-topup', {timeoutMs: 4000});
    assertIncludes(m.driver.bodyText(), '∂100.00', 'onboarding must have funded ∂100.00 through the real faucet');

    // The relay refuses — the same refusal the deployed relay gives — rendered VERBATIM (N5):
    // the retry time, not a generic failure.
    await m.driver.click('btn-topup', {timeoutMs: 4000});
    await m.driver.findByTestID('topup-err', {timeoutMs: 8000});
    const said = m.driver.readText('topup-err');
    expect(said).toMatch(/faucet cooldown: try again in ~\d+ (h|min|s)/);

    // Nothing was credited. A refusal that moved the number would be worse than the refusal.
    const body = m.driver.bodyText();
    expect(body).toContain('∂100.00');
    expect(body).not.toContain('∂200.00');

    await m.unmount();
  }, 60_000);
});

hermeticDescribe('flow 23 — username-default', () => {
  it('creates with an empty username → defaults to "me", onboards + funds ∂100', async () => {
    await freshContext();
    const m = await mountApp();
    await skipWalkthroughIfPresent(m);

    // M6 — the username input carries a testID (the pre-split audit reported it missing). Prove it.
    await m.driver.findByTestID('username-input', {timeoutMs: 8000});
    await m.driver.typeByPlaceholder('e.g. Alice', '', {timeoutMs: 8000});

    // Click Create directly — the app defaults the empty name to 'me'.
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    await skipPracticeIfPresent(m);

    // The wallet mounts + the faucet funds ∂100 (the real relay path, same as flow 01).
    await chooseHomeCurrencyIfPresent(m);
    await selectDemoAsset(m);
    await waitForWallet(m, {timeoutMs: 10_000});
    await openBalances(m);
    const funded = await m.driver.waitForText('∂100.00', {timeoutMs: 12_000});
    expect({funded, body: m.driver.bodyText().slice(0, 120)}).toEqual({funded: true, body: expect.any(String)});

    // M6 — the default 'me' username was persisted to the stored identity (asserted directly,
    // independent of how the header renders the name).
    expect((await accountOf(m))?.username).toBe('me');

    await m.unmount();
  }, 60_000);
});
