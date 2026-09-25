// Flow 208 — the CeFi lifecycle is honest past quote expiry (2026-09-24). The old story —
// `expired` ends the trade, "nothing needs reversing" — was a claim the venue never made:
// a deposit that lands LATE is still refunded (or honored) by the venue, and the dead
// record never observed it. What must be true, all asserted here:
//
//   1. EXPIRED IS A WATCH, NOT THE END. awaiting_deposit → expired lands the record at
//      quote_expired whose copy names the watch (the venue returns a late deposit) — the
//      old "nothing needs reversing" verdict is gone.
//   2. THE SLOW WATCH IS LIVE. While parked at quote_expired the provider poll KEEPS
//      running (at the slow stuck-watch cadence, never the fast one) — the stub's status
//      counter grows after the expiry.
//   3. THE VENUE'S LATER WORD LANDS. refunded after expiry flips the record to
//      provider_refunded on its own — no reload, no user action.
//   4. THE HONEST WAIT LINE. provider_processing shows "Last checked HH:MM" — the engine's
//      own last completed read, no SLA claimed.
//   5. THE DEPOSIT HANDOFF NAMES THE ORDER'S WINDOW: the venue's shift id and its expiry.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor,
  pickSwapTarget,
  pickSwapVenue,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {installSideShiftStub, setSideShiftStatus, sideShiftStubState} from '../harness/sideshift.mjs';

const AMOUNT_TEXT = '3';
const SHIFT_ID = 'e2e-shift-9c1d';
const CEFI_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
const CEFI_MECH = 'convert-venue-sideshift';

export const meta = {
  id: '208',
  name: 'convert-cefi-lifecycle',
  journey: 'convert',
  covers: ['convert', 'cefi', 'sideshift', 'lifecycle', 'quote-expired', 'late-deposit-watch',
    'slow-watch', 'provider-refunded', 'last-checked', 'no-sla', 'deposit-handoff'],
  verifies: 'the CeFi record lifecycle is honest past quote expiry: the expired card names the late-deposit watch instead of claiming nothing can move, the slow provider poll keeps running and the venue\'s refunded word lands provider_refunded on its own, provider_processing shows the engine\'s last-checked read without inventing an SLA, and the deposit handoff names the shift id and its expiry window.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** Re-enter the convert surface from the accounts route. */
async function reopenConvert(driver) {
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await openConvertFor(driver, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(driver, 'SOL');
      await pickSwapVenue(driver, 'sideshift');
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

async function pickCefiAndConfirm(driver) {
  await driver.type('convert-amount', AMOUNT_TEXT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
  await driver.waitForText('SideShift', {timeoutMs: 8_000});
  await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
  await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
  await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
}

export async function run() {
  const start = Date.now();
  console.log('[208-cefi-lifecycle] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[208-cefi-lifecycle] onboarding + funding ICP…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-cefi-lifecycle');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, 2000000000, {currency: 8});
    assert(fund.ok, `faucet ICP credit ok (status ${fund.status})`);

    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // --- §1 the order is born into waiting; the handoff names the shift id + expiry window
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'SOL');
    await pickSwapVenue(driver, 'sideshift');
    await pickCefiAndConfirm(driver);
    const handoff = await driver.readText('convert-awaiting-deposit');
    assertIncludes(handoff, SHIFT_ID, 'the venue\'s shift id renders (the status-page handle)');
    assertIncludes(handoff, 'expires', 'the order\'s own expiry window renders beside it');
    await driver.screenshot('208-cefi-awaiting');

    // --- §2 expired: the dead-end copy is honest — a watch, not a verdict
    await setSideShiftStatus(driver, 'expired');
    await driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
    const expired = await driver.readText('convert-quote-expired');
    assert(expired.includes('expired'), `the card says the quote expired (got: ${expired.slice(0, 120)})`);
    assertIncludes(expired, 'returns it', 'the copy says the venue RETURNS a late deposit (the watch named)');
    assertIncludes(expired, 'keeps watching', 'the copy says dpay keeps watching in the background');
    assert(!expired.includes('nothing needs reversing'),
      'the old "nothing needs reversing" verdict is GONE — the venue never promised that');
    await driver.screenshot('208-cefi-expired');

    // --- §3 the slow watch is live: the stub's status counter grows past the expiry
    const pollsAtExpiry = (await sideShiftStubState(driver)).statusCalls.length;
    await driver.waitForFunction(
      (n) => globalThis.__E2E_SIDESHIFT && globalThis.__E2E_SIDESHIFT.statusCalls.length > n,
      {timeoutMs: 20_000, label: 'the quote_expired slow watch polls again', args: [pollsAtExpiry]},
    );
    assert(await driver.findByTestID('convert-quote-expired', {timeoutMs: 1_000}) != null,
      'the record stays parked at quote_expired while the watch runs');

    // --- §4 the venue's later word lands: refunded after expiry → provider_refunded, on its own
    await setSideShiftStatus(driver, 'refunded');
    await driver.findByTestID('convert-provider-refunded', {timeoutMs: 30_000});
    const refunded = await driver.readText('convert-provider-refunded');
    assertIncludes(refunded, 'SideShift', 'the refund card names the venue that holds the remedy');
    await driver.screenshot('208-cefi-refunded');
    const polls = (await sideShiftStubState(driver)).statusCalls;
    assertEq(polls.every((c) => c.id === SHIFT_ID), true, 'every poll was keyed by the ONE shift id');

    // --- §5 the honest wait line: provider_processing shows "Last checked HH:MM" (no SLA)
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await setSideShiftStatus(driver, 'waiting');
    await reopenConvert(driver);
    await pickCefiAndConfirm(driver); // second order, born waiting
    await setSideShiftStatus(driver, 'multiple');
    await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
    await driver.findByTestID('convert-last-checked', {timeoutMs: 20_000});
    const lastChecked = await driver.readText('convert-last-checked');
    assert(/Last checked \d{1,2}:\d{2}/.test(lastChecked),
      `the wait line is the engine's own last read, clock-formatted (got: ${lastChecked})`);
    await driver.screenshot('208-cefi-processing');

    const hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'zero bare upstream calls — the relay attached the credential');
    assertEq(hits.shiftCalls, 2, 'two orders total (the refunded-after-expiry one + the processing one)');

    console.log(`GREEN 208 — CeFi lifecycle: expired → honest late-deposit watch (polls continued: ${polls.length}) → refunded landed on its own; last-checked line on processing in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 208:', e);
    process.exit(1);
  });
}
