// Flow 181 — restart with a cached balance: funded at home, walked offline into the city, app
// restarted (the harness reloads the page against the still-dead relay). The wallet must open
// showing REAL numbers from the persisted last-good read (never '—', never zero — the fund gate
// passes offline), the offline hand-off's pending row must still be there, and the balance must
// read APPROXIMATE.
//
// The approx marker follows the founder's >1 min rule (2026-09-15): a freshly offline wallet
// shows its plain number; after the staleness bound passes the figure is marked. This flow pins
// BOTH edges: unmarked right after the hand-off, marked once the staleness clock passes — and
// still marked (from the cache's own timestamp) after the restart.
//
// The prod magnitude (60 s, ticked by a 30 s re-render) would make this a ~90 s wall-clock
// sleep, so the flow shrinks the Wallet.tsx staleness SEAM (__DPAY_TEST_BALANCE_STALE_MS = 3 s,
// __DPAY_TEST_BALANCE_TICK_MS = 250 ms — per-call reads) after the edge-1 plain assert: the
// MECHANISM (fresh ⇒ plain, stale ⇒ marked, cache-age ⇒ marked on boot) is what e2e pins; the
// prod 60 s magnitude stays pinned as the untouched default in Wallet.tsx.
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
  verifies: 'A restarted offline wallet shows its cached real balance (approx-marked per the staleness rule), the pending row survives the restart, and the fund gate stays reachable.',
  timeoutMs: 90_000, // onboard + offline hand-off + seam-shrunk staleness edges + reload (contention budget)
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

    // --- Edge 2: the staleness clock passes ⇒ the figure is marked where the user reads it.-
    // The sheet stays open across the wait. Shrink the Wallet staleness seam FIRST (the edge-1
    // plain assert above ran against the real 60 s default): 3 s bound + 250 ms tick ⇒ the
    // marker lands in ~3.5 s instead of the ~90 s the prod magnitudes would take.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_BALANCE_STALE_MS = 3000;
      globalThis.__DPAY_TEST_BALANCE_TICK_MS = 250;
    });
    assert(await driver.waitForText('~1.1 ICP', { timeoutMs: 15_000 }),
      'the balance figure itself must become approx-marked once the offline read is past the staleness bound');
    console.log('[181-offline-restart-cached] ✓ approx marker appeared on the amount (staleness past bound)');

    // --- The restart: reload against the STILL-DEAD relay (the persisted retarget). -------------
    console.log('[181-offline-restart-cached] reloading the page (offline restart)…');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(deadRelay)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    // Fresh document ⇒ the per-call seam globals are gone; re-apply them so the cache's own
    // timestamp (already past the bound) marks on the first render, no fresh-poll needed.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_BALANCE_STALE_MS = 3000;
      globalThis.__DPAY_TEST_BALANCE_TICK_MS = 250;
    });

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
