/**
 * flow 142 (venueless-fails-closed) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  faucetAccount, onboardWallet, accountOf, openConvertFor, openBalances,
  selectCurrency,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

hermeticDescribe('flow 142 — venue-less fails closed; a venue subject opens the form from the SAME button', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('renders no VEUR row, no DEMO convert affordance, and the real ICP form', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-venueless');

      // The retirement: no VEUR row anywhere.
      await openBalances(m);
      expect(await m.driver.findByTestID('asset-veur', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(false);

      // DEMO: the practice row offers NO convert affordance at all.
      await selectCurrency(m, 'demo');
      await openBalances(m);
      expect(await m.driver.findByTestID('asset-demo', {timeoutMs: 5_000})).not.toBeNull();
      expect(await m.driver.findByTestID('btn-accounts-convert-DEMO', {timeoutMs: 2_000}).then(() => true).catch(() => false)).toBe(false);
      expect(m.driver.bodyText()).not.toContain('Minimum you\'ll receive');

      // ICP: the SAME button, an asset that HAS a venue → the real form.
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);
      await openConvertFor(m, 'icp');
      expect(await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000})).not.toBeNull();
      expect(await m.driver.findByTestID('convert-amount', {timeoutMs: 4_000})).not.toBeNull();
      expect(await m.driver.findByTestID('convert-unavailable', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(120_000));
});
