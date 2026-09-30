/**
 * flow 209 (later-leg-stops) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installCctpStub, installSolRpcStub,
  configureJupiterStub, jupiterStubState, FORWARD_TX_HASH, deriveSolanaKeypair,
  deriveAta, bs58Encode, jupiterSwapTxB64, solConvertTxDetail,
  solSentTxs, installEvmSignSeam, setCctpMessageState, cctpStubState,
  enableSolRail, installSideShiftStub, sideShiftStubState, sideshiftRelayHits,
  deriveEvmKeypair, eip55,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SEED_ICP = 2000000000;
const SEED_ETH = 400000000000000;
const SHIFT_ID = 'e2e-shift-9c1d';

hermeticDescribe('flow 209 — the Stop on the later legs: crossing, sol_ready, and provider stops', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('stops honestly at each phase, freezes the watches, and stays aborted across a reload', async () => {
    const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
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
      await configureJupiterStub({
        quote: {outAmount: '260000000', otherAmountThreshold: '257000000', priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installEvmSignSeam(BURN_209);

      /** One Route C run up to a LIVE crossing (the 209 helper). The payout address is the
       *  wallet's OWN derived default — nothing to type (founder directive 2026-09-30). */
      const attachBurnAndGetCrossing = async (amountText: string): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await typeConvertAmount(m!, amountText).catch(() => undefined);
          await m!.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
          await m!.driver.waitForFunction(() => m!.driver.isPresent('convert-dest-shown'), {timeoutMs: 8_000, label: 'the payout default rendered'});
          expect(m!.driver.readText('convert-dest-shown')).toBe(eip55(deriveEvmKeypair(account!.secretHex).address.toLowerCase()));
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
            await new Promise((r) => setTimeout(r, budgetScaled(250)));
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
      assertIncludes(providerAborted, 'No deposit sent', 'the aborted card carries the unfunded-order truth');
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
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);

      const icpEnd = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpEnd).toBeLessThan(BigInt(SEED_ICP));
      expect((await jupiterStubState())!.swapCalls.length).toBe(0);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
