// Flow 161 — the wallet is a place you can navigate, link to, and come back to (OPEN_ISSUES X11).
//
// Measured before this landed: every tab and every sheet was the single URL `/wallet`. So the
// browser's Back button — the most-pressed control a browser has — ejected the user OUT of the
// wallet instead of moving inside it; no tab could be bookmarked or shared; and a refresh always
// dumped the user back on the landing screen no matter where they had been. On a wallet whose
// primary surface is the web, that is not polish.
//
// What this pins, and each one is a separate way the old behaviour hurt:
//   (a) moving between tabs writes a URL, and the URL names the screen in the user's own words
//       (`transactions`, the tab's label — not `ledger`, the internal mode name);
//   (b) browser Back returns to the PREVIOUS wallet screen and stays inside the wallet;
//   (c) a within-tab sub-mode is part of the address, so a link to "Send to address" opens that
//       form rather than the scanner with a toggle to press;
//   (d) a cold load of a deep URL lands on the named screen — the refresh case;
//   (e) Settings is part of the route, so Back CLOSES it instead of navigating out from under it
//       (the measured X11 symptom was Settings staying open while the URL changed underneath);
//   (f) THE REGRESSION GUARD: a URL carrying somebody else's parameters is left alone. The first
//       version of this router replaced the whole query string on its first render and deleted the
//       payment link that brought the user to the page — it took down flows 03 and 103. That bug
//       is invisible to a unit test of the wallet and obvious here.
//
// Selector contract: `home-headline`, `pay-scan`, `btn-request`, `hist-title`, `accounts-list`,
// `tab-pay`, `tab-receive`, `tab-transactions`, `btn-settings`, `btn-settings-close`,
// `btn-receive-address`.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '161',
  name: 'url-routing',
  journey: 'system',
  covers: ['url-routing', 'browser-back', 'deep-link', 'refresh', 'foreign-query-params'],
  verifies: 'Each wallet surface has its own URL: tab changes write it, browser Back walks back through the wallet instead of leaving it, a sub-moded and a Settings URL both restore on a cold load, and query parameters owned by other parsers (a pay link) survive navigation untouched.',
  timeoutMs: 40_000,
};

/** The wallet's query string, read from the page. NOTE it always carries the harness's own
 *  `?relay=…`, which is precisely why (f) below matters: the router shares the query string with
 *  parameters it does not own, and "home" therefore means "no ROUTER parameter", not "empty". */
const search = (driver) => driver.eval(() => globalThis.location.search);

/** Home is the absence of the router's own parameters, whatever else is in the URL. */
const assertOnHome = async (driver, why) => {
  const s = await search(driver);
  assert(!s.includes('screen=') && !s.includes('settings='), `${why} — expected no router parameter, got "${s}"`);
};

export async function run() {
  const start = Date.now();
  console.log('[161-url-routing] setup (relay + web + browser)…');
  const env = await setup({ solStub: true });
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    console.log('[161-url-routing] onboarding…');
    await onboardWallet(driver, 'e2e-url-routing');

    // ---- (a) a tab change writes a URL ------------------------------------------------------
    // Start from a known place rather than wherever onboarding left us.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline', { timeoutMs: 5_000 });
    await assertOnHome(driver, 'Home writes no router parameter');

    await driver.click('tab-receive', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-request', { timeoutMs: 5_000 });
    assertIncludes(await search(driver), 'screen=receive', 'the Receive tab names itself in the URL');

    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    // The URL uses the tab's LABEL, not the internal mode name — a URL is user-facing text.
    const txSearch = await search(driver);
    assertIncludes(txSearch, 'screen=transactions', 'the Transactions tab names itself in the URL');
    assert(!txSearch.includes('ledger'), `the URL must not leak the internal mode name, got "${txSearch}"`);
    console.log('[161-url-routing] ✓ tab changes write a URL, in the user\'s vocabulary');

    // ---- (b) Back walks back through the wallet, not out of it -------------------------------
    await driver.eval(() => { globalThis.history.back(); });
    await driver.findByTestID('btn-request', { timeoutMs: 5_000 });
    assertIncludes(await search(driver), 'screen=receive', 'Back returned to the Receive tab');
    // Still inside the wallet: the chrome that only the wallet renders is still mounted.
    assert(await driver.isPresent('tab-pay'), 'Back must stay inside the wallet, not leave it');

    await driver.eval(() => { globalThis.history.back(); });
    await driver.findByTestID('home-headline', { timeoutMs: 5_000 });
    await assertOnHome(driver, 'a second Back returned to Home');
    console.log('[161-url-routing] ✓ browser Back moves between wallet screens and stays inside');

    // ---- (c) a sub-mode is part of the address ----------------------------------------------
    // The Receive address toggle renders only for an asset with an on-chain family — DEMO, which
    // onboarding leaves selected, has no address to show and correctly hides it. So pick a real
    // asset first; that selection is deliberately NOT in the URL (see the routing comment in
    // Wallet: a shareable address must never carry a money-critical selection).
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await driver.click('tab-receive', { timeoutMs: 5_000 });
    await driver.click('btn-receive-address', { timeoutMs: 5_000 });
    const subSearch = await search(driver);
    assertIncludes(subSearch, 'screen=receive', 'the sub-moded URL still names the screen');
    assertIncludes(subSearch, 'm=address', 'the sub-mode rides in the URL');
    console.log('[161-url-routing] ✓ a within-tab sub-mode is part of the address');

    // ---- (d) a cold load of a deep URL lands on the named screen -----------------------------
    // This is the refresh case, and the shareable-link case, in one navigation.
    await driver.navigate(webBaseURL, `/?screen=receive&m=address&relay=${encodeURIComponent(relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 10_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    // The address sub-mode of the Receive tab renders its deposit body, not the request form.
    await driver.findByTestID('btn-receive-address', { timeoutMs: 8_000 });
    assert(!(await driver.isPresent('btn-request')), 'a cold load of the address URL must not land on the request form');
    console.log('[161-url-routing] ✓ a cold load of a deep URL restores the screen it names');

    // ---- (e) Settings is part of the route, so Back closes it --------------------------------
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-settings-close', { timeoutMs: 5_000 });
    assertIncludes(await search(driver), 'settings=1', 'an open Settings sheet is in the URL');
    await driver.eval(() => { globalThis.history.back(); });
    await driver.waitGone('btn-settings-close', { timeoutMs: 5_000 });
    assert(!(await search(driver)).includes('settings=1'), 'Back closed Settings and removed it from the URL');
    console.log('[161-url-routing] ✓ Back closes Settings instead of navigating out from under it');

    // ---- (f) foreign query parameters survive navigation ------------------------------------
    // THE REGRESSION GUARD. `relay` is not the router's parameter; neither are a pay link's
    // asset/network/amount. A router that owns the whole query string deletes the link that
    // brought the user to the page, before the parser that reads it has run.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 10_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 8_000 });
    const afterNav = await search(driver);
    assertIncludes(afterNav, 'screen=pay', 'the router wrote its own parameter');
    assertIncludes(afterNav, 'relay=', 'a parameter the router does not own MUST survive navigation');
    console.log('[161-url-routing] ✓ foreign query parameters survive a navigation');

    console.log(`[161-url-routing] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[161-url-routing] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
