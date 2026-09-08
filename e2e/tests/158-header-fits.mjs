// Flow 158 — the header fits the phone, whatever the wallet is called (X18).
//
// The header row is [gear][theme][∂pay / ACCOUNT / username] … [account chip]. Before this, the
// identity block was sized to the username and neither side could yield: both `headerLeft` and
// `balBox` default to `flexShrink: 0` in RNW and in Yoga alike. A 22-character name therefore
// PUSHED the account chip — the balance and the account switcher — off the right edge. Measured
// at 390 px with "Bartholomew Fitzgerald": the chip's right edge at x = 410.2 (20.2 px
// off-viewport) on every tab that shows an amount, in both themes, with the identity block and
// the chip flush at 0 px apart.
//
// A real browser is the only place this is visible: it is a flexbox sizing fact, and
// react-test-renderer has no layout engine. So the assertions here are GEOMETRY, read off the live
// layout, and they hold for a name long enough to force the squeeze.
//
// It also pins the two smaller header facts the same change settles:
//   * the username may TRUNCATE on screen but `header-who` still carries the whole name (the e2e
//     identity contract every other flow reads);
//   * on Home — where the amount is deliberately not printed a second time — the chevron sits
//     beside the account name instead of alone in a 16 px row of its own.
import { setup, assert, skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, waitForEnabled } from '../harness/lib.mjs';

export const meta = {
  id: '158',
  name: 'header-fits',
  journey: 'system',
  covers: ['header', 'layout', 'overflow', 'home-tab', 'a11y'],
  verifies: 'With a long username the header stays inside the phone column: the account chip is fully on screen, the identity block and the chip keep a real gap, the username truncates on screen while header-who still carries the whole name, and on Home the account chevron sits beside the label rather than alone in a row of its own.',
  timeoutMs: 40000,
};

/** The 22-character name that produced the measured 20.2 px overflow. */
const LONG_NAME = 'Bartholomew Fitzgerald';
/** `S.header`'s own horizontal padding — the chip may reach this inset and no further. */
const HEADER_PAD = 16;

const geometry = (driver) => driver.eval(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) }; };
  const who = document.querySelector('[data-testid="header-who"]');
  const identity = box(who.parentElement);
  const chip = box(document.querySelector('[data-testid="balance"]'));
  return { identity, chip, gap: +(chip.x - identity.x - identity.w).toFixed(1), viewport: innerWidth, whoText: who.textContent };
});

export async function run() {
  const start = Date.now();
  console.log('[158-header-fits] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', LONG_NAME, { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver, 'CHF');
    await driver.findByTestID('balance', { timeoutMs: 10_000 });

    // Both the tab that hides the header amount (Home) and one that shows it (Pay) — the amount is
    // the widest thing the chip ever carries, so it is the tab the overflow was measured on.
    for (const [label, tab] of [['home', 'tab-home'], ['pay', 'tab-pay']]) {
      await driver.click(tab, { timeoutMs: 5_000 });
      await driver.findByTestID('balance', { timeoutMs: 5_000 });
      const g = await geometry(driver);
      assert(g.chip.right <= g.viewport - HEADER_PAD + 0.5,
        `[${label}] the account chip must stay inside the column: right=${g.chip.right}, viewport=${g.viewport}`);
      assert(g.identity.x > 0 && g.identity.w > 0, `[${label}] the identity block must still render (${JSON.stringify(g.identity)})`);
      assert(g.gap >= 8, `[${label}] the identity block and the account chip must keep a real gap, got ${g.gap}px`);
      assert(g.whoText === LONG_NAME, `[${label}] header-who must still carry the WHOLE name, got ${JSON.stringify(g.whoText)}`);
      console.log(`[158-header-fits] ✓ ${label}: chip right=${g.chip.right} ≤ ${g.viewport - HEADER_PAD}, gap=${g.gap}px, name intact`);
      await driver.screenshot(`158-header-fits-${label}`);
    }

    // On Home the amount is not printed a second time, so the chevron joins the label's row: the
    // chip is ONE line tall. (On Pay it is two — label over amount — which the loop above just saw.)
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    const home = await geometry(driver);
    assert(home.chip.h <= 20,
      `on Home the chip must be a single line (label + chevron), got h=${home.chip.h} — an empty amount row is back`);
    console.log(`[158-header-fits] ✓ home chip is one line (h=${home.chip.h})`);

    console.log(`[158-header-fits] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[158-header-fits] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
