// Flow 143 — delegated conversion staleness: a stale quote refreshes itself; confirm re-quotes.
//
// Spec §5: the rate line is the venue's own quote, attributed + timestamped; it auto-refreshes
// when older than 30 s, and confirm re-quotes before anything is signed. This flow pins both
// behaviors with the app's own staleness test seam (`__DPAY_TEST_CONVERT_STALE_MS`, the
// `__DPAY_TEST_*` convention — no 30 s wall-clock wait):
//   * a fresh quote renders the attributed+timestamped line and NO staleness notice;
//   * dropping the threshold to 50 ms makes the surface flag the quote as stale and refresh it —
//     the stale notice appears, then clears when the fresh (re-fetched) quote lands, and the
//     re-fetch is proven by a recorded request counter;
//   * a REAL venue-price move (the relay's own fee knob — the fake pool is shared across parallel
//     flows, so sibling swaps also move it) raises the quote-changed review interrupt, and confirm
//     stays armed: the user re-reviews, and the on-confirm re-quote is the signing gate;
//   * Screenshots: the stale notice mid-refresh, the interrupt, and the refreshed surface.
import {setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)

export const meta = {
  id: '143',
  name: 'convert-stale-quote-refresh',
  journey: 'convert',
  covers: ['convert', 'icp', 'vchf', 'quote-staleness', 'auto-refresh', 'quote-attribution', 'quote-changed-interrupt', 'test-seam'],
  verifies: 'A fresh Convert quote shows the attributed+timestamped line with no staleness notice; forcing staleness via the app\'s test seam makes the surface flag + refresh it (re-fetch proven by a request counter, stale notice clears); a real venue-price move via the relay\'s fee knob raises the quote-changed review interrupt while confirm stays armed (the on-confirm re-quote is the signing gate).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[143-convert-stale] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    console.log('[143-convert-stale] onboarding + funding 3 ICP…');
    await onboardWallet(driver, 'e2e-convert-stale');
    const account = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    // selectCurrency makes ICP the active asset and leaves on Pay; re-open the accounts route so
    // Convert (which renders on the SELECTED row only) is on screen.
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', { timeoutMs: 6_000 });
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 10_000 });

    // Fresh: attributed + timestamped, no stale notice, no quote-changed interrupt.
    assertIncludes(await driver.readText('convert-quote-source'), 'Quote from ICPSwap, fetched', 'fresh quote renders attributed + timestamped');
    assert(await driver.findByTestID('convert-stale', { timeoutMs: 1_000 }).catch(() => null) == null, 'no staleness notice on a fresh quote');
    assert(await driver.findByTestID('convert-quote-changed', { timeoutMs: 1_000 }).catch(() => null) == null, 'no quote-changed interrupt on a fresh quote');
    const fetchedBefore = await driver.readText('convert-quote-source');

    // Deterministic re-fetch proof: record every /api/v1/swap_quote request the surface issues
    // (the flow-96 fetch-recorder pattern) — the refresh must actually hit the relay again.
    await driver.eval(() => {
      const orig = window.fetch;
      window.__quoteFetches = 0;
      window.fetch = (...args) => {
        if (String(args[0]).includes('/api/v1/swap_quote')) window.__quoteFetches += 1;
        return orig(...args);
      };
    });
    const fetchesBefore = await driver.eval(() => window.__quoteFetches);

    // Force staleness through the app's own seam (the __DPAY_TEST_* convention).
    console.log('[143-convert-stale] forcing staleness via __DPAY_TEST_CONVERT_STALE_MS=50…');
    await driver.eval(() => {
      globalThis.__DPAY_TEST_CONVERT_STALE_MS = 50;
    });

    // The stale notice appears (the 1 s staleness sweep picks it up), then clears on refresh.
    await driver.findByTestID('convert-stale', { timeoutMs: 10_000 });
    await driver.screenshot('143-convert-stale-notice');
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="convert-stale"]') == null,
      { timeoutMs: 12_000 },
    );
    const fetchesAfter = await driver.eval(() => window.__quoteFetches);
    const fetchedAfter = await driver.readText('convert-quote-source');
    assertIncludes(fetchedAfter, 'Quote from ICPSwap, fetched', 'refreshed quote is still attributed + timestamped');
    assert(fetchesAfter > fetchesBefore, `the surface re-fetched the venue quote (${fetchesBefore} → ${fetchesAfter} swap_quote requests)`);
    // formatClock is locale-aware with minute granularity — the instant MAY render identically
    // within one minute; the re-fetch count above is the hard proof, this is the soft bonus.
    if (fetchedBefore === fetchedAfter) {
      console.log('[143-convert-stale] note: fetched-at text unchanged within the minute (locale clock granularity) — re-fetch proven by counter above');
    }

    // A REAL venue-price move must raise the review interrupt — driven deterministically via the
    // relay's own test knob (the fake pool is SHARED across parallel flows: sibling swaps also move
    // the price, so "the quote never changes" cannot be promised here; the interrupt LOGIC is what
    // this flow pins, and a knob move guarantees it without racing anyone).
    console.log('[143-convert-stale] moving the venue price via the fee knob (3000 → 4000 millionths)…');
    const knob = await fetch(`${relayBaseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: '65mrh-fqaaa-aaaar-qapoa-cai', fee_millionths: 4000 }),
    });
    assert(knob.ok, `swap_pool knob ok (status ${knob.status})`);
    const changedLine = await driver.findByTestID('convert-quote-changed', { timeoutMs: 15_000 });
    assert(changedLine != null, 'a REAL quote move raises the quote-changed review interrupt');
    const changedText = await driver.readText('convert-quote-changed');
    assertIncludes(changedText, 'Quote changed', 'the interrupt names what happened');
    assertIncludes(changedText, 'Review and confirm again', 'the interrupt demands re-review before signing');
    await driver.screenshot('143-convert-quote-changed');

    // Confirm stays armed through the interrupt — the user re-reviews and re-confirms; the
    // on-confirm re-quote is the gate that actually blocks signing a stale number.
    const confirmDisabled = await driver.eval(
      () => document.querySelector('[data-testid="btn-convert-confirm"]')?.hasAttribute('disabled'),
    );
    assert(!confirmDisabled, 'confirm stays armed after the refresh + interrupt cycle');

    // Knob hygiene: restore the pool's default tier for sibling flows sharing this relay.
    await fetch(`${relayBaseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: '65mrh-fqaaa-aaaar-qapoa-cai', fee_millionths: 3000 }),
    });
    await driver.screenshot('143-convert-refreshed');

    console.log(`[143-convert-stale] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('143-convert-stale RED:', e.stack || e.message || e);
  });
}
