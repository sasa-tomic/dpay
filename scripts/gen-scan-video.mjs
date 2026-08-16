#!/usr/bin/env node
// Generates e2e/shots/scan-qr.y4m — the fake-camera video for web-scan-smoke.mjs (`just web-scan`).
//
// A REAL 132-byte wire payment request (harness/wire.mjs buildRequestQR, fresh keypair + nonce) is
// rendered as a black-on-white QR PNG (app/node_modules/qrcode) and loop-padded to 640x480 via
// ffmpeg. Chrome's --use-file-for-fake-video-capture replays it as the camera device, so the
// prod-build smoke exercises the true getUserMedia→video→canvas→jsQR path. Offline, deterministic
// per run (fresh nonce — the app accepts any well-formed request).
import { createRequire } from 'node:module';
import { generateKeypair, randNonceHex, buildRequestQR } from '../e2e/harness/wire.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const QR = require(join(__dirname, '../app/node_modules/qrcode'));

const outDir = join(__dirname, '../e2e/shots');
mkdirSync(outDir, { recursive: true });
const png = join(outDir, 'scan-qr-src.png');
const y4m = join(outDir, 'scan-qr.y4m');

const bob = await generateKeypair();
const qr = buildRequestQR(bob.publicHex, 2500, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
await QR.toFile(png, qr, { width: 440, margin: 3, color: { dark: '000000ff', light: 'ffffffff' }, errorCorrectionLevel: 'M' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '3', '-r', '24',
  '-vf', 'pad=640:480:(ow-iw)/2:(oh-ih)/2:white', '-pix_fmt', 'yuv420p', y4m]);
console.log(`scan video: ${y4m} (request ${qr.slice(0, 24)}…)`);
