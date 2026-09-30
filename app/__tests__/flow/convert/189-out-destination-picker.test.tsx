/**
 * flow 189 (out-destination-picker) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
  pickSwapTarget,
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

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';

hermeticDescribe('flow 189 — the out-destination picker: SOL → EURC via jupiter-eurc', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('defaults unchanged, re-targets the pair on pick, and lands the realized EURC credit', async () => {
    const IN_LAMPORTS = '1000000000';
    const OUT_EURC = '84120000';
    const FLOOR_EURC = '83000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-sol-eurc');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_EURC), mint: EURC_MINT})});
      await configureJupiterStub({
        quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.003'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });


      // §1 the standing target is the registry-row-0 venue's other side (USD — flow 185's pair).
      await openConvertFor(m, 'sol');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'EUR');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → EUR', 'the heading names the picked pair');

      // §3 Jupiter's digits for the EURC pair, verbatim through the relay proxy.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Jupiter', 'attribution names the venue');
      expect(m.driver.readText('convert-venue-auto')).toMatch(/\d{1,2}:\d{2}/);
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('84.12 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '83 EURC', 'minimum is otherAmountThreshold verbatim');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-sol-impact'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '84.12', 'rate is the only derived figure');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure (shared key)');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      expect(m.driver.isPresent('convert-net')).toBe(false);
      assertIncludes(m.driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');

      // §4 confirm → one broadcast; §5 the realized EURC credit.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '84.12 EURC', 'done reports the realized token credit');
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
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_EURC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls;
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      // Pre-pick calls legitimately quote the STANDING pair; every post-pick call names EURC.
      const postPick = quoteCalls.filter((q) => q.outputMint === EURC_MINT && q.amount !== '5000000000');
      expect(postPick.length).toBeGreaterThanOrEqual(1);
      for (const q of postPick) {
        expect(q.inputMint).toBe(WRAPPED_SOL_MINT);
        expect(q.outputMint).toBe(EURC_MINT);
        expect(q.amount).toBe(IN_LAMPORTS);
        expect(q.slippageBps).toBe('100');
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});
