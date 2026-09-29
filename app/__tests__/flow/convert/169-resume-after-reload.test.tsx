/**
 * flow 169 (resume-after-reload) — hermetic per-flow file: one describe, ONE PRIVATE relay
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
import {deadline as budgetDeadline, scaled as budgetScaled} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
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

hermeticDescribe('flow 169 — a pending conversion survives an app reload; the engine drives it home', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('persists under the identity-scoped v3 key, resumes to done unmounted, never resurrects', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-resume');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Park the conversion on the honest pending (venue holds the output) — both pools, the
      // winner-derived gross, exactly flow 141's adaptation to the two-venue world.
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      await swapPoolKnob({pool: POOL_B, fail_withdrawal: true});
      const winPool = pickedPool(m);
      const executedGross = await swapQuoteOut(winPool);
      let parked = false;
      for (let round = 0; round < 5 && !parked; round++) {
        await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
        // Same concurrent-poll as flow 141: the moved interrupt can clear itself once the
        // refresh settles, so watch BOTH outcomes in one window (low host load observed
        // 2026-09-29 losing the sequential wait's race here too).
        const outcomeDeadline = budgetDeadline(20_000);
        for (;;) {
          if (m.driver.isPresent('convert-pending')) { parked = true; break; }
          if (m.driver.isPresent('convert-moved-note') || Date.now() > outcomeDeadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!parked && m.driver.readTextSafe('convert-moved-note') == null) break;
      }
      expect(parked).toBe(true);

      // The record persists under the IDENTITY-SCOPED key: read it from the app's own store.
      // (RN-web maps AsyncStorage 1:1 onto localStorage; the engine's advance and its persist
      // are two steps, so poll briefly instead of reading once.)
      const scopedKey = `dpay.convert.v3.${account!.publicHex}`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
      const readParked = async (): Promise<{step?: string; legs?: unknown[]} | null> => {
        const raw = await AsyncStorage.getItem(scopedKey);
        if (raw == null) return null;
        const all = JSON.parse(raw) as Record<string, {step?: string; legs?: unknown[]}>;
        const rec = Object.values(all)[0];
        return rec ?? null;
      };
      let rec: {step?: string; legs?: unknown[]} | null = null;
      for (let i = 0; i < 20; i++) {
        rec = await readParked();
        if (rec?.step === 'pending_withdrawal') break;
        await new Promise((r) => setTimeout(r, budgetScaled(250)));
      }
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('pending_withdrawal');
      expect(rec!.legs?.length).toBe(2);

      // --- the full reload: identity AND the scoped store survive (remount, no clear) ----------
      await m.remount();
      // Wallet (not onboarding) mounts the engine on load; the Convert screen is NEVER opened
      // from here on — only the engine can move the parked record.
      await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true});

      let resolved: {step?: string; outTx?: unknown} | null = null;
      const deadline = budgetDeadline(30_000); // positive transition (engine → done) — budget-scaled
      while (Date.now() < deadline) {
        const raw = await AsyncStorage.getItem(scopedKey);
        const all = raw == null ? {} : JSON.parse(raw) as Record<string, {step?: string; outTx?: unknown}>;
        const candidate = Object.values(all)[0] ?? null;
        if (candidate?.step === 'done') { resolved = candidate; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(resolved).not.toBeNull();
      expect(resolved!.outTx).not.toBeNull();
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(executedGross);

      // A terminal record is NOT resurrected: opening Convert shows the form, not a done panel.
      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 10_000});
      expect(await m.driver.findByTestID('convert-done', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(false);
      assertIncludes(m.driver.bodyText(), 'ICP', 'the convert form renders for the next conversion');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
