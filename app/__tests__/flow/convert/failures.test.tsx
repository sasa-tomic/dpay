/**
 * failures — the jest twins of e2e/tests/{191,192,195}-convert-*.mjs (M2 batch C).
 *
 * Flow 191 convert-approve-refused — the approve REFUSAL is a clean, surfaced failure: the
 *   fake-IC approve_fail knob (AllowanceChanged{0}, the exact 2026-09-19 live-defect shape)
 *   refuses the FIRST icrc2_approve; the engine decodes it natively and lands the TERMINAL
 *   failed card ("Swap not executed", the approve-refusal body naming the asset) — never an
 *   endless Approving spinner, never stuck; the ledger stays byte-whole.
 * Flow 192 convert-abort — the user's Stop during a LIVE swap: the fake-IC reply-delay knob
 *   holds the depositFromAndSwap reply for 12 s; in that window the record is watching ("Stop
 *   watching"), the Stop lands the TERMINAL aborted card whose watching flavor says the swap
 *   may still go through, and no Stop control remains.
 * Flow 195 convert-crossrail-icp-eurc — Route C generalized to a REGISTERED SPL token (ICP →
 *   EURC via USDC): the EURC route composes beside the SOL one, the CCTP chain is
 *   byte-identical, the reload resumes from the mint watch, and the final Jupiter leg quotes
 *   USDC→EURC on the verified credit, pins the device's own EURC ATA, and lands realized EURC
 *   — no "EURC EURC" double-unit anywhere.
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {
  disposeConvertStubs, enableSolRail, installSolRpcStub, installCctpStub,
  installEvmSignSeam, evmSignsRecorded, configureJupiterStub, jupiterStubState, cctpFeeExpectations,
  FORWARD_TX_HASH, deriveSolanaKeypair, deriveAta, bs58Encode, jupiterSwapTxB64,
  solConvertTxDetail, solSentTxs, setCctpMessageState, cctpStubState, icDelayKnob,
  approveFailKnob, swapPoolKnob, fmt, floor99,
} from './convertStubs';
import {relayGet} from '../harness/relayClient';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const SEED_ICP = 300000000; // 3 ICP
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';

async function restoreIcDelay(): Promise<void> {
  try {
    await icDelayKnob('depositFromAndSwap', 0);
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: CKUSDC_POOL, fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 191 — the approve refusal is a terminal failed card, never a stuck spinner', () => {
  it('surfaces the refusal, names the asset, and leaves the ledger byte-whole', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-approve-refused');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Arm the approve_fail knob (AllowanceChanged{0}, the live-defect shape; one refusal).
      await approveFailKnob(ICP_LEDGER);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      // A green here PROVES the panel left the Approving spinner: the old bug rendered it for
      // the full 5-minute envelope window and only then flipped to stuck.
      expect(await m.driver.findByTestID('convert-failed', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect(await m.driver.findByTestID('convert-stuck', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);

      const failedBody = m.driver.readText('convert-failed');
      expect(failedBody.includes('Swap not executed')).toBe(true);
      expect(failedBody.includes('ICP') && failedBody.includes('refused the approval')).toBe(true);
      expect(failedBody.includes('nothing moved') || failedBody.includes('No allowance was created')).toBe(true);
      expect(failedBody.includes('Approving')).toBe(false);

      // The ledger is byte-whole: a refused approve charges no fee and moves nothing.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 192 — the Stop during a LIVE swap aborts honestly', () => {
  it('labels the in-flight window watching, stops to the terminal card, and removes the control', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-abort');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // The swap reply stays pending 12 s — the deterministic in-flight window.
      await icDelayKnob('depositFromAndSwap', 12_000);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      expect(await m.driver.findByTestID('convert-swapping', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('btn-convert-stop'), 'Stop watching', 'the watching flavor labels the button');

      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000}).then(() => true).catch(() => false)).toBe(true);
      const abortedBody = m.driver.readText('convert-aborted');
      expect(abortedBody.includes('The swap may still go through')).toBe(true);
      expect(await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await restoreIcDelay();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 195 — Route C generalized: ICP → EURC via USDC as one cross-rail intent', () => {
  it('composes the EURC route, hands off keyless, resumes, and lands EURC without double units', async () => {
    const ROUTE_C_SOL_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const ROUTE_C_EURC_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_HASH = '0x' + '2c'.repeat(32);
    const EURC_OUT = '10300000';
    const EURC_FLOOR = '10200000';
    const SOL_OUT = '260000000';
    const SOL_FLOOR = '257000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-icp-eurc');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, 2000000000, {currency: 8}); // 20 ICP
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // Prebuild the deterministic venue + mint fixtures for THIS wallet (the EURC leg pays
      // out at the USER'S OWN EURC ATA — the app's beneficiary check re-derives it).
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const eurcAtaString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, eurcAtaString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayGet(`/api/v1/swap_quote?pool=${CKUSDC_POOL}&token_in=${ICP_LEDGER}&token_out=${CKUSDC_LEDGER}&amount_in=500000000`) as {amount_out: string};
      let gross = BigInt(oracle0.amount_out);
      let minOut = floor99(gross);
      let fees = cctpFeeExpectations(minOut);
      const mintCredit = fees.mintFloor;

      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(mintCredit)});
      const eurcDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: eurcAtaString, outAmount: Number(EURC_OUT), mint: EURC_MINT, decimals: 6});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: eurcDetail});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: EURC_OUT, otherAmountThreshold: EURC_FLOOR, priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the EURC route composes beside the CeFi venue; the original SOL route still exists.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      expect(await m.driver.findByTestID(ROUTE_C_SOL_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await pickSwapTarget(m, 'EUR');
      expect(await m.driver.findByTestID(ROUTE_C_EURC_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await m.driver.click(ROUTE_C_EURC_ROW);
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination warns that this address also SIGNS the crossing');
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the census (unchanged from the SOL route, USDC-denominated).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-circle-fee') && m!.driver.isPresent('crossrail-mint-floor'),
        {timeoutMs: 15_000, label: 'the cross-rail census mounted'},
      );
      assertIncludes(m.driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      assertIncludes(m.driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(78000000000000n, 18)} ETH`, 'the minter gas line is unchanged from Route A');

      // Confirm (quote-changed interrupt → re-review).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayGet(`/api/v1/swap_quote?pool=${CKUSDC_POOL}&token_in=${ICP_LEDGER}&token_out=${CKUSDC_LEDGER}&amount_in=500000000`) as {amount_out: string};
        gross = BigInt(re.amount_out);
        minOut = floor99(gross);
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff (byte-identical CCTP chain — the burn cannot tell the destinations apart).
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      expect(m.driver.isPresent('crossrail-handoff')).toBe(true);
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
      assertIncludes(m.driver.readText('crossrail-approve-calldata').slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
      assertIncludes(m.driver.readText('crossrail-burn-calldata').slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');

      // The wallet double signs; the app attaches the reported hash.
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
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 10_000});

      // §4 the mint watch parks honestly.
      const sigs = evmSignsRecorded();
      expect(sigs.length).toBe(1);
      expect(String(sigs[0].amountSubunits)).toBe(minOut.toString());
      const pollsAtStall = cctpStubState().messageCalls.length;
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > pollsAtStall,
        {timeoutMs: 15_000, label: 'the mint watch polls again while parked'},
      );
      expect(m.driver.isPresent('crossrail-crossing')).toBe(true);
      const cctpBeforeReload = cctpStubState();

      // §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-leg-5-state'), {timeoutMs: 15_000, label: 'the six-leg list rendered'});
      for (let i = 0; i < 5; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `after reload IC leg ${i} reads Confirmed (resumed, not re-signed)`);
      }
      assertIncludes(m.driver.readText('convert-leg-5-state'), 'Sent', 'the cctp_burn leg reads Sent');
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(ethBefore);

      // §6 the mint lands, then the EURC leg offers on a FRESH quote.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('crossrail-sol-out'), {timeoutMs: 15_000, label: 'the final leg\'s estimate rendered'});
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders');
      assertIncludes(ready, ataString, 'the USDC location is named: the user\'s own ATA');
      assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(EURC_OUT, 6), 'the fresh Jupiter estimate renders in EURC units');
      assertIncludes(ready, `${fmt(EURC_FLOOR, 6)} EURC`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold, named EURC');
      expect(ready.includes('EURC EURC')).toBe(false);
      assertIncludes(m.driver.readText('btn-crossrail-sol-confirm'), 'Swap to EURC', 'the confirm button names the destination token');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(EURC_OUT, 6)} EURC`, 'done reports the REALIZED EURC credit');
      expect(done.includes('EURC EURC')).toBe(false);
      assertIncludes(done, kp.address, 'the Solana address is named');
      for (let i = 0; i < 7; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `final leg ${i} of 7 reads Confirmed`);
      }

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const eurcLegQuotes = jup!.quoteCalls.slice(jup0!.quoteCalls.length)
        .filter((q) => q.inputMint === USDC_MINT && q.outputMint === EURC_MINT);
      expect(eurcLegQuotes.length).toBeGreaterThanOrEqual(1);
      expect(eurcLegQuotes[0].amount).toBe(mintCredit.toString());
      const cctpAfter = cctpStubState();
      expect(cctpAfter.unexpected.length).toBe(0);
      expect(cctpBeforeReload.feesCalls + cctpAfter.feesCalls).toBeGreaterThanOrEqual(2);
      const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctpAfter.messageCalls];
      expect(allMessageCalls.length).toBeGreaterThanOrEqual(2);
      for (const msg of allMessageCalls) {
        expect(msg.hash).toBe(BURN_HASH);
      }
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(2000000000) - 500000000n - 2n * 10000n);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - 10000n);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(400000000000000) - 78000000000000n - 2000000000000n);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
