/**
 * flow 185 (jupiter-sol-usdc) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSolRpcStub, configureJupiterStub,
  jupiterStubState, deriveSolanaKeypair, deriveAta, bs58Encode,
  jupiterSwapTxB64, solConvertTxDetail, solSentTxs, enableSolRail,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

hermeticDescribe('flow 185 — SOL → USDC(Solana) via Jupiter, end to end, offline', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('renders Jupiter\'s digits verbatim, POSTs the verbatim quote, broadcasts once, reports realized', async () => {
    const IN_LAMPORTS = '1000000000';
    const OUT_USDC = '10360000';
    const FLOOR_USDC = '10250000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-sol');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      // Prebuild the venue's deterministic reply for THIS wallet.
      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_USDC)})});
      await configureJupiterStub({
        quote: {outAmount: OUT_USDC, otherAmountThreshold: FLOOR_USDC, priceImpact: '0.003'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });

      // The stub's counters are ABSOLUTE: this file's hermetic relay serves nothing but this test.

      // §1 the surface is reachable for a SOLANA wallet at all (the V11 gate, now open).
      await openConvertFor(m, 'sol');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → USD', 'heading names the currency pair');
      expect(m.driver.isPresent('convert-venue-jupiter')).toBe(false);

      // §2 Jupiter's own digits, verbatim through the relay proxy.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      const quoteSource = m.driver.readText('convert-quote-source');
      assertIncludes(quoteSource, 'Jupiter', 'attribution names the venue');
      assertIncludes(quoteSource, 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('10.36 USDC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '10.25 USDC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');

      // The census folds behind Details; the fee-note + dpay lines are GONE.
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-pool-principal'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '10.36', 'rate is the only derived figure (BigInt, cross-decimal 9→6)');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown where IC shows the pool principal');
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'Jupiter', 'counterparty line names the venue');
      expect(counterparty.includes('aggregator')).toBe(false);
      assertIncludes(counterparty, 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure, unmodified');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      assertIncludes(m.driver.readText('convert-refusal'), 'SOL', 'refusal line names the input asset');
      expect(m.driver.isPresent('convert-net')).toBe(false);
      for (const bps of [50, 100, 300]) {
        expect(m.driver.isPresent(`convert-bps-${bps}`)).toBe(false);
      }
      assertIncludes(m.driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');

      // §4 confirm: re-quote, verbatim quoteResponse POST, beneficiary-checked venue tx, one broadcast.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);

      // §5 the done panel is honest: the REALIZED chain credit, payout by signature.
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '10.36 USDC', 'done reports the realized token credit');
      assertIncludes(done, 'Payout record:', 'done names the payout record');

      expect(solSentTxs().length).toBe(1);
      const sent = solSentTxs()[0];
      expect(sent.signature.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sent.signature)).toBe(true);
      assertIncludes(done, sent.signature, 'the payout record IS that signature');

      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(0);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_LAMPORTS);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_USDC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls;
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      // The sheet's Max prefill legitimately quotes the FULL balance on open; every quote AFTER
      // that prefill must be at the typed amount.
      const postPrefill = [...quoteCalls];
      while (postPrefill.length > 0 && postPrefill[0].amount === '5000000000') postPrefill.shift();
      for (const q of postPrefill) {
        expect(q.inputMint).toBe(WRAPPED_SOL_MINT);
        expect(q.outputMint).toBe(USDC_MINT);
        expect(q.amount).toBe(IN_LAMPORTS);
        expect(q.slippageBps).toBe('100');
      }
      expect(postPrefill[postPrefill.length - 1]?.amount).toBe(IN_LAMPORTS);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
