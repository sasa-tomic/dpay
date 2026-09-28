// UIX2 FULL CAPTURE — every key surface, LIGHT and DARK (validator pass 2026-09-28).
// Companion to uix2-capture.mjs (slice faces only): this one adds onboarding, deposit, the
// withdraw/send form, the receipt, the convert intent sheet (chooser + checklist), the
// Settlement Field in-flight + done states, all in both themes.
// NOT a numbered flow. Run: node e2e/uix2-capture-full.mjs → e2e/shots/val/*.png
import {setup, onboardWallet, accountOf, faucetAccount, openConvertFor, typeConvertAmount, openBalances, selectCurrency, openPaySend} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';
import {mkdirSync} from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE_VENUE = 'icpswap-fixture-b';
const env = await setup();
const r2 = await startRelay();
try {
  const {driver, webBaseURL} = env;
  mkdirSync(new URL('./shots/val/', import.meta.url), {recursive: true});
  await fetch(`${r2.baseURL}/api/v1/test/venue`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true})});
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await sleep(600);
  await driver.screenshot('val/light-onboarding');

  await onboardWallet(driver, 'val-capture');
  await driver.findByTestID('pay-scan', {timeoutMs: 8_000});
  await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
  await sleep(500);
  await driver.screenshot('val/light-pay');
  await driver.click('btn-start-scan', {timeoutMs: 4_000});
  await driver.findByTestID('scan-cam-box', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/light-pay-armed');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.findByTestID('home-headline-amount', {timeoutMs: 8_000});
  await sleep(600);
  await driver.screenshot('val/light-home');

  await driver.click('btn-home-add-funds', {timeoutMs: 4_000});
  await driver.findByTestID('deposit-instructions', {timeoutMs: 6_000}).catch(() => driver.findByTestID('deposit-qr', {timeoutMs: 6_000}));
  await sleep(400);
  await driver.screenshot('val/light-deposit');
  await driver.click('tab-home', {timeoutMs: 4_000});

  await faucetAccount(r2.baseURL, (await accountOf(driver)).publicHex, 500000000, {currency: 7});
  await openBalances(driver, {timeoutMs: 6_000});
  await selectCurrency(driver, 'vchf');
  await openPaySend(driver);
  await driver.findByTestID('send-address-input', {timeoutMs: 6_000});
  await sleep(400);
  await driver.screenshot('val/light-withdraw');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('home-hist-row-0', {timeoutMs: 4_000});
  await driver.findByTestID('txn-receipt', {timeoutMs: 4_000});
  await sleep(400);
  await driver.screenshot('val/light-receipt');
  await driver.click('btn-txn-receipt-close', {timeoutMs: 4_000});

  await driver.click('tab-transactions', {timeoutMs: 4_000});
  await driver.findByTestID('ledger-view', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/light-ledger');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('btn-home-accounts', {timeoutMs: 4_000});
  await driver.findByTestID('accounts-list', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/light-accounts');
  await driver.click('btn-accounts-back', {timeoutMs: 4_000});

  await driver.click('btn-settings', {timeoutMs: 4_000});
  await driver.findByTestID('btn-settings-close', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/light-settings');
  await driver.click('btn-settings-close', {timeoutMs: 4_000});

  // CONVERT (light): faucet ICP → chooser → checklist → field → done.
  const account = await accountOf(driver);
  await faucetAccount(r2.baseURL, account.publicHex, 300000000, {currency: 8});
  await openConvertFor(driver, 'icp');
  await typeConvertAmount(driver, '1');
  await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
  await driver.click('btn-convert-venues-other', {timeoutMs: 5_000});
  await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
  await driver.eval(() => window.scrollTo(0, 0));
  await driver.settleFrames(3);
  await driver.screenshot('val/light-convert-chooser');
  await driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 5_000});
  await driver.findByTestID('convert-min-out', {timeoutMs: 10_000});
  await driver.click('convert-details', {timeoutMs: 5_000});
  await driver.settleFrames(3);
  await driver.screenshot('val/light-convert-checklist');
  await driver.click('btn-convert-confirm', {timeoutMs: 6_000});
  let inflight = false;
  for (let i = 0; i < 60 && !inflight; i++) {
    inflight = await driver.eval(() => document.querySelector('[data-testid="convert-state"]') != null).catch(() => false);
    if (!inflight) await sleep(80);
  }
  await driver.settleFrames(2);
  await driver.screenshot('val/light-convert-field');
  await driver.findByTestID('convert-done', {timeoutMs: 60_000});
  await sleep(400);
  await driver.screenshot('val/light-convert-done');

  // ---------- DARK ----------
  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('btn-theme', {timeoutMs: 4_000});
  await sleep(600);
  await driver.screenshot('val/dark-home');
  // Fresh app state (the light pass left Pay in the send sub-mode): reload keeps the persisted
  // dark theme + wallet, and the app opens on Home with an unarmed scanner.
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await sleep(600);
  await driver.click('tab-pay', {timeoutMs: 4_000});
  await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/dark-pay');
  await driver.click('btn-start-scan', {timeoutMs: 4_000});
  await driver.findByTestID('scan-cam-box', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/dark-pay-armed');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('btn-home-add-funds', {timeoutMs: 4_000});
  await driver.findByTestID('deposit-instructions', {timeoutMs: 6_000}).catch(() => driver.findByTestID('deposit-qr', {timeoutMs: 6_000}));
  await sleep(400);
  await driver.screenshot('val/dark-deposit');
  await driver.click('tab-home', {timeoutMs: 4_000});

  await openBalances(driver, {timeoutMs: 6_000});
  await selectCurrency(driver, 'vchf');
  await openPaySend(driver);
  await driver.findByTestID('send-address-input', {timeoutMs: 6_000});
  await sleep(400);
  await driver.screenshot('val/dark-withdraw');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('home-hist-row-0', {timeoutMs: 4_000});
  await driver.findByTestID('txn-receipt', {timeoutMs: 4_000});
  await sleep(400);
  await driver.screenshot('val/dark-receipt');
  await driver.click('btn-txn-receipt-close', {timeoutMs: 4_000});

  await driver.click('tab-transactions', {timeoutMs: 4_000});
  await driver.findByTestID('ledger-view', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/dark-ledger');

  await driver.click('tab-home', {timeoutMs: 4_000});
  await driver.click('btn-home-accounts', {timeoutMs: 4_000});
  await driver.findByTestID('accounts-list', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/dark-accounts');
  await driver.click('btn-accounts-back', {timeoutMs: 4_000});

  await driver.click('btn-settings', {timeoutMs: 4_000});
  await driver.findByTestID('btn-settings-close', {timeoutMs: 8_000});
  await sleep(400);
  await driver.screenshot('val/dark-settings');
  await driver.click('btn-settings-close', {timeoutMs: 4_000});

  // CONVERT (dark): the VCHF the light drive just landed, back toward ICP at the prefilled max.
  await openConvertFor(driver, 'vchf');
  await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
  await driver.click('btn-convert-venues-other', {timeoutMs: 5_000}).catch(() => {});
  await driver.eval(() => window.scrollTo(0, 0));
  await driver.settleFrames(3);
  await driver.screenshot('val/dark-convert-chooser');
  await driver.click('convert-details', {timeoutMs: 5_000});
  await driver.settleFrames(3);
  await driver.screenshot('val/dark-convert-checklist');
  await driver.click('btn-convert-confirm', {timeoutMs: 6_000});
  inflight = false;
  for (let i = 0; i < 60 && !inflight; i++) {
    inflight = await driver.eval(() => document.querySelector('[data-testid="convert-state"]') != null).catch(() => false);
    if (!inflight) await sleep(80);
  }
  await driver.settleFrames(2);
  await driver.screenshot('val/dark-convert-field');
  await driver.findByTestID('convert-done', {timeoutMs: 60_000});
  await sleep(400);
  await driver.screenshot('val/dark-convert-done');
  console.log('[val-capture] all captures done');
} finally {
  await env.stop?.();
  await r2.stop();
}
