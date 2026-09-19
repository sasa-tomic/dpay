// 88 — Trip Ready J1: the first-run walkthrough (Happy Path scene→scene→Get started→create→wallet).
//
// A fresh context boots into the 3-scene walkthrough INSTEAD of the create form. This flow walks
// the full happy path:
//   1. walkthrough visible (scene 1, its key-truth body, dots, Skip, Next)
//   2. scene 1 → 2 → 3 via Next (per-scene testIDs mount one at a time; each body carries its
//      comprehension-critical phrase from config/education.ts — the ≥85% comprehension contract)
//   3. final scene: "Get started" label + the campaign send-off line
//   4. Get started → the create form appears (Logo/username/Create wallet unchanged)
//   5. create wallet ("wlk") → mnemonic backup gate → funded Wallet (Pay surface + balance)
//   6. the walkthroughDone stamp persisted (journey store readable from localStorage)
//
// Selector contract: `walkthrough`, `walkthrough-scene-1|2|3`, `walkthrough-body-1|2|3`,
// `walkthrough-dots`, `btn-walkthrough-next`, `btn-walkthrough-skip`, then the existing onboarding
// + wallet net (`username-input` by placeholder, `btn-create`, `mnemonic-backup`, `balance`).
import { setup, assert, assertIncludes, waitForEnabled, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, selectDemoAsset, waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: 88,
  name: 'First-run walkthrough happy path',
  journey: 'onboard',
  covers: ['walkthrough', 'education', 'first-run-gate', 'journey-stamps'],
  verifies: [
    'a fresh boot shows the walkthrough instead of the create form',
    'scenes advance via Next; only the active scene is mounted',
    'each scene body carries its comprehension-critical truth',
    'the final Next reads "Get started" and reveals the create form unchanged',
    'creating from there lands in the funded Wallet',
    'walkthroughDone is persisted in the journey store',
  ],
  timeoutMs: 90000,
};

export async function run() {
  const env = await setup({ lazyBoot: false });
  try {
    const { driver } = env;

    // 1. Fresh boot → the walkthrough (NOT the create form).
    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    console.log('[88-walkthrough] ✓ walkthrough mounted on fresh boot');
    const bootText = await driver.bodyText();
    assert(!bootText.includes('e.g. Alice'), 'create form must NOT show while the walkthrough is up');
    await driver.findByTestID('walkthrough-dots', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-walkthrough-skip', { timeoutMs: 5_000 });
    console.log('[88-walkthrough] ✓ dots + Skip present');

    // 2. Scene 1 — the payment sequence: the RECEIVING phone's connection can send the payment.
    await driver.findByTestID('walkthrough-scene-1', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('walkthrough-scene-2')), 'only scene 1 may be mounted');
    const body1 = await driver.readText('walkthrough-body-1');
    assertIncludes(body1, 'other phone shows a request', 'scene 1 must open with the request');
    assertIncludes(body1, 'check the amount', 'scene 1 must name the check-before-approve step');
    assertIncludes(body1, 'if yours is offline', 'scene 1 must state the other connection can send it');
    console.log('[88-walkthrough] ✓ scene 1 two-phone payment copy pinned');

    // 3. Advance → scene 2 (the key/custody truth).
    await driver.click('btn-walkthrough-next', { timeoutMs: 5_000 });
    await driver.findByTestID('walkthrough-scene-2', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('walkthrough-scene-1')), 'scene 1 must unmount on advance');
    const body2 = await driver.readText('walkthrough-body-2');
    assertIncludes(body2, 'cannot approve payments', 'scene 2 must state dpay cannot approve');
    assertIncludes(body2, 'no dpay account', 'scene 2 must state there is no dpay account');
    console.log('[88-walkthrough] ✓ scene 2 key-on-device copy pinned');

    // 4. Advance → scene 3 (the exact-asset truth) + the campaign send-off + "Get started".
    await driver.click('btn-walkthrough-next', { timeoutMs: 5_000 });
    await driver.findByTestID('walkthrough-scene-3', { timeoutMs: 5_000 });
    const body3 = await driver.readText('walkthrough-body-3');
    assertIncludes(body3, 'never swaps', 'scene 3 must state dpay never swaps another balance');
    assertIncludes(body3, 'one exact asset', 'scene 3 must state the shop asks for one exact asset');
    const finalText = await driver.readText('btn-walkthrough-next');
    assertIncludes(finalText, 'Get started', 'the final Next reads "Get started"');
    const scene3Text = await driver.bodyText();
    // The send-off strip renders the campaign line in mono uppercase — match case-insensitively.
    assertIncludes(
      scene3Text.toLowerCase(), "signal? don't need it.",
      'campaign line on the final scene');
    console.log('[88-walkthrough] ✓ scene 3 exact-asset copy + campaign line pinned');

    // 5. Get started → the existing create form, unchanged.
    await driver.click('btn-walkthrough-next', { timeoutMs: 5_000 });
    await driver.waitGone('walkthrough', { timeoutMs: 5_000 });
    await driver.typeByPlaceholder('e.g. Alice', 'wlk', { timeoutMs: 8_000 });
    const formText = await driver.bodyText();
    assertIncludes(formText, 'No account', 'create form custody line unchanged');
    console.log('[88-walkthrough] ✓ Get started reveals the create form');

    // 6. Create → backup gate → recovery beat + practice (left) → funded Wallet.
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    // The RECOVERY SAVED beat + the first-run practice payment play here; flows 152-156 pin them
    // in full, this flow just needs the funded wallet behind them.
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver);
    // The wallet opens on the chosen CURRENCY; this flow is about the DEMO rail, so say so.
    await selectDemoAsset(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
    await driver.waitForText('∂100.00', { timeoutMs: 15_000 });
    await driver.waitForText('wlk', { timeoutMs: 5_000 });
    console.log('[88-walkthrough] ✓ wallet created + funded (Pay surface)');

    // 7. The stamp persisted — the walkthrough must never show again on relaunch.
    const journey = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
    assert(journey !== null, 'journey store must be persisted');
    assertIncludes(journey, 'walkthroughDone', 'walkthroughDone stamp awarded on Get started');
    console.log('[88-walkthrough] ✓ walkthroughDone stamp persisted');

    await driver.screenshot('88-walkthrough-done');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
