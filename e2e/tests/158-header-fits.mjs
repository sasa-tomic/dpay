// Flow 158 — the header fits the phone, whatever the wallet is called and whatever it holds.
//
// The header is TWO rows: [gear][theme][∂pay][username] over the account chip. It used to be ONE,
// and that is what this flow exists to keep from coming back.
//
// History, because both failures were real and the second one shipped:
//   * ONE ROW, IDENTITY WINS (fixed 2026-09-08). Neither side could yield — `headerLeft` and
//     `balBox` both default to `flexShrink: 0` in RNW and in Yoga alike — so a 22-character name
//     PUSHED the account chip off the right edge. Measured at 390 px with "Bartholomew
//     Fitzgerald": the chip's right edge at x = 410.2, 20.2 px off-viewport.
//   * ONE ROW, BALANCE WINS (fixed 2026-09-09, the founder's own report). The fix above made the
//     identity block the side that yields — and then an 8-decimal balance took the whole row and
//     yielded it to ~20 px, so "∂pay" rendered ONE GLYPH PER LINE down the left edge and the
//     eyebrow above the username wrapped to A/C/C/O/U/N/T. Measured on a physical device with
//     `3.99029806 VCHF` selected.
//
// The old version of this flow was GREEN on that second failure, because it asserted only that the
// identity block had a width `> 0`. A 20 px column satisfies that. So the assertions here are now
// about SHAPE, not mere existence: the wordmark must occupy ONE line, and the balance must sit
// BELOW it rather than beside it (founder direction, 2026-09-09: "move balance below ∂pay, to give
// it more room"). Both are read off the live layout in a real browser — this is a flexbox sizing
// fact and react-test-renderer has no layout engine.
//
// It also pins the two smaller header facts:
//   * the username may TRUNCATE on screen but `header-who` still carries the whole name (the e2e
//     identity contract every other flow reads);
//   * on Home — where the amount is deliberately not printed a second time — the chip is one line.
import { setup, assert, skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, waitForEnabled, waitForWallet } from '../harness/lib.mjs';

export const meta = {
  id: '158',
  name: 'header-fits',
  journey: 'system',
  covers: ['header', 'layout', 'overflow', 'home-tab', 'a11y'],
  verifies: 'With a long username the header stays inside the phone column and keeps its shape: the wordmark renders on ONE line (never one glyph per line), the account chip sits BELOW the identity row and spans the column, the chip stays fully on screen, and the username truncates on screen while header-who still carries the whole name. Home renders NO chip at all — it would name a different account than its own headline — and keeps its labelled Accounts pill as the single switcher.',
  timeoutMs: 40000,
};

/** The 22-character name that produced the measured 20.2 px overflow. */
const LONG_NAME = 'Bartholomew Fitzgerald';
/** `S.header`'s own horizontal padding — the chip may reach this inset and no further. */
const HEADER_PAD = 16;
/** `S.brand` is fontSize 24. One line of it is ~30 px; a two-line wrap clears 50 and the observed
 *  per-glyph collapse cleared 200. 44 leaves room for font metrics without admitting a wrap. */
const ONE_LINE_MAX = 44;

const geometry = (driver) => driver.eval(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  const who = document.querySelector('[data-testid="header-who"]');
  const brand = document.querySelector('[data-testid="link-home"]');
  return {
    who: box(who),
    brand: box(brand),
    chip: box(document.querySelector('[data-testid="balance"]')),
    viewport: innerWidth,
    whoText: who.textContent,
  };
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
    // The landing screen is Home, which carries no chip — wait for the shell, not for the chip.
    await waitForWallet(driver, { timeoutMs: 10_000 });

    // Pay and Receive both carry the chip with its amount — the widest thing the header ever holds,
    // and the tab both overflows were measured on. (Home has no chip at all; see the block below.)
    for (const [label, tab] of [['pay', 'tab-pay'], ['receive', 'tab-receive']]) {
      await driver.click(tab, { timeoutMs: 5_000 });
      await driver.findByTestID('balance', { timeoutMs: 5_000 });
      const g = await geometry(driver);

      // THE SHAPE. The wordmark on one line is the assertion the old gate was missing: it is what
      // fails the instant the identity block is squeezed by anything beside it.
      assert(g.brand.h <= ONE_LINE_MAX,
        `[${label}] the ∂pay wordmark must render on ONE line, got h=${g.brand.h} (a squeezed column wraps it per glyph)`);
      assert(g.chip.y >= g.brand.bottom - 0.5,
        `[${label}] the account chip must sit BELOW the identity row, not beside it: brand bottom=${g.brand.bottom}, chip top=${g.chip.y}`);

      // THE COLUMN. The chip owns its own row, so it spans the header — and stays inside it.
      assert(g.chip.right <= g.viewport - HEADER_PAD + 0.5,
        `[${label}] the account chip must stay inside the column: right=${g.chip.right}, viewport=${g.viewport}`);
      assert(g.chip.w >= g.viewport - 2 * HEADER_PAD - 0.5,
        `[${label}] the account chip must span the header row it now owns, got w=${g.chip.w} of ${g.viewport - 2 * HEADER_PAD}`);

      // THE NAME. It may ellipsize on screen; the DOM keeps all of it.
      assert(g.who.w > 0, `[${label}] the username must still render (${JSON.stringify(g.who)})`);
      assert(g.whoText === LONG_NAME, `[${label}] header-who must still carry the WHOLE name, got ${JSON.stringify(g.whoText)}`);
      console.log(`[158-header-fits] ✓ ${label}: wordmark h=${g.brand.h} (one line), chip below at y=${g.chip.y} w=${g.chip.w}, name intact`);
      await driver.screenshot(`158-header-fits-${label}`);
    }

    // HOME HAS NO CHIP. It is the one screen that prints its own balance, and it prints a
    // DIFFERENT one — the headline names the HOME CURRENCY while the chip names the SELECTION, and
    // the two are deliberately independent (flow 133: choosing an account must not rewrite the home
    // currency). Rendered together they put two accounts and two labels in one viewport with
    // nothing saying which is which. Since 2026-09-14 the headline block itself is the switcher
    // (`btn-home-accounts` rides the tappable balance; the old "Accounts · N" pill is gone), and
    // it is the only one — the chip's chevron was a second, unlabelled route to the same place.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('balance')),
      'Home must not render the header account chip — it names a different account than the headline');
    assert(!(await driver.isPresent('active-asset-label')),
      'Home must not carry a second account label beside its own headline');
    assert(await driver.isPresent('btn-home-accounts'),
      'Home must keep its own labelled accounts affordance — the route stays one gesture away');
    // …and the header it does render still keeps its shape.
    const home = await driver.eval(() => {
      const b = document.querySelector('[data-testid="link-home"]').getBoundingClientRect();
      return {brandH: +b.height.toFixed(1)};
    });
    assert(home.brandH <= ONE_LINE_MAX,
      `[home] the ∂pay wordmark must render on ONE line, got h=${home.brandH}`);
    console.log(`[158-header-fits] ✓ home: no chip, labelled pill kept, wordmark h=${home.brandH}`);
    await driver.screenshot('158-header-fits-home');

    console.log(`[158-header-fits] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[158-header-fits] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
