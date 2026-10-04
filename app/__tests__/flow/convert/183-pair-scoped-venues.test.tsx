/**
 * flow 183 (pair-scoped-venues) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues,
  openConvertDetails,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, fmt,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const CKETH_POOL = 'angxa-baaaa-aaaag-qcvnq-cai';
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint | number): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}
/** Find a testID that STARTS WITH a prefix (the hub-row probe; exact findAllByProps can't). */
function findTestIDByPrefix(m: Awaited<ReturnType<typeof onboardWallet>>, prefix: string): string | null {
  let hit: string | null = null;
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (hit == null && id != null && id.startsWith(prefix)) hit = id;
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  return hit;
}

hermeticDescribe('flow 183 — the pair-scoped ICPSwap venues (ckUSDC, ckETH) are live on Convert', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('executes ckUSDC→ICP through its pool and pins the 6- and 18-decimal quote shapes', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-ckusdc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 1000000000, {currency: 2}); // 1000 ckUSDC
      expect(fund.ok).toBe(true);

      // ckUSDC→ICP: discover the pair on the Convert surface.
      await openConvertFor(m, 'ckusdc');
      await pickSwapTarget(m, 'ICP');
      await typeConvertAmount(m, '100');
      // ONE direct venue on this pair → the sheet auto-picks it; the via-VCHF hub waits behind
      // the ONE expander as an explicit opt-in row.
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 15_000});
      await openConvertDetails(m);
      const autoLine = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine, 'ICPSwap', 'the pick line names its executor');
      expect(autoLine).not.toContain('of 2 venues');
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await openOtherVenues(m);
      expect(findTestIDByPrefix(m, 'convert-venue-hub:')).not.toBeNull();
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);

      // The oracle BEFORE the confirm: the pool's own facts (its token0 is ICP).
      const oracle = await relayQuote(CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, 100000000n);
      expect(oracle.venue_id).toBe('icpswap-ckusdc');
      expect(oracle.zero_for_one).toBe(false);
      expect(oracle.fee_millionths).toBe(3000);
      let gross = BigInt(oracle.amount_out);
      expect(gross > 0n).toBe(true);
      let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      await openConvertDetails(m);
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(CKUSDC_POOL);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the counterparty is attributed to ICPSwap');
      assertIncludes(m.driver.readText('convert-headline'), `${fmt(gross - ICP_FEE, 8)} ICP`, 'the headline states the net ICP output');
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt(minOut, 8)} ICP`, 'the minimum follows the pool\'s quote');
      assertIncludes(m.driver.readText('convert-pool-fee'), '0.30%', 'the fee line states the pool\'s 0.30% tier');

      // The forward ICP→ckUSDC quote through the production route (the 6-decimal side).
      const fwd = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 100000000n);
      expect(fwd.venue_id).toBe('icpswap-ckusdc');
      expect(fwd.zero_for_one).toBe(true);
      expect(fwd.fee_millionths).toBe(3000);
      const fwdOut = BigInt(fwd.amount_out);
      expect(fwdOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6))).toBe(true);

      // Confirm (quote-changed interrupt → re-confirm, re-deriving the oracle after a move).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, 100000000n);
        gross = BigInt(re.amount_out);
        minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      }
      expect(await m.driver.waitForText('Done', {timeoutMs: 60_000})).toBe(true);
      await openConvertDetails(m); // the payout record folds under Details (S4, spec 2026-10-04)
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(gross, 8)} ICP`, 'the done panel states the pool\'s quoted ICP payout');
      assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

      // Settlement: 6-decimal ckUSDC input math; the ICP side is the quoted output verbatim.
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(BigInt(1000000000) - 100000000n - 2n * CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross);

      // --- ckETH pair: offered quote-only (the 18-decimal side) --------------------------------
      const fundEth = await faucetAccount(account!.publicHex, 4000000000000000, {currency: 6}); // 0.004 ckETH
      expect(fundEth.ok).toBe(true);
      await openConvertFor(m, 'cketh');
      await typeConvertAmount(m, '0.002');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await openConvertDetails(m);
      // The ckETH pool venue resolves async over the relay (seconds under lane load); until it
      // commits, venue-none is ALSO absent — absence proves nothing. Poll for the pool line.
      expect(await m.driver.waitForText(CKETH_POOL, {timeoutMs: 15_000})).toBe(true);
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(CKETH_POOL);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the ckETH counterparty is attributed to ICPSwap');
      const oracleEth = await relayQuote(CKETH_POOL, CKETH_LEDGER, ICP_LEDGER, 2000000000000000n);
      expect(oracleEth.venue_id).toBe('icpswap-cketh');
      expect(oracleEth.zero_for_one).toBe(false);
      const grossEth = BigInt(oracleEth.amount_out);
      expect(grossEth > 0n).toBe(true);
      // The sheet re-keys to the typed amount async — the deterministic signal is the headline
      // itself carrying the typed amount's oracle figure (the flow-140 pattern).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`${fmt(grossEth - ICP_FEE, 8)} ICP`) === true,
        {timeoutMs: 15_000, label: 'the ckETH checklist headline re-keyed to the typed amount'},
      );
      const minOutEth = (grossEth / 10000n) * 9900n + ((grossEth % 10000n) * 9900n) / 10000n;
      const fwdEth = await relayQuote(CKETH_POOL, ICP_LEDGER, CKETH_LEDGER, 100000000n);
      expect(fwdEth.venue_id).toBe('icpswap-cketh');
      expect(fwdEth.zero_for_one).toBe(true);
      expect(fwdEth.fee_millionths).toBe(3000);
      const fwdEthOut = BigInt(fwdEth.amount_out);
      expect(fwdEthOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,18})?$/.test(fmt(fwdEthOut, 18))).toBe(true);
      // QUOTE-ONLY: nothing executes on this leg.
      expect(m.driver.isPresent('convert-done')).toBe(false);
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt(minOutEth, 8)} ICP`, 'the ckETH minimum follows the pool\'s quote (form, not done panel)');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
