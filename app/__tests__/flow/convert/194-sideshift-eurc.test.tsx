/**
 * flow 194 (sideshift-eurc) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero,
  openConvertDetails,
} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSolRpcStub, deriveSolanaKeypair,
  enableSolRail, installSideShiftStub, setSideShiftStatus, sideShiftStubState,
  sideshiftRelayHits,
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

hermeticDescribe('flow 194 — ICP → EURC via sideshift-eurc (the EUR→IC bridge\'s venue)', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('sub-picks the cefi venue in the EURC group, hands off verbatim, resumes, settles in EURC', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target needs the EURC(Solana) rail in the wallet's asset list.
      await enableSolRail();
      m = await onboardWallet('jest-cefi-sideshift-eurc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      installSolRpcStub({refuseSend: true});
      installSideShiftStub({initialStatus: 'waiting'});

      // §1 the EUR pair: the SideShift venue is the only device-signable row → auto-picked;
      // the composed CCTP+jupiter route is the explicit opt-in row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 8_000});
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick line names the CeFi venue');
      await openOtherVenues(m);
      expect(await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-settle-address'), kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
      expect(await m.driver.waitForText(`≈ ${fmtHero('49500', 6, 'EURC', {stable: true})}`, {timeoutMs: 15_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the quote is attributed to SideShift (the ONE merged line, auto-picked)');
      await openConvertDetails(m);
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-quote-verbatim'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-quote-verbatim'), '0.0495 EURC', 'Details carries SideShift\'s verbatim quoted settle figure');
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'SideShift', 'the counterparty line names the venue');
      assertIncludes(counterparty, 'automated exchange service', 'the cefi copy says what the venue IS');
      assertIncludes(counterparty, 'this wallet sends the deposit to the venue itself', 'the IC-source census says the WALLET sends the deposit');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'sideshift.ai/terms', 'the venue\'s OWN published terms link renders');
      assertIncludes(disclosure, 'not a licensed provider', 'the disclosure says what the venue is NOT');

      // §2 confirm → the auto-deposit panel: no manual trio, the venue truths stay.
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-deposit-address')).toBe(false);
      expect(m.driver.isPresent('convert-deposit-amount')).toBe(false);
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
      assertIncludes(handoff, 'not a party', 'dpay names itself a non-party');

      // §3 the partner-key audit.
      let hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(1);
      expect(hits.quoteCalls).toBeGreaterThanOrEqual(2);
      expect(handoff.includes('e2e-stub-partner-secret')).toBe(false);

      // Steady waiting, then processing.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});

      // §5 reload mid-processing: resume WITHOUT re-creating the order; let the resumed record
      // poll AT LEAST TWICE before the settled verdict flips (sequencing, not sleeping).
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      installSideShiftStub({initialStatus: 'multiple'});
      await openConvertFor(m, 'icp');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) >= 2,
        {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'},
      );

      // §6 settled: the venue's own figures complete the record (EURC settle leg).
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-194'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 EURC', 'done reports the VENUE\'s own settle amount in EURC');
      assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');

      // §7 audits.
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
      hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(1);
      // The auto-deposit (2026-10-02): dpay sends the venue deposit from the wallet the moment
      // the record reaches awaiting_deposit - ONE order ran, so the ledger holds the seed minus
      // that deposit (3 ICP) and its transfer fee (the ICP ledger's 10000 e8s).
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP) - 300000000n - 10000n);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
