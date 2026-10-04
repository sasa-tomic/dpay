/**
 * flow 230 (silent re-quote) — the S2 confirm lock (spec 2026-10-04-convert-ux-rework §2 S2).
 *
 * ONE rule everywhere: the displayed quote is the lock. The confirm re-quotes fresh at the
 * gesture exactly once; a move within 5% is market noise the confirm absorbs SILENTLY (it
 * proceeds from the fresh quote - no second tap); only a MATERIAL move (>5%) re-arms the
 * same button once, with the new figure inline. This pin holds both arms against the real
 * app tree + the prod-shaped relay, at the fee knob seam (never timing).
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount,
} from '../harness/lib';
import {relayPost} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {disposeConvertStubs, venueKnob} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
const SEED = 300000000; // 3 ICP
const BASE_FEE = 3000;

async function setPoolFee(millionths: number): Promise<void> {
  const a = await relayPost('/api/v1/test/swap_pool', {pool: POOL, fee_millionths: millionths});
  expect(a.ok).toBe(true);
  const b = await relayPost('/api/v1/test/swap_pool', {pool: POOL_B, fee_millionths: millionths});
  expect(b.ok).toBe(true);
}

hermeticDescribe('flow 230 - the confirm absorbs noise, re-arms once on a material move', () => {
  afterEach(() => {
    disposeConvertStubs();
  });
  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });

  it('a 1.7% fee move at confirm proceeds silently - no moved note, no second tap', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-requote-quiet');
      const account = await accountOf(m);
      expect((await faucetAccount(account!.publicHex, SEED, {currency: 8})).ok).toBe(true);
      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});

      // The venue's fee tier jumps 0.30% -> 2%: the quoted output drops ~1.7% - INSIDE the
      // 5% tolerance. The confirm must proceed from the fresh quote without a re-arm.
      await setPoolFee(20_000);
      await m.driver.click('btn-convert-confirm');
      const moved = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
      expect(moved).toBeNull();
      await m.driver.findByTestID('convert-state', {timeoutMs: 20_000});
    } finally {
      await setPoolFee(BASE_FEE);
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));

  it('a material move (>5%) re-arms the same button ONCE; the next confirm proceeds', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-requote-move');
      const account = await accountOf(m);
      expect((await faucetAccount(account!.publicHex, SEED, {currency: 8})).ok).toBe(true);
      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});

      // 0.30% -> 60%: the quoted output drops far past 5% - the ONE re-confirm arm.
      await setPoolFee(600_000);
      await m.driver.click('btn-convert-confirm');
      await m.driver.findByTestID('convert-moved-note', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-moved-note'), 'Price changed', 'the interrupt names what happened');
      assertIncludes(m.driver.readText('convert-moved-note'), 'Confirm again', 'the same button re-arms');
      expect(m.driver.isPresent('convert-state')).toBe(false); // nothing was adopted on the move

      // The ONE re-confirm: the displayed quote IS the fresh one - the gesture proceeds.
      await m.driver.click('btn-convert-confirm');
      const movedAgain = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
      expect(movedAgain).toBeNull();
      await m.driver.findByTestID('convert-state', {timeoutMs: 20_000});
    } finally {
      await setPoolFee(BASE_FEE);
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
