#!/usr/bin/env node
// Web PROD camera-scan smoke (`just web-scan`) — proves the REAL camera path of the shipped bytes.
//
//   e2e/dist-prod (the exact bytes the relay embeds at /wallet)
//   + the REAL dpay-relay (FakeLedger + faucet, spawned by the e2e harness)
//   → headless chrome with a FAKE CAMERA DEVICE (--use-fake-device-for-media-stream
//     --use-file-for-fake-video-capture=scan-qr.y4m) drives the real app:
//     1. DPAY_SELFCHECK PASS, then the full first run (harness `onboardWallet`, which also puts
//        the wallet on DEMO — the currency the y4m's request names)
//     2. the vendored jsQR must NOT be on `window` (UMD-as-ESM interop regression guard)
//     3. Pay ▸ "Pay now" ▸ "Allow camera scan" — the two deliberate gestures that stand between
//        the tab and a running lens (see the block comment at the presses)
//     4. THE GATE: a real getUserMedia stream flows from the fake device and camera-real.tsx's
//        rAF video→canvas→jsQR loop must DECODE the request QR out of the video frames — the
//        review's amount and payee must be the ones the y4m ENCODED, and, because the fixture
//        asks for more than the wallet holds, the app must refuse to sign
//     5. no off-box origin contacted, and the Driver's own teardown gate (console error /
//        pageerror / failed request)
//
// This is the gate the e2e suite structurally CANNOT run: the e2e build aliases the camera to the
// inject-only shim (camera.ts), so a broken DECODER (the 2026-08-16 /jsqr.js 404 regression, a
// bundler interop break of the vendored UMD, a decode-loop regression) sails through `just verify`
// and only dies on prod web. Here the decode is exercised for real — if jsQR never fires, step 4
// times out and the smoke REDs with what was on screen instead.
//
// The y4m is generated from a REAL wire request (harness/wire.mjs buildRequestQR, currency 0 =
// DEMO), and `scan-qr.json` beside it says what that request contains, so step 4 asserts a round
// trip rather than "a review appeared" — see scripts/gen-scan-video.mjs. Node-only, offline.
//
// Why the harness is imported rather than re-implemented, and why the Solana rail is off: the
// module header of e2e/web-wallet-smoke.mjs — both smokes are the same shape and the reasoning is
// one fact. (This file was RED for the same reason that one was: its private copy of the first-run
// sequence had drifted, and it never even reached the camera.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Driver } from './harness/driver.mjs';
import { onboardWallet } from './harness/lib.mjs';
import { startRelay, pickFreePort } from './harness/relay.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'e2e/dist-prod');
const Y4M = process.env.DPAY_SCAN_Y4M ?? join(ROOT, 'e2e/shots/scan-qr.y4m');
// The sidecar `scripts/gen-scan-video.mjs` writes beside the video: what the QR in those frames
// encodes. Same basename, so an overridden y4m brings its own fixture rather than a stale one.
const FIXTURE = `${Y4M.replace(/\.y4m$/, '')}.json`;

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

// --- static server for dist-prod (same shape as web-wallet-smoke.mjs) ---------------------------
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

const relay = await startRelay();

