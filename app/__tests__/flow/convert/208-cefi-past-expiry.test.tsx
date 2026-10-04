/**
 * flow 208 (cefi-past-expiry) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget,
  openConvertDetails,
} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSideShiftStub, setSideShiftStatus,
  sideShiftStubState, sideshiftRelayHits,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

/** awaitDepositPanel — the awaiting-deposit wait with an on-failure screen dump. */
async function awaitDepositPanel(m: Awaited<ReturnType<typeof onboardWallet>>): Promise<void> {
  try {
    await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
  } catch (e) {
    console.log('    [cefi-dbg] body:', JSON.stringify(m.driver.bodyText()).slice(0, 1500));
    throw e;
  }
}
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_ICP = 2000000000; // 20 ICP
/** confirmCefi — press the CTA and wait for the awaiting panel; a moved-quote interrupt gets
 *  the e2e re-review treatment (one extra press, only when the sheet says the rate moved), and
 *  a press that never took (swallowed by a surface transition) is issued once more. */
async function confirmCefi(m: Awaited<ReturnType<typeof onboardWallet>>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    const deadline = budgetDeadline(8_000); // positive transition (→ awaiting panel) — budget-scaled
    for (;;) {
      if (m.driver.isPresent('convert-awaiting-deposit')) return;
      const moved = m.driver.readTextSafe('convert-moved-note') != null;
      if (moved || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (m.driver.readTextSafe('convert-moved-note') == null && m.driver.isPresent('convert-awaiting-deposit')) return;
  }
  await awaitDepositPanel(m);
}

hermeticDescribe('flow 208 — the CeFi lifecycle is honest past quote expiry', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('watches through expiry, lands the venue\'s refunded word on its own, shows last-checked', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-cefi-lifecycle');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});

      // §1 the order is born into waiting; the handoff names the shift id + expiry window.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      // The venue attribution lives inside Details (the copy law, spec 2026-10-04 §3):
      // wait on the quote figure, then read the attribution in the opened census.
      expect(await m.driver.waitForText('0.0495 SOL', {timeoutMs: 8_000})).toBe(true);
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick line names the venue');
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, SHIFT_ID, 'the venue\'s shift id renders (the status-page handle)');
      assertIncludes(handoff, 'expires', 'the order\'s own expiry window renders beside it');

      // §2 expired: a watch, not a verdict.
      setSideShiftStatus('expired');
      await m.driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
      const expired = m.driver.readText('convert-quote-expired');
      expect(expired.includes('expired')).toBe(true);
      assertIncludes(expired, 'is simply returned', 'the copy says a late deposit is RETURNED (venue-lessly, the copy law)');
      assertIncludes(expired, 'keeps watching', 'the copy says dpay keeps watching in the background');
      expect(expired.includes('nothing needs reversing')).toBe(false);

      // §3 the slow watch is live: the status counter grows past the expiry.
      const pollsAtExpiry = sideShiftStubState()!.statusCalls.length;
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) > pollsAtExpiry,
        {timeoutMs: 20_000, label: 'the quote_expired slow watch polls again'},
      );
      expect(m.driver.isPresent('convert-quote-expired')).toBe(true);

      // §4 the venue's later word lands: refunded after expiry → provider_refunded, on its own.
      setSideShiftStatus('refunded');
      await m.driver.findByTestID('convert-provider-refunded', {timeoutMs: 30_000});
      // The remedy's venue folds under Details on the terminal card (the copy law).
      await m.driver.click('convert-details');
      assertIncludes(m.driver.readText('convert-refunded-details'), 'SideShift', 'the refund card names the venue that holds the remedy (Details)');
      const polls = sideShiftStubState()!.statusCalls;
      expect(polls.every((c) => c.id === SHIFT_ID)).toBe(true);

      // §5 the honest wait line: provider_processing shows "Last checked HH:MM" (no SLA).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      await m.driver.findByTestID('convert-last-checked', {timeoutMs: 20_000});
      expect(/Last checked \d{1,2}:\d{2}/.test(m.driver.readText('convert-last-checked'))).toBe(true);

      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(2);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
