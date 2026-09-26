// validate-r1d-capture.mjs — post-fix verification: sentence-case surfaces + the CTA fold check.
import {
  setup, stopSession, onboardWallet, accountOf, faucetAccount,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent,
  waitForEnabled, openConvertFor, typeConvertAmount,
} from './harness/lib.mjs';
import { startRelay } from './harness/relay.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const env = await setup({ lazyBoot: false });
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    await driver.screenshot('r1d-walkthrough');
    await skipWalkthroughIfPresent(driver);
    await driver.findByTestID('btn-create', { timeoutMs: 8_000 });
    await driver.typeByPlaceholder('e.g. Alice', 'r1d', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.findByTestID('practice', { timeoutMs: 15_000 });
    await sleep(1_200);
    await driver.screenshot('r1d-practice');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title', { timeoutMs: 10_000 });
    await chooseHomeCurrencyIfPresent(driver);

    const acct = await accountOf(driver);
    const a = await faucetAccount(r2.baseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!a?.ok) throw new Error(`ICP faucet failed (${a?.status})`);
    await driver.click('tab-home', { timeoutMs: 8_000 });
    await sleep(1_000);
    await driver.screenshot('r1d-home');

    await openConvertFor(driver, 'icp');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 15_000 });
    await typeConvertAmount(driver, '1');
    await sleep(500);
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(300);
    await driver.screenshot('r1d-sheet');
    const fold = await driver.eval(() => {
      const cta = document.querySelector('[data-testid="btn-convert-confirm"]');
      const win = { h: window.innerHeight, w: window.innerWidth };
      if (!cta) return { present: false, win };
      const r = cta.getBoundingClientRect();
      return { present: true, top: Math.round(r.top), bottom: Math.round(r.bottom), ctaH: Math.round(r.height), win };
    });
    console.log(`[r1d] CTA fold check (viewport ${fold.win.w}x${fold.win.h}): ` +
      (fold.present ? `CTA top=${fold.top} bottom=${fold.bottom} h=${fold.ctaH} → ${fold.bottom <= fold.win.h ? 'VISIBLE at entry' : 'BELOW FOLD'}` : 'absent'));
    await driver.screenshot('r1d-sheet-bottom');
    await driver.eval(() => document.querySelector('[data-testid="btn-convert-confirm"]')?.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await driver.screenshot('r1d-cta');
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
console.log('[r1d] done.');
await stopSession();
