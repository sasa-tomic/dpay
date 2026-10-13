/**
 * flow 207 (trocador-no-quote) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues, isDisabled,
  openConvertDetails,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSideShiftStub, trocadorConfig,
  trocadorRelayHits,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const SEED_ICP = 2000000000; // 20 ICP

hermeticDescribe('flow 207 — the trocador listed-but-unquoted verdict renders as the attributed no-quote line', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('names the venue + the way out, withholds confirm, creates nothing, sibling still quotes', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-trocador-no-quote');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      // The sideshift half quotes through the relay; its status read is keyless device-direct.
      installSideShiftStub({initialStatus: 'waiting'});

      // §1 the SOL pair's venue area: BOTH CeFi services as rows.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-venues', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 15_000});
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the registry-first venue is the auto pick (disclosed)');
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venue-trocador')).toBe(true);

      // §2 the armed no-quote venue answers; the surface names it honestly.
      await trocadorConfig({no_quote: true});
      await m.driver.click('convert-venue-trocador', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-no-quote', {timeoutMs: 20_000});
      const noQuoteText = m.driver.readText('convert-no-quote');
      // The copy law (spec 2026-10-04 §3): the primary refusal stays venue-less; the
      // verdict's attribution folds under the no-quote card's own Details control.
      assertIncludes(noQuoteText, 'No live market', 'the refusal names the state and the way out');
      await m.driver.click('convert-no-quote-details', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('convert-no-quote-venue'), 'Trocador', 'the verdict is attributed to the venue (Details)');
      assertIncludes(noQuoteText, 'no live market', 'the line says the venue has no live market right now');
      // Copy law (founder 2026-10-13): "Nothing was sent" only after a real send
      // attempt; a no-quote refusal is pre-attempt, so the phrase must be absent.
      expect(noQuoteText).not.toContain('Nothing was sent');
      assertIncludes(noQuoteText, 'Pick another venue or try again later', 'the line names the way out');
      expect(m.driver.isPresent('convert-quote-err')).toBe(false);
      const receiveText = m.driver.readText('convert-receive');
      expect(/\d/.test(receiveText.replace('1%', ''))).toBe(false);
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);

      // §3 fail-closed audit: the quote was asked, nothing was created.
      const hits = await trocadorRelayHits();
      expect(hits.rateCalls).toBeGreaterThanOrEqual(1);
      expect(hits.tradeCalls).toBe(0);
      expect(hits.bareCalls).toBe(0);
      assertIncludes(hits.lastQuery ?? '', 'markup=0', 'the no-dpay-cut pin rode the quote');
      assertIncludes(hits.lastQuery ?? '', 'best_only=True', 'the aggregator\'s one-quote pin rode the quote');

      // §4 the sibling mechanism is unaffected: sideshift quotes normally.
      await m.driver.click('convert-venue-sideshift', {timeoutMs: 5_000});
      expect(m.driver.isPresent('convert-no-quote')).toBe(false);
      await m.driver.findByTestID('convert-headline', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-headline'), '0.0495 SOL', 'the sideshift quote renders verbatim');
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to the sibling venue'); // Details still open from the read above
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
