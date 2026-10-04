/**
 * flow 167 (pick-follows-quotes) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, openOtherVenues,
  openConvertDetails,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
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
    () => (m.driver.readTextSafe('convert-quote-ready') ?? '') !== '',
    {timeoutMs: 10_000, label: 'the recommendation line stands (a quote is live)'},
  );
  // The venue attribution lives inside Details (the copy law, spec 2026-10-04 §3).
  await openConvertDetails(m);
  return m.driver.readText('convert-venue-auto');
}

hermeticDescribe('flow 167 — the auto pick follows the quotes; the expander holds exactly the complement', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('flips the pick in BOTH knob directions with the zeroed floored row quoted byte-identically', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-order');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 10_000});
      await openOtherVenues(m);
      const before = venueRowOrder(m);
      expect(before.length).toBe(1);
      expect(before[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);

      // Phase 1: the real pool's payout floors to zero → the pick flips to the fixture.
      await swapPoolKnob({pool: POOL, impact_bps: 10000});
      await typeConvertAmount(m, '2');
      // The pick-flip signal is the expander's complement row (the attribution itself
      // lives inside Details - the copy law, spec 2026-10-04 §3).
      await m.driver.waitForFunction(
        () => venueRowOrder(m!)[0] === 'convert-venue-icpswap',
        {timeoutMs: 15_000, label: 'the pick flipped to the fixture venue'},
      );
      const autoLine1 = await awaitVenueComparison(m);
      assertIncludes(autoLine1, 'ICPSwap (offline fixture)', 'the disclosed pick followed the strictly-better fixture venue');
      assertIncludes(autoLine1, '2 venues', 'the pick states the comparison count');
      const after1 = venueRowOrder(m);
      expect(after1.length).toBe(1);
      expect(after1[0]).toBe('convert-venue-icpswap');
      const aQuote = m.driver.readText('convert-venue-icpswap-quote');
      expect(/^0(\.0+)? VCHF$/.test(aQuote.trim())).toBe(true);
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);

      // Phase 2: re-price fixture B, floor it, restore the real pool → the pick flips back.
      await swapPoolKnob({pool: POOL_B, fee_millionths: 4321});
      await swapPoolKnob({pool: POOL_B, impact_bps: 10000});
      await swapPoolKnob({pool: POOL, impact_bps: 0});
      await typeConvertAmount(m, '3');
      await m.driver.waitForFunction(
        () => venueRowOrder(m!)[0] === `convert-venue-${FIXTURE_VENUE}`,
        {timeoutMs: 15_000, label: 'the pick flipped back to the real venue'},
      );
      // The flip settled; awaitVenueComparison opens Details for the attribution read.
      const autoLine2 = await awaitVenueComparison(m);
      assertIncludes(autoLine2, 'ICPSwap ·', 'the disclosed pick flipped back to the real venue');
      expect(autoLine2).not.toContain('offline fixture');
      const after2 = venueRowOrder(m);
      expect(after2.length).toBe(1);
      expect(after2[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);
      const bQuote2 = m.driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
      expect(/^0(\.0+)? VCHF$/.test(bQuote2.trim())).toBe(true);
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
