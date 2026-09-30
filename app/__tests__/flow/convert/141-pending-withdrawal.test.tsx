/**
 * flow 141 (pending-withdrawal) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, swapPoolKnob, venueKnob,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // the fixture venue's pool (file runs venue-armed)
const SEED = 300000000; // 3 ICP
const AMOUNT_IN = 100000000n; // 1 ICP
/** The pool the sheet's auto pick is executing through (real vs fixture — the file runs in the
 *  two-venue world, and the real pool's edge over the fixture flips as its state drifts). */
function pickedPool(m: Awaited<ReturnType<typeof onboardWallet>>): string {
  return (m.driver.readTextSafe('convert-venue-auto') ?? '').includes('offline fixture') ? POOL_B : POOL;
}
async function swapQuoteOut(pool: string): Promise<bigint> {
  const q = await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`) as {amount_out: string};
  return BigInt(q.amount_out);
}

hermeticDescribe('flow 141 — pool #ok with a held withdrawal is an honest pending_withdrawal', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('parks honest, names the asset + pool + support recipe, resolves in place, credits exactly', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-pending');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});

      // Hold the venue's output leg BEFORE confirming (BOTH pools — the pick follows the live
      // quotes in the two-venue world); re-read the winning pool's quote right before arming so
      // the confirm re-quote matches the number the screen shows.
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      await swapPoolKnob({pool: POOL_B, fail_withdrawal: true});
      const winPool = pickedPool(m);
      let executedGross = await swapQuoteOut(winPool);
      let pending = false;
      for (let round = 0; round < 5 && !pending; round++) {
        await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
        // EITHER outcome can land first, and the moved interrupt can CLEAR itself once the
        // refresh settles (the sheet re-quotes and re-arms the confirm) — so poll both states
        // in ONE window; a sequential wait-for-pending-then-read-the-note loses that race at
        // low host load (observed 2026-09-29: 5 empty rounds, note read null after the fact).
        const outcomeDeadline = budgetDeadline(20_000);
        for (;;) {
          if (m.driver.isPresent('convert-pending')) { pending = true; break; }
          if (m.driver.isPresent('convert-moved-note') || Date.now() > outcomeDeadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!pending) {
          const changed = m.driver.readTextSafe('convert-moved-note');
          if (changed != null) {
            // Shared-pool drift tripped the confirm re-quote — re-read and re-confirm.
            executedGross = await swapQuoteOut(winPool);
            continue;
          }
          break;
        }
      }
      expect(pending).toBe(true);
      const pendingBody = m.driver.readTextSafe('convert-pending')
        ?? `(no convert-pending after 5 confirm rounds — on screen: ${m.driver.bodyText().slice(0, 400)})`;
      assertIncludes(pendingBody, 'Payout pending', 'pending title');
      assertIncludes(pendingBody, 'VCHF', 'pending names the asset owed');
      assertIncludes(pendingBody, winPool, 'pending names the pool principal (support line)');
      assertIncludes(pendingBody, 'quote this to support', 'the practical support recipe stays');
      assertIncludes(pendingBody, 'watching', 'it keeps watching (no dead end)');
      expect(m.driver.bodyText()).not.toContain('Converted');

      // The VCHF is NOT credited while held.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(0n);

      // Resolution: drain the venue's queue → the screen flips to done on its own.
      await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 30_000})).toBe(true);
      const doneBody = m.driver.readText('convert-done');
      assertIncludes(doneBody, 'VCHF', 'done names the asset received');

      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(executedGross);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(180_000));
});
