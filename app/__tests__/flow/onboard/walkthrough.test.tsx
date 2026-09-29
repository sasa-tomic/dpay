/**
 * Flows 88 + 89 — the walkthrough cold-boot gate and the skip/replay semantics — the jest twins of
 * `e2e/tests/88-walkthrough.mjs` + `89-walkthrough-skip-replay.mjs`. (Walkthrough.test.tsx pins the
 * component; this ports the full-app cold-boot + persistence legs.)
 *
 * 88: fresh boot shows the walkthrough (never the create form), scene copy is pinned, Get started
 *     reveals the create form, and the walkthroughDone stamp persists.
 * 89: Skip on sight lands on the create form and awards the stamp; the PERSISTED stamp suppresses
 *     the walkthrough on the next boot; the Settings replay renders the same education copy with a
 *     close instead of a Skip and leaves the journey untouched.
 *
 * Not ported (browser-only): the screenshots. The `localStorage` eval reads go through AsyncStorage
 * (its RNW backing store — the same record the browser read).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {mountApp} from '../harness/mount';
import {
  assertIncludes, chooseHomeCurrencyIfPresent, onboardWallet,
  selectDemoAsset, skipPracticeIfPresent, waitForEnabled,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};
const journeyOf = (): Promise<string | null> => AsyncStorage.getItem('dpay.journey.v1');

hermeticDescribe('flow 88 — walkthrough', () => {
  it('cold boot gates on the walkthrough; scene copy pinned; Get started → create → funded wallet; stamp persists', async () => {
    const m = await mountApp();

    // 1. Fresh boot → the walkthrough (NOT the create form).
    await m.driver.findByTestID('walkthrough', {timeoutMs: 10_000});
    expect(m.driver.bodyText()).not.toContain('e.g. Alice');
    await m.driver.findByTestID('walkthrough-dots', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-walkthrough-skip', {timeoutMs: 5000});

    // 2. Scene 1 — the payment sequence: the RECEIVING phone's connection can send the payment.
    await m.driver.findByTestID('walkthrough-scene-1', {timeoutMs: 5000});
    expect(m.driver.isPresent('walkthrough-scene-2')).toBe(false);
    const body1 = m.driver.readText('walkthrough-body-1');
    assertIncludes(body1, 'other phone shows a request', 'scene 1 must open with the request');
    assertIncludes(body1, 'check the amount', 'scene 1 must name the check-before-approve step');
    assertIncludes(body1, 'if yours is offline', 'scene 1 must state the other connection can send it');

    // 3. Advance → scene 2 (the key/custody truth).
    await m.driver.click('btn-walkthrough-next', {timeoutMs: 5000});
    await m.driver.findByTestID('walkthrough-scene-2', {timeoutMs: 5000});
    expect(m.driver.isPresent('walkthrough-scene-1')).toBe(false);
    const body2 = m.driver.readText('walkthrough-body-2');
    assertIncludes(body2, 'cannot approve payments', 'scene 2 must state dpay cannot approve');
    assertIncludes(body2, 'no dpay account', 'scene 2 must state there is no dpay account');

    // 4. Advance → scene 3 (the exact-asset truth) + the campaign send-off + "Get started".
    await m.driver.click('btn-walkthrough-next', {timeoutMs: 5000});
    await m.driver.findByTestID('walkthrough-scene-3', {timeoutMs: 5000});
    const body3 = m.driver.readText('walkthrough-body-3');
    assertIncludes(body3, 'never swaps', 'scene 3 must state dpay never swaps another balance');
    assertIncludes(body3, 'one exact asset', 'scene 3 must state the shop asks for one exact asset');
    assertIncludes(m.driver.readText('btn-walkthrough-next'), 'Get started', 'the final Next reads "Get started"');
    // The send-off strip renders the campaign line in mono uppercase — match case-insensitively.
    assertIncludes(m.driver.bodyText().toLowerCase(), "signal? don't need it.", 'campaign line on the final scene');

    // 5. Get started → the existing create form, unchanged.
    await m.driver.click('btn-walkthrough-next', {timeoutMs: 5000});
    await m.driver.waitGone('walkthrough', {timeoutMs: 5000});
    await m.driver.typeByPlaceholder('e.g. Alice', 'wlk', {timeoutMs: 8000});
    assertIncludes(m.driver.bodyText(), 'No account', 'create form custody line unchanged');

    // 6. Create → backup gate → recovery beat + practice (left) → funded Wallet.
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    // The RECOVERY SAVED beat + the first-run practice payment play here; flows 152-156 pin them
    // in full, this flow just needs the funded wallet behind them.
    await skipPracticeIfPresent(m);
    await chooseHomeCurrencyIfPresent(m);
    await selectDemoAsset(m);
    await m.driver.waitForText('∂100.00', {timeoutMs: 15_000});
    expect(await m.driver.waitForText('wlk', {timeoutMs: 5000})).toBe(true);

    // 7. The stamp persisted — the walkthrough must never show again on relaunch.
    const journey = await journeyOf();
    expect(journey).not.toBeNull();
    assertIncludes(journey ?? '', 'walkthroughDone', 'walkthroughDone stamp awarded on Get started');

    await m.unmount();
  }, 90_000);
});

hermeticDescribe('flow 89 — walkthrough-skip-replay', () => {
  it('skip on sight → create form + stamp; persisted stamp suppresses; Settings replay has no Skip and leaves the journey alone', async () => {
    // ── Phase A — Skip on sight ─────────────────────────────────────────────────────────────
    {
      const m = await mountApp();
      await m.driver.findByTestID('walkthrough-scene-1', {timeoutMs: 10_000});
      await m.driver.click('btn-walkthrough-skip', {timeoutMs: 5000});
      await m.driver.waitGone('walkthrough', {timeoutMs: 5000});
      await m.driver.typeByPlaceholder('e.g. Alice', 'skipper', {timeoutMs: 8000});
      assertIncludes((await journeyOf()) ?? '', 'walkthroughDone', 'Skip also awards walkthroughDone');
      await m.unmount();
    }

    // ── Phase B — persisted stamp suppresses the walkthrough on the next boot ───────────────
    {
      await AsyncStorage.setItem('dpay.journey.v1', JSON.stringify({stamps: ['walkthroughDone'], at: {walkthroughDone: 1}}));
      const m = await mountApp();
      // Wait for the CREATE FORM first (proves the boot finished), then assert the walkthrough
      // never mounted — asserting absence first would race the boot.
      await m.driver.findByTestID('username-input', {timeoutMs: 10_000});
      expect(m.driver.isPresent('walkthrough')).toBe(false);
      await m.unmount();
    }

    // ── Phase C — the Settings replay ───────────────────────────────────────────────────────
    {
      const m = await onboardWallet('replayer');
      await m.driver.click('btn-settings', {timeoutMs: 5000});
      await m.driver.findByTestID('btn-how-it-works', {timeoutMs: 5000});

      await m.driver.click('btn-how-it-works', {timeoutMs: 5000});
      await m.driver.findByTestID('walkthrough-scene-1', {timeoutMs: 5000});
      assertIncludes(m.driver.readText('walkthrough-body-1'), 'other phone shows a request', 'replay renders the same education copy');
      expect(m.driver.isPresent('btn-walkthrough-skip')).toBe(false);
      await m.driver.findByTestID('btn-walkthrough-close', {timeoutMs: 5000});

      const before = await journeyOf();
      await m.driver.click('btn-walkthrough-close', {timeoutMs: 5000});
      await m.driver.waitGone('walkthrough', {timeoutMs: 5000});
      await m.driver.findByTestID('btn-how-it-works', {timeoutMs: 5000});
      expect(await journeyOf()).toBe(before);
      await m.unmount();
    }
  }, 90_000);
});
