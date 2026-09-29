/**
 * flow 184 (route-a-icp-usdc) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero,
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
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai';
const GAS_WEI = 78000000000000n;
const CKUSDC_FEE = 10000n;
type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

hermeticDescribe('flow 184 — Route A: ICP → USDC(Ethereum) as one opt-in intent', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('offers the composed row in kind order, quotes the hop verbatim, names the gas census', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-route-a');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, 2000000000, {currency: 8}); // 20 ICP
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6}); // 0.0004 ckETH
      expect(fundEth.ok).toBe(true);

      // The venue area: the USD pair's rows in kind order, Route A gone.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'USD');
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      for (const rowId of ['hub:icpswap:7:icpswap-vchf-ckusdc', 'multihop:icpswap-ckusdc:2:cctp', 'sideshift-usdc']) {
        expect(await m.driver.findByTestID(`convert-venue-${rowId}`, {timeoutMs: 4_000}).then(() => true).catch(() => false)).toBe(true);
      }
      expect(await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is the auto pick (disclosed mechanically)');
      expect(m.driver.isPresent('convert-headline')).toBe(true);
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);

      // Picking Route B swaps the surface: the crossing's signer-side address + the hop quote.
      await m.driver.click('convert-venue-multihop:icpswap-ckusdc:2:cctp');
      await m.driver.type('convert-dest-address', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);

      // The hop's own quote through the production route.
      const oracle = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
      expect(oracle.venue_id).toBe('icpswap-ckusdc');
      expect(oracle.zero_for_one).toBe(true);
      const gross = BigInt(oracle.amount_out);
      expect(gross > 0n).toBe(true);
      const net = gross - CKUSDC_FEE;
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      // The route census: hop quote + floor stay MAIN; the minter's gas fee + burn counterparty
      // fold behind the ONE Details control.
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`≈ ${fmtHero(net.toString(), 6, 'USDC', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the headline re-keyed to the hop oracle'},
      );
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the crossing minimum is the hop quote\'s 1% floor');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-quote-verbatim') && m!.driver.isPresent('convert-gas-note'),
        {timeoutMs: 15_000, label: 'the census lines mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt(gross, 6)} USDC`, 'Details carries the hop venue\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the gas census line states the minter\'s live figure');
      expect(m.driver.readText('convert-minter-principal').trim()).toBe(MINTER);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the swap counterparty is attributed to ICPSwap');
      expect(m.driver.isPresent('convert-gas-preflight')).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});
