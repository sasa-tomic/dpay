/**
 * flow 186 (route-c-icp-sol) — hermetic per-flow file: one describe, ONE PRIVATE relay
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
  solConvertTxDetail, solSentTxs, fmt, installEvmSignSeam,
  evmSignsRecorded, setCctpMessageState, cctpStubState, enableSolRail,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const SEED_ICP = 2000000000;
const SEED_ETH = 400000000000000;
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;
const BURN_HASH = '0x' + '1b'.repeat(32);
type Quote = {venue_id: string; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

hermeticDescribe('flow 186 — Route C: ICP → SOL via USDC as one cross-rail intent', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('hands off keyless, parks honestly on a stall, resumes from the mint watch, lands SOL', async () => {
    const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const SOL_OUT = '260000000';
    const SOL_FLOOR = '257000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-icp-sol');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, SEED_ETH, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // Prebuild the deterministic venue + mint fixtures for THIS wallet.
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
      let gross = BigInt(oracle0.amount_out);
      let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
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
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the composed route is an explicit opt-in row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      expect(await m.driver.findByTestID(ROUTE_C_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await m.driver.click(ROUTE_C_ROW);
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination input warns that this address also SIGNS the crossing');
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the cross-rail fee census (the census lines mount behind Details).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-external-gas') && m!.driver.isPresent('crossrail-circle-fee') && m!.driver.isPresent('crossrail-mint-floor'),
        {timeoutMs: 15_000, label: 'the cross-rail census mounted'},
      );
      assertIncludes(m.driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      assertIncludes(m.driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the minter gas line is unchanged from Route A');

      // Confirm (quote-changed interrupt → re-review, re-deriving the oracle after a move).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
        gross = BigInt(re.amount_out);
        minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff: five device-signed IC legs, then dpay renders the EXACT txs.
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      expect(m.driver.isPresent('crossrail-handoff')).toBe(true);
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
      const approveData = m.driver.readText('crossrail-approve-calldata');
      const burnData = m.driver.readText('crossrail-burn-calldata');
      assertIncludes(approveData.slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
      assertIncludes(burnData.slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook');
      assertIncludes(handoff, 'seconds to a few minutes', 'the timing note sets the honest expectation');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');

      // The wallet double signs, the app attaches the reported hash.
      await m.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, budgetScaled(250)));
        }
      }
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 10_000});

      // §4 the mint watch: parked pending with Circle's link — never a false failure.
      const crossing = m.driver.readText('crossrail-crossing');
      assertIncludes(crossing, 'Crossing to Solana', 'the crossing panel titles the wait');
      assertIncludes(crossing, BURN_HASH, 'the burn tx hash is visible and copyable');
      assertIncludes(m.driver.readText('crossrail-still'), 'not failed', 'the not-failed line is explicit');
      expect(m.driver.isPresent('btn-crossrail-view-circle')).toBe(true);
      expect(m.driver.isPresent('btn-crossrail-view-burn')).toBe(true);
      const sigs = evmSignsRecorded();
      expect(sigs.length).toBe(1);
      assertIncludes(String(sigs[0].burnCalldata).slice(0, 10), '0x779b432d', 'what dpay asked the wallet to sign IS the burn calldata');
      assertIncludes(String(sigs[0].approveCalldata).slice(0, 10), '0x095ea7b3', '…and the approve calldata');
      expect(String(sigs[0].burnTo).toLowerCase()).toContain('28b5a0e9c621a5badaa536219b3a228c8168cf5d');
      expect(String(sigs[0].approveTo).toLowerCase()).toContain('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      expect(String(sigs[0].amountSubunits)).toBe(minOut.toString());

      // The STALL: state still pending — the record must stay parked, not failed.
      const pollsAtStall = cctpStubState().messageCalls.length;
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > pollsAtStall,
        {timeoutMs: 15_000, label: 'the mint watch polls again while parked'},
      );
      expect(m.driver.isPresent('crossrail-crossing')).toBe(true);

      // §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.remount();
      // The window stubs live on globalThis and survive the remount (jest's one-context model).
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
      const readLegs = async (n: number): Promise<string[]> => {
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(m!.driver.readText(`convert-leg-${i}-state`));
        return out;
      };
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-leg-5-state'),
        {timeoutMs: 15_000, label: 'the six-leg list rendered after the resume'},
      );
      const legsAfterReload = await readLegs(6);
      for (let i = 0; i < 5; i++) {
        assertIncludes(legsAfterReload[i], 'Confirmed', `after reload IC leg ${i} reads Confirmed (resumed, not re-signed)`);
      }
      assertIncludes(legsAfterReload[5], 'Sent', 'the cctp_burn leg reads Sent (hash known, mint watched)');
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(ethBefore);

      // §6 the mint lands: Circle reports complete, dpay CORROBORATES at the ATA, then SOL.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('crossrail-sol-out'), {timeoutMs: 15_000, label: 'the final leg\'s estimate rendered'});
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders (corroborated at the ATA)');
      assertIncludes(ready, ataString, 'the USDC location is named: the user\'s own ATA');
      assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the fresh Jupiter estimate renders (SOL now, not USDC)');
      assertIncludes(ready, `${fmt(SOL_FLOOR, 9)} SOL`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit');
      assertIncludes(done, kp.address, 'the Solana address is named');
      for (let i = 0; i < 7; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `final leg ${i} of 7 reads Confirmed`);
      }

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(0);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length).toBe(1);
      const finalLegQuotes = jup!.quoteCalls
        .filter((q) => q.inputMint === USDC_MINT && q.outputMint === 'So11111111111111111111111111111111111111112');
      expect(finalLegQuotes.length).toBeGreaterThanOrEqual(1);
      expect(finalLegQuotes[finalLegQuotes.length - 1].amount).toBe(mintCredit.toString());
      const cctpAfter = cctpStubState();
      expect(cctpAfter.unexpected.length).toBe(0);
      expect(cctpAfter.feesCalls).toBeGreaterThanOrEqual(2);
      const allMessageCalls = cctpAfter.messageCalls;
      expect(allMessageCalls.length).toBeGreaterThanOrEqual(2);
      for (const msg of allMessageCalls) {
        expect(msg.hash).toBe(BURN_HASH);
      }
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP) - 500000000n - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
