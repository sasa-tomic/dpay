/**
 * flow 193 (jupiter-usdc-eurc) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSolRpcStub, configureJupiterStub,
  jupiterStubState, deriveSolanaKeypair, deriveAta, bs58Encode,
  jupiterSwapTxB64, solConvertTxDetail, solSentTxs, enableSolRail,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';

hermeticDescribe('flow 193 — the rail-local FX pair: USDC(Solana) → EURC via jupiter-usdc-eurc', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('stands stable-first USD→EUR, re-targets on pick, and lands the realized EURC credit', async () => {
    const IN_MICRO = '1000000';
    const OUT_EURC = '870000';
    const FLOOR_EURC = '855000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-usdc-eurc');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_EURC), mint: EURC_MINT})});
      await configureJupiterStub({
        quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.000002'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });


      // §1 the standing target: the stable TWIN (USD → CHF) — since the chain widening
      // (2026-09-28) the twin CHF is reachable from the SOL rail (the cefi settle into ICP,
      // then the VCHF pool), so the categorical twin rule lands there; the rail-local FX
      // pair (USD → EUR) is one chip away and this flow's subject.
      await openConvertFor(m, 'sol-usdc');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert USD → CHF', 'the standing pair is the twin CHF (now reachable)');
      await m.driver.click('convert-target-chip-EUR', {timeoutMs: 8_000});
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-screen')?.includes('Convert USD → EUR') === true,
        {timeoutMs: 8_000, label: 'the pair re-targeted to the FX venue'},
      );

      // §2 Jupiter's digits for the standing FX pair, verbatim.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Jupiter', 'attribution names the venue');
      expect(m.driver.readText('convert-venue-auto')).toMatch(/\d{1,2}:\d{2}/);
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.87 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '0.855 EURC', 'minimum is otherAmountThreshold verbatim');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-sol-impact'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      // The retarget + prefill re-quote race: wait until the RENDERED census is the typed
      // amount's own quote (the rate line is the only out/in-derived figure), then pin it.
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-rate')?.includes('0.87') === true,
        {timeoutMs: 15_000, label: 'the rate line settled on the typed amount\u2019s quote'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '0.87', 'rate is the only derived figure (6→6 decimals)');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.000002', 'price impact is Jupiter\'s own figure, unmodified');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      expect(m.driver.isPresent('convert-net')).toBe(false);
      // Fork #4: the balance line is the CURRENCY-unit summed figure (USD across the rails).
      assertIncludes(m.driver.readText('convert-balance'), '$2.50', 'balance line is the currency-unit figure');

      // §4 confirm → one broadcast; §5 the realized EURC credit.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.87 EURC', 'done reports the realized token credit');
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
      // The typed amount is pinned by the quote-CALL audit below (the kept calls ARE the typed
      // ones); `lastQuoteResponse.inAmount/outAmount` are transport-order sensitive — the
      // retarget's prefill quote can LAND after the typed quote and make the stub's "last
      // response" the prefill's (observed 2026-09-29 gate 2). The typed-ness of the SERVED
      // state is pinned end-to-end: the rate/impact lines above render the typed quote, the
      // done panel reports its realized credit, and the kept quote calls below are the typed
      // pair at the typed amount. inputMint/outputMint/platformFee are stub-static for the pair.
      expect(jup!.lastQuoteResponse?.inputMint).toBe(USDC_MINT);
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls;
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      // Prefill-amount calls are stripped ANYWHERE in the transport order, not just the leading
      // run: the retarget commits its typed quote while the sheet's 1 s refresh tick may be one
      // event-loop turn behind the re-render, and that single-window tick still refreshes the
      // captured prefill amount before the superseded-amount guard sees the new text (the
      // product never SERVES that response — the late-echo guard drops it). What matters and is
      // asserted: at least one typed-amount call exists, every kept call is the typed pair at
      // the typed amount, and the LAST served response is the typed one (above).
      const postPrefill = quoteCalls.filter(q => q.amount !== '2500000');
      expect(postPrefill.length).toBeGreaterThanOrEqual(1);
      for (const q of postPrefill) {
        expect(q.inputMint).toBe(USDC_MINT);
        expect(q.outputMint).toBe(EURC_MINT);
        expect(q.amount).toBe(IN_MICRO);
        expect(q.slippageBps).toBe('100');
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
