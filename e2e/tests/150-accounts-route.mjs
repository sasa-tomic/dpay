// Flow 150 — the currency list is ONE gesture from every screen, and it is a ROUTE.
//
// The founder's ask when Home stopped being the currency list: "the list of currencies should
// still be easily accessible." The literal answer is the header account chip, which renders on
// every surface INCLUDING the Pay scanner — so this flow starts on the scanner, the screen a
// traveller is actually standing on at a till.
//
// It also pins what makes the list a route rather than the modal it used to be:
//   (a) one tap on the header chip, from the Pay scanner, opens it;
//   (b) every enabled asset renders, zero-balance rows included — the asset-first rule survives
//       the move (nothing is behind a positive-balance condition);
//   (c) Back returns to the surface it was opened FROM, not to a hardcoded Home;
//   (d) no modal overlay is mounted and the bottom navigation stays reachable — a modal would
//       trap focus and swallow the tabs, which is why this is not one;
//   (e) the `a` hotkey and the Home affordance reach the same route.
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '150',
  name: 'accounts-route',
  journey: 'system',
  covers: ['accounts-route', 'balances', 'one-gesture', 'zero-balance-visible'],
  verifies: 'The currency list is one gesture from every screen: the header balance chip on the Pay scanner opens the Accounts route, every enabled asset including zero-balance rows renders, Back returns to the surface it was opened from, no modal overlay is mounted, and the `a` hotkey plus the Home affordance reach the same route.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[150-accounts-route] setup (relay + web + browser)…');
  const env = await setup({solStub: true});
  try {
    const { driver } = env;

    console.log('[150-accounts-route] onboarding…');
    await onboardWallet(driver, 'e2e-accounts-route');

    // (a) Standing on the Pay scanner — the till surface — ONE tap on the header chip.
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('pay-scan')), 'the accounts route replaces the surface, it does not float over it');
    console.log('[150-accounts-route] ✓ one tap from the Pay scanner opened the accounts route');

    // (b) Every enabled asset, zero balances included. The wallet is cold apart from the practice
    //     faucet, so all but one row read zero — and all of them are here.
    for (const key of ['vchf', 'icp', 'ckbtc', 'ckusdc', 'cketh', 'sol', 'demo']) {
      assert(await driver.isPresent(`asset-${key}`), `asset-${key} must render in the accounts route`);
    }
    assertIncludes(await driver.readText('asset-icp'), '0 ICP', 'a zero-balance row states its zero honestly');
    console.log('[150-accounts-route] ✓ every enabled asset renders, zero-balance rows included');

    // (d) It is a ROUTE: no modal overlay, and the bottom navigation is still there. A modal would
    //     render role="dialog" over the wallet and take the tabs away with it.
    const dialogs = await driver.eval(() => document.querySelectorAll('[role="dialog"]').length);
    assert(Number(dialogs) === 0, `no modal overlay may be mounted for the accounts route (found ${dialogs})`);
    await driver.findByTestID('tab-pay', { timeoutMs: 3_000 });
    await driver.findByTestID('tab-home', { timeoutMs: 3_000 });
    console.log('[150-accounts-route] ✓ no modal overlay; the bottom navigation stays reachable');

    // (c) Back returns to the surface it was opened FROM — the Pay scanner, not Home.
    await driver.click('btn-accounts-back', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('accounts-list')), 'Back leaves the route');
    console.log('[150-accounts-route] ✓ Back returned to the Pay scanner, not to Home');

    // …and from a DIFFERENT origin it returns THERE. Same control, no hardcoded destination.
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    await driver.findByTestID('ledger-view', { timeoutMs: 5_000 });
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await driver.click('btn-accounts-back', { timeoutMs: 5_000 });
    await driver.findByTestID('ledger-view', { timeoutMs: 5_000 });
    console.log('[150-accounts-route] ✓ Back is origin-aware (Transactions → accounts → Transactions)');

    // (e) The `a` hotkey and the Home affordance reach the same route.
    await driver.pressKey('a');
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await driver.click('btn-accounts-back', { timeoutMs: 5_000 });
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.click('btn-home-accounts', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    console.log('[150-accounts-route] ✓ the `a` hotkey and btn-home-accounts reach the same route');

    await driver.screenshot('150-accounts-route');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[150-accounts-route] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[150-accounts-route] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
