/**
 * dest-groups — the jest twin of e2e/tests/206-convert-dest-groups.mjs (M2 batch C).
 *
 * The intent sheet's TARGET grammar on the real VCHF sheet: the standing target is ONE
 * pre-computed default on its own line (the value twin), every OTHER reachable currency rides
 * as a sibling chip — no chip ever shows a number; one chip tap re-resolves the pair and flips
 * the line; and the USD pair's OTHER rows sit behind the Other-venues expander in kind order
 * (direct pool standing, via-ICP hub, the composed IC+CeFi chains, Route B), the direct pool
 * auto-picked and mechanically disclosed.
 *
 * The SOL chip needs the SOL rail in the wallet's asset list — the rail boots through the
 * operator override with the in-memory RPC simulator answering (convertStubs).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor, pickSwapTarget,
  openOtherVenues,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {disposeConvertStubs, enableSolRail} from './convertStubs';

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

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 206 — the intent sheet\'s target grammar: the standing line + the sibling chips', () => {
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
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 15_000});

      // 2. one chip tap re-resolves the pair (the optional decision, one tap).
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-target-line'), 'Internet Computer', 'the line flipped to the picked currency');
      expect(m.driver.isPresent('convert-target-chip-USD')).toBe(true);
      expect(m.driver.isPresent('convert-target-chip-ICP')).toBe(false);

      // 3. the USD pair: its OTHER rows in the expander, kind order.
      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is auto-picked and mechanically disclosed');
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
  }, 180_000);
});
