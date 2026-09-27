/**
 * multihop — the jest twins of e2e/tests/{184,188,190,196,200}-convert-*.mjs (M2 batch C).
 *
 * Flow 184 convert-multihop-route-a — ICP → USDC(Ethereum) as ONE intent: the composed
 *   destination is an explicit opt-in row beside the direct pair (the external-address cash-out
 *   route is NOT offered — the swap screen converts between the user's own balances), the
 *   Route-B hop quote is verbatim with the 1% floor and the minter's live gas fee, the funded
 *   wallet passes the gas preflight silently. TRIMMED (browser-only): screenshots.
 * Flow 188 convert-vchf-ckusdc-pair — the served registry lists all thirteen real venues in
 *   registry order, the DIRECT pair quotes both directions through the production route
 *   (zero_for_one flip), the standing VCHF form quotes through the stable pair pool, and Route
 *   B's hop quotes the 1% floor through the SAME pool. QUOTE-ONLY. (Relocated from the venues
 *   file: its registry pin needs the UN-knobbed served list, and the venues file runs its whole
 *   session with the fixture venue armed.)
 * Flow 190 convert-hub — VCHF → ICP → ETH as one 4-leg intent: the hub-only destination arms
 *   the two-venue composed surface (both venues attributed, via-ICP chip, in-wallet floor,
 *   itemized census), the D15 step tracker + per-leg states, the in-wallet receipt naming the
 *   SEEN amount, exact fake-IC books, and a swap2 refusal (impact knob under the signed floor,
 *   parked deterministically on pending_withdrawal first) lands the hub failed_leg taxonomy
 *   with the ICP position named.
 * Flow 196 convert-crossrail-gas-fund — the gas-fund card: EIP-55 checksum enforcement at
 *   entry + the one-time re-type gate, Need ≈ / Your wallet lines (the passive warn stands
 *   down), the self path rechecks against a MUTABLE external balance, the funded path
 *   prepends the gas legs (7 total), and the decline card names BOTH stranded assets.
 * Flow 200 convert-crossrail-vchf-sol — the venue-attribution pin on the Route C machine: the
 *   census names the full chain, the floor reads USDC as the mid-stop, the fail-soft Jupiter
 *   destination estimate renders, and the done receipt attributes all three venues.
 *
 * Flows 196/200 need the CCTP/ETH-balance page stubs and the SOL rail: they ride
 * ./convertStubs (the cctp.mjs / solaccounts.mjs / jupiter.mjs ports). Knob windows stay
 * short and every knob is restored (the shared-relay isolation gap is filed).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero, isDisabled,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {
  disposeConvertStubs, swapPoolKnob, installCctpStub, installSolRpcStub, installMutableEthBalance,
  configureJupiterStub, jupiterStubState, cctpFeeExpectations, FORWARD_TX_HASH,
  deriveSolanaKeypair, deriveAta, jupiterSwapTxB64, solConvertTxDetail, solSentTxs, fmt, floor99,
  installEvmSignSeam, setCctpMessageState, bs58Encode, enableSolRail,
} from './convertStubs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_ICP_CKETH = 'angxa-baaaa-aaaag-qcvnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai';
const GAS_WEI = 78000000000000n;
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;

type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

async function restorePoolKnobs(): Promise<void> {
  try {
    await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: false, settle_pending: true, fee_millionths: 3000, impact_bps: 0});
    await swapPoolKnob({pool: POOL_ICP_CKETH, fail_withdrawal: false, settle_pending: true, fee_millionths: 3000, impact_bps: 0});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 184 — Route A: ICP → USDC(Ethereum) as one opt-in intent', () => {
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

describe('flow 188 — the VCHF ↔ ckUSDC pair (registry order + both-direction quotes)', () => {
  it('serves the registry, quotes both directions, routes the USD walk through the new pool', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The served registry: the expansion is on the wire, in registry order (no knob armed here).
      const venuesRes = await relayGet('/api/v1/venues') as {venues: Array<{venue_id: string}>};
      expect(venuesRes.venues.map((v) => v.venue_id).join('|')).toBe([
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
      await m.driver.type('convert-dest-address', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
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
  }, 180_000);
});

describe('flow 190 — the hub 2-hop conversion (VCHF → ICP → ETH), one 4-leg intent', () => {
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
      assertIncludes(m.driver.readText('convert-quote-source'), 'Quotes from ICPSwap and ICPSwap, fetched ', 'the attribution names BOTH venues verbatim');
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
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is the auto pick for the USD pair');
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
      await restorePoolKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 196 — the cross-rail gas-fund card', () => {
  it('gates on checksum + re-entry, offers need-vs-have, rechecks, prepends the gas legs', async () => {
    const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const DEST_BAD = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48';
    const DEST_OTHER = DEST.toLowerCase().slice(0, -1) + '3';
    const SEED_ICP = 2000000000n;
    const SEED_ETH = 50000000000000n; // 0.00005 ckETH — below need: gasShort from the start
    const NEED_WEI = 93600000000000n; // fresh feeWei 7.8e13 + 20%
    const F = (n: bigint, d: number): string => {
      const s = BigInt(n).toString().padStart(d + 1, '0');
      return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '');
    };

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-crossrail-gas-fund');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, Number(SEED_ICP), {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, Number(SEED_ETH), {currency: 6});
      expect(fundEth.ok).toBe(true);

      // The fail-closed CCTP stub, then a MUTABLE balance layer on top (last wrap wins).
      installCctpStub({});
      const eth = installMutableEthBalance('0x' + SEED_ETH.toString(16));

      // §1 checksum at entry + the one-time re-type gate.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '5');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter', {timeoutMs: 3_000});
      await m.driver.click('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});

      // Shape-valid but checksum-bad: refused AT ENTRY, minimal line, no re-type ask yet.
      await m.driver.type('convert-dest-address', DEST_BAD);
      expect(await m.driver.waitForText('Checksum mismatch', {timeoutMs: 8_000})).toBe(true);
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);
      expect(m.driver.isPresent('convert-dest-reenter')).toBe(false);

      // Fix the one character: the ask becomes a one-time re-entry that must COMPARE.
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-dest-checksum'), {timeoutMs: 8_000, label: 'the checksum line cleared'});
      await m.driver.findByTestID('convert-dest-reenter', {timeoutMs: 5_000});
      await m.driver.type('convert-dest-reenter', DEST_OTHER);
      expect(await m.driver.waitForText('Does not match', {timeoutMs: 5_000})).toBe(true);
      await m.driver.type('convert-dest-reenter', DEST);
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-dest-reenter'), {timeoutMs: 8_000, label: 'the re-type gate passed'});
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination input warns this address also SIGNS the crossing');

      // §2 the offer card: Need ≈ / Your wallet: (one number per line).
      await m.driver.findByTestID('convert-gas-fund-card', {timeoutMs: 20_000});
      const card = m.driver.readText('convert-gas-fund-card');
      assertIncludes(card, `Need ≈ ${F(NEED_WEI, 18)} ETH`, 'the card names the need (fresh feeWei + headroom)');
      assertIncludes(card, `Your wallet: ${F(SEED_ETH, 18)} ETH`, 'the card names the measured have');
      expect(m.driver.isPresent('convert-gas-preflight')).toBe(false);
      expect(await isDisabled(m, 'btn-gas-fund-wallet')).toBe(false);
      expect(eth.reads()).toBeGreaterThanOrEqual(1);

      // §3 the self path: address, Send ≥, recheck names the shortfall, recheck returns.
      await m.driver.click('btn-gas-fund-self');
      expect(await m.driver.waitForText(`Send ≥ ${F(NEED_WEI, 18)} ETH`, {timeoutMs: 5_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-gas-fund-card'), DEST, 'the self path names the destination to fund');

      eth.set('0x' + 20000000000000n.toString(16));
      await m.driver.click('btn-gas-fund-recheck');
      expect(await m.driver.waitForText(`Still ${F(NEED_WEI - 20000000000000n, 18)} ETH short`, {timeoutMs: 10_000})).toBe(true);

      eth.set('0x' + 1000000000000000n.toString(16));
      await m.driver.click('btn-gas-fund-recheck');
      expect(await m.driver.waitForText('Your wallet: 0.001 ETH', {timeoutMs: 10_000})).toBe(true);

      // §4 the funded path: prepended legs, honest decline.
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.driver.click('btn-gas-fund-wallet');
      for (let round = 0; round < 5; round++) {
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        if (m.driver.isPresent('btn-gas-fund-wallet')) await m.driver.click('btn-gas-fund-wallet');
        else await m.driver.click('btn-convert-confirm');
      }
      await m.driver.findByTestID('convert-gas-legs-note', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-gas-legs-note'), 'fund the gas', 'the checklist names the gas legs');
      expect(await m.driver.findByTestID('convert-leg-6-state', {timeoutMs: 10_000}).then(() => true).catch(() => false)).toBe(true);
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      const ethAfter = BigInt(await getBalance(account!.publicHex, 6));
      expect(ethAfter > ethBefore).toBe(true);

      // Decline at awaiting_external on a gas-funded record: BOTH assets get their whereabouts.
      await m.driver.click('btn-crossrail-decline', {timeoutMs: 10_000});
      expect(await m.driver.waitForText('Nothing crossed', {timeoutMs: 10_000})).toBe(true);
      const failedCard = m.driver.readText('convert-failed-leg');
      assertIncludes(failedCard, DEST, 'the decline card names the USDC\'s address');
      assertIncludes(failedCard, 'still in this wallet', 'the decline card names where the gas funding sits');

      // Ledger truth: the funding left the wallet and the ckETH net position is UP.
      const icpAfter = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpAfter < SEED_ICP - 500000000n - 10000n).toBe(true);
      expect(icpAfter > 0n).toBe(true);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 200 — VCHF → SOL Route C with the whole venue chain named before anything signs', () => {
  it('names the chain at the picker + census, reads the floor as mid-stop, attributes the receipt', async () => {
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_HASH = '0x' + 'c7'.repeat(32);
    const SOL_OUT = '260000000';
    const SOL_FLOOR = '257000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The SOL rail must be CONFIGURED before boot (the e2e twin's setup({solStub:true})):
      // the mint-watch corroboration and the final leg ride the rail's own RPC path.
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-vchf-sol');
      const account = await accountOf(m);
      const fundVchf = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fundVchf.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // The deterministic venue + mint fixtures for THIS wallet.
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
      const txBytes = jupiterSwapTxB64(kp.address, ataString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
      let gross = BigInt(oracle0.amount_out);
      let minOut = floor99(gross);
      let fees = cctpFeeExpectations(minOut);
      const mintCredit = fees.mintFloor;

      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(mintCredit)});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: nativeDetail});
      await configureJupiterStub({
        quote: {outAmount: SOL_OUT, otherAmountThreshold: SOL_FLOOR, priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64: txBytes,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the composed route: explicit opt-in; the destination input renders on pick.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '10');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 10_000});
      await m.driver.click('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 10_000});
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the review census: full chain + the destination's own estimate (the fee lines land
      // async behind Details — wait for the census to mount before reading it).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-route-venues') && m!.driver.isPresent('crossrail-circle-fee'),
        {timeoutMs: 15_000, label: 'the census lines mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-route-venues'), 'Route: ICPSwap → Circle CCTP → Jupiter', 'the census names the FULL venue chain in one line');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      const floorLine = m.driver.readText('crossrail-mint-floor');
      assertIncludes(floorLine, `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee, in the HOP asset');
      assertIncludes(floorLine, 'crosses to your Solana address', 'the floor line reads USDC as the MID-STOP');
      assertIncludes(floorLine, 'final step swaps it on', 'the floor line names the onward swap');
      await m.driver.findByTestID('crossrail-dest-estimate', {timeoutMs: 10_000});
      const estimateLine = m.driver.readText('crossrail-dest-estimate');
      assertIncludes(estimateLine, '≈', 'the estimate is labeled an ESTIMATE, never a promise');
      assertIncludes(estimateLine, `${fmt(SOL_OUT, 9)} SOL`, 'the estimate names the DESTINATION asset and figure');
      assertIncludes(estimateLine, 'Jupiter', 'the estimate names the venue that will produce the fresh final quote');

      // Confirm (quote-changed interrupt → re-review).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
        gross = BigInt(re.amount_out);
        minOut = floor99(gross);
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff keeps the mid-stop phrasing.
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');
      assertIncludes(handoff, `${fmt(fees.mintFloor, 6)} USDC`, 'the handoff floor line carries the hop-asset figure');
      assertIncludes(handoff, 'crosses to your Solana address', 'the handoff floor line reads USDC as the MID-STOP');

      // The wallet double signs, the app attaches the reported hash.
      await m.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});

      // §4 the mint lands, then the final leg's offer.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-sol-out'),
        {timeoutMs: 15_000, label: 'the final leg\'s Jupiter estimate rendered'},
      );
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the final leg\'s fresh Jupiter estimate renders in SOL');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit');
      assertIncludes(done, kp.address, 'the Solana address is named');
      assertIncludes(m.driver.readText('crossrail-done-via'), 'ICPSwap, Circle and Jupiter', 'the done receipt attributes the conversion to all three');

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(0);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length).toBe(1);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(50000000000) - 1000000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(400000000000000) - GAS_WEI - CKETH_FEE);
    } finally {
      await restorePoolKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
