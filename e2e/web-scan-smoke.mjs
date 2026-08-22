#!/usr/bin/env node
// Web PROD camera-scan smoke (`just web-scan`): proves the REAL camera path of the shipped bytes.
//
//   relay (real dpay-relay, FakeLedger)  +  sirv serving e2e/dist-prod (the exact embedded bytes)
//   →  headless chrome with a FAKE CAMERA (--use-fake-device-for-media-stream
//     --use-file-for-fake-video-capture=qr.y4m) drives the REAL app at /wallet:
//     1. onboard (faucet-funded), land on Pay (scan screen)
//     2. click "Allow camera scan" (the founder gesture rule — camera only opens on explicit click)
//     3. a REAL getUserMedia stream flows from the fake device; camera-real.tsx's rAF
//        video→canvas→jsQR loop must decode the dpay request QR IN THE VIDEO FRAMES
//     4. the app reacts: PayMode leaves the scan phase and mounts the review (btn-approve)
//
// This is the gate the e2e suite structurally CANNOT run: the e2e build aliases the camera to the
// inject-only shim (camera.ts), so a broken DECODER (the 2026-08-16 /jsqr.js 404 regression, a
// bundler interop break of the vendored UMD, a decode-loop regression) sails through `just verify`
// and only dies on prod web. Here the decode is exercised for real — if jsQR never fires, the
// approve step times out and the smoke REDs with the exact console state.
//
// The y4m is generated from a REAL wire request (harness/wire.mjs buildRequestQR) — see
// scripts/gen-scan-video.mjs. Node-only, offline.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { resolveExecutablePath } from './harness/browser.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'e2e/dist-prod');
const Y4M = process.env.DPAY_SCAN_Y4M ?? join(ROOT, 'e2e/shots/scan-qr.y4m');
const PORT_WEB = 4393;
const PORT_RELAY = 4394;

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
  if (!existsSync(Y4M)) throw new Error(`fake-camera video missing: ${Y4M} (run scripts/gen-scan-video.mjs)`);
  const exe = resolveExecutablePath();
  if (!exe) throw new Error('no headless browser found (run e2e npm install once)');
  const browser = await puppeteer.launch({
    executablePath: exe,
    args: [
      '--no-sandbox',
      // THE POINT OF THIS SMOKE: a real (fake) camera device whose frames contain a dpay request QR.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    logs.push(t);
    if (msg.type() === 'error') bad(`console error: ${t}`);
  });
  page.on('pageerror', (e) => bad(`pageerror: ${e.message}`));

  // 1. boot + onboard (the same DOM path the e2e harness drives: name → create → mnemonic backup
  //    checkbox → continue → faucet funds → wallet renders).
  await page.goto(`http://127.0.0.1:${PORT_WEB}/wallet?relay=http://127.0.0.1:${PORT_RELAY}`, { waitUntil: 'networkidle0', timeout: 30000 });
  const selfcheck = logs.some((l) => l.includes('DPAY_SELFCHECK PASS'));
  selfcheck ? ok('DPAY_SELFCHECK PASS') : bad('no DPAY_SELFCHECK PASS in console');
  await page.waitForSelector('input[placeholder*="e.g." i], [data-testid="btn-create"]', { timeout: 15000 });
  await page.type('input[placeholder*="e.g." i]', 'ScanTester');
  await page.click('[data-testid="btn-create"]');
  await page.waitForSelector('[data-testid="mnemonic-backup"]', { timeout: 8000 });
  await page.click('[data-testid="mnemonic-backup-checkbox"]');
  for (let i = 0; i < 100; i++) {
    const dis = await page.$eval('[data-testid="btn-mnemonic-continue"]', (n) => n.disabled || n.getAttribute('aria-disabled') === 'true').catch(() => true);
    if (!dis) break;
    await sleep(50);
  }
  await page.click('[data-testid="btn-mnemonic-continue"]');
  // Trip Ready J2B/J3 — the create path plays the RECOVERY SAVED beat (~750ms) then the payment
  // rehearsal. Dismiss the rehearsal when present (restore paths never see it); landing on the
  // wallet balance either way is the outcome we want.
  for (let i = 0; i < 150; i++) {
    const skip = await page.$('[data-testid="btn-rehearsal-skip"]');
    if (skip) { await skip.click(); break; }
    if (await page.$('[data-testid="balance"]')) break;
    await sleep(100);
  }
  await page.waitForSelector('[data-testid="balance"]', { timeout: 10000 });
  await sleep(2500);
  const walletUp = await page.$('[data-testid="btn-settings"]');
  walletUp ? ok('wallet rendered (onboarded)') : bad('wallet did not render after onboarding');

  // 2. interop probe: the vendored jsQR must NOT leak onto window — if the UMD attached there, the
  //    ESM default import is suspect (the bundler treated the .js as ESM under type:module).
  const winJsQR = await page.evaluate(() => typeof window.jsQR);
  winJsQR === 'undefined' ? ok('window.jsQR undefined (vendored UMD resolved via CJS interop, not a window leak)') : bad(`window.jsQR is ${winJsQR} — the UMD ran as ESM and attached to the global; the default import may be undefined (rename vendor to .cjs)`);

  // 3. Pay tab → scan screen → the founder-gesture camera open. NOTE: Pay is the DEFAULT tab, the
  //    fake-UI flag auto-grants camera permission, and the decode can land during/right after
  //    onboarding — so this is a RACE: wait directly for the OUTCOME (review = btn-approve), not
  //    the intermediate scan box. If the review isn't up yet, nudge to Pay (idempotent) and re-wait.
  let approveBtn = await page.waitForSelector('[data-testid="btn-approve"]', { timeout: 6000 }).catch(() => null);
  if (!approveBtn) {
    await page.click('[aria-label="Pay"]').catch(() => {});
    approveBtn = await page.waitForSelector('[data-testid="btn-approve"]', { timeout: 8000 }).catch(() => null);
  }
  approveBtn ? ok('camera scan landed on review (jsQR decoded the request QR from video frames)') : bad('camera scan never landed on review — jsQR decode did not fire (decoder broken in the shipped bytes)');

  // 4. THE GATE: jsQR must decode the request QR out of the video frames and the app must leave the
  //    scan phase for the review. If the decoder is dead (interop/404/loop regression) this times
  //    out and REDs — exactly the class `just verify` cannot see.
  let review = false;
  for (let i = 0; i < 40 && !review; i++) {
    await sleep(250);
    review = !!(await page.$('[data-testid="btn-approve"]'));
  }
  review ? ok('QR DECODED from camera frames — app reached the review (btn-approve)') : bad('camera scan never landed on review — jsQR decode did not fire (decoder broken in the shipped bytes)');

  await page.screenshot({ path: join(ROOT, 'e2e/shots/web-scan-prod.png'), fullPage: false });
  await browser.close();
} catch (e) {
  bad(`smoke crashed: ${e.message}`);
} finally {
  relay.kill('SIGKILL');
  srv.close();
}
console.log(failed ? `\nWEB SCAN SMOKE FAILED (${failed})` : '\nweb scan smoke GREEN: the shipped /wallet decodes a real camera stream');
process.exit(failed ? 1 : 0);