let driver = null;
try {
  if (!existsSync(Y4M)) throw new Error(`fake-camera video missing: ${Y4M} (run scripts/gen-scan-video.mjs)`);
  if (!existsSync(FIXTURE)) throw new Error(`fake-camera fixture missing: ${FIXTURE} (run scripts/gen-scan-video.mjs)`);
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  driver = await Driver.create({
    extraArgs: [
      // THE POINT OF THIS SMOKE: a real (fake) camera device whose frames carry a dpay request QR.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  });

  const foreignOrigins = new Map();
  const localOrigins = new Set([webBase, relay.baseURL]);
  driver.page.on('request', (req) => {
    const url = req.url();
    if (!/^https?:/.test(url)) return;
    const origin = new URL(url).origin;
    if (localOrigins.has(origin)) return;
    if (!foreignOrigins.has(origin)) foreignOrigins.set(origin, url);
  });

  // 1. boot + self-check + the full first run (ends on Pay, DEMO selected, faucet-funded).
  await driver.navigate(webBase, `/wallet?relay=${relay.baseURL}`);
  await driver.waitReady();
  driver.consoleLog.some((l) => l.text.includes('DPAY_SELFCHECK PASS'))
    ? ok('DPAY_SELFCHECK PASS')
    : bad('no DPAY_SELFCHECK PASS in console');
  await onboardWallet(driver, 'ScanTester');
  ok('wallet rendered (onboarded, on the DEMO rail the y4m request names)');

  // 2. interop probe: the vendored jsQR must NOT leak onto window — if the UMD attached there, the
  //    ESM default import is suspect (the bundler treated the .js as ESM under type:module).
  const winJsQR = await driver.eval(() => typeof window.jsQR);
  winJsQR === 'undefined'
    ? ok('window.jsQR undefined (vendored UMD resolved via CJS interop, not a window leak)')
    : bad(`window.jsQR is ${winJsQR} — the UMD ran as ESM and attached to the global; the default import may be undefined (rename vendor to .cjs)`);

  // 3+4. TWO deliberate gestures stand between the Pay tab and a running camera, and the smoke
  //      makes both, because both are founder rules and a real payer makes both:
  //        · `btn-start-scan` ("Pay now") arms the surface — camera and NFC start only there.
  //        · "Allow camera scan" is the ONLY call that may touch getUserMedia (camera-real.tsx
  //          module header): QrScanner's silent path queries the permission and, while it is still
  //          `prompt`, renders the placeholder WITHOUT opening a stream. Chrome's
  //          --use-fake-ui-for-media-stream then auto-accepts the prompt this click raises.
  //      Both are addressed by testID (`btn-allow-camera` landed 2026-09-08): this smoke used to
  //      reach the permission button through its localised aria-label, the one locale-coupled
  //      selector left in either smoke, and a selector that renames itself the moment a locale
  //      lands is a gate that goes green by not running.
  //      Re-arm once if the review has not appeared: a press can land while the surface is still
  //      resolving, which is a no-op that no exception reports.
  const openGate = async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    if (await driver.isPresent('btn-start-scan')) await driver.click('btn-start-scan', { timeoutMs: 4_000 });
    // The permission button only mounts once the surface is armed, so this WAITS for it rather
    // than probing — and says so when it never comes, instead of passing silently.
    const allow = await driver.findByTestID('btn-allow-camera', { timeoutMs: 4_000 }).catch(() => null);
    if (allow) await allow.click();
    else console.log('  · btn-allow-camera did not mount within 4s (permission already granted, or the surface never armed)');
  };
  await openGate();
  let review = await driver.findByTestID('pay-amount', { timeoutMs: 8_000 }).then(() => true).catch(() => false);
  if (!review) {
    await openGate();
    review = await driver.findByTestID('pay-amount', { timeoutMs: 12_000 }).then(() => true).catch(() => false);
  }
  const screen = (await driver.bodyText()).replace(/\s+/g, ' ');
  if (!review) {
    bad('camera scan never landed on review — jsQR decode did not fire (decoder broken in the shipped bytes)');
    console.error(`  · on screen: ${JSON.stringify(screen.slice(0, 400))}`);
  } else {
    // The ROUND TRIP: what gen-scan-video.mjs encoded is what the shipped decoder read out of the
    // video frames. Asserting the values (not just "a review mounted") is what makes this a
    // decoder gate rather than a "something happened" gate.
    const amount = await driver.readText('pay-amount');
    amount.includes(fixture.amountText)
      ? ok(`QR DECODED from camera frames — the review reads the encoded amount (${fixture.amountText})`)
      : bad(`review amount ${JSON.stringify(amount)} does not contain the encoded ${fixture.amountText}`);
    screen.includes(fixture.payeeName)
      ? ok(`the encoded payee name (${fixture.payeeName}) reached the review`)
      : bad(`the encoded payee name ${fixture.payeeName} is not on the review: ${JSON.stringify(screen.slice(0, 400))}`);
    // Fail-closed terminal, by construction: the fixture asks for more than the faucet grants, so
    // the app must refuse to sign rather than submit — which is also what keeps this gate local
    // (a signed envelope goes to https://icp-api.io; see the gen-scan-video.mjs header).
    (await driver.isPresent('review-lowbal'))
      ? ok('online + insufficient → refused, nothing signed')
      : bad(`the unaffordable request did not land on the low-balance terminal: ${JSON.stringify(screen.slice(0, 400))}`);
  }

  await driver.screenshot('web-scan-prod');

  // 5. the gate that keeps this gate honest.
  foreignOrigins.size === 0
    ? ok('no off-box origin contacted')
    : bad(`off-box origins contacted: ${[...foreignOrigins.values()].join(', ')}`);
} catch (e) {
  bad(`smoke crashed: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  if (driver) {
    try { await driver.close(); } catch (e) { bad(`page diagnostics: ${e instanceof Error ? e.message : e}`); }
  }
  await relay.stop();
  srv.close();
}
console.log(failed ? `\nWEB SCAN SMOKE FAILED (${failed})` : '\nweb scan smoke GREEN: the shipped /wallet decodes a real camera stream');
process.exit(failed ? 1 : 0);
