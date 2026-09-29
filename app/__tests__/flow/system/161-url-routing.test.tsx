/**
 * Flow 161 url-routing — the jest twin of `e2e/tests/161-url-routing.mjs`, ported against the
 * location/history stub (spec 1.7, the one harness feature the URL flows need). The app's OWN
 * routing code runs (useWalletHistory with Platform.OS='web'): tab changes push real entries,
 * history.back() rewinds through the stub and the app's popstate listener applies the URL.
 *
 * Asserted here (the stub's capability proof): (a) a tab change writes a URL in the user's
 * vocabulary; (b) Back walks back through the wallet and stays inside it; (d) a COLD LOAD of a
 * deep URL lands on the named screen; (f) foreign query parameters survive navigation (the
 * regression guard — a router that owns the whole query deletes pay links).
 *
 * Trimmed for M1 (M2 batch E owns full parity): (c) the ckbtc sub-mode leg and (e) the Settings
 * sheet legs ride the same stub mechanics proven here.
 */
import {it, expect} from '@jest/globals';
import {onboardWallet} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as {
  location: {search: string; href: string};
  history: {back: () => void};
};

/** Home is the absence of the router's own parameters, whatever else is in the URL. */
const expectOnHome = (why: string): void => {
  expect({why, search: g.location.search, ok: !g.location.search.includes('screen=') && !g.location.search.includes('settings=')})
    .toEqual({why, search: g.location.search, ok: true});
};

hermeticDescribe('flow 161 — the wallet is navigable, linkable, and Back stays inside', () => {
  it('tabs write URLs, Back walks back, a cold load restores, foreign params survive', async () => {
    const m = await onboardWallet('jest-url-routing');

    // ---- (a) a tab change writes a URL -------------------------------------------------------
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline', {timeoutMs: 5000});
    expectOnHome('Home writes no router parameter');

    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-request', {timeoutMs: 5000});
    expect(g.location.search).toContain('screen=receive');

    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    // The URL uses the tab's LABEL, not the internal mode name — a URL is user-facing text.
    expect(g.location.search).toContain('screen=transactions');
    expect(g.location.search).not.toContain('ledger');

    // ---- (b) Back walks back through the wallet, not out of it -------------------------------
    // After each Back, wait for screen AND URL to AGREE: the app's stale-route effect can
    // re-push the previous entry one tick after popstate and then self-heal on the next render
    // (the same race a fast double-Back in a real browser hits — the screen wins, the URL
    // follows). A real user never observes the intermediate frame; neither should the flow.
    g.history.back();
    await m.driver.waitForFunction(
      () => m.driver.isPresent('btn-request') && g.location.search.includes('screen=receive'),
      {timeoutMs: 5000, label: 'Back #1 lands on Receive (screen + URL agree)'},
    );
    expect(m.driver.isPresent('tab-pay')).toBe(true);

    g.history.back();
    await m.driver.waitForFunction(
      () => m.driver.isPresent('home-headline') && !g.location.search.includes('screen='),
      {timeoutMs: 5000, label: 'Back #2 lands on Home (screen + URL agree)'},
    );
    expectOnHome('a second Back returned to Home');

    // ---- (d) a cold load of a deep URL lands on the named screen -----------------------------
    // Fresh reload semantics: unmount + remount WITHOUT clearing storage, with the URL set first
    // (mountApp({url}) is exactly the cold-load contract).
    await m.remount({url: '/?screen=transactions'});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 8000});
    expect(m.driver.isPresent('btn-request')).toBe(false);

    // ---- (f) foreign query parameters survive navigation -------------------------------------
    // THE REGRESSION GUARD: a router that rewrites the whole query string deletes the link that
    // brought the user to the page. `someforeign` stands in for a pay link's asset/amount.
    await m.remount({url: '/?someforeign=1'});
    await m.driver.findByTestID('home-headline', {timeoutMs: 8000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 8000});
    expect(g.location.search).toContain('screen=pay');
    expect(g.location.search).toContain('someforeign=1');

    await m.unmount();
  }, 90_000);
});
