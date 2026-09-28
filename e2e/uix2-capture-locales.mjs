// UIX2 LOCALE CAPTURE — the G4 locale screenshot passes (de / es / fr).
// One wallet, three live language flips through the Settings language selector
// (btn-lang-<locale>); after each flip: the key surfaces in LIGHT, then home + pay +
// convert chooser again in DARK. Finds wrap/overflow/truncation the en-only passes
// cannot see. NOT a numbered flow.
// Run: node e2e/uix2-capture-locales.mjs → e2e/shots/val/locale-<tag>-*.png
import {setup, onboardWallet, accountOf, faucetAccount, openConvertFor, typeConvertAmount, openBalances, selectCurrency, openPaySend} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';
import {mkdirSync} from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE_VENUE = 'icpswap-fixture-b';
const LOCALES = ['de', 'es', 'fr'];

const env = await setup();
const r2 = await startRelay();
const shot = (name) => driver.screenshot(`val/${name}`);
let driver;
try {
  ({driver} = env);
  mkdirSync(new URL('./shots/val/', import.meta.url), {recursive: true});
  await fetch(`${r2.baseURL}/api/v1/test/venue`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true})});
  await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await sleep(600);
  await onboardWallet(driver, 'uix2-locale');
  await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});

  // Fund once, in en, before the flips: VCHF for the withdraw form, ICP for convert.
  await faucetAccount(r2.baseURL, (await accountOf(driver)).publicHex, 500000000, {currency: 7});
  await faucetAccount(r2.baseURL, (await accountOf(driver)).publicHex, 300000000, {currency: 8});
  await driver.click('tab-home', {timeoutMs: 4_000});

  const setLocale = async (tag) => {
    await driver.click('btn-settings', {timeoutMs: 4_000});
    await driver.click(`btn-lang-${tag}`, {timeoutMs: 4_000});
    await sleep(500); // the locale swap re-renders the sheet live
    await driver.click('btn-settings-close', {timeoutMs: 4_000});
    await sleep(400);
  };

  const convertFaces = async (tag, theme) => {
    await openConvertFor(driver, 'icp');
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    await driver.click('btn-convert-venues-other', {timeoutMs: 5_000});
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
    await driver.eval(() => window.scrollTo(0, 0));
    await driver.settleFrames(3);
    await shot(`locale-${tag}-${theme}-convert-chooser`);
    await driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 5_000});
    await driver.findByTestID('convert-min-out', {timeoutMs: 10_000});
    await driver.click('convert-details', {timeoutMs: 5_000});
    await driver.settleFrames(3);
    await shot(`locale-${tag}-${theme}-convert-checklist`);
    // Leave WITHOUT confirming: the record must stay clean for the next pass.
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await sleep(300);
  };

  for (const tag of LOCALES) {
    // ---------- fresh app state, then LIGHT in this locale ----------
    // A reload (not a tab click) is the honest cold start AND the sub-mode reset: the previous
    // pass leaves Pay in the send sub-mode and convert's Back on the accounts route; the app
    // opens on Home with an unarmed scanner. Wallet + locale + theme persist through it.
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await sleep(600);
    await setLocale(tag);

    await driver.click('tab-home', {timeoutMs: 4_000});
    await driver.findByTestID('home-headline-amount', {timeoutMs: 8_000});
    await sleep(400);
    await shot(`locale-${tag}-light-home`);

    // Deposit first (home asset), then select VCHF so the Pay shots show the SEND-CAPABLE
    // surface - the ModeToggle is exactly where the locale wraps were found (G4).
    await driver.click('btn-home-add-funds', {timeoutMs: 4_000});
    await driver.findByTestID('deposit-instructions', {timeoutMs: 6_000}).catch(() => driver.findByTestID('deposit-qr', {timeoutMs: 6_000}));
    await sleep(300);
    await shot(`locale-${tag}-light-deposit`);

    await openBalances(driver, {timeoutMs: 6_000});
    await selectCurrency(driver, 'vchf');
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', {timeoutMs: 6_000});
    await sleep(300);
    await shot(`locale-${tag}-light-withdraw`);

    // Back to the SCAN sub-mode on the same (send-capable) asset: toggle + viewfinder + NFC row.
    await driver.click('btn-pay-scan', {timeoutMs: 4_000});
    await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
    await sleep(300);
    await shot(`locale-${tag}-light-pay`);
    await driver.click('btn-start-scan', {timeoutMs: 4_000});
    await driver.findByTestID('scan-cam-box', {timeoutMs: 8_000});
    await sleep(300);
    await shot(`locale-${tag}-light-pay-armed`);

    await driver.click('tab-home', {timeoutMs: 4_000});
    await driver.click('home-hist-row-0', {timeoutMs: 4_000});
    await driver.findByTestID('txn-receipt', {timeoutMs: 4_000});
    await sleep(300);
    await shot(`locale-${tag}-light-receipt`);
    await driver.click('btn-txn-receipt-close', {timeoutMs: 4_000});

    await driver.click('tab-transactions', {timeoutMs: 4_000});
    await driver.findByTestID('ledger-view', {timeoutMs: 8_000});
    await sleep(300);
    await shot(`locale-${tag}-light-ledger`);

    await driver.click('tab-home', {timeoutMs: 4_000});
    await driver.click('btn-home-accounts', {timeoutMs: 4_000});
    await driver.findByTestID('accounts-list', {timeoutMs: 8_000});
    await sleep(300);
    await shot(`locale-${tag}-light-accounts`);
    await driver.click('btn-accounts-back', {timeoutMs: 4_000});

    await convertFaces(tag, 'light');

    // ---------- DARK, the three key faces ----------
    // Reload first: the light pass left Pay armed and convert may have re-entered; a cold start
    // is the same state every dark pass sees.
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await sleep(600);
    await driver.click('btn-theme', {timeoutMs: 4_000});
    await sleep(500);
    await shot(`locale-${tag}-dark-home`);
    // The dark pay face on the send-capable surface (same selection as the light pass).
    await driver.click('tab-pay', {timeoutMs: 4_000});
    await driver.findByTestID('pay-viewfinder', {timeoutMs: 8_000});
    await sleep(300);
    await shot(`locale-${tag}-dark-pay`);
    await convertFaces(tag, 'dark');
    await driver.click('btn-theme', {timeoutMs: 4_000});
    await sleep(400);
    console.log(`[uix2-locales] ✓ ${tag} pass done`);
  }
  console.log('[uix2-locales] all passes done');
} finally {
  await env.stop?.();
}
