// UIX2 SLICE-1 CAPTURE — the craft-pass screenshots (founder review artifact).
//
// NOT a numbered flow: drives the REAL app (offline test-helpers relay) and screenshots the
// slice-1 faces — Home, Pay idle (the composed viewfinder), and the bottom nav — in LIGHT and
// DARK. Run: node e2e/uix2-capture.mjs   → e2e/shots/uix2/slice1-*.png
import {setup, onboardWallet} from './harness/lib.mjs';
import {mkdirSync} from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = await setup();
try {
  const {driver} = env;
  mkdirSync(new URL('./shots/uix2/', import.meta.url), {recursive: true});
  console.log('[uix2] onboarding…');
  await onboardWallet(driver, 'uix2-capture');
  await driver.findByTestID('pay-scan', {timeoutMs: 8_000});
  await sleep(600);

  // LIGHT — Pay idle (the viewfinder instrument is the face of this slice).
  await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
  await driver.screenshot('uix2/slice1-light-pay');
  // The armed camera (web shim grants instantly) — the geometry must match the instrument.
  await driver.click('btn-start-scan', {timeoutMs: 4_000});
  await driver.findByTestID('scan-cam-box', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('uix2/slice1-light-pay-armed');

  // LIGHT — Home (left-aligned headline + the divided action panel + section header row).
  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.findByTestID('home-headline-amount', {timeoutMs: 8_000});
  await sleep(500);
  await driver.screenshot('uix2/slice1-light-home');

  // DARK — the same three faces under the night palette.
  await driver.click('btn-theme', {timeoutMs: 4_000});
  await sleep(500);
  await driver.screenshot('uix2/slice1-dark-home');
  await driver.click('tab-pay', {timeoutMs: 4_000});
  await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('uix2/slice1-dark-pay');
  console.log('[uix2] captures done');
} finally {
  await env.stop?.();
}
