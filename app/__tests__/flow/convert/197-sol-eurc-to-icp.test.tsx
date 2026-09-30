/**
 * flow 197 (sol-eurc-to-icp) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
  pickSwapTarget,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSolRpcStub, deriveSolanaKeypair,
  solSentTxs, icpAccountIdHex, enableSolRail, installSideShiftStub,
  setSideShiftStatus, sideShiftStubState, sideshiftRelayHits,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const DEPOSIT_ADDRESS_SIDESHIFT = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const SHIFT_ID = 'e2e-shift-9c1d';

hermeticDescribe('flow 197 — EURC(Solana) → ICP via sideshift-eurc from the SOL surface', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('offers the cefi target, pays at the derived IC identifier, hands off with zero broadcasts', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-eurc');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      const kp = deriveSolanaKeypair(account!.secretHex);
      expect(kp.address.length).toBeGreaterThanOrEqual(32);

      installSolRpcStub({refuseSend: true});
      installSideShiftStub({initialStatus: 'waiting'});

      // §1 the standing target is stable-first USD; the ICP target carries the cefi venue.
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → USD', 'the standing pair is EUR→USD (stable-first)');

      // §2 the cefi target: derived payout address FIRST, venue quote verbatim.
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'attribution names the venue');
      expect(m.driver.readText('convert-venue-auto')).toMatch(/\d{1,2}:\d{2}/);
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      const expectedSettleId = await icpAccountIdHex(account!.publicHex);
      expect(settle).toBe(expectedSettleId);
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'SideShift', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence: the deposit is a handoff');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'sideshift.ai/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the fixed ORDER; the handoff is the venue's address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_SIDESHIFT, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 EURC', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(m.driver.isPresent('convert-deposit-sol-fee-note')).toBe(true);
      // NEGATIVE (honest-pending: the conversion must NOT complete) — window stays tight.
      expect(await m.driver.waitForText('Converted', {timeoutMs: 1_000, unscaled: true}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit.
      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(1);
      expect(hits.quoteCalls).toBeGreaterThanOrEqual(2);

      // §5 the provider lifecycle.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      setSideShiftStatus('multiple');
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel.
      await m.remount();
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) >= 2,
        {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'},
      );

      // §7 settle → done with the realized figures at the user's own address.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'ic-settle-sig-197'});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 45_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC account identifier');
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
