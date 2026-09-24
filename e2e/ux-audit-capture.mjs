// UX-AUDIT CAPTURE — one-shot visual-evidence collector for the full-surface premium-UX audit.
//
// NOT a numbered flow: drives the REAL app (offline test-helpers relay) through EVERY major
// surface and screenshots each, in light/en (primary), dark/en, and light/de passes:
//   • first run: walkthrough → create form → backup gate → practice → home-currency question
//   • funded wallet: home, accounts, selected-asset actions, Pay scan shim, send form + review,
//     receive QR + address, request, add-money funding sheet, history, txn receipt, settings,
//     reset dialog
//   • convert: FUNDED happy path (3 ICP seeded via faucet currency:8) — destination picker →
//     amount+quote → details disclosure → checklist → in-flight → done
//   • checkout (checkout) code form + charge QR with VCHF SELECTED (the rail the checkout takes)
//   • SOL rail in its OWN pass with {solStub:true}: accounts SOL card, SOL receive QR + address,
//     SOL pay, SOL send form
// Run: node e2e/ux-audit-capture.mjs   (screenshots land in e2e/shots/ux-*.png)
import {
  setup, stopSession, onboardWallet, openBalances, selectCurrency, openPaySend,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent,
  waitForEnabled, accountOf, railPrincipalText, faucetAccount,
} from './harness/lib.mjs';
import { openHistory } from './harness/flow-steps.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Best-effort step: a capture that fails must not kill the remaining captures. */
async function step(label, fn) {
  try {
    await fn();
    console.log(`[ux-audit] ✓ ${label}`);
  } catch (e) {
    console.error(`[ux-audit] ✗ ${label}: ${e?.message ?? e}`);
  }
}

