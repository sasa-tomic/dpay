/**
 * flow 168 (fixture-venue-b) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, openOtherVenues, fmtHero,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, fmt,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
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

hermeticDescribe('flow 168 — picking fixture venue B executes through pool B, end-to-end', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('quotes, settles and pays B\'s reversed-pool output verbatim', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-fixture');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      await openOtherVenues(m);

      // The oracle BEFORE the pick: pool B's own facts (its token0 is ICP).
      const oracle = await relayQuote(POOL_B, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      expect(oracle.venue_id).toBe(FIXTURE_VENUE);
      expect(oracle.zero_for_one).toBe(true);
      expect(oracle.fee_millionths).toBe(1000);
      const gross = BigInt(oracle.amount_out);
      const net = gross - VCHF_FEE;
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      // Pick venue B → the decision surfaces quote B, attributed to B, on B's pool.
      await m.driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 6_000});
      // The pick re-quotes ASYNC: the headline exists immediately still carrying the previous
      // (auto-pick) quote — wait for the TRANSITION to B's net output, never snapshot-read a
      // racing re-quote (observed 2026-09-29 at low host load).
      const headlineB = `≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`;
      const drv = m.driver;
      await drv.waitForFunction(
        () => (drv.readTextSafe('convert-headline') ?? '').includes(headlineB),
        {timeoutMs: 10_000, label: "the headline flips to venue B's net output"},
      );
      await m.driver.findByTestID('convert-headline', {timeoutMs: 10_000});
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(POOL_B);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap (offline fixture)', 'the counterparty is attributed to venue B');
      assertIncludes(m.driver.readText('convert-headline'), `≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`, 'the headline states B\'s net output at display precision');
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`, 'Details carries B\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt8(minOut)} VCHF`, 'the minimum follows B\'s quote');
      assertIncludes(m.driver.readText('convert-pool-fee'), '0.10%', 'the fee line states B\'s own 0.10% tier');

      // Confirm (a quote-changed interrupt would demand a re-confirm — retry a few rounds).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
      }
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt8(gross)} VCHF`, 'the done panel states B\'s quoted payout');
      assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

      // Settlement: pool B paid its quoted output VERBATIM.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(300000000) - 100000000n - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(gross);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
