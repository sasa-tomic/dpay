/**
 * flow 198 (trocador-aggregator) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
  pickSwapTarget, openOtherVenues,
  openConvertDetails,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSolRpcStub, deriveSolanaKeypair,
  solSentTxs, icpAccountIdHex, enableSolRail, trocadorConfig,
  trocadorRelayHits,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const DEPOSIT_ADDRESS_TROCADOR = 'e2e-trocador-deposit-01';

hermeticDescribe('flow 198 — SOL → ICP via the trocador aggregator: every venue call relay-borne', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('sub-picks the service, locks a fixed order, drives the lifecycle through the relay status route', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-trocador');
      const account = await accountOf(m);
      const kp = deriveSolanaKeypair(account!.secretHex);
      installSolRpcStub({refuseSend: true});

      // §1 the venue area: SideShift is the auto pick; Trocador waits behind the expander.
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → USD', 'the standing pair is SOL→USD (registry order)');
      await pickSwapTarget(m, 'ICP');
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 8_000});
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venue-trocador')).toBe(true);
      await m.driver.click('convert-venue-trocador', {timeoutMs: 3_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0496 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue (override: the plain attribution line)');
      expect(m.driver.readText('convert-quote-source')).toMatch(/\d{1,2}:\d{2}/);
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      expect(settle).toBe(await icpAccountIdHex(account!.publicHex));
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await openConvertDetails(m);
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'Trocador', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'trocador.app/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the venue's ORDER; the handoff is the venue's own deposit address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_TROCADOR, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 SOL', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(await m.driver.waitForText('Done', {timeoutMs: 1_000, unscaled: true}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit: EVERY venue call rode the relay, key attached.
      const hits = await trocadorRelayHits();
      expect(hits.bareCalls).toBe(0);
      expect(hits.tradeCalls).toBe(1);
      expect(hits.rateCalls).toBeGreaterThanOrEqual(2);
      expect(hits.keyCalls).toBeGreaterThanOrEqual(hits.rateCalls + hits.tradeCalls);
      const tradeQuery = hits.lastTradeQuery ?? '';
      assertIncludes(tradeQuery, 'refund=', 'the trade request carried the refund address (the fund-loss guard)');
      assertIncludes(tradeQuery, 'min_kycrating=A', 'the non-KYC backends-only pin is relay-side');
      assertIncludes(tradeQuery, 'markup=0', 'the no-dpay-cut pin is relay-side');
      assertIncludes(tradeQuery, 'fixed=True', 'the trade is the venue\'s fixed-rate kind');

      // §5 the lifecycle THROUGH the key-gated relay status route.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      const statusCallsBefore = (await trocadorRelayHits()).statusCalls;
      expect(statusCallsBefore).toBeGreaterThanOrEqual(1);
      await trocadorConfig({status: 'Processing'});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel, still relay-fed.
      await m.remount();
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);
      const after = await trocadorRelayHits();
      expect(after.tradeCalls).toBe(1);
      expect(after.statusCalls).toBeGreaterThan(statusCallsBefore);

      // §7 settle → done with the realized figures at the user's own address.
      await trocadorConfig({status: 'Completed', amount_to: '0.0496', hashout: 'sol-settle-sig-198'});
      expect(await m.driver.waitForText('Done', {timeoutMs: 90_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0496 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC identifier');
      expect(kp.address.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
