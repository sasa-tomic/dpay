// validate-r3-capture.mjs — VALIDATION ROUND 3 evidence capture (not a flow, not committed gates).
// Final fresh-context regression sweep over the round-2 surfaces: the post-precision convert hero
// (light+dark, entry fold + Details verbatim), venue-named history rows + receipt, onboarding,
// deposit/receive sheets, settings, ledger. Shots land in e2e/shots/r3-*.png (light+dark).
import {
  setup, stopSession, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, openConvertFor, pickSwapTarget,
  typeConvertAmount, skipWalkthroughIfPresent, skipPracticeIfPresent,
  chooseHomeCurrencyIfPresent, waitForEnabled,
} from './harness/lib.mjs';
import { openHistory } from './harness/flow-steps.mjs';
import { startRelay } from './harness/relay.mjs';
import { installSideShiftStub, setSideShiftStatus } from './harness/sideshift.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(label, fn) {
  try {
    await fn();
    console.log(`[r3] ✓ ${label}`);
  } catch (e) {
    console.error(`[r3] ✗ ${label}: ${e?.message ?? e}`);
  }
}

/** Slow every /api/v2/canister/ call so the Settlement Field legs are observable mid-flight. */
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

/** Confirm through quote-changed interrupts (flow-140 loop). */
async function confirmThrough(driver) {
  for (let round = 0; round < 5; round++) {
    await driver.click('btn-convert-confirm');
    const changed = await driver.findByTestID('convert-moved-note', { timeoutMs: 1_500 }).catch(() => null);
    const changed2 = changed ?? await driver.findByTestID('convert-quote-changed', { timeoutMs: 1_000 }).catch(() => null);
    if (changed2 == null) return;
    await sleep(300);
  }
}

/** The CTA fold measurement (round-1 invariant: the CTA sits above the fold at entry). */
async function foldMeasure(driver) {
  return driver.eval(() => {
    const el = document.querySelector('[data-testid="btn-convert-confirm"], [data-testid="convert-cta"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  });
}

async function runLight(env, r2) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`r3-light-${name}`);

  // --- onboarding first screens ------------------------------------------------------------
  await step('walkthrough', async () => {
    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    await sleep(600);
    await shot('01-walkthrough');
    await skipWalkthroughIfPresent(driver);
  });
  await step('create-form', async () => {
    await driver.findByTestID('btn-create', { timeoutMs: 8_000 });
    await shot('02-create');
    await driver.typeByPlaceholder('e.g. Alice', 'r3-light', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
  });
  await step('backup-gate', async () => {
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await shot('03-backup');
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
  });
  await step('practice', async () => {
    await driver.findByTestID('practice', { timeoutMs: 15_000 });
    await sleep(1_200);
    await shot('04-practice');
    await skipPracticeIfPresent(driver);
  });
  await step('home-currency', async () => {
    await driver.findByTestID('home-currency-title', { timeoutMs: 10_000 });
    await chooseHomeCurrencyIfPresent(driver);
  });

  // --- fund + primary surfaces ------------------------------------------------------------
  await step('seed', async () => {
    const acct = await accountOf(driver);
    const a = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!a?.ok) throw new Error(`ICP faucet failed (${a?.status})`);
    const b = await faucetAccount(env.relayBaseURL, acct.publicHex, 2000000000, { currency: 7 });
    if (!b?.ok) throw new Error(`VCHF faucet failed (${b?.status})`);
  });
  await step('home', async () => {
    await driver.findByTestID('tab-home', { timeoutMs: 10_000 });
    await driver.waitForText('∂', { timeoutMs: 10_000 });
    await sleep(900);
    await shot('10-home');
  });
  await step('accounts', async () => {
    await openBalances(driver);
    await sleep(600);
    await shot('12-accounts');
  });

  // --- convert entry + hero + Details (the round-2 surface) --------------------------------
  await step('convert-sheet-entry', async () => {
    await openConvertFor(driver, 'icp');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 15_000 });
    await sleep(400);
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot('30-sheet-entry');
    console.log('[r3] fold@entry =', JSON.stringify(await foldMeasure(driver)));
  });
  await step('convert-sheet-details', async () => {
    await typeConvertAmount(driver, '1');
    await driver.click('convert-details', { timeoutMs: 5_000 });
    await sleep(500);
    await driver.eval(() => {
      const el = document.querySelector('[data-testid="convert-quote-verbatim"]');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await sleep(300);
    await shot('31-sheet-details');
    const verbatim = await driver.eval(() => document.querySelector('[data-testid="convert-quote-verbatim"]')?.textContent ?? null);
    const receive = await driver.eval(() => document.querySelector('[data-testid="convert-receive"]')?.textContent ?? null);
    console.log('[r3] receive hero =', JSON.stringify(receive));
    console.log('[r3] verbatim line =', JSON.stringify(verbatim));
    // close details
    await driver.click('convert-details', { timeoutMs: 4_000 }).catch(() => {});
  });

  // --- Settlement Field: inflight → done ---------------------------------------------------
  const slow = await slowCanisterCalls(driver, 2_500);
  await step('sf-inflight', async () => {
    await confirmThrough(driver);
    await driver.findByTestID('convert-state', { timeoutMs: 15_000 });
    await sleep(1_200);
    await shot('40-sf-inflight');
  });
  await step('sf-done', async () => {
    await driver.findByTestID('convert-done', { timeoutMs: 90_000 });
    await sleep(600);
    await shot('41-sf-done');
  });
  await slow.release().catch(() => {});

  // --- ledger + receipt: the venue-named row (round-2 surface) ------------------------------
  await step('ledger', async () => {
    await driver.click('btn-convert-back', { timeoutMs: 5_000 }).catch(() => {});
    await openHistory(driver);
    await sleep(700);
    await shot('50-ledger');
    const row0 = await driver.eval(() => document.querySelector('[data-testid="hist-row-0"]')?.textContent ?? null);
    console.log('[r3] ledger row 0 =', JSON.stringify(row0));
  });
  await step('receipt', async () => {
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('51-receipt');
    const party = await driver.eval(() => document.querySelector('[data-testid="txn-receipt"]')?.textContent ?? null);
    console.log('[r3] receipt body =', JSON.stringify(party));
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
  });

  // --- sheets: receive + deposit -------------------------------------------------------------
  await step('receive-form', async () => {
    await selectCurrency(driver, 'icp');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('53-receive-form');
  });
  await step('deposit-icp', async () => {
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await sleep(1_200);
    await shot('55-deposit');
    await driver.pressKey('Escape').catch(() => {});
    await sleep(300);
  });

  // --- settings ------------------------------------------------------------------------------
  await step('settings', async () => {
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('60-settings');
  });

  // --- composed VCHF → EURC hero (fiat 2dp on the EURC out) + the 2-press shape --------------
  await step('composed-ready', async () => {
    const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, { passOrigins, initialStatus: 'waiting' });
    await openConvertFor(driver, 'vchf');
    await pickSwapTarget(driver, 'EUR');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 20_000 });
    await sleep(500);
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot('70-composed-ready');
    console.log('[r3] composed fold@entry =', JSON.stringify(await foldMeasure(driver)));
    const receive = await driver.eval(() => document.querySelector('[data-testid="convert-receive"]')?.textContent ?? null);
    console.log('[r3] composed receive hero =', JSON.stringify(receive));
  });
  await step('composed-awaiting', async () => {
    const slow2 = await slowCanisterCalls(driver, 1_500);
    await confirmThrough(driver);
    await driver.findByTestID('convert-state', { timeoutMs: 15_000 });
    await sleep(1_000);
    await shot('71-composed-sf');
    await driver.findByTestID('convert-awaiting-deposit', { timeoutMs: 60_000 });
    await sleep(600);
    await slow2.release().catch(() => {});
    await shot('72-composed-awaiting');
  });
  await step('composed-done', async () => {
    await setSideShiftStatus(driver, 'settled', { settleAmount: '4.11', settleHash: 'sol-settle-sig-r3' });
    await driver.findByTestID('convert-done', { timeoutMs: 60_000 });
    await sleep(600);
    await shot('73-composed-done');
  });
}

