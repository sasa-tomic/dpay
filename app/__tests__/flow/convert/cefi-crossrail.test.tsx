/**
 * cefi-crossrail — the jest twins of e2e/tests/{186,197,198,209}-convert-*.mjs (M2 batch C).
 *
 * Flow 186 convert-crossrail-icp-sol — Route C as ONE intent (ICP → ckUSDC → USDC → SOL): the
 *   composed route is an explicit opt-in with the signer warning on the destination, the census
 *   names the external ETH gas + Circle's own fee + the mint floor, five device-signed IC legs,
 *   the CCTP burn is wallet-signed via the handoff (dpay never touches keys), a stalled
 *   attestation PARKS (never a false failure), a reload resumes from the mint watch without
 *   re-signing, and the final Jupiter leg lands realized SOL.
 * Flow 197 convert-sol-cefi-sideshift-eurc — the SAME surfaces on the OTHER rail: EURC(Solana)
 *   → ICP via sideshift-eurc from the SOL surface, the payout target is the wallet's OWN derived
 *   IC account identifier, the deposit is a HANDOFF (nothing ever broadcast on SOL), the order
 *   locks the figures (no exact-match gate), full provider lifecycle + reload resume.
 * Flow 198 convert-sol-cefi-trocador — the aggregator with NO keyless surface: EVERY venue call
 *   (rate, trade, status) rides the relay with the API key attached server-side (zero bare), the
 *   merged spot + venue sub-picker, derived IC payout target, fixed order, key-gated status
 *   lifecycle surviving a reload.
 * Flow 209 convert-abort-cefi — the Stop on the later legs: crossing stop (watching flavor, the
 *   ATA named, the Circle watch stops), sol_ready stop (clean, nothing signed), provider stop
 *   (the two-sided unfunded/deposit-sent truth + the shift id), reload keeps the records aborted
 *   with the poll loop frozen and the order never re-created.
 *
 * Relay-side stub counters (sideshift/trocador/jupiter upstreams) accumulate for the process —
 * count asserts are DELTAS against a per-test baseline (the e2e own-relay isolation, gap filed).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, assertEq, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues, isDisabled,
} from '../harness/lib';
import {
  disposeConvertStubs, enableSolRail, installSolRpcStub, installCctpStub, installSideShiftStub,
  setSideShiftStatus, sideShiftStubState, cctpStubState, setCctpMessageState,
  installEvmSignSeam, evmSignsRecorded,
  configureJupiterStub, jupiterStubState, cctpFeeExpectations, FORWARD_TX_HASH,
  deriveSolanaKeypair, deriveAta, bs58Encode, jupiterSwapTxB64, solConvertTxDetail, solSentTxs,
  icpAccountIdHex, sideshiftRelayHits, trocadorRelayHits, trocadorConfig, swapPoolKnob, fmt,
} from './convertStubs';
import {relayBaseURL, relayGet} from '../harness/relayClient';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const BURN_HASH = '0x' + '1b'.repeat(32);
const SHIFT_ID = 'e2e-shift-9c1d';
const DEPOSIT_ADDRESS_SIDESHIFT = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const DEPOSIT_ADDRESS_TROCADOR = 'e2e-trocador-deposit-01';
const SEED_ICP = 2000000000; // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{venue_id: string; amount_out: string}> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as {venue_id: string; amount_out: string};
}

/** Restore the hop pool after the cross-rail runs (the knob is global on the shared relay). */
async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: CKUSDC_POOL, fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 186 — Route C: ICP → SOL via USDC as one cross-rail intent', () => {
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
      const jup0 = await jupiterStubState();
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
          await new Promise((r) => setTimeout(r, 250));
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
      const cctpBeforeReload = cctpStubState();

      // §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.remount();
      // The window stubs live on globalThis and survive the remount (jest's one-context model).
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
      const readLegs = async (n: number): Promise<string[]> => {
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(m.driver.readText(`convert-leg-${i}-state`));
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
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const finalLegQuotes = jup!.quoteCalls.slice(jup0!.quoteCalls.length)
        .filter((q) => q.inputMint === USDC_MINT && q.outputMint === 'So11111111111111111111111111111111111111112');
      expect(finalLegQuotes.length).toBeGreaterThanOrEqual(1);
      expect(finalLegQuotes[finalLegQuotes.length - 1].amount).toBe(mintCredit.toString());
      const cctpAfter = cctpStubState();
      expect(cctpAfter.unexpected.length).toBe(0);
      expect(cctpBeforeReload.feesCalls + cctpAfter.feesCalls).toBeGreaterThanOrEqual(2);
      const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctpAfter.messageCalls];
      expect(allMessageCalls.length).toBeGreaterThanOrEqual(2);
      for (const msg of allMessageCalls) {
        expect(msg.hash).toBe(BURN_HASH);
      }
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP) - 500000000n - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 197 — EURC(Solana) → ICP via sideshift-eurc from the SOL surface', () => {
  it('offers the cefi target, pays at the derived IC identifier, hands off with zero broadcasts', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-eurc');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      const kp = deriveSolanaKeypair(account!.secretHex);
      expect(kp.address.length).toBeGreaterThanOrEqual(32);

      installSolRpcStub({refuseSend: true});
      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the standing target is stable-first USD; the ICP target carries the cefi venue.
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → USD', 'the standing pair is EUR→USD (stable-first)');

      // §2 the cefi target: derived payout address FIRST, venue quote verbatim.
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      const expectedSettleId = await icpAccountIdHex(account!.publicHex);
      expect(settle).toBe(expectedSettleId);
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'SideShift', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence: the deposit is a handoff');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'sideshift.ai/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the fixed ORDER; the handoff is the venue's address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_SIDESHIFT, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 EURC', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(m.driver.isPresent('convert-deposit-sol-fee-note')).toBe(true);
      expect(await m.driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit.
      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);

      // §5 the provider lifecycle.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      setSideShiftStatus('multiple');
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel.
      await m.remount();
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect((await sideshiftRelayHits()).shiftCalls).toBe(hits0.shiftCalls + 1);
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) >= 2,
        {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'},
      );

      // §7 settle → done with the realized figures at the user's own address.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'ic-settle-sig-197'});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 45_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC account identifier');
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 198 — SOL → ICP via the trocador aggregator: every venue call relay-borne', () => {
  it('sub-picks the service, locks a fixed order, drives the lifecycle through the relay status route', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-trocador');
      const account = await accountOf(m);
      const kp = deriveSolanaKeypair(account!.secretHex);
      installSolRpcStub({refuseSend: true});
      const hits0 = await trocadorRelayHits();

      // §1 the venue area: SideShift is the auto pick; Trocador waits behind the expander.
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → USD', 'the standing pair is SOL→USD (registry order)');
      await pickSwapTarget(m, 'ICP');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venue-trocador')).toBe(true);
      await m.driver.click('convert-venue-trocador', {timeoutMs: 3_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0496 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      expect(settle).toBe(await icpAccountIdHex(account!.publicHex));
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'Trocador', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'trocador.app/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the venue's ORDER; the handoff is the venue's own deposit address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_TROCADOR, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 SOL', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(await m.driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit: EVERY venue call rode the relay, key attached.
      const hits = await trocadorRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.tradeCalls - hits0.tradeCalls).toBe(1);
      expect(hits.rateCalls - hits0.rateCalls).toBeGreaterThanOrEqual(2);
      expect(hits.keyCalls).toBeGreaterThanOrEqual(hits.rateCalls + hits.tradeCalls - hits0.keyCalls);
      const tradeQuery = hits.lastTradeQuery ?? '';
      assertIncludes(tradeQuery, 'refund=', 'the trade request carried the refund address (the fund-loss guard)');
      assertIncludes(tradeQuery, 'min_kycrating=A', 'the non-KYC backends-only pin is relay-side');
      assertIncludes(tradeQuery, 'markup=0', 'the no-dpay-cut pin is relay-side');
      assertIncludes(tradeQuery, 'fixed=True', 'the trade is the venue\'s fixed-rate kind');

      // §5 the lifecycle THROUGH the key-gated relay status route.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      const statusCallsBefore = (await trocadorRelayHits()).statusCalls;
      expect(statusCallsBefore).toBeGreaterThanOrEqual(1);
      await trocadorConfig({status: 'Processing'});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel, still relay-fed.
      await m.remount();
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);
      const after = await trocadorRelayHits();
      expect(after.tradeCalls).toBe(hits0.tradeCalls + 1);
      expect(after.statusCalls).toBeGreaterThan(statusCallsBefore);

      // §7 settle → done with the realized figures at the user's own address.
      await trocadorConfig({status: 'Completed', amount_to: '0.0496', hashout: 'sol-settle-sig-198'});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 90_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0496 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC identifier');
      expect(kp.address.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 209 — the Stop on the later legs: crossing, sol_ready, and provider stops', () => {
  it('stops honestly at each phase, freezes the watches, and stays aborted across a reload', async () => {
    const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_209 = '0x' + '3c'.repeat(32);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-abort-cefi');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, SEED_ETH, {currency: 6});
      expect(fundEth.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: 2400000});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: nativeDetail});
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: '260000000', otherAmountThreshold: '257000000', priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installEvmSignSeam(BURN_209);

      /** One Route C run up to a LIVE crossing (the 209 helper). */
      const attachBurnAndGetCrossing = async (amountText: string): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await typeConvertAmount(m!, amountText).catch(() => undefined);
          await m!.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
          await m!.driver.type('convert-dest-address', DEST);
          await m!.driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
          await m!.driver.click('btn-convert-confirm');
          const changed = await m!.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
          if (changed == null) break;
          await m!.driver.click('btn-convert-back', {timeoutMs: 5_000}).catch(() => undefined);
        }
        await m!.driver.findByTestID('crossrail-handoff', {timeoutMs: 90_000});
        await m!.driver.waitForText('Step 1', {timeoutMs: 15_000});
        await m!.driver.type('crossrail-burn-tx', 'signed');
        for (let i = 0; i < 3; i++) {
          try {
            await m!.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
            break;
          } catch (e) {
            if (i === 2) throw e;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        await m!.driver.findByTestID('crossrail-crossing', {timeoutMs: 20_000});
      };

      // §B the CROSSING STOP: the burn is out — watching, never "nothing moved".
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      await m.driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
      await attachBurnAndGetCrossing('5');
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > 0,
        {timeoutMs: 15_000, label: 'the mint watch polls Circle at least once'},
      );
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      assertIncludes(m.driver.readText('btn-convert-stop'), 'Stop watching', 'the crossing stop is honestly labeled watching');
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const crossingAborted = m.driver.readText('convert-aborted');
      assertIncludes(crossingAborted, 'may still complete the mint', 'the crossing aborted card never claims nothing moved');
      assertIncludes(crossingAborted, ataString, 'the card names where the funds land: the user\'s OWN ATA');
      const pollsAtAbort = cctpStubState().messageCalls.length;
      await new Promise((r) => setTimeout(r, 2500));
      expect(cctpStubState().messageCalls.length - pollsAtAbort).toBe(0);

      // §C the SOL_READY STOP: the final leg was never signed — clean.
      await m.driver.click('btn-convert-back', {timeoutMs: 8_000});
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      await m.driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
      await attachBurnAndGetCrossing('5');
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 40_000});
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const readyAborted = m.driver.readText('convert-aborted');
      assertIncludes(readyAborted, 'Nothing was signed', 'the sol_ready stop is honestly CLEAN');
      assertIncludes(readyAborted, 'final swap never ran', 'the card names what was skipped');
      assertIncludes(readyAborted, ataString, 'the card names where the USDC sits');
      expect(solSentTxs().length).toBe(0);

      // §A the PROVIDER STOP on awaiting_deposit.
      const sideshift0 = await sideshiftRelayHits();
      installSideShiftStub({initialStatus: 'waiting'});
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      const icpBeforeCefi = BigInt(await getBalance(account!.publicHex, 8));
      await typeConvertAmount(m, '3');
      try {
        await m.driver.waitForFunction(
          () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 SOL') === true,
          {timeoutMs: 20_000, label: 'the cefi quote rendered before the confirm'},
        );
      } catch (e) {
        console.log('    [209-dbg] body:', JSON.stringify(m.driver.bodyText()).slice(0, 1200));
        throw e;
      }
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 15_000});
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) > 0,
        {timeoutMs: 15_000, label: 'the provider watch polls the venue at least once'},
      );
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const providerAborted = m.driver.readText('convert-aborted');
      assertIncludes(providerAborted, 'never sent the deposit', 'the aborted card carries the unfunded-order truth');
      assertIncludes(providerAborted, 'may still settle', 'the aborted card carries the deposit-already-sent truth');
      assertIncludes(providerAborted, SHIFT_ID, 'the venue shift id renders');
      expect(m.driver.isPresent('btn-convert-stop')).toBe(false);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBeforeCefi);

      // Reload: the records STAY aborted, the watch never comes back, the order is not re-created.
      await m.remount();
      const storeAfterReload = await AsyncStorage.getItem(`dpay.convert.v3.${account!.publicHex}`);
      expect(storeAfterReload).not.toBeNull();
      expect(storeAfterReload).toContain('"step":"aborted"');
      const pollsAtReload = sideShiftStubState()?.statusCalls.length ?? 0;
      await new Promise((r) => setTimeout(r, 2500));
      expect((sideShiftStubState()?.statusCalls.length ?? 0)).toBe(pollsAtReload);
      expect((await sideshiftRelayHits()).shiftCalls - sideshift0.shiftCalls).toBe(1);

      const icpEnd = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpEnd).toBeLessThan(BigInt(SEED_ICP));
      expect((await jupiterStubState())!.swapCalls.length - jup0!.swapCalls.length).toBe(0);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
