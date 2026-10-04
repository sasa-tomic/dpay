/**
 * flow 143 (stale-quote-refresh) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, isDisabled,
} from '../harness/lib';
import {relayPost} from '../harness/relayClient';
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
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // the fixture venue's pool (file runs venue-armed)
const SEED = 300000000; // 3 ICP

hermeticDescribe('flow 143 — a stale quote refreshes itself; confirm re-quotes', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('flags + re-fetches staleness (counter-proven) and raises the moved-quote interrupt', async () => {
    const g = globalThis as Record<string, unknown>;
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-stale');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});

      // Fresh: attributed + timestamped, no stale notice, no quote-changed interrupt.
      assertIncludes(m.driver.readText('convert-venue-auto'), 'ICPSwap', 'fresh quote renders attributed');
      expect(m.driver.isPresent('convert-stale')).toBe(false);
      expect(m.driver.isPresent('convert-moved-note')).toBe(false);
      const fetchedBefore = m.driver.readText('convert-venue-auto');

      // Deterministic re-fetch proof: count every /api/v1/swap_quote request the surface issues.
      let quoteFetches = 0;
      const prevFetch = g.fetch as typeof fetch;
      g.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (String(url).includes('/api/v1/swap_quote')) quoteFetches += 1;
        return prevFetch(input, init);
      }) as typeof fetch;
      const fetchesBefore = quoteFetches;

      // Force staleness through the app's own seam (the __DPAY_TEST_* convention).
      g.__DPAY_TEST_CONVERT_STALE_MS = 50;

      // The stale notice appears (the 1 s staleness sweep picks it up), then clears on refresh.
      await m.driver.findByTestID('convert-stale', {timeoutMs: 10_000});
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-stale'), {timeoutMs: 12_000, label: 'the stale notice cleared on refresh'});
      const fetchedAfter = m.driver.readText('convert-venue-auto');
      assertIncludes(fetchedAfter, 'ICPSwap', 'refreshed quote is still attributed');
      expect(quoteFetches).toBeGreaterThan(fetchesBefore);
      if (fetchedBefore === fetchedAfter) {
        // formatClock is minute-granular — the instant MAY render identically within one minute;
        // the re-fetch counter above is the hard proof.
        console.log('    [143] note: fetched-at text unchanged within the minute (locale clock granularity)');
      }

      // A REAL venue-price move raises the review interrupt — driven via the relay's fee knob
      // on BOTH pools (whichever venue the sheet picked must see its quote move). The jump is
      // sized PAST the S2 tolerance (0.30% -> 60%: the output drops far beyond 5%), because a
      // within-tolerance move is now absorbed silently (flow 230 pins that arm).
      const knob = await relayPost('/api/v1/test/swap_pool', {pool: POOL, fee_millionths: 600_000});
      expect(knob.ok).toBe(true);
      const knobB = await relayPost('/api/v1/test/swap_pool', {pool: POOL_B, fee_millionths: 600_001});
      expect(knobB.ok).toBe(true);
      await m.driver.findByTestID('convert-moved-note', {timeoutMs: 15_000});
      const changedText = m.driver.readText('convert-moved-note');
      assertIncludes(changedText, 'Price changed', 'the interrupt names what happened, the fresh figure inline');
      assertIncludes(changedText, 'Confirm again', 'the interrupt re-arms the same button');
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).__DPAY_TEST_CONVERT_STALE_MS;
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
