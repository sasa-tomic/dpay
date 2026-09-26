// validate-r1-capture.mjs — VALIDATION-AGENT evidence capture (not a flow, not committed gates).
// Drives the REAL app through every surface the validation round must LOOK at, in light/en and
// dark/en, plus the composed VCHF→EURC walk with the SideShift stub (flow-213 machinery).
// Shots land in e2e/shots/r1-*.png. Best-effort steps: a failed capture logs and moves on.
import {
  setup, stopSession, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, openConvertFor, pickSwapTarget,
  typeConvertAmount, openOtherVenues,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent,
  waitForEnabled, openPaySend,
} from './harness/lib.mjs';
import { openHistory } from './harness/flow-steps.mjs';
import { startRelay } from './harness/relay.mjs';
import { installSideShiftStub, setSideShiftStatus } from './harness/sideshift.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(label, fn) {
  try {
    await fn();
    console.log(`[r1] ✓ ${label}`);
  } catch (e) {
    console.error(`[r1] ✗ ${label}: ${e?.message ?? e}`);
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

/** Confirm through quote-changed interrupts (flow-140/213 loop). */
async function confirmThrough(driver) {
  for (let round = 0; round < 5; round++) {
    await driver.click('btn-convert-confirm');
    const changed = await driver.findByTestID('convert-moved-note', { timeoutMs: 1_500 }).catch(() => null);
    const changed2 = changed ?? await driver.findByTestID('convert-quote-changed', { timeoutMs: 1_000 }).catch(() => null);
    if (changed2 == null) return;
    await sleep(300);
  }
}

async function runLight(env, r2) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`r1-light-${name}`);

  // --- slow onboarding: every first-run beat ---------------------------------------------
  await step('walkthrough', async () => {
    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    await shot('01-walkthrough');
    await skipWalkthroughIfPresent(driver);
  });
  await step('create-form', async () => {
    await driver.findByTestID('btn-create', { timeoutMs: 8_000 });
    await shot('02-create');
    await driver.typeByPlaceholder('e.g. Alice', 'r1-light', { timeoutMs: 8_000 });
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
    await sleep(1_500);
    await shot('04-practice');
    await skipPracticeIfPresent(driver);
  });
  await step('home-currency', async () => {
    await driver.findByTestID('home-currency-title', { timeoutMs: 10_000 });
    await shot('05-home-currency');
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
  await step('home-menu', async () => {
    await driver.click('btn-home-more', { timeoutMs: 4_000 });
    await sleep(500);
    await shot('11-home-menu');
    await driver.click('btn-home-menu-close', { timeoutMs: 3_000 });
  });
  await step('accounts', async () => {
    await openBalances(driver);
    await sleep(600);
    await shot('12-accounts');
  });
  await step('accounts-icp-selected', async () => {
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await sleep(500);
    await shot('13-accounts-icp');
  });

  // --- convert intent sheet (direct pair, two venues) -------------------------------------
  await step('convert-sheet-ready', async () => {
    await openConvertFor(driver, 'icp');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 15_000 });
    await sleep(400);
    await shot('30-sheet-ready');
  });
  await step('convert-sheet-other-venues', async () => {
    await typeConvertAmount(driver, '1');
    await openOtherVenues(driver);
    await driver.findByTestID('convert-venue-icpswap-fixture-b-quote', { timeoutMs: 10_000 });
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot('31-sheet-other-venues');
    await openOtherVenues(driver); // close it again
  });
  await step('convert-details', async () => {
    await driver.click('convert-details', { timeoutMs: 5_000 });
    await sleep(500);
    await driver.eval(() => {
      const el = document.querySelector('[data-testid="convert-min-out"]');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await sleep(300);
    await shot('32-sheet-details');
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

  // --- ledger + receipt ---------------------------------------------------------------------
  await step('ledger', async () => {
    await driver.click('btn-convert-back', { timeoutMs: 5_000 }).catch(() => {});
    await openHistory(driver);
    await sleep(700);
    await shot('50-ledger');
  });
  await step('receipt', async () => {
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 6_000 });
    await sleep(400);
    await shot('51-receipt');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
  });

  // --- pay / receive / deposit / send -------------------------------------------------------
  await step('pay-scan', async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await sleep(900);
    await shot('52-pay-scan');
  });
  await step('receive-form', async () => {
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('53-receive-form');
    await driver.type('amount-input', '12.50', { timeoutMs: 4_000 });
    await driver.type('memo-input', 'Lunch', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 6_000 });
    await sleep(800);
    await shot('54-request-qr');
    await driver.eval(() => {
      const els = Array.from(document.querySelectorAll('button,[role="button"]'));
      const b = els.find((e) => (e.textContent || '').trim().toLowerCase().includes('new request'));
      if (b) { b.click(); return 'ok'; }
      return 'missing';
    });
    await driver.findByTestID('btn-receive-address', { timeoutMs: 5_000 });
  });
  await step('deposit-icp', async () => {
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await sleep(1_200);
    await shot('55-deposit');
    await driver.pressKey('Escape').catch(() => {});
    await sleep(300);
  });
  await step('send-form', async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await openPaySend(driver);
    await sleep(500);
    await shot('56-send-form');
  });
  await step('send-review', async () => {
    const { railPrincipalText } = await import('./harness/lib.mjs');
    const principal = await railPrincipalText('b'.repeat(64));
    await driver.type('send-address-input', principal, { timeoutMs: 5_000 });
    await driver.waitForText('ICP', { timeoutMs: 8_000 });
    await driver.type('send-amount-input', '1', { timeoutMs: 5_000 });
    await driver.findByTestID('send-review-amount', { timeoutMs: 8_000 });
    await sleep(400);
    await shot('57-send-review');
    await driver.pressKey('Escape').catch(() => {});
  });

  // --- add funds / withdraw sheets from Home -------------------------------------------------
  await step('add-funds', async () => {
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.click('btn-home-add-funds', { timeoutMs: 4_000 });
    await sleep(900);
    await shot('58-add-funds');
    await driver.pressKey('Escape');
    await sleep(300);
  });
  await step('withdraw', async () => {
    await driver.click('btn-home-withdraw', { timeoutMs: 4_000 });
    await sleep(900);
    await shot('59-withdraw');
    await driver.pressKey('Escape');
    await sleep(300);
  });

  // --- settings + reset -----------------------------------------------------------------------
  await step('settings', async () => {
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('60-settings');
  });
  await step('reset-dialog', async () => {
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-reset-confirm', { timeoutMs: 4_000 });
    await shot('61-reset');
    for (const id of ['btn-reset-cancel', 'btn-reset-back']) {
      if (await driver.isPresent(id)) { await driver.click(id, { timeoutMs: 2_000 }); return; }
    }
    await driver.pressKey('Escape');
  });

  // --- composed VCHF → ICP → EURC (flow-213 machinery, SideShift stub) ------------------------
  await step('composed-ready', async () => {
    const account = await accountOf(driver);
    const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, { passOrigins, initialStatus: 'waiting' });
    await openConvertFor(driver, 'vchf');
    await pickSwapTarget(driver, 'EUR');
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 20_000 });
    await sleep(500);
    await shot('70-composed-ready');
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
    await setSideShiftStatus(driver, 'settled', { settleAmount: '0.0495', settleHash: 'sol-settle-sig-r1' });
    await driver.findByTestID('convert-done', { timeoutMs: 60_000 });
    await sleep(600);
    await shot('73-composed-done');
  });
}

