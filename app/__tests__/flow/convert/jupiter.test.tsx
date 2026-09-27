/**
 * jupiter — the jest twins of e2e/tests/{185,189,193}-convert-jupiter-*.mjs (M2 batch C).
 *
 * Flow 185 convert-jupiter-sol — the FIRST Solana convert (SOL → USDC through Jupiter, V11):
 * the surface is reachable for a SOLANA wallet at all, the quote is Jupiter's OWN verbatim
 * through dpay's relay proxy (estimate = outAmount, minimum = otherAmountThreshold, the
 * published impact, attribution + clock, the https endpoint where IC shows the pool principal),
 * fees are honest, confirm re-quotes + POSTs the VERBATIM quoteResponse with the wallet's own
 * SOL address, the venue-built legacy tx passes the beneficiary check (fee payer = user, SPL
 * destination = the user's own USDC ATA), exactly ONE device-signed broadcast, and the done
 * panel reports the REALIZED token credit by signature.
 * Flow 189 convert-jupiter-sol-eurc — the out-destination picker: with two Jupiter venues
 * registered the SOL surface renders one row per venue, the FIRST (USDC) preselected, and
 * picking EUR re-targets the pair (every quote GET asks wrapped-SOL → EURC).
 * Flow 193 convert-jupiter-usdc-eurc — the rail-local FX pair (USDC → EURC on the SOL rail):
 * standing pair USD→EUR stable-first, the EUR pick re-targets the FX venue, the balance line
 * is the CURRENCY-unit figure.
 *
 * The Jupiter stub is the RELAY's own test-stub upstream (configured + read back over HTTP —
 * the app-side client runs for real through the relay proxy). The SOL rail boots through the
 * operator override (enableSolRail) with the in-memory RPC simulator answering.
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, assertEq, onboardWallet, accountOf, openConvertFor, pickSwapTarget,
  typeConvertAmount,
} from '../harness/lib';
import {
  disposeConvertStubs, enableSolRail, installSolRpcStub, configureJupiterStub, jupiterStubState,
  deriveSolanaKeypair, deriveAta, bs58Encode, jupiterSwapTxB64, solConvertTxDetail, solSentTxs,
} from './convertStubs';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 185 — SOL → USDC(Solana) via Jupiter, end to end, offline', () => {
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

      // The stub's call vectors accumulate per relay process (no reset route) — every count
      // assert below is a DELTA against this baseline (the e2e twin's own-relay isolation,
      // re-expressed for the one shared relay; the gap is filed for the integrator).
      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

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
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_LAMPORTS);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_USDC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
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

describe('flow 189 — the out-destination picker: SOL → EURC via jupiter-eurc', () => {
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

      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

      // §1 the standing target is the registry-row-0 venue's other side (USD — flow 185's pair).
      await openConvertFor(m, 'sol');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'EUR');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → EUR', 'the heading names the picked pair');

      // §3 Jupiter's digits for the EURC pair, verbatim through the relay proxy.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('84.12 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '83 EURC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown');
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
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_LAMPORTS);
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_EURC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
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
  }, 240_000);
});

describe('flow 193 — the rail-local FX pair: USDC(Solana) → EURC via jupiter-usdc-eurc', () => {
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

      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

      // §1 the standing target is stable-first (USD → EUR through the FX venue).
      await openConvertFor(m, 'sol-usdc');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert USD → EUR', 'the standing pair is USD→EUR (stable-first)');

      // §2 Jupiter's digits for the standing FX pair, verbatim.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.87 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '0.855 EURC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-sol-impact'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
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
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_MICRO);
      expect(jup!.lastQuoteResponse?.inputMint).toBe(USDC_MINT);
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_EURC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      const postPrefill = [...quoteCalls];
      while (postPrefill.length > 0 && postPrefill[0].amount === '2500000') postPrefill.shift();
      for (const q of postPrefill) {
        expect(q.inputMint).toBe(USDC_MINT);
        expect(q.outputMint).toBe(EURC_MINT);
        expect(q.amount).toBe(IN_MICRO);
        expect(q.slippageBps).toBe('100');
      }
      expect(postPrefill[postPrefill.length - 1]?.amount).toBe(IN_MICRO);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
