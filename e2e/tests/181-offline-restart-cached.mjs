// Flow 181 — restart with a cached balance: funded at home, walked offline into the city, app
// restarted (the harness reloads the page against the still-dead relay). The wallet must open
// showing REAL numbers from the persisted last-good read (never '—', never zero — the fund gate
// passes offline), the offline hand-off's pending row must still be there, and the balance must
// read APPROXIMATE.
//
// The approx marker follows the founder's >1 min rule (2026-09-15): a freshly offline wallet
// shows its plain number; after ~a minute offline the figure is stale enough to be marked. This
// flow pins BOTH edges: unmarked right after the hand-off, marked once the staleness clock passes
// 60 s — and still marked (immediately, from the cache's own timestamp) after the restart.
//
// The slow leg is the point: the wallet's freshness tick fires every 30 s and the marker appears
// on the first tick past 60 s. Budget accordingly (~90 s worst case).
import {
  setup, assert, assertIncludes, onboardWallet, armPayScan, waitForWallet, selectCurrency, openBalances,
  faucetAccount, accountOf, goOffline,
} from '../harness/lib.mjs';
import { buildRequestQR, generateKeypair, randNonceHex } from '../harness/wire.mjs';

const CURRENCY = 8; // ICP
const SEED = 210000001;
const PAY = 100000001;
const FEE = 10000;
const WIRE = PAY - FEE;

export const meta = {
  id: '181',
  name: 'offline-restart-cached',
  journey: 'offline',
  covers: ['offline', 'pending', 'balances', 'approx', 'restart'],
  verifies: 'A restarted offline wallet shows its cached real balance (approx-marked per the 60 s rule), the pending row survives the restart, and the fund gate stays reachable.',
  timeoutMs: 240_000,
};

export async function run() {
  const start = Date.now();
  console.log('[181-offline-restart-cached] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    await onboardWallet(driver, 'e2e-offline-restart');
    const merchant = await generateKeypair();

    const payer = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 10_000 }), 'the header must show the funded ICP balance before the offline leg');

    // keepGateway (the flow-20 offline hand-off premise): the relay dies (online flips false,
    // the cache stops refreshing) while the IC gateway stays alive so the hand-off sign's
    // value-envelope expiry can stamp from the certified clock (icp.ts refuses value signing on
    // an unreachable clock — see flow 180's comment). The RESTART below reloads against the dead
    // relay, which also re-bootstraps the gateway seam at the dead origin — after the sign, this
    // flow never touches the value rail again, so that is fine.
    const { deadRelay } = await goOffline(driver, { keepGateway: true });
    assert(await driver.waitForText('approx.', { timeoutMs: 8_000 }), 'the offline eyebrow must appear');
    console.log('[181-offline-restart-cached] ✓ offline (dead relay retargeted)');

    // --- An offline hand-off first, so the restart must ALSO carry the pending row. ------------
    const nonceHex = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(merchant.publicHex, String(WIRE), nonceHex, expiry, CURRENCY, 'Café Sunrise');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('btn-paid', { timeoutMs: 6_000 });
    await driver.click('btn-paid', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-new', { timeoutMs: 5_000 });
    await driver.click('btn-new', { timeoutMs: 4_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 6_000 });
    console.log('[181-offline-restart-cached] ✓ offline hand-off done, pending row on Home');

    // --- Edge 1: freshly offline ⇒ the figure is plain (no "~"). --------------------------------
    // The last good poll was seconds ago; the founder's rule withholds the marker until >1 min.
    // The Balances sheet's per-asset row is the assertion surface (the Home tab's own headline
    // reads the HOME currency, not the selected asset).
    await openBalances(driver);
    await driver.findByTestID('asset-icp', { timeoutMs: 6_000 });
    let sheet = await driver.bodyText();
    assertIncludes(sheet, '1.1 ICP', 'the deducted balance renders on the sheet');
    assert(!sheet.includes('~1.1 ICP'), 'a freshly offline figure must NOT be approx-marked yet (the >1 min rule)');
    console.log('[181-offline-restart-cached] ✓ plain (unmarked) deducted balance — staleness < 60 s');

    // --- Edge 2: the staleness clock passes 60 s ⇒ the figure is marked where the user reads it.-
    // The sheet stays open across the wait; the wallet's 30 s staleness tick re-renders it.
    assert(await driver.waitForText('~1.1 ICP', { timeoutMs: 110_000 }),
      'the balance figure itself must become approx-marked once the offline read is >1 min stale');
    console.log('[181-offline-restart-cached] ✓ approx marker appeared on the amount (staleness > 60 s)');

    // --- The restart: reload against the STILL-DEAD relay (the persisted retarget). -------------
    console.log('[181-offline-restart-cached] reloading the page (offline restart)…');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(deadRelay)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    // The wallet shell mounts, the cache hydrates, and the numbers are REAL immediately:
    // the sheet's ICP row carries the deducted balance with the approx marker (the cache's own
    // timestamp is >1 min old now — the marker is correct from the first render, no tick needed).
    await waitForWallet(driver);
    await openBalances(driver);
    assert(await driver.waitForText('~1.1 ICP', { timeoutMs: 15_000 }),
      'the restarted wallet must show the cached, deducted, approx-marked balance');
    const body = await driver.bodyText();
    assert(!body.includes('2.10000001 ICP'), 'the pre-hand-off figure must not resurface (the cache was written after funding, the deduction after it)');
    console.log('[181-offline-restart-cached] ✓ cached balance hydrated across the restart (approx-marked, deduction intact)');

    // The pending row survived the restart (persisted outbox, not session state).
    await driver.click('tab-home', { timeoutMs: 6_000 });
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 8_000 });
    assertIncludes(await driver.bodyText(), '\u22121.00000001 ICP', 'the pending row survives the restart with its gross headline');
    console.log('[181-offline-restart-cached] ✓ pending row survived the restart');

    await driver.screenshot('181-offline-restart-cached');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[181-offline-restart-cached] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[181-offline-restart-cached] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
