#!/usr/bin/env node
// Prod web-wallet smoke (the mandate's acceptance gate, run by `just web-smoke`):
//
//   relay (real dpay-relay, FakeLedger)  +  sirv serving e2e/dist-prod (the exact embedded bytes)
//   →  headless chrome drives the REAL app at /wallet:
//     1. DPAY_SELFCHECK PASS in the console (the wasm DpayCore boots + signs + verifies)
//     2. Onboarding completes against the relay (faucet-funded balance renders)
//     3. Identity PERSISTS across reload (AsyncStorage → IndexedDB, first-party web impl)
//     4. Tabs render (Balances / Pay / Receive / Send surfaces present)
//     5. Screenshot > 30 KB + zero console errors
//
// This is the same shape as the e2e harness but pointed at dist-prod — proving the SHIPPED bytes,
// not the dev build. Node-only, offline.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { resolveExecutablePath } from './harness/browser.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'e2e/dist-prod');
const PORT_WEB = 4390;
const PORT_RELAY = 4391;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

// --- static server for dist-prod (same behavior as the relay's /wallet + /assets routes) -------
const srv = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path === '/wallet') path = '/wallet.html';
    if (path === '/') path = '/wallet.html';
    const file = join(DIST, path.replace(/^\//, ''));
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => srv.listen(PORT_WEB, '127.0.0.1', r));

// --- real relay (FakeLedger + faucet), same env the e2e harness uses --------------------------
const relayBin = process.env.DPAY_RELAY_BIN ?? join(ROOT, '.dev/target-e2e/debug/dpay-relay');
const relay = spawn(relayBin, [], { env: { ...process.env, DPAY_LEDGER: 'memory', DPAY_RELAY_ADDR: `127.0.0.1:${PORT_RELAY}`, DPAY_ENABLE_FAUCET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
relay.stderr.on('data', () => {});
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://127.0.0.1:${PORT_RELAY}/api/v1/health`); break; } catch { await sleep(100); }
}

const logs = [];
let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

try {
  const exe = resolveExecutablePath();
  if (!exe) throw new Error('no headless browser found (run e2e npm install once)');
  const browser = await puppeteer.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-web-security'] });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    logs.push(t);
    if (msg.type() === 'error') bad(`console error: ${t}`);
  });
  page.on('pageerror', (e) => bad(`pageerror: ${e.message}`));

  // 1–2. boot + self-check + onboard against the relay via ?relay=
  await page.goto(`http://127.0.0.1:${PORT_WEB}/wallet?relay=http://127.0.0.1:${PORT_RELAY}`, { waitUntil: 'networkidle0', timeout: 30000 });
  const selfcheck = logs.some((l) => l.includes('DPAY_SELFCHECK PASS'));
  selfcheck ? ok('DPAY_SELFCHECK PASS (wasm DpayCore boots, signs, verifies)') : bad('no DPAY_SELFCHECK PASS in console');

  await page.waitForSelector('[data-testid="btn-create"], input[placeholder*="name" i]', { timeout: 15000 }).catch(() => {});
  // Trip Ready J1 — skip the first-run walkthrough if it gates this fresh boot.
  {
    const skip = await page.waitForSelector('[data-testid="btn-walkthrough-skip"]', { timeout: 2000 }).catch(() => null);
    if (skip) await skip.click();
  }
  // Onboarding: create identity (the flow the e2e suite drives; anchors on the same testIDs).
  const typed = await page.evaluate(() => !!document.querySelector('input'));
  if (typed) {
    await page.type('input', 'SmokeTester');
    const btn = await page.$('[data-testid="btn-create"]');
    if (btn) await btn.click();
    // Trip Ready J2B/J3 — the create path plays the RECOVERY SAVED beat + payment rehearsal
    // before the wallet; dismiss the rehearsal so the wallet chrome check below is meaningful.
    const mnemonic = await page.waitForSelector('[data-testid="mnemonic-backup-checkbox"]', { timeout: 8000 }).catch(() => null);
    if (mnemonic) {
      await mnemonic.click();
      for (let i = 0; i < 100; i++) {
        const dis = await page.$eval('[data-testid="btn-mnemonic-continue"]', (n) => n.disabled || n.getAttribute('aria-disabled') === 'true').catch(() => true);
        if (!dis) break;
        await sleep(50);
      }
      await page.click('[data-testid="btn-mnemonic-continue"]');
      for (let i = 0; i < 150; i++) {
        const skip = await page.$('[data-testid="btn-rehearsal-skip"]');
        if (skip) { await skip.click(); break; }
        if (await page.$('[data-testid="balance"]')) break;
        await sleep(100);
      }
    }
  }
  await sleep(2500);

  // 3. identity persists across reload. AsyncStorage v3's default web impl is localStorage-backed
  //    (`getLegacyStorage()` — IndexedDB is the opt-in `createAsyncStorage` API we don't use), so
  //    assert the physical store: the app's `dpay.identity.v1` row must survive the reload.
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(2000);
  const persisted = await page.evaluate(() => {
    const id = localStorage.getItem('dpay.identity.v1');
    return { hasId: !!id, looksLike: !!id && /^\{"|^\{/.test(id) && id.includes('secretHex') };
  });
  const dbNames = await page.evaluate(async () =>
    (window.indexedDB && indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
  (persisted.hasId && persisted.looksLike)
    ? ok(`identity persists across reload (localStorage dpay.identity.v1, ${dbNames.length ? `+ IndexedDB ${dbNames.join('/')}` : 'localStorage-backed'})`)
    : bad('dpay.identity.v1 missing after reload — identity lost');
  // The real app's wallet chrome: settings button + the Pay/Receive/Transactions tab bar (aria
  // labels — see Tab.tsx). Onboarding re-appearing would mean the identity was lost.
  const stillWallet = await page.evaluate(() =>
    !!document.querySelector('[data-testid="btn-settings"], [aria-label="Pay"], [aria-label="Receive"]'));
  stillWallet ? ok('wallet renders after reload (no onboarding reset — identity persisted)') : bad('app reset to onboarding after reload — identity lost');

  // 4. wallet surfaces render (the real app's anchors, same ones the e2e flows drive)
  for (const sel of ['[data-testid="balance"]', '[data-testid="header-who"]', '[data-testid="btn-settings"]', '[aria-label="Pay"]', '[aria-label="Receive"]', '[aria-label="Transactions"]']) {
    const hit = await page.$(sel);
    hit ? ok(`${sel} renders`) : bad(`${sel} missing`);
  }

  // 5. screenshot + wrap up
  const shot = join(ROOT, 'e2e/shots/web-wallet-prod.png');
  await page.screenshot({ path: shot, fullPage: false });
  const size = statSync(shot).size;
  size > 30000 ? ok(`screenshot ${Math.round(size / 1024)} KB (rendered, not blank)`) : bad(`screenshot only ${size} B — likely blank`);

  await browser.close();
} catch (e) {
  bad(`smoke crashed: ${e.message}`);
} finally {
  relay.kill('SIGKILL');
  srv.close();
}
console.log(failed ? `\nWEB SMOKE FAILED (${failed})` : '\nweb smoke GREEN: /wallet is the real app, wasm-backed, persistent');
process.exit(failed ? 1 : 0);