async function runDark(env, r2) {
  const { driver } = env;
  const shot = (name) => driver.screenshot(`r1-dark-${name}`);

  // fast onboarding, then the same key surfaces
  await step('dark seed', async () => {
    await driver.click('tab-home', { timeoutMs: 10_000 }).catch(async () => {
      await onboardWallet(driver, 'r1-dark');
      await driver.click('tab-home', { timeoutMs: 5_000 });
    });
    const acct = await accountOf(driver);
    const a = await faucetAccount(env.relayBaseURL, acct.publicHex, 300000000, { currency: 8 });
    if (!a?.ok) throw new Error(`ICP faucet failed (${a?.status})`);
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
    await shot('30-sheet-ready');
  });
  await step('dark sf-inflight', async () => {
    const slow = await slowCanisterCalls(driver, 2_500);
    await confirmThrough(driver);
    await driver.findByTestID('convert-state', { timeoutMs: 15_000 });
    await sleep(1_200);
    await shot('40-sf-inflight');
    await driver.findByTestID('convert-done', { timeoutMs: 90_000 });
    await sleep(600);
    await shot('41-sf-done');
    await slow.release().catch(() => {});
  });
  await step('dark ledger', async () => {
    await driver.click('btn-convert-back', { timeoutMs: 5_000 }).catch(() => {});
    await openHistory(driver);
    await sleep(700);
    await shot('50-ledger');
  });
  await step('dark pay', async () => {
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await sleep(900);
    await shot('52-pay-scan');
  });
  await step('dark receive', async () => {
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('amount-input', { timeoutMs: 5_000 });
    await sleep(700);
    await shot('53-receive-form');
  });
  await step('dark deposit', async () => {
    await driver.click('btn-receive-address', { timeoutMs: 4_000 });
    await sleep(1_200);
    await shot('55-deposit');
    await driver.pressKey('Escape').catch(() => {});
  });
  await step('dark settings', async () => {
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await sleep(600);
    await shot('60-settings');
    await driver.click('btn-settings-close', { timeoutMs: 3_000 }).catch(() => {});
  });
}

console.log('[r1] starting validation capture…');
{
  const env = await setup({ lazyBoot: false, solStub: true });
  const r2 = await startRelay();
  try {
    // Arm the second venue BEFORE the wallet mounts (flow-40 pattern) so the sheet shows
    // the Other-venues expander with a real second quote.
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ venue_id: 'icpswap-fixture-b', served: true }),
    });
    console.log(`[r1] venue knob armed (${arm.status})`);
    await runLight(env, r2);
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
{
  const env = await setup({ dark: true });
  const r2 = await startRelay();
  try {
    await runDark(env, r2);
  } finally {
    try { await env.stop(); } catch {}
    try { await r2.stop(); } catch {}
  }
}
console.log('[r1] done.');
await stopSession();
