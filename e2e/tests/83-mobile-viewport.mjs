// Flow 83 — Mobile viewport: the tab row (incl. Transactions) must fit a 390px phone screen.
//
// The e2e harness's default viewport is already iPhone-12-ish 390×844 — exactly the mobile-web
// width where the tab row used to overflow (~517px: 3 pills × icon+label+24px HotkeyHint badge +
// paddings). The 2026 fix: HotkeyHint hides below 700px (keyboard hints are meaningless on touch)
// + tighter tab paddings/gaps + `flexWrap` safety valve on S.tabs. This flow pins that contract:
//   (a) the DOCUMENT has no horizontal overflow (scrollWidth ≤ innerWidth), and
//   (b) the `tab-transactions` pill — the rightmost one, the one that clipped — renders and its
//       right edge is inside the viewport.
//
// Native never showed the overflow (no hotkey badges render off-web), which is why this is a
// browser-only assert. A regression here (a wider pill, a re-added badge, a dropped flexWrap)
// clips Transactions off-screen right on every phone-width web visit.
import { setup, assert, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '83',
  name: 'mobile-viewport',
  journey: 'system',
  covers: ['layout', 'viewport'],
  verifies: 'On a 390px mobile-web viewport the tab row fits: no horizontal document overflow and the Transactions tab renders fully inside the viewport.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[83-mobile-viewport] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[83-mobile-viewport] onboarding (default 390px viewport)…');
    await onboardWallet(driver, 'e2e-viewport');

    // Measure the document + every tab pill in one eval. The viewport width is asserted too so a
    // future harness viewport change fails LOUDLY here instead of silently testing a wide screen.
    const m = await driver.eval(() => {
      const rect = (testid) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height};
      };
      return {
        innerW: window.innerWidth,
        scrollW: document.documentElement.scrollWidth,
        pay: rect('tab-pay'),
        receive: rect('tab-receive'),
        transactions: rect('tab-transactions'),
      };
    });

    assert(m.innerW <= 500, `expected a phone-width viewport (innerWidth=${m.innerW}); this flow only proves layout at mobile width`);
    assert(m.scrollW <= m.innerW, `document overflows horizontally: scrollWidth=${m.scrollW} > innerWidth=${m.innerW} (a pill row or child is wider than the phone screen)`);
    console.log(`[83-mobile-viewport] ✓ no horizontal document overflow (scrollWidth ${m.scrollW} ≤ innerWidth ${m.innerW})`);

    assert(m.pay && m.receive && m.transactions, `all three tab pills must render (pay=${!!m.pay} receive=${!!m.receive} transactions=${!!m.transactions})`);
    assert(m.transactions.height > 0, 'tab-transactions rendered 0px tall — collapsed/hidden');
    for (const [name, r] of [['pay', m.pay], ['receive', m.receive], ['transactions', m.transactions]]) {
      assert(r.right <= m.innerW + 0.5, `tab-${name} clips off-screen right (right=${r.right.toFixed(1)} > innerWidth=${m.innerW})`);
    }
    console.log(`[83-mobile-viewport] ✓ Transactions pill fits (right=${m.transactions.right.toFixed(1)} ≤ ${m.innerW})`);

    await driver.screenshot('83-mobile-viewport');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[83-mobile-viewport] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[83-mobile-viewport] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
