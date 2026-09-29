/**
 * flow 166 (auto-pick-fee-census) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, openOtherVenues, fmtHero,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, swapPoolKnob, venueKnob, fmt,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
/** Raw e8s compact twin (8 decimals, trailing zeros trimmed). */
function fmt8(raw: bigint): string {
  return fmt(raw, 8);
}
type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint | number): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}
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

hermeticDescribe('flow 166 — the disclosed auto pick + the one-tap override + the INV-6 fee census', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('picks the higher net quote, overrides in one tap, and pins every fee line byte-exact', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-chooser');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      // The served registry lands async: wait for BOTH rows' quotes before any expander read.
      await m.driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000}).catch(() => null);
      await m.driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000}).catch(() => null);

      // The mechanical pick, cross-checked against the two oracle replies for the same amount.
      const oracleA = await relayQuote(POOL, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      const netA = BigInt(oracleA.amount_out) - VCHF_FEE;
      const oracleB = await relayQuote(POOL_B, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      const netB = BigInt(oracleB.amount_out) - VCHF_FEE;
      const best = netB > netA
        ? {id: FIXTURE_VENUE, name: 'ICPSwap (offline fixture)', net: netB}
        : {id: 'icpswap', name: 'ICPSwap', net: netA};

      const autoLine = await awaitVenueComparison(m);
      assertIncludes(autoLine, 'Executed via', 'the pick line names its executor');
      assertIncludes(autoLine, 'highest quoted rate of 2 venues', 'the pick states the comparison count as a fact');
      expect(autoLine.toLowerCase()).not.toContain('best');
      assertIncludes(autoLine, best.name, `the pick followed the higher net quote (${best.name})`);
      const headlineNet = m.driver.readText('convert-receive');
      assertIncludes(headlineNet, `≈ ${fmtHero(best.net.toString(), 8, 'VCHF', {stable: true})}`, 'the receive hero is the PICKED venue\'s own reply at display precision');

      // The expander holds exactly the OTHER row, carrying its OWN quote at the typed amount.
      await openOtherVenues(m);
      const otherId = best.id === 'icpswap' ? FIXTURE_VENUE : 'icpswap';
      const otherNet = best.id === 'icpswap' ? netB : netA;
      const typed = m.driver.readInputValue('convert-amount');
      assertIncludes(typed, '1', 'the sheet\'s input holds the typed amount');
      const expectedOther = `${fmt8(otherNet + VCHF_FEE)} VCHF`;
      await m.driver.waitForFunction(
        () => (m!.driver.readTextSafe(`convert-venue-${otherId}-quote`) ?? '').trim() === expectedOther,
        {timeoutMs: 15_000, label: 'the other row shows its OWN quote at the typed amount'},
      );
      const order = venueRowOrder(m);
      expect(order.length).toBe(1);
      expect(order[0]).toBe(`convert-venue-${otherId}`);

      // ONE-TAP override: attribution + floor + headline move to the picked row's numbers.
      await m.driver.click(`convert-venue-${otherId}`, {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      const overriddenSource = m.driver.readText('convert-quote-source');
      assertIncludes(overriddenSource, 'fetched', 'the overridden card still carries attribution + a timestamp');
      assertIncludes(overriddenSource, otherId === 'icpswap' ? 'Quote from ICPSwap,' : 'ICPSwap (offline fixture)', 'the attribution names the OVERRIDDEN venue');
      expect(m.driver.isPresent('convert-venue-auto')).toBe(false);
      // The overridden row's fresh quote lands async — the deterministic signal is the hero
      // itself carrying the overridden venue's own reply (the flow-140 oracle pattern).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes(`≈ ${fmtHero(otherNet.toString(), 8, 'VCHF', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the receive hero follows the overridden row\'s own reply'},
      );

      // --- INV-6 fee census: force the real pool tier to 4321 millionths, re-key, override. ----
      await swapPoolKnob({pool: POOL, fee_millionths: 4321});
      const AMOUNT_IN = 200000000n;
      const oracle = await relayQuote(POOL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
      expect(String(oracle.fee_millionths)).toBe('4321');
      expect(oracle.venue_id).toBe('icpswap');
      const gross = BigInt(oracle.amount_out);
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      const net = gross - VCHF_FEE;

      await typeConvertAmount(m, '2');
      if (m.driver.isPresent('convert-venue-icpswap') === false) await openOtherVenues(m);
      await m.driver.click('convert-venue-icpswap', {timeoutMs: 5_000});
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      // The pool-fee line settling at the FORCED tier + the hero re-keying to the typed
      // amount are jointly the deterministic signal that the fresh quote landed (the two
      // card sections settle on separate ticks — poll the money figure, then read the rest).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes(`≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the receive hero re-keyed to the forced-tier quote'},
      );
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-pool-fee')?.includes('0.4321%') === true,
        {timeoutMs: 15_000, label: 'the pool-fee line settles at the FORCED tier'},
      );

      // THE CENSUS — every fee-bearing money line, byte-exact:
      const poolFeeLine = m.driver.readText('convert-pool-fee');
      assertIncludes(poolFeeLine, '0.4321%', 'pool fee = the FORCED tier (4 decimals, never rounded)');
      assertIncludes(poolFeeLine, 'ICPSwap fee tier', 'the tier is attributed to the venue whose quote it rode');
      assertIncludes(m.driver.readText('convert-in-fee'), `Input fee: ${fmt8(ICP_FEE)} ICP`, 'input fee = the catalog ledger fee, exact');
      assertIncludes(m.driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`, 'output fee = the catalog ledger fee, exact');
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      assertIncludes(m.driver.readText('convert-receive'), `≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`, 'receive hero = gross − output fee from the forced quote');
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`, 'Details carries the forced quote\'s verbatim gross');
      const minOutLine = m.driver.readText('convert-min-out');
      assertIncludes(minOutLine, `${fmt8(minOut)} VCHF`, 'the floor = the core\'s floor math on the forced quote');
      assertIncludes(minOutLine, '1% slippage', 'at the default 1% slippage');
      expect(m.driver.isPresent('convert-net')).toBe(false);
      expect(m.driver.readText('convert-venue-disclosure').trim().length).toBeGreaterThan(0);
      expect(m.driver.isPresent('convert-impact')).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
