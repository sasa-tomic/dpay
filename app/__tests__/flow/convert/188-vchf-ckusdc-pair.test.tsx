/**
 * flow 188 (vchf-ckusdc-pair) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, fmt, deriveEvmKeypair, eip55,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

hermeticDescribe('flow 188 — the VCHF ↔ ckUSDC pair (registry order + both-direction quotes)', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('serves the registry, quotes both directions, routes the USD walk through the new pool', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The served registry: the expansion is on the wire, in registry order. The file-scoped
      // fixture knob adds a 14th row (icpswap-fixture-b) — filter it and pin the THIRTEEN real
      // venues' order (the e2e twin ran on an un-armed private relay).
      const venuesRes = await relayGet('/api/v1/venues') as {venues: Array<{venue_id: string}>};
      expect(venuesRes.venues.map((v) => v.venue_id).filter((id) => id !== 'icpswap-fixture-b').join('|')).toBe([
        'icpswap', 'icpswap-ckusdc', 'icpswap-cketh', 'icpswap-ckbtc', 'icpswap-ckbtc-cketh',
        'icpswap-vchf-ckusdc', 'jupiter', 'jupiter-eurc', 'jupiter-usdc-eurc', 'sideshift',
        'sideshift-usdc', 'sideshift-eurc', 'trocador',
      ].join('|'));

      // The DIRECT pair: production-route oracle quotes, both directions.
      const fwd = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
      expect(fwd.venue_id).toBe('icpswap-vchf-ckusdc');
      expect(fwd.zero_for_one).toBe(true);
      expect(fwd.fee_millionths).toBe(3000);
      const fwdOut = BigInt(fwd.amount_out);
      expect(fwdOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6))).toBe(true);
      const rev = await relayQuote(VCHF_USDC_POOL, CKUSDC_LEDGER, VCHF_LEDGER, 100000000n);
      expect(rev.venue_id).toBe('icpswap-vchf-ckusdc');
      expect(rev.zero_for_one).toBe(false);
      expect(rev.fee_millionths).toBe(3000);
      const revOut = BigInt(rev.amount_out);
      expect(revOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,8})?$/.test(fmt(revOut, 8))).toBe(true);

      // The app: the direct form is untouched; the new pool surfaces as the Route B hop.
      m = await onboardWallet('jest-convert-vchf-usdc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'vchf');
      await typeConvertAmount(m, '10');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-pool-principal'),
        {timeoutMs: 15_000, label: 'the details census mounted'},
      );
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(VCHF_USDC_POOL);

      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', {timeoutMs: 3_000});
      await m.driver.click('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', {timeoutMs: 4_000});
      // The payout default: the wallet's OWN derived EVM address — shown, never typed
      // (founder directive 2026-09-30).
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-dest-shown'), {timeoutMs: 8_000, label: 'the payout default rendered'});
      expect(m.driver.readText('convert-dest-shown')).toBe(eip55(deriveEvmKeypair(account!.secretHex).address.toLowerCase()));
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);
      expect(m.driver.isPresent('convert-dest-reenter')).toBe(false);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);
      const minOut = (fwdOut / 10000n) * 9900n + ((fwdOut % 10000n) * 9900n) / 10000n;
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the destination minimum is the hop quote\'s 1% floor through the NEW pool');

      // QUOTE-ONLY: nothing executed.
      expect(m.driver.isPresent('convert-done')).toBe(false);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(50000000000));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
