// Flow 135 — Home activity feed (O4 slice 2): the newest ledger rows, capped, in own token units.
//
// The Home tab's Activity section is the SAME history the Transactions tab renders (the shared
// HistoryRow — own token units per row, never a converted figure), capped at 3 rows with a
// See-all link into the full tab. This flow pins:
//   (a) rail-settled payments land in the feed on the next history poll, newest first, in ∂ units;
//   (b) the cap: with 4+ rows in the ledger only the newest 3 render (no 4th row on Home);
//   (c) See all opens the full Transactions tab, where the capped-OUT oldest row is still listed.
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, railTransfer } from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '135',
  name: 'home-activity',
  journey: 'system',
  covers: ['home-tab', 'activity-feed'],
  verifies: 'Home activity shows the newest ledger rows in their own token units, capped at 3; See all opens the full Transactions tab',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[135-home-activity] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // The wallet's ledger starts with ONE row (the onboarding faucet mint). Three rail payments
    // from an ephemeral payer grow it to 4 — one past the feed's 3-row cap, so the flow can prove
    // the cap AND that See-all surfaces the capped-out oldest row.
    console.log('[135-home-activity] onboarding…');
    await onboardWallet(driver, 'e2e-feed');
    const alice = await accountOf(driver);
    const payer = await generateKeypair();
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, 20000);
    assert(fund.ok, `payer faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);

    const AMOUNTS = [1200, 3400, 5600];
    for (const cents of AMOUNTS) {
      const pay = await railTransfer(relayBaseURL, payer.secretHex, alice.publicHex, BigInt(cents), {});
      assert(pay.ok === true && pay.status === 202, `payer rail payment of ${cents} must be accepted (202), got ${JSON.stringify(pay)}`);
    }
    console.log('[135-home-activity] ✓ 3 rail payments settled (the ledger now has 4 rows)');

    // (a) + (b) The feed lands the newest rows (next history poll), newest first, capped at 3.
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    const landed = await driver.waitForText('+∂56.00', { timeoutMs: 10_000 });
    assert(landed, 'the newest rail payment should appear in the Home activity feed');
    const activity = await driver.readText('home-activity');
    assertIncludes(activity, '+∂56.00', 'the newest payment renders in its own ∂ unit');
    assertIncludes(activity, '+∂34.00', 'the second payment renders in its own ∂ unit');
    assertIncludes(activity, '+∂12.00', 'the third payment renders in its own ∂ unit');
    assert(!activity.includes('+∂100.00'), 'the 4th (oldest, faucet-mint) row must be capped OUT of the 3-row Home feed');
    assert(!(await driver.isPresent('home-hist-time-3')), 'the feed renders at most 3 rows (home-hist-time-3 must not exist)');
    await driver.findByTestID('home-hist-time-2', { timeoutMs: 4_000 });
    console.log('[135-home-activity] ✓ feed: newest 3 rows in ∂ units, cap holds (mint row capped out)');

    // (c) See all opens the full Transactions tab — the capped-out oldest row is still listed.
    await driver.click('btn-home-activity-all', { timeoutMs: 4_000 });
    await driver.findByTestID('ledger-view', { timeoutMs: 5_000 });
    const ledger = await driver.readText('ledger-view');
    assertIncludes(ledger, '+∂100.00', 'the full Transactions tab still lists the oldest (mint) row');
    assertIncludes(ledger, '+∂56.00', 'the full Transactions tab lists the newest row too');
    console.log('[135-home-activity] ✓ See all opened the full Transactions tab');

    await driver.screenshot('135-home-activity');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[135-home-activity] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[135-home-activity] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
