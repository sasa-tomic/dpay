/**
 * flow 187 (sideshift-handoff) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, deriveSolanaKeypair, installSideShiftStub,
  setSideShiftStatus, sideShiftStubState, sideshiftRelayHits,
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

hermeticDescribe('flow 187 — ICP → SOL via SideShift: partner key relay-held, deposit handoff, venue status', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('hands off verbatim, advances on the venue\'s own word, resumes order-free, dead-ends honestly', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-cefi-sideshift');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const constants = require('../../../config/constants') as {solanaRpcUrl: () => string};
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AS = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
      const storedSol = await AS.getItem('dpay.solanaRpc.v1');
      console.log('    [187-probe] solanaRpcUrl:', constants.solanaRpcUrl(), '| stored:', storedSol);
      installSideShiftStub({initialStatus: 'waiting'});

      // §1 the disclosed pick, the disclosure, and the verbatim quote.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick line names the venue');
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venues-expanded')).toBe(true);
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-settle-address'), kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
      expect(await m.driver.waitForText('0.0495 SOL', {timeoutMs: 15_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the quote is attributed to SideShift (the ONE merged line, auto-picked)');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'SideShift', 'the counterparty line names the venue');
      assertIncludes(counterparty, 'automated exchange service', 'the cefi copy says what the venue IS');
      assertIncludes(counterparty, 'this wallet sends the deposit to the venue itself', 'the IC-source census says the WALLET sends the deposit (2026-10-02 auto-deposit)');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'sideshift.ai/terms', 'the venue\'s OWN published terms link renders');
      assertIncludes(disclosure, 'not a licensed provider', 'the disclosure says what the venue is NOT');

      // §2 confirm: order created through the relay; the deposit handoff renders verbatim.
      await confirmCefi(m);
      // The auto-deposit panel (2026-10-04): an IC-source row renders NO manual send trio
      // (a hand-copied deposit on top of the auto-send is a double-spend invitation); the
      // venue truths and the order handles stay.
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-deposit-address')).toBe(false);
      expect(m.driver.isPresent('convert-deposit-amount')).toBe(false);
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
      assertIncludes(handoff, 'not a party', 'dpay names itself a non-party');
      assertIncludes(m.driver.readText('convert-shift-id'), SHIFT_ID, 'the venue shift id stays visible');

      // §3 the partner-key audit: credentialed upstream calls only, one order so far.
      let hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(1);
      expect(hits.quoteCalls).toBeGreaterThanOrEqual(2);
      expect(handoff.includes('e2e-stub-partner-secret')).toBe(false);

      // 'waiting' is steady-state: still awaiting_deposit a beat later (no false transition).
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);

      // §4 processing: the venue's own word drives the record.
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});

      // §5 reload mid-processing: resume WITHOUT re-creating the order.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      expect(shiftsBefore).toBe(1);
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);

      // §6 settled: the venue's own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-187'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 SOL', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');

      // §7 the expired dead-end (a second order, born waiting, driven to expiry).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      setSideShiftStatus('expired');
      await m.driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
      assertIncludes(m.driver.readText('convert-quote-expired'), 'expired', 'the expired dead-end says expired');

      // §8 the refunded dead-end (a third order, refunded by the venue).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      setSideShiftStatus('refunded');
      await m.driver.findByTestID('convert-provider-refunded', {timeoutMs: 45_000});
      assertIncludes(m.driver.readText('convert-provider-refunded'), 'SideShift', 'the refund dead-end names the venue that holds the remedy');

      // §9 audits: status keying, no unexpected origins, ledger truth.
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      if (st!.unexpected.length > 0) {
        console.log('    [187-dbg] unexpected sample:', JSON.stringify(st!.unexpected.slice(0, 4)));
      }
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
      hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(3);
      // The auto-deposit (2026-10-02): every confirmed order's deposit leaves from the wallet
      // when the record reaches awaiting_deposit - THREE orders ran (settled, expired,
      // refunded), each debiting 3 ICP plus its 10000 e8s transfer fee.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP) - 3n * (300000000n + 10000n));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
