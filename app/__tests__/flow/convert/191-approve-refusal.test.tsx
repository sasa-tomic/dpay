/**
 * flow 191 (approve-refusal) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, approveFailKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const SEED_ICP = 300000000; // 3 ICP

hermeticDescribe('flow 191 — the approve refusal is a terminal failed card, never a stuck spinner', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('surfaces the refusal, names the asset, and leaves the ledger byte-whole', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-approve-refused');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 10_000});

      // Arm the approve_fail knob (AllowanceChanged{0}, the live-defect shape; one refusal).
      await approveFailKnob(ICP_LEDGER);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      // A green here PROVES the panel left the Approving spinner: the old bug rendered it for
      // the full 5-minute envelope window and only then flipped to stuck.
      expect(await m.driver.findByTestID('convert-failed', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect(await m.driver.findByTestID('convert-stuck', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);

      const failedBody = m.driver.readText('convert-failed');
      expect(failedBody.includes('Failed')).toBe(true);
      // The plain-verb copy (the copy law bans "approve"): the ledger refused the FIRST
      // signature - the position is unchanged, and that is the sentence.
      expect(failedBody.includes('ICP') && failedBody.includes('refused the first signature')).toBe(true);
      expect(failedBody.includes('nothing moved')).toBe(true);
      expect(failedBody.includes('Approving')).toBe(false);

      // The ledger is byte-whole: a refused approve charges no fee and moves nothing.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
