#!/usr/bin/env node
// Generates the fake-camera fixture for web-scan-smoke.mjs (`just web-scan`):
//   e2e/shots/scan-qr.y4m   the video chrome replays as the camera device
//   e2e/shots/scan-qr.json  what that video ENCODES, so the smoke can assert the DECODE
//
// A REAL 132-byte wire payment request (harness/wire.mjs buildRequestQR, fresh keypair + nonce) is
// rendered as a black-on-white QR PNG (app/node_modules/qrcode) and loop-padded to 640x480 via
// ffmpeg. Chrome's --use-file-for-fake-video-capture replays it as the camera device, so the
// prod-build smoke exercises the true getUserMedia→video→canvas→jsQR path. Offline, deterministic
// per run (fresh nonce — the app accepts any well-formed request).
//
// WHY THE AMOUNT IS ABOVE WHAT THE WALLET HOLDS. The smoke's subject is the DECODER, and the app's
// camera path auto-signs a decoded request that it CAN pay (PayMode `onRequestString`, the
// one-press rule of 2026-08-24). The shipped web bundle has no IC-gateway test seam — by design,
// `scripts/check-web-prod-seams.mjs` fails the build if one leaks — so a sign here would submit a
// real envelope to https://icp-api.io. A local build gate must not reach mainnet, and must not
// depend on it being up. Asking for more than the onboarding faucet grants (∂100.00 — see
// `onboardWallet` in e2e/harness/lib.mjs) puts the review on its fail-closed terminal instead:
// the decoded amount and payee are on screen, read out of camera frames, and nothing is signed.
// That is the decoder proof, plus a free pin on "online + insufficient never signs".
import { createRequire } from 'node:module';
import { generateKeypair, randNonceHex, buildRequestQR } from '../e2e/harness/wire.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const QR = require(join(__dirname, '../app/node_modules/qrcode'));

const outDir = join(__dirname, '../e2e/shots');
mkdirSync(outDir, { recursive: true });
const png = join(outDir, 'scan-qr-src.png');
const y4m = join(outDir, 'scan-qr.y4m');
const meta = join(outDir, 'scan-qr.json');

// DEMO (currency 0) is a 2-decimal rail — dfx/catalog_truth.json, mirrored by the relay catalog.
const CURRENCY = 0;
const DECIMALS = 2;
const AMOUNT_RAW = 25_000; // ∂250.00 — above the ∂100.00 faucet grant; see the header.
const PAYEE_NAME = 'Bob';

// ffmpeg is the one tool outside the in-project toolchain this needs. Say so plainly rather than
// letting execFileSync throw a bare ENOENT out of a gate the caller did not know depended on it.
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error(
    'gen-scan-video: `ffmpeg` is not on PATH, and it is what turns the QR image into the video\n' +
    'chrome replays as a camera. Install it (Debian/Ubuntu: `sudo apt install ffmpeg`) and re-run\n' +
    '`just web-scan`. Nothing else in the inner loop needs it.',
  );
  process.exit(1);
}

const bob = await generateKeypair();
const qr = buildRequestQR(bob.publicHex, AMOUNT_RAW, randNonceHex(), Math.floor(Date.now() / 1000) + 600, CURRENCY, PAYEE_NAME);
await QR.toFile(png, qr, { width: 440, margin: 3, color: { dark: '000000ff', light: 'ffffffff' }, errorCorrectionLevel: 'M' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '3', '-r', '24',
  '-vf', 'pad=640:480:(ow-iw)/2:(oh-ih)/2:white', '-pix_fmt', 'yuv420p', y4m]);

// The sidecar is the ONE statement of what the video says, so the smoke asserts a round trip
// (encoded here → painted as pixels → decoded by the shipped jsQR → rendered) rather than merely
// "some review appeared". `amountText` is the plain decimal the review must contain; the currency
// glyph and grouping are the app's own formatting and are deliberately not pinned here.
writeFileSync(meta, `${JSON.stringify({
  currency: CURRENCY,
  amountRaw: String(AMOUNT_RAW),
  amountText: (AMOUNT_RAW / 10 ** DECIMALS).toFixed(DECIMALS),
  payeeName: PAYEE_NAME,
}, null, 2)}\n`);

console.log(`scan video: ${y4m} (request ${qr.slice(0, 24)}… → ${PAYEE_NAME} ${(AMOUNT_RAW / 10 ** DECIMALS).toFixed(DECIMALS)})`);
