/**
 * flow 145 (refuse-losing-swap) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, isDisabled,
  openConvertDetails,
} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';

hermeticDescribe('flow 145 — convert refuses a swap that could only fail', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('fund-gates a zero balance, disables the confirm out of reach, re-arms when it fits', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // --- half 1: nothing to convert ---------------------------------------------------------
      m = await onboardWallet('jest-convert-fundgate'); // funds DEMO only — ICP stays zero
      const account = await accountOf(m);
      await openConvertFor(m, 'icp');

      await m.driver.findByTestID('convert-fund', {timeoutMs: 8_000});
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(false);
      expect(m.driver.isPresent('convert-amount')).toBe(false);
      const gate = m.driver.readText('convert-fund');
      assertIncludes(gate, 'ICP', 'the gate names the asset the wallet lacks');
      assertIncludes(gate, 'Receive', 'the gate names the tab that can fund it');
      assertIncludes(gate, 'My address', 'the gate names the sub-surface inside it');
      assertIncludes(gate, 'Show my ICP address', 'the gate offers the route it names, as a button');
      await m.driver.click('convert-fund-go', {timeoutMs: 5_000});
      await m.driver.findByTestID('deposit-address', {timeoutMs: 8_000});

      // --- half 2: funded, but the entered amount is out of reach ------------------------------
      const fund = await faucetAccount(account!.publicHex, 50000000, {currency: 8}); // 0.5 ICP
      expect(fund.ok).toBe(true);
      // A reload is the deterministic way to make the wallet read the new balance (no poll race).
      await m.remount();
      await openConvertFor(m, 'icp');
      assertIncludes(m.driver.readText('convert-balance'), '0.5 ICP', 'the balance line shows the funded amount');

      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-insufficient', {timeoutMs: 8_000});
      const refusal = m.driver.readText('convert-insufficient');
      assertIncludes(refusal, '2.0002 ICP', 'the refusal states what the conversion needs (amount + both input-ledger fees)');
      assertIncludes(refusal, '0.5 ICP', 'the refusal states the balance it is measured against');
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);

      // --- half 3: an affordable amount re-arms the confirm, headline first --------------------
      await typeConvertAmount(m, '0.1');
      // Positive transition (the confirm re-arms once the amount fits) — budget-scaled ceiling.
      const rearmDeadline = budgetDeadline(12_000);
      while (await isDisabled(m, 'btn-convert-confirm')) {
        if (Date.now() > rearmDeadline) throw new Error('[145] the confirm never re-armed once the amount fit');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(false);
      const headline = m.driver.readText('convert-headline');
      assertIncludes(headline, 'You receive', 'the screen leads with what the user receives');
      assertIncludes(headline, 'VCHF', 'the headline is in the asset the user ends up holding');
      // The census folds behind the ONE Details control: the rate + pool principal are still
      // spelled on their own lines; the net end-state line is GONE (the headline IS the end state).
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-rate'), 'ICP', 'the rate names both legs');
      assertIncludes(m.driver.readText('convert-pool-principal'), POOL, 'the pool principal has a line of its own');
      expect(m.driver.isPresent('convert-net')).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
