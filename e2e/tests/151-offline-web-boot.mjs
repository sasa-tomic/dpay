// Flow 151 — the SHIPPED web wallet opens with the origin dead (OPEN_ISSUES X10).
//
// The product's one-line claim is "your phone never needs a connection". Before the service worker
// landed, a reload of /wallet with the network down gave the browser's offline error page —
// `navigator.serviceWorker.getRegistrations()` returned 0 and there was no manifest. This flow is
// the regression gate on that claim, and it drives the REAL relay serving the REAL shipped bytes.
//
// Why this flow is built differently from every other one: the service worker exists ONLY in the
// web-prod build (`e2e/web/sw.js` + the `dpayWebProdAssets` plugin), because a worker that
// intercepted some of a flow's navigations and not others would make the shared-dist suite
// nondeterministic. So this flow drives `<relay>/wallet` — the dist the relay embeds — rather than
// the shared sirv dev origin, and it runs its OWN relay so it can KILL it. A dead port is a real
// dead origin; CDP offline emulation is applied to the page target and is not guaranteed to reach
// the fetches the worker thread makes on its own, which is exactly the code under test.
//
// What it pins, in order:
//   1. a worker is registered at the ROOT scope (it must see /wallet AND /assets/)
//   2. the shell document, the entry bundle and the signing core are all precached
//   3. with the origin KILLED, a reload is served BY the worker (`workerStart > 0`, status 200)
//   4. the app does not merely paint: it boots to READY and MINTS A KEY offline — the wasm core
//      came off the cache and ran
//   5. and it stays honest: `/api/v1/*` is never answered from cache, so no balance, catalog or
//      capability can be shown as current when it is not. What the wallet then SHOWS about being
//      offline is the app's own behaviour and is pinned by flow 100; the worker cannot influence
//      it precisely because of this assertion.
import { existsSync } from 'node:fs';
import { setup, assert, skipWalkthroughIfPresent } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '151',
  name: 'offline-web-boot',
  journey: 'offline',
  covers: ['offline', 'cold-start', 'service-worker', 'web-prod', 'pwa', 'honesty'],
  verifies: 'The shipped /wallet is served by its service worker after the origin is killed — the app reaches READY, generates a key offline, and /api/v1/* is still refused rather than served stale.',
  timeoutMs: 45000, // prod bundle + a ~2 MB precache + a reload with a dead origin
};

const SW_DIST = new URL('../dist-prod/sw.js', import.meta.url).pathname;

export async function run() {
  const start = Date.now();
  if (!existsSync(SW_DIST)) {
    throw new Error(
      'e2e/dist-prod/sw.js missing — this flow drives the SHIPPED web build. Run `just web`. ' +
      '(Every recipe that builds dpay-relay already depends on it: build.rs embeds that dist.)',
    );
  }
  console.log('[151-offline-web-boot] setup (own relay: this flow kills it)…');
  const env = await setup();
  // A relay of our own, on its own free port — the shared one is serving the rest of the pool.
  const relay = await startRelay();
  try {
    const { driver } = env;
    const base = relay.baseURL;
    // Every request to this origin fails once we kill it; that is the flow, not a defect.
    driver.allowRequestFailuresFrom(base);

    await driver.navigate(base, `/wallet?relay=${encodeURIComponent(base)}`, { waitUntil: 'domcontentloaded', timeoutMs: 20_000 });
    await driver.waitReady({ timeoutMs: 20_000 });

    // 1 + 2. The worker is active at the ROOT and has precached the shell.
    const sw = await driver.eval(async () => {
      const reg = await navigator.serviceWorker.ready;
      const names = await caches.keys();
      const shell = names.find((n) => n.startsWith('dpay-shell-'));
      const keys = shell ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname) : [];
      return { scope: new URL(reg.scope).pathname, state: reg.active && reg.active.state, cache: shell, keys };
    });
    assert(sw.state === 'activated', `service worker must be activated, was ${sw.state}`);
    assert(sw.scope === '/', `worker scope must be / (it must see /wallet AND /assets/), was ${sw.scope}`);
    assert(sw.keys.includes('/wallet'), 'the shell document must be precached');
    assert(
      sw.keys.some((k) => /^\/assets\/wallet-.*\.js$/.test(k)),
      `the entry bundle must be precached; cache "${sw.cache}" held: ${sw.keys.join(' ')}`,
    );
    assert(
      sw.keys.some((k) => k.endsWith('.wasm')),
      'the signing core must be precached — a wallet that cannot sign is not booted',
    );

    // 3. Kill the origin, then reload. Nothing but the cache can answer this.
    await relay.stop();
    const stillUp = await driver.eval(async (b) => {
      try { await fetch(`${b}/api/v1/health`); return true; } catch { return false; }
    }, base);
    assert(!stillUp, 'the relay must be DEAD before the offline reload is meaningful');

    await driver.navigate(base, '/wallet', { waitUntil: 'domcontentloaded', timeoutMs: 20_000 });
    await driver.waitReady({ timeoutMs: 20_000 });
    // The document came OFF the worker: `workerStart` is non-zero only when a service worker
    // handled the navigation, and with the origin dead a 200 can come from nowhere else.
    const nav = await driver.eval(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return { workerStart: n.workerStart, status: n.responseStatus, controlled: !!navigator.serviceWorker.controller };
    });
    assert(nav.controlled, 'the reloaded page must be controlled by the worker');
    assert(nav.workerStart > 0, 'the navigation must have been served BY the worker (workerStart > 0)');
    assert(nav.status === 200, `the offline shell must be a 200, got ${nav.status}`);

    // 4. It is a working app, not a painted shell: the wasm core loaded from cache and mints a key
    //    with no network anywhere.
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-offline-boot', { timeoutMs: 10_000 });
    await driver.click('btn-create', { timeoutMs: 5_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 10_000 });
    // The recovery phrase is DERIVED from the freshly generated key, so a full-length phrase on
    // screen is proof the cached wasm core ran — not just that a form painted.
    const words = await driver.eval(() =>
      [...document.querySelectorAll('[data-testid^="mnemonic-word-"]')].map((n) => n.innerText.trim()),
    );
    const real = words.filter((w) => /[a-z]{3,}/.test(w));
    assert(
      real.length >= 12,
      `the offline boot must have generated a real device key (recovery phrase had ${real.length} words: ${JSON.stringify(words.slice(0, 3))})`,
    );

    // 5. The honesty half: a live fact is still a live fact.
    const api = await driver.eval(async (b) => {
      try { const r = await fetch(`${b}/api/v1/capabilities`); return { answered: true, status: r.status }; }
      catch { return { answered: false, status: 0 }; }
    }, base);
    assert(
      !api.answered,
      `/api/v1/* must never be answered from cache — it returned ${api.status} with the origin dead`,
    );

    await driver.screenshot('151-offline-web-boot');
    console.log(`[151-offline-web-boot] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await relay.stop();
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[151-offline-web-boot] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
