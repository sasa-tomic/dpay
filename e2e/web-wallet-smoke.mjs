#!/usr/bin/env node
// Prod web-wallet smoke (`just web-smoke`) — the acceptance gate for the SHIPPED web bytes.
//
//   e2e/dist-prod (the exact bytes crates/dpay-relay/build.rs embeds and serves at /wallet)
//   + the REAL dpay-relay (FakeLedger + faucet, spawned by the e2e harness)
//   → the harness's headless-chrome Driver drives the real app:
//     1. DPAY_SELFCHECK PASS in the console (the wasm DpayCore boots, signs, verifies)
//     2. the FULL first run completes and the wallet funds
//     3. identity PERSISTS across a reload (AsyncStorage → localStorage, the first-party web impl)
//     4. the wallet chrome renders (balance, header, settings, all four bottom tabs)
//     5. screenshot > 30 KB, plus the Driver's own teardown gate: no console error, no pageerror,
//        no failed request
//     6. NOTHING off-box was contacted — every request went to the local dist server or the
//        local relay
//
// WHY THIS FILE IMPORTS THE HARNESS. It used to carry its own copy of the onboarding sequence, of
// the relay's spawn env, and of the browser launch. The app's first run changed three times in
// five weeks (walkthrough → practice payment → home-currency question) and the copy here silently
// stopped matching at the 2026-09-04 chooser: the smoke sat on a screen it had never heard of
// until every later assertion timed out, and `just web-smoke` was RED for days. Each of those is
// ONE fact with ONE owner — `onboardWallet` (harness/lib.mjs), `startRelay` (harness/relay.mjs),
// `Driver` (harness/driver.mjs). This file owns only what is genuinely its own: serving dist-prod,
// and the assertions above.
//
// WHY THE SOLANA RAIL IS OFF. `Driver` injects `__DPAY_TEST_SOLANA_RPC_URL=''`
// (harness/driver.mjs `injectTestGlobals`) — the same read-only seam jest and every e2e flow use,
// which production never sets, so the bytes under test are unchanged. Without it the shipped
// bundle polls the baked mainnet Helius endpoint, and on 2026-09-08 that key's quota was
// exhausted: ten `429`s alone turned this gate RED for a reason that had nothing to do with the
// bytes it exists to check. What the smoke proves is unaffected — it has never asserted anything
// about Solana, and it cannot: whether a third party's mainnet RPC is up is not a property of a
// local build. Assertion 6 makes that structural instead of a hope; a future dependency on any
// off-box origin fails the gate by name rather than by flaking whenever that origin is unhappy.
//
// Node-only, offline.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Driver } from './harness/driver.mjs';
import { onboardWallet } from './harness/lib.mjs';
import { startRelay, pickFreePort } from './harness/relay.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'e2e/dist-prod');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

// --- static server for dist-prod (the relay's /wallet + /assets + /sw.js routes, minus brotli) ---
// `.br` siblings are never served here: the relay negotiates them from `Accept-Encoding`, and the
// body it hands back is byte-identical to the plain file this serves.
const webPort = await pickFreePort();
const srv = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path === '/wallet' || path === '/') path = '/wallet.html';
    if (path.endsWith('.br')) throw new Error('the relay serves .br by negotiation, never by path');
    const file = join(DIST, path.replace(/^\//, ''));
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => srv.listen(webPort, '127.0.0.1', r));
const webBase = `http://127.0.0.1:${webPort}`;

// --- the real relay: built + spawned + health-probed by the harness ------------------------------
// `startRelay` also runs `cargo build --features test-helpers` into the isolated e2e target dir, so
// a missing or stale binary is a loud build error here instead of an onboarding timeout later.
const relay = await startRelay();

let driver = null;
try {
  driver = await Driver.create();

  // Every request the page makes, so assertion 6 can name any origin that is not local.
  const foreignOrigins = new Map(); // origin → first URL seen
  const localOrigins = new Set([webBase, relay.baseURL]);
  driver.page.on('request', (req) => {
    const url = req.url();
    if (!/^https?:/.test(url)) return; // data:/blob: are page-internal, not network
    const origin = new URL(url).origin;
    if (localOrigins.has(origin)) return;
    if (!foreignOrigins.has(origin)) foreignOrigins.set(origin, url);
  });

  // 1. boot + self-check
  await driver.navigate(webBase, `/wallet?relay=${relay.baseURL}`);
  await driver.waitReady();
  driver.consoleLog.some((l) => l.text.includes('DPAY_SELFCHECK PASS'))
    ? ok('DPAY_SELFCHECK PASS (wasm DpayCore boots, signs, verifies)')
    : bad('no DPAY_SELFCHECK PASS in console');

  // 2. the first run, driven by the ONE helper that knows the current path (walkthrough →
  //    name → backup → practice → home currency → wallet → DEMO rail, funded by the faucet).
  await onboardWallet(driver, 'SmokeTester');
  ok('first run completes and the wallet funds (∂100.00 on the DEMO rail)');

  // 3. identity persists across a reload. AsyncStorage v3's default web impl is localStorage-backed
  //    (`getLegacyStorage()` — IndexedDB is the opt-in `createAsyncStorage` API we don't use), so
  //    assert the physical store: the app's `dpay.identity.v1` row must survive the reload.
  //    `domcontentloaded`, not networkidle0: a returning user mounts the Wallet and starts the
  //    continuous balance/history/deposit polls, which may never let the network go idle.
  await driver.navigate(webBase, `/wallet?relay=${relay.baseURL}`, { waitUntil: 'domcontentloaded' });
  const persisted = await driver.eval(() => {
    const id = localStorage.getItem('dpay.identity.v1');
    return { hasId: !!id, looksLike: !!id && id.includes('secretHex') };
  });
  (persisted.hasId && persisted.looksLike)
    ? ok('identity persists across reload (localStorage dpay.identity.v1)')
    : bad('dpay.identity.v1 missing after reload — identity lost');

  // 4. the wallet chrome the real app renders for a returning user. Onboarding re-appearing here
  //    would mean the identity was lost. TestIDs, not aria-labels: the labels are localized copy
  //    (`M.wallet.tab.*`) and the testIDs are the byte-stable contract — see Tab.tsx.
  await driver.findByTestID('balance', { timeoutMs: 15_000 });
  for (const id of ['balance', 'header-who', 'btn-settings', 'tab-home', 'tab-pay', 'tab-receive', 'tab-transactions']) {
    (await driver.isPresent(id)) ? ok(`${id} renders`) : bad(`${id} missing`);
  }

  // 5. pixels
  const shot = await driver.screenshot('web-wallet-prod');
  const size = statSync(shot).size;
  size > 30_000 ? ok(`screenshot ${Math.round(size / 1024)} KB (rendered, not blank)`)
                : bad(`screenshot only ${size} B — likely blank`);

  // 6. the gate that keeps this gate honest: no third party was in the loop.
  foreignOrigins.size === 0
    ? ok('no off-box origin contacted (the gate cannot be broken by a third party being down)')
    : bad(`off-box origins contacted: ${[...foreignOrigins.values()].join(', ')}`);
} catch (e) {
  bad(`smoke crashed: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  // Driver.close() re-throws the console-error / pageerror / requestfailed diagnostics it collected.
  if (driver) {
    try { await driver.close(); } catch (e) { bad(`page diagnostics: ${e instanceof Error ? e.message : e}`); }
  }
  await relay.stop();
  srv.close();
}
console.log(failed ? `\nWEB SMOKE FAILED (${failed})` : '\nweb smoke GREEN: /wallet is the real app, wasm-backed, persistent');
process.exit(failed ? 1 : 0);
