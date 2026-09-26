// validate-r3-capture2.mjs — the surfaces pass 1 missed (script navigation bugs, not app defects):
// light receive-form + deposit sheet, the composed VCHF→EURC hero (fiat 2dp) + 2-press drive,
// dark deposit sheet.
import {
  setup, stopSession, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, openConvertFor, pickSwapTarget,
  typeConvertAmount, skipWalkthroughIfPresent, skipPracticeIfPresent,
  chooseHomeCurrencyIfPresent, waitForEnabled,
} from './harness/lib.mjs';
import { startRelay } from './harness/relay.mjs';
import { installSideShiftStub, setSideShiftStatus } from './harness/sideshift.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(label, fn) {
  try {
    await fn();
    console.log(`[r3b] ✓ ${label}`);
  } catch (e) {
    console.error(`[r3b] ✗ ${label}: ${e?.message ?? e}`);
  }
}

async function confirmThrough(driver) {
  for (let round = 0; round < 5; round++) {
    await driver.click('btn-convert-confirm');
    const changed = await driver.findByTestID('convert-moved-note', { timeoutMs: 1_500 }).catch(() => null);
    const changed2 = changed ?? await driver.findByTestID('convert-quote-changed', { timeoutMs: 1_000 }).catch(() => null);
    if (changed2 == null) return;
    await sleep(300);
  }
}

function slowCanisterCalls(driver, ms) {
  const page = driver.page;
  const onReq = (req) => {
    if (req.url().includes('/api/v2/canister/')) {
      setTimeout(() => req.continue().catch(() => {}), ms);
    } else {
      req.continue().catch(() => {});
    }
  };
  page.on('request', onReq);
  return page.setRequestInterception(true).then(() => ({
    async release() {
      page.off('request', onReq);
      await page.setRequestInterception(false).catch(() => {});
    },
  }));
}

async function seedAndSheets(env, r2, tag) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`r3-${tag}-${name}`);
  await step(`${tag} onboard+seed`, async () => {
    await driver.click('tab-home', { timeoutMs: 10_000 }).catch(async () => {
      await onboardWallet(driver, `r3-${tag}`);
      await driver.click('tab-home', { timeoutMs: 5_000 });
    });
    const acct = await accountOf(driver);
    const a = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!a?.ok) throw new Error(`ICP faucet failed (${a?.status})`);
    const b = await faucetAccount(env.relayBaseURL, acct.publicHex, 2000000000, { currency: 7 });
    if (!b?.ok) throw new Error(`VCHF faucet failed (${b?.status})`);
  });
  await step(`${tag} receive+deposit`, async () => {
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('53-receive-form');
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await sleep(1_200);
    await shot('55-deposit');
    await driver.pressKey('Escape').catch(() => {});
    await sleep(300);
  });
}

{
  const env = await setup({ lazyBoot: false, solStub: true });
  const r2 = await startRelay();
  try {
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ venue_id: 'icpswap-fixture-b', served: true }),
    });
    console.log(`[r3b] venue knob armed (${arm.status})`);
    const { driver } = env;

    // Fast onboarding for this pass (pass 1 already shot the first-run beats).
    await step('light onboard', async () => {
      await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
      await skipWalkthroughIfPresent(driver);
      await driver.findByTestID('btn-create', { timeoutMs: 8_000 });
      await driver.typeByPlaceholder('e.g. Alice', 'r3b', { timeoutMs: 8_000 });
      await driver.click('btn-create', { timeoutMs: 4_000 });
      await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
      await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
      await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
      await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
      await driver.findByTestID('practice', { timeoutMs: 15_000 });
      await skipPracticeIfPresent(driver);
      await driver.findByTestID('home-currency-title', { timeoutMs: 10_000 });
      await chooseHomeCurrencyIfPresent(driver);
    });
    await seedAndSheets(env, r2, 'light');

    // Composed VCHF → EURC: the fiat-2dp hero on a stable out + the 2-press drive.
    await step('composed-ready', async () => {
      const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
      await installSideShiftStub(driver, { passOrigins, initialStatus: 'waiting' });
      await openConvertFor(driver, 'vchf');
      await pickSwapTarget(driver, 'EUR');
      await driver.findByTestID('convert-venue-auto', { timeoutMs: 20_000 });
      await sleep(500);
      await driver.eval(() => window.scrollTo(0, 0));
      await sleep(300);
      await driver.screenshot('r3-light-70-composed-ready');
      const fold = await driver.eval(() => {
        const el = document.querySelector('[data-testid="btn-convert-confirm"], [data-testid="convert-cta"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
      });
      console.log('[r3b] composed fold@entry =', JSON.stringify(fold));
      const receive = await driver.eval(() => document.querySelector('[data-testid="convert-receive"]')?.textContent ?? null);
      console.log('[r3b] composed receive hero =', JSON.stringify(receive));
    });
    await step('composed-awaiting', async () => {
      const slow = await slowCanisterCalls(driver, 1_500);
      await confirmThrough(driver);
      await driver.findByTestID('convert-state', { timeoutMs: 15_000 });
      await sleep(1_000);
      await driver.screenshot('r3-light-71-composed-sf');
      await driver.findByTestID('convert-awaiting-deposit', { timeoutMs: 60_000 });
      await sleep(600);
      await slow.release().catch(() => {});
      await driver.screenshot('r3-light-72-composed-awaiting');
    });
    await step('composed-done', async () => {
      await setSideShiftStatus(driver, 'settled', { settleAmount: '4.11', settleHash: 'sol-settle-sig-r3b' });
      await driver.findByTestID('convert-done', { timeoutMs: 60_000 });
      await sleep(600);
      await driver.screenshot('r3-light-73-composed-done');
    });
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
{
  const env = await setup({ dark: true, solStub: true });
  const r2 = await startRelay();
  try {
    await seedAndSheets(env, r2, 'dark');
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
console.log('[r3b] done.');
await stopSession();
