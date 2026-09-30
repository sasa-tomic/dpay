/**
 * flow 200 (route-c-vchf-sol) — hermetic per-flow file: one describe, ONE PRIVATE relay
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
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installCctpStub, installSolRpcStub,
  configureJupiterStub, jupiterStubState, cctpFeeExpectations, FORWARD_TX_HASH,
  deriveSolanaKeypair, deriveAta, bs58Encode, jupiterSwapTxB64,
  solConvertTxDetail, solSentTxs, fmt, floor99,
  installEvmSignSeam, setCctpMessageState, enableSolRail,
  deriveEvmKeypair, eip55,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;
const VCHF_FEE = 10000n;
type Quote = {venue_id: string; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

hermeticDescribe('flow 200 — VCHF → SOL Route C with the whole venue chain named before anything signs', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('names the chain at the picker + census, reads the floor as mid-stop, attributes the receipt', async () => {
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
      // The payout default: the wallet's OWN derived EVM address (founder directive 2026-09-30).
      const DEST = eip55(deriveEvmKeypair(account!.secretHex).address.toLowerCase());
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
      // The payout default: shown, never typed; no re-type arms (founder directive).
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-dest-shown'), {timeoutMs: 8_000, label: 'the payout default rendered'});
      expect(m.driver.readText('convert-dest-shown')).toBe(DEST);
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);
      expect(m.driver.isPresent('convert-dest-reenter')).toBe(false);
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
      assertIncludes(floorLine, 'the final step swaps it onward', 'the floor line reads USDC as the MID-STOP');
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
      assertIncludes(handoff, 'the final step swaps it onward', 'the handoff floor line reads USDC as the MID-STOP');

      // The wallet double signs, the app attaches the reported hash.
      await m!.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m!.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, budgetScaled(250)));
        }
      }
      await m!.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});

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
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
