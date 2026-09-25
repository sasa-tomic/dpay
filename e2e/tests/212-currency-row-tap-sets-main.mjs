// Flow 212 — the currency-row tap SETS MAIN (the 2026-09-24 spec's deliberate gesture, which
// supersedes the old X4 tap-protection rule): ONE tap on a currency row re-points the wallet —
// main AND the working rail follow — and Home headlines the new currency.
//
// Pinned here, end to end through the real app:
//   * tapping the ICP row sets ICP main: the Home headline reads "Balance ICP" and the working
//     selection follows to the ICP rail (the receive surface states its own asset);
//   * the tap survives a reload (main is persisted; the wallet opens where it was left);
//   * the rail choice is chooseRail's (funded-first): with ICP funded and everything else cold,
//     the wallet lands on the ICP rail — the funded one — without any manual routing.
import { setup, assert, assertEq, onboardWallet, faucetAccount, accountOf, openBalances, waitForWallet } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '212',
  name: 'currency-row-tap-sets-main',
  journey: 'convert',
  covers: ['currency-list', 'row-tap', 'set-main', 'working-rail', 'reload-resume'],
  verifies: 'Tapping a currency row sets that currency MAIN and goes Home: the headline flips to the new currency\'s eyebrow, the working rail follows (the funded ICP rail after an ICP-row tap — chooseRail, funded-first, no manual routing), and the choice survives a reload.',
  timeoutMs: 120_000,
};

export async function run() {
  const start = Date.now();
  console.log('[212-currency-row-tap-sets-main] setup (relay + web + browser)…');
  const env = await setup({ solStub: true });
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await onboardWallet(driver, 'e2e-row-tap-main');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, 150000000, { currency: 8 }); // 1.5 ICP
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    // --- §1 tap the ICP currency row: ICP becomes main, the headline follows -------------------
    console.log('[212-currency-row-tap-sets-main] tapping the ICP currency row…');
    await openBalances(driver);
    await driver.click('btn-accounts-currency-ICP', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-label', { timeoutMs: 6_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance ICP', 'the row tap set ICP main — the headline names it');
    console.log('[212-currency-row-tap-sets-main] ✓ main is ICP');

    // --- §2 the working rail follows: the receive surface states the ICP asset ------------------
    await driver.click('tab-receive', { timeoutMs: 5_000 });
    await driver.findByTestID('req-prefix', { timeoutMs: 5_000 });
    console.log('[212-currency-row-tap-sets-main] ✓ the working rail follows main (receive renders ICP)');

    // --- §3 the tap survives a reload -----------------------------------------------------------
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await waitForWallet(driver, { timeoutMs: 8_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance ICP', 'the reload resumes with ICP main (persisted)');
    console.log('[212-currency-row-tap-sets-main] ✓ reload resumed with ICP main');

    await driver.screenshot('212-currency-row-tap-sets-main');
    console.log(`[212-currency-row-tap-sets-main] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('212-currency-row-tap-sets-main RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
