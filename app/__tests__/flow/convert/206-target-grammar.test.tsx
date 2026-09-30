/**
 * flow 206 (target-grammar) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, enableSolRail,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

/** The sheet's target + venue testIDs in TRUE TREE ORDER (the DOM-order twin). */
function targetLayout(m: Mount): string[] {
  const ids: string[] = [];
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (id != null && (id === 'convert-target-line' || /^convert-target-chip-[A-Z]+$/.test(id) || /^convert-venue-/.test(id))) {
      ids.push(id);
    }
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  // RN-web mirrors testID onto wrapper layers — the DOM-order twin de-dupes (first occurrence).
  return [...new Set(ids)];
}

hermeticDescribe('flow 206 — the intent sheet\'s target grammar: the standing line + the sibling chips', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('stands on the value twin, carries exactly the reachable chips, flips on one tap, kinds the rows', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-dest-groups');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fund.ok).toBe(true);

      // Tap 1 — the convert sheet on the VCHF account.
      await openConvertFor(m, 'vchf');
      await m.driver.findByTestID('convert-target-leg', {timeoutMs: 15_000});

      // 1. the standing target is the value twin; the chips carry exactly the reachable set.
      const layout = targetLayout(m);
      const chips = layout.filter((t) => t.startsWith('convert-target-chip-'));
      const expectedChips = [
        'convert-target-chip-USD',
        'convert-target-chip-BTC',
        'convert-target-chip-ETH',
        'convert-target-chip-ICP',
        'convert-target-chip-SOL',
      ];
      expect(JSON.stringify(chips)).toBe(JSON.stringify(expectedChips));
      expect(layout.includes('convert-target-line')).toBe(true);
      assertIncludes(m.driver.readText('convert-target-line'), 'Euros', 'a stable source stands on its value twin');
      // The pair walk arms the sheet: the standing pair is already quoted on open.
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});

      // 2. one chip tap re-resolves the pair (the optional decision, one tap).
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-target-line'), 'Internet Computer', 'the line flipped to the picked currency');
      expect(m.driver.isPresent('convert-target-chip-USD')).toBe(true);
      expect(m.driver.isPresent('convert-target-chip-ICP')).toBe(false);

      // 3. the USD pair: its OTHER rows in the expander, kind order.
      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'ICPSwap', 'the direct pool is auto-picked and mechanically disclosed');
      await openOtherVenues(m);
      const venueRows = targetLayout(m)
        .filter((t) => t.startsWith('convert-venue-') && t !== 'convert-venue-auto' && !/-quote$|-err$|-slow$/.test(t));
      const expectedRows = [
        'convert-venue-hub:icpswap:8:icpswap-ckusdc',        // via the ICP hub
        // The composed IC+CeFi chains: direct-then-hub IC legs into the sideshift-usdc
        // order, keyed on the settle mint, in registry order.
        'convert-venue-composed:icpswap:sideshift-usdc',
        'convert-venue-composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:sideshift-usdc',
        'convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', // Route B (in-wallet landing)
      ];
      expect(JSON.stringify(venueRows)).toBe(JSON.stringify(expectedRows));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