async function runDark(env, r2) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`r3-dark-${name}`);

  await step('dark seed', async () => {
    await driver.click('tab-home', { timeoutMs: 10_000 }).catch(async () => {
      await onboardWallet(driver, 'r3-dark');
      await driver.click('tab-home', { timeoutMs: 5_000 });
    });
    const acct = await accountOf(driver);
    const a = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!a?.ok) throw new Error(`ICP faucet failed (${a?.status})`);
    const b = await faucetAccount(env.relayBaseURL, acct.publicHex, 2000000000, { currency: 7 });
    if (!b?.ok) throw new Error(`VCHF faucet failed (${b?.status})`);
  });
  await step('dark home', async () => {
    await driver.waitForText('∂', { timeoutMs: 10_000 });
    await sleep(900);
    await shot('10-home');
  });
  await step('dark accounts', async () => {
    await openBalances(driver);
    await sleep(600);
    await shot('12-accounts');
  });
  await step('dark convert-sheet', async () => {
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await openConvertFor(driver, 'icp');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 15_000 });
    await sleep(400);
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot('30-sheet-entry');
    console.log('[r3] dark fold@entry =', JSON.stringify(await foldMeasure(driver)));
  });
  await step('dark sheet-details', async () => {
    await typeConvertAmount(driver, '1');
    await driver.click('convert-details', { timeoutMs: 5_000 });
    await sleep(500);
    await driver.eval(() => {
      const el = document.querySelector('[data-testid="convert-quote-verbatim"]');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await sleep(300);
    await shot('31-sheet-details');
    await driver.click('convert-details', { timeoutMs: 4_000 }).catch(() => {});
  });
  await step('dark ledger+receipt', async () => {
    await driver.click('btn-convert-back', { timeoutMs: 5_000 }).catch(() => {});
    await openHistory(driver);
    await sleep(700);
    await shot('50-ledger');
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('51-receipt');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
  });
  await step('dark deposit', async () => {
    await selectCurrency(driver, 'icp');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await driver.click('btn-receive-address', { timeoutMs: 5_000 });
    await sleep(1_200);
    await shot('55-deposit');
    await driver.pressKey('Escape').catch(() => {});
  });
  await step('dark settings', async () => {
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('60-settings');
  });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
{
  const env = await setup({ lazyBoot: false, solStub: true });
  const r2 = await startRelay();
  try {
    // Arm the second venue BEFORE the wallet mounts (flow-40 pattern) so the sheet's
    // auto-pick line reads "…of 2 venues" and the Other-venues expander has a real row.
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ venue_id: 'icpswap-fixture-b', served: true }),
    });
    console.log(`[r3] venue knob armed (${arm.status})`);
    await runLight(env, r2);
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
{
  const env = await setup({ dark: true, solStub: true });
  const r2 = await startRelay();
  try {
    await runDark(env, r2);
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
console.log('[r3] done.');
await stopSession();
