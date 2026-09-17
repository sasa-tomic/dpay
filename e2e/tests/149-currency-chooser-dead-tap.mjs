// Flow 149 — the first-run currency chooser answers an early Continue instead of swallowing it
// (UX swarm 2026-09-08, defect X5).
//
// Measured on the live build: Continue rendered at 40% opacity in the PRIMARY colour, looked
// unmistakably pressable, and produced no response of any kind when tapped — no shake, no hint, no
// "pick one first". A dead end with no instruction, against the founder's 2026-08-29 hard rule,
// on the very first screen that asks the user for a decision.
//
// The no-preselect decision is NOT what changed and is not under test here — it stands
// (`docs/specs/2026-09-07-ux-decisions.md` §2). What changed is that a control which LOOKS
// pressable IS pressable and names the missing step.
//
// Selector contract: `home-currency-title`, `home-currency-pick-first`,
// `btn-home-currency-continue`, `home-currency-CHF`, `balance`.
import {setup, assert, assertEq, skipWalkthroughIfPresent, skipPracticeIfPresent, waitForEnabled, waitForWallet, WALLET_READY} from '../harness/lib.mjs';

export const meta = {
  id: '149',
  name: 'currency-chooser-dead-tap',
  journey: 'onboard',
  covers: ['home-currency', 'onboarding', 'honest-copy', 'dead-end'],
  verifies: 'Continue pressed with no currency picked answers with the missing step instead of swallowing the tap in silence; picking clears the prompt and Continue then commits.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[149-currency-chooser-dead-tap] setup (relay + web + browser)…');
  const env = await setup({ lazyBoot: false });
  try {
    const {driver} = env;

    // Walk a fresh wallet to the chooser (onboardWallet answers it for us, so this is manual).
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-chooser', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});

    // Nothing is preselected, and nothing is nagging yet.
    const preselected = await driver.eval(
      () => [...document.querySelectorAll('[data-testid^="home-currency-"]')].some(n => n.getAttribute('aria-checked') === 'true'),
    );
    assert(!preselected, 'no currency is preselected — the screen is a question, not a form');
    assert(!(await driver.isPresent('home-currency-pick-first')), 'the prompt never appears unprompted');

    // The early press: it must ANSWER, and it must not commit anything.
    await driver.click('btn-home-currency-continue', {timeoutMs: 5_000});
    const prompt = await driver.readText('home-currency-pick-first');
    assertEq(prompt, 'Tap the currency you want first, then Continue.', 'the early press names the missing step');
    assert(await driver.isPresent('home-currency-title'), 'and commits nothing — the chooser is still on screen');
    assert(!(await driver.isPresent(WALLET_READY)), 'no currency was chosen, so the wallet did not open');
    await driver.screenshot('149-currency-chooser-dead-tap');
    console.log(`[149-currency-chooser-dead-tap] ✓ early press answered: "${prompt}"`);

    // Picking clears the prompt; Continue then does exactly what it says.
    await driver.click('home-currency-CHF', {timeoutMs: 5_000});
    assert(!(await driver.isPresent('home-currency-pick-first')), 'the instruction never outlives its cause');
    await driver.click('btn-home-currency-continue', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 10_000});
    console.log('[149-currency-chooser-dead-tap] ✓ picked → Continue commits');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[149-currency-chooser-dead-tap] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[149-currency-chooser-dead-tap] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