async function runPass(env, tag, opts = {}) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`ux-${tag}-${name}`);

  // --- first run -----------------------------------------------------------------
  await step('walkthrough', async () => {
    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    await shot('01-walkthrough');
    await skipWalkthroughIfPresent(driver);
  });
  await step('create-form', async () => {
    await driver.findByTestID('btn-create', { timeoutMs: 8_000 });
    await shot('02-create-form');
    await driver.typeByPlaceholder('e.g. Alice', `ux-${tag}`, { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
  });
  await step('backup-gate', async () => {
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await shot('03-backup-gate');
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
  });
  await step('practice', async () => {
    await driver.findByTestID('practice', { timeoutMs: 15_000 });
    await sleep(1_500); // let the practice payment settle its first paint
    await shot('04-practice');
    await skipPracticeIfPresent(driver);
  });
  await step('home-currency', async () => {
    await driver.findByTestID('home-currency-title', { timeoutMs: 10_000 });
    await shot('05-home-currency');
    await chooseHomeCurrencyIfPresent(driver);
  });

  // Seed real ICP so the convert happy path (picker → quote → checklist → confirm → done) runs
  // funded — flow 140's recipe: faucet currency:8 = 3 ICP.
  await step('seed-icp', async () => {
    const acct = await accountOf(driver);
    const fund = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!fund?.ok) throw new Error(`ICP faucet failed (status ${fund?.status})`);
  });

  // --- funded wallet (slow-path onboard already created the identity above) -------
  await step('home', async () => {
    await driver.findByTestID('tab-home', { timeoutMs: 10_000 });
    await driver.waitForText('∂', { timeoutMs: 10_000 });
    await sleep(800);
    await shot('10-home');
  });
  await step('accounts', async () => {
    await openBalances(driver);
    await sleep(600);
    await shot('12-accounts');
  });
  await step('accounts-icp-selected', async () => {
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await sleep(600);
    await shot('13-accounts-icp-actions');
  });
  await step('convert-picker', async () => {
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    await driver.findByTestID('convert-screen', { timeoutMs: 8_000 });
    await sleep(600);
    await shot('30-convert-picker');
  });
  await step('convert-filled', async () => {
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 12_000 });
    await sleep(500);
    await shot('31-convert-filled');
    await driver.click('convert-details', { timeoutMs: 5_000 });
    await sleep(500);
    await shot('32-convert-details');
  });
  await step('convert-checklist', async () => {
    await sleep(400);
    await shot('33-convert-checklist');
  });
  await step('convert-inflight', async () => {
    await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });
    await sleep(2_500);
    await shot('34-convert-inflight');
  });
  await step('convert-done', async () => {
    const done = await driver.waitForText('Converted', { timeoutMs: 60_000 });
    if (!done) throw new Error('convert never reached Converted within 60s');
    await sleep(500);
    await shot('35-convert-done');
  });
  await step('convert-back-home', async () => {
    // best-effort: find a done/continue affordance
    for (const id of ['btn-convert-done', 'btn-convert-close', 'btn-convert-back']) {
      if (await driver.isPresent(id)) { await driver.click(id, { timeoutMs: 2_000 }); break; }
    }
    await driver.click('tab-home', { timeoutMs: 5_000 });
  });
  await step('pay-scan', async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await sleep(800);
    await shot('14-pay-scan');
  });
  await step('pay-send-form', async () => {
    await openPaySend(driver);
    await sleep(400);
    await shot('15-pay-send-form');
  });
  await step('pay-send-review', async () => {
    const principal = await railPrincipalText('b'.repeat(64));
    await driver.type('send-address-input', principal, { timeoutMs: 5_000 });
    await driver.waitForText('ICP', { timeoutMs: 8_000 });
    await driver.type('send-amount-input', '1', { timeoutMs: 5_000 });
    await driver.findByTestID('send-review-amount', { timeoutMs: 8_000 });
    await sleep(400);
    await shot('16-pay-send-review');
  });
  await step('receive-form', async () => {
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('17-receive-form');
    await driver.type('amount-input', '12.50', { timeoutMs: 4_000 });
    await driver.type('memo-input', 'Lunch', { timeoutMs: 4_000 });
  });
  await step('request-qr', async () => {
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('18-request-qr');
    // back to the form via the "New request" ghost button (no testID — find by label text)
    await driver.eval(() => {
      const els = Array.from(document.querySelectorAll('button,[role="button"]'));
      const b = els.find((e) => (e.textContent || '').trim().toLowerCase().includes('new request'));
      if (b) { b.click(); return 'ok'; }
      return 'missing';
    });
    await driver.findByTestID('btn-receive-address', { timeoutMs: 5_000 });
  });
  await step('receive-address', async () => {
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await sleep(700);
    await shot('19-receive-address');
    await driver.click('btn-receive-request', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-code-checkout', { timeoutMs: 5_000 });
  });
  await step('checkout-form', async () => {
    // The checkout is the VCHF counter (flow 114): select VCHF before opening the Receive form.
    // selectCurrency assumes the Accounts route — navigate there first (the prior step left the
    // app on the Receive tab, where asset rows do not exist).
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-code-checkout', { timeoutMs: 5_000 });
    await driver.click('btn-code-checkout', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('20-checkout-form');
    await driver.type('amount-input', '10.50', { timeoutMs: 4_000 });
    await driver.click('btn-checkout-open', { timeoutMs: 4_000 });
    await driver.findByTestID('checkout-qr', { timeoutMs: 15_000 });
    await sleep(400);
    await shot('21-checkout-qr');
    await driver.click('btn-checkout-cancel', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-code-checkout', { timeoutMs: 5_000 });
    await driver.click('btn-code-checkout', { timeoutMs: 4_000 }); // back to the dpay code form
    await sleep(300);
  });
  await step('add-money', async () => {
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.click('btn-home-add-money', { timeoutMs: 4_000 });
    await sleep(700);
    await shot('22-add-money');
    await driver.pressKey('Escape');
    await sleep(300);
  });
  await step('history', async () => {
    await openHistory(driver);
    await sleep(600);
    await shot('23-history');
  });
  await step('txn-receipt', async () => {
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    await sleep(400);
    await shot('24-txn-receipt');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
  });
  await step('settings', async () => {
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('25-settings');
  });
  await step('reset-dialog', async () => {
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-reset-confirm', { timeoutMs: 4_000 });
    await shot('26-reset-dialog');
    // DO NOT confirm — back out
    for (const id of ['btn-reset-cancel', 'btn-reset-back']) {
      if (await driver.isPresent(id)) { await driver.click(id, { timeoutMs: 2_000 }); return; }
    }
    await driver.pressKey('Escape');
  });
}

// --- SOL rail: its own pass — the SOL surfaces only mount with the stubbed rail ({solStub:true}) ----
async function runSolPass(env) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`ux-sol-${name}`);
  await step('sol onboard', async () => {
    await onboardWallet(driver, 'ux-sol');
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.waitForText('∂', { timeoutMs: 10_000 });
  });
  await step('sol-accounts', async () => {
    await openBalances(driver);
    await driver.findByTestID('asset-sol', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('40-sol-accounts');
  });
  await step('sol-receive', async () => {
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('receive-mode-toggle', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('41-sol-receive-qr');
  });
  await step('sol-receive-address', async () => {
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await driver.findByTestID('sol-receive-address', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('42-sol-receive-address');
  });
  await step('sol-pay', async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await sleep(800);
    await shot('43-sol-pay');
  });
  await step('sol-send-form', async () => {
    if (await driver.isPresent('btn-pay-send')) {
      await openPaySend(driver);
      await sleep(400);
      await shot('44-sol-send-form');
    }
  });
}

// --- dark + locale passes: primary surfaces only -------------------------------------
async function runDarkPass(env, tag) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`ux-${tag}-${name}`);
  await step(`${tag} home`, async () => {
    await onboardWallet(driver, `ux-${tag}`);
    // onboardWallet's fast path can leave the app off the Home tab — land there explicitly.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.waitForText('∂', { timeoutMs: 10_000 });
    await sleep(800);
    await shot('10-home');
  });
  await step(`${tag} seed-icp`, async () => {
    const acct = await accountOf(driver);
    const fund = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!fund?.ok) throw new Error(`ICP faucet failed (status ${fund?.status})`);
  });
  await step(`${tag} accounts`, async () => {
    await openBalances(driver);
    await sleep(500);
    await shot('12-accounts');
  });
  await step(`${tag} convert`, async () => {
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    await driver.findByTestID('convert-screen', { timeoutMs: 8_000 });
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 12_000 });
    await sleep(500);
    await shot('30-convert');
  });
  await step(`${tag} receive`, async () => {
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await sleep(700);
    await shot('17-receive');
  });
  await step(`${tag} settings`, async () => {
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('25-settings');
  });
}

console.log('[ux-audit] starting full-surface capture…');
{
  // Pass 1: light / en-US — full walk INCLUDING the honest slow-path onboarding.
  // lazyBoot:false → setup() itself navigates to the app; the walkthrough is showing.
  const env = await setup({ lazyBoot: false });
  try {
    await runPass(env, 'light');
  } finally {
    try { await env.stop(); } catch {}
  }
}
{
  // Pass 2: dark / en-US — primary surfaces.
  const env = await setup({ dark: true });
  try {
    await runDarkPass(env, 'dark');
  } finally {
    try { await env.stop(); } catch {}
  }
}
{
  // Pass 3: light / de-DE — long-copy layout probe on primary surfaces.
  const env = await setup({ locale: 'de-DE' });
  try {
    await runDarkPass(env, 'de');
  } finally {
    try { await env.stop(); } catch {}
  }
}
{
  // Pass 4: light / en-US — the SOL rail with the stubbed rail backend.
  const env = await setup({ solStub: true });
  try {
    await runSolPass(env);
  } finally {
    try { await env.stop(); } catch {}
  }
}

console.log('[ux-audit] done.');
await stopSession();
