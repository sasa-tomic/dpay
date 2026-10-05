/**
 * flow 196 (gas-fund-card) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues, isDisabled,
} from '../harness/lib';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installCctpStub, installMutableEthBalance,
  deriveEvmKeypair, eip55,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

hermeticDescribe('flow 196 — the cross-rail gas-fund card', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
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

      // §1 the payout default + the editor's checksum and one-time re-type gates.
      // The derived address is confirmed by construction — shown, never typed, no re-type.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '5');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter', {timeoutMs: 3_000});
      await m.driver.click('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-dest-shown'), {timeoutMs: 8_000, label: 'the payout default rendered'});
      expect(m.driver.readText('convert-dest-shown')).toBe(eip55(deriveEvmKeypair(account!.secretHex).address.toLowerCase()));
      expect(m.driver.isPresent('convert-dest-reenter')).toBe(false);

      // The advanced control reveals the typed field, pre-filled with the derived address.
      await m.driver.click('btn-convert-dest-change');
      await m.driver.findByTestID('convert-dest-address', {timeoutMs: 5_000});

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
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also signs the crossing', 'the destination input warns this address also SIGNS the crossing');

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
      assertIncludes(failedCard, 'landed, untouched', 'the decline card names where the gas funding sits'); // copy-economy sweep: filler removed, fact kept;

      // Ledger truth: the funding left the wallet and the ckETH net position is UP.
      const icpAfter = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpAfter < SEED_ICP - 500000000n - 10000n).toBe(true);
      expect(icpAfter > 0n).toBe(true);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
