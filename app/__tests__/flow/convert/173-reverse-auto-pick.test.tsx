/**
 * flow 173 (reverse-auto-pick) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, swapPoolKnob, venueKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
/** Unique venue-row testIDs in tree order (the RN-web DOM-order twin via the rendered tree). */
function venueRowOrder(m: Mount): string[] {
  const ids: string[] = [];
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (id != null && (id === 'convert-venue-icpswap' || id === `convert-venue-${FIXTURE_VENUE}`) && !ids.includes(id)) ids.push(id);
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  return ids;
}
/** The venue world's comparison disclosure lands ASYNC after the auto line first renders (the
 *  registry quote of the second venue resolves a beat later) — wait for the disclosed count
 *  instead of snapshot-reading the racing first render (low host load flips these constantly). */
async function awaitVenueComparison(m: Mount): Promise<string> {
  await m.driver.waitForFunction(
    () => (m.driver.readTextSafe('convert-venue-auto') ?? '').includes('of 2 venues'),
    {timeoutMs: 10_000, label: 'the auto pick discloses the venue comparison count'},
  );
  return m.driver.readText('convert-venue-auto');
}

hermeticDescribe('flow 173 — the auto-pick invariants in the REVERSE direction (VCHF → ICP)', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('flips the pick in both phases where the pools disagree about token0', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-order-rev');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 1_000_000_000, {currency: 7}); // 10 VCHF
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'ICP');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      await openOtherVenues(m);
      const before = venueRowOrder(m);
      expect(before.length).toBe(1);
      expect(before[0]).toBe('convert-venue-icpswap');

      // Phase 1: floor the real pool → the fixture picks, the real row zeroes (in ICP units).
      await swapPoolKnob({pool: POOL, impact_bps: 10000});
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-venue-auto')?.includes('offline fixture') === true,
        {timeoutMs: 15_000, label: 'the pick flipped to the fixture venue (reverse)'},
      );
      const autoLine1 = await awaitVenueComparison(m);
      assertIncludes(autoLine1, 'Executed via ICPSwap (offline fixture)', 'the pick followed the strictly-better fixture venue');
      assertIncludes(autoLine1, 'highest quoted rate of 2 venues', 'the pick states the comparison count');
      const after1 = venueRowOrder(m);
      expect(after1.length).toBe(1);
      expect(after1[0]).toBe('convert-venue-icpswap');
      await m.driver.waitForFunction(
        () => /^0(\.0+)? ICP$/.test((m!.driver.readTextSafe('convert-venue-icpswap-quote') ?? '').trim()),
        {timeoutMs: 15_000, label: 'the floored real row shows its OWN zeroed reverse reply'},
      );
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);

      // Phase 2: re-price then floor fixture B while the real pool restores → the pick flips back.
      await swapPoolKnob({pool: POOL_B, fee_millionths: 4321});
      await swapPoolKnob({pool: POOL_B, impact_bps: 10000});
      await swapPoolKnob({pool: POOL, impact_bps: 0});
      await typeConvertAmount(m, '3');
      await m.driver.waitForFunction(
        () => {
          const auto = m!.driver.readTextSafe('convert-venue-auto') ?? '';
          return auto.includes('Executed via ICPSwap,') && !auto.includes('offline fixture');
        },
        {timeoutMs: 15_000, label: 'the pick flipped back to the real venue (reverse)'},
      );
      const autoLine2 = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine2, 'Executed via ICPSwap,', 'the pick flipped back to the real venue');
      expect(autoLine2).not.toContain('offline fixture');
      const after2 = venueRowOrder(m);
      expect(after2.length).toBe(1);
      expect(after2[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);
      await m.driver.waitForFunction(
        () => /^0(\.0+)? ICP$/.test((m!.driver.readTextSafe(`convert-venue-${FIXTURE_VENUE}-quote`) ?? '').trim()),
        {timeoutMs: 15_000, label: 'the floored fixture row shows its OWN zeroed reverse reply'},
      );
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
