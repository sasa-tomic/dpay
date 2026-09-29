/**
 * flow 192 (live-stop) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, icDelayKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const SEED_ICP = 300000000; // 3 ICP

hermeticDescribe('flow 192 — the Stop during a LIVE swap aborts honestly', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('labels the in-flight window watching, stops to the terminal card, and removes the control', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-abort');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // The swap reply stays pending 12 s — the deterministic in-flight window.
      await icDelayKnob('depositFromAndSwap', 12_000);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      expect(await m.driver.findByTestID('convert-swapping', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('btn-convert-stop'), 'Stop watching', 'the watching flavor labels the button');

      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000}).then(() => true).catch(() => false)).toBe(true);
      const abortedBody = m.driver.readText('convert-aborted');
      expect(abortedBody.includes('The swap may still go through')).toBe(true);
      expect(await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});
