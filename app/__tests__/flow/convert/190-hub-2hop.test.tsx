/**
 * flow 190 (hub-2hop) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, swapPoolKnob, venueKnob, fmt,
  floor99,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_ICP_CKETH = 'angxa-baaaa-aaaag-qcvnq-cai';
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

hermeticDescribe('flow 190 — the hub 2-hop conversion (VCHF → ICP → ETH), one 4-leg intent', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('runs the composed surface, the 4-leg tracker, the in-wallet receipt, and the refusal taxonomy', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-hub');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7}); // 20 VCHF
      expect(fund.ok).toBe(true);

      // The target list: currency chips from VCHF; the ICP pair carries the direct pool + hub.
      await openConvertFor(m, 'vchf');
      for (const code of ['ICP', 'ETH', 'BTC', 'SOL']) {
        expect(m.driver.isPresent(`convert-target-chip-${code}`)).toBe(true);
      }
      await pickSwapTarget(m, 'ICP');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc', {timeoutMs: 8_000});

      // The hub-only target: ETH — no address input, the composed surface arms on it.
      await pickSwapTarget(m, 'ETH');
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});

      // The composed oracle BEFORE confirming: the exact two quotes the surface shows.
      const hubOracle = async () => {
        const q1 = await relayQuote(POOL_VCHF_ICP, VCHF_LEDGER, ICP_LEDGER, 200000000n);
        expect(q1.venue_id).toBe('icpswap');
        expect(q1.zero_for_one).toBe(true);
        const gross1 = BigInt(q1.amount_out);
        const minOut1 = floor99(gross1);
        const q2 = await relayQuote(POOL_ICP_CKETH, ICP_LEDGER, CKETH_LEDGER, minOut1);
        expect(q2.venue_id).toBe('icpswap-cketh');
        expect(q2.zero_for_one).toBe(true);
        const gross2 = BigInt(q2.amount_out);
        expect(gross2 > CKETH_FEE).toBe(true);
        return {gross1, minOut1, gross2, minOut2: floor99(gross2), net2: gross2 - CKETH_FEE};
      };
      let {gross1, minOut1, gross2, net2} = await hubOracle();
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`≈ ${fmtHero(net2.toString(), 18, 'ETH', {displayDecimals: 6})}`) === true,
        {timeoutMs: 15_000, label: 'the composed headline re-keyed to the two-hop oracle'},
      );
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt(gross2, 18)} ETH`, 'Details carries swap2\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-quote-source'), 'ICPSwap + ICPSwap', 'the attribution names BOTH venues verbatim');
      assertIncludes(m.driver.readText('convert-route-via'), 'via ICP · 2 swaps', 'the route chip names the hub and the swap count');
      const census = m.driver.readText('convert-hub-census');
      assertIncludes(census, 'Two swaps, itemized', 'the census heading names the fold');
      assertIncludes(census, 'Combined rate, VCHF → ETH:', 'the composed rate names both ends');
      assertIncludes(census, 'Swap VCHF → ICP on ICPSwap', 'hop 1 names its venue and its pair');
      assertIncludes(census, 'Swap ICP → ETH on ICPSwap', 'hop 2 names its venue and its pair');
      assertIncludes(census, 'Pool fee: 0.30% (ICPSwap fee tier)', 'each hop names its own fee tier');
      assertIncludes(census, 'Approving the next pool costs 0.0001 VCHF', 'hop 1\'s approve cost is its own census line');
      assertIncludes(census, 'Approving the next pool costs 0.0001 ICP', 'hop 2\'s approve cost is its own census line');
      assertIncludes(census, 'the surplus stays in this wallet as ICP or ETH.', 'the surplus note covers both hops');

      // Confirm: four legs, per-leg status, the in-wallet receipt.
      let confirmed = false;
      for (let round = 0; round < 5 && !confirmed; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) { confirmed = true; break; }
        ({gross1, minOut1, gross2, net2} = await hubOracle());
      }
      expect(confirmed).toBe(true);
      await m.driver.findByTestID('convert-state', {timeoutMs: 10_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const stateText = m.driver.readText('convert-state');
      assertIncludes(stateText, 'Convert VCHF → ETH', 'the state screen keeps the plain selection heading');
      expect(m.driver.isPresent('convert-route-legs')).toBe(true);
      const legLabels = [
        'Approve the pool to pull your VCHF',
        'Swap VCHF → ICP on ICPSwap',
        'Approve the pool to pull your ICP',
        'Swap ICP → ETH on ICPSwap',
      ];
      for (let i = 0; i < 4; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}`), legLabels[i], `leg ${i} carries its own label`);
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `leg ${i} reads Confirmed after the run`);
      }
      assertIncludes(m.driver.readText('convert-leg-0-state'), '· 0.0001 VCHF', 'leg 1\'s approve fee is its own ledger\'s fee');
      assertIncludes(m.driver.readText('convert-leg-2-state'), '· 0.0001 ICP', 'leg 3\'s approve fee is the hub ledger\'s fee');
      const done = m.driver.readText('convert-done');
      assertIncludes(done, 'Converted', 'the done title is the in-wallet receipt\'s title');
      assertIncludes(done, `${fmt(gross2, 18)} ETH received in your wallet.`, 'the receipt names the SEEN payout amount');
      assertIncludes(done, 'Payout record: ', 'the receipt carries the dest-ledger payout record');
      expect(!done.includes('on its way') && !stateText.includes('Ethereum')).toBe(true);

      // Ledger truth: VCHF debited amount + two fees; ICP nets the surplus; ckETH the full gross.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(2000000000) - 200000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross1 - minOut1 - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(gross2);

      // --- the USD pair's venue rows: direct pool standing, hub opt-in; selection only ----------
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'ICPSwap', 'the direct pool is the auto pick for the USD pair');
      await openOtherVenues(m);
      const hubRow = m.driver.readText('convert-venue-hub:icpswap:8:icpswap-ckusdc');
      assertIncludes(hubRow, 'Via ICP', 'the opt-in hub row names its mechanism');
      assertIncludes(hubRow, '2 swaps', 'the opt-in hub row carries its static shape line');
      await m.driver.click('convert-venue-hub:icpswap:8:icpswap-ckusdc');
      await typeConvertAmount(m, '1');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-route-via')?.includes('via ICP · 2 swaps') === true,
        {timeoutMs: 15_000, label: 'picking Via ICP arms the composed surface for USD'},
      );
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);

      // --- the swap2 refusal: park on pending_withdrawal, degrade the hop pool, settle ----------
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'ETH');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      const run2 = await hubOracle(); // fresh: run 1 moved both pools
      // fail_withdrawal does NOT touch the quote curve — the confirm-time re-quote still matches.
      await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: true});
      let run2Confirmed = false;
      for (let round = 0; round < 5 && !run2Confirmed; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) { run2Confirmed = true; break; }
      }
      expect(run2Confirmed).toBe(true);
      // swap1 executes (#ok) but its payout row never lands → the honest pending_withdrawal park.
      let parked = false;
      for (let i = 0; i < 40 && !parked; i++) {
        parked = await m.driver.findByTestID('convert-pending', {timeoutMs: 500}).then(() => true).catch(() => false);
      }
      expect(parked).toBe(true);
      // NOW degrade the hop pool: any swap2 pays 5% of its curve — far below the signed floor.
      await swapPoolKnob({pool: POOL_ICP_CKETH, impact_bps: 9500});
      // Drain the queued payout → swap1 confirms → the engine marches into the degraded swap2.
      await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: false, settle_pending: true});
      let refused = false;
      for (let i = 0; i < 60 && !refused; i++) {
        refused = await m.driver.findByTestID('convert-failed-leg', {timeoutMs: 300}).then(() => true).catch(() => false);
      }
      expect(refused).toBe(true);
      // The failed-leg card mounts one tick before the leg list flips its label — wait for the
      // label itself (a positive transition) instead of snapshot-reading the racing first render.
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-leg-3-state')?.includes('Refused') === true,
        {timeoutMs: 15_000, label: 'the refused leg names itself'},
      );
      assertIncludes(m.driver.readText('convert-leg-3-state'), 'Refused', 'the refused leg names itself');
      const failed = m.driver.readText('convert-failed-leg');
      assertIncludes(failed, 'ICP', 'the failure names the HUB asset as the in-wallet position');
      assertIncludes(failed, 'ETH', 'the failure names what the refused leg was bound for');
      expect(m.driver.bodyText()).not.toContain('received in your wallet');
      // Books: swap2 pulled NOTHING — the user holds swap1's gross minus ICP's approve fee.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(2000000000) - 2n * (200000000n + 2n * VCHF_FEE));
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe((gross1 - minOut1 - 2n * ICP_FEE) + (run2.gross1 - ICP_FEE));
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(gross2);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
