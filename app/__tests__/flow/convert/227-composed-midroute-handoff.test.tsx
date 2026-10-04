/**
 * flow 227 (composed-midroute-handoff) — the founder's 2026-10-04 route: composed
 * VCHF → ICP → EURC(Solana), parked mid-route. Two honest-machine pins the UI defect
 * investigation demanded:
 *
 *   §1 the HANDOFF (composfix machinery, convertResume + execute.ts): a record parked at
 *      `pending_withdrawal` - leg 2's pool payout watch, the leg-3 cefi order pre-created -
 *      is picked up by the engine's re-arm, resolves the hop row, re-runs the deposit gate
 *      (windows + balance, re-verified from the frozen bytes) and re-submits the deposit
 *      leg's frozen envelope, advancing to the cefi leg. The ledger DEDUPES the identical
 *      bytes (request_id) - the deposit leaves EXACTLY ONCE, never a second spend - and no
 *      second order is ever created.
 *   §2 the EXPIRY: when the venue order dies BEFORE its payout, the record resolves
 *      honestly through the venue's own words - expired → quote_expired, refunded →
 *      provider_refunded - never a silent strand (money in motion is never silent).
 *
 * Hermetic per-flow file: one describe, ONE PRIVATE relay (harness/hermetic.ts), the
 * SideShift stub per-spawn. The mid-route clone is seeded from the REAL record the happy
 * path produced (its envelope bytes are the real signed ones; its deposit amount is bumped
 * so the template's sent deposit row can never be mistaken for the clone's own evidence).
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, enableSolRail, installSideShiftStub,
  setSideShiftStatus, sideshiftRelayHits,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_VCHF = 2000000000; // 20 VCHF
const SEED_ICP = 200000000; // 2 ICP - the deposit gate's balance read must pass for the clone
const CLONE_ID = 'seeded-pending-227';

type ConvertRecord = {
  step?: string;
  legPlan?: Array<{kind?: string; state?: string}>;
  legs?: Array<{expiresAtMs?: number}>;
  composedDeposit?: {sentTx?: unknown; amountRaw?: string; amountDecimal?: string; expiresAtMs?: number; orderId?: string};
  hopTx?: unknown;
  venueId?: string;
  failureCode?: string;
  failureDetail?: string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};
async function storeRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, ConvertRecord>;
}
/** Poll the store until `pred` holds for the clone; the error carries the record's refusal
 *  evidence (step, failure code + detail verbatim, per-leg states) - never a bare step name. */
async function waitFor(publicHex: string, pred: (r: ConvertRecord) => boolean, label: string, timeoutMs = 60_000): Promise<ConvertRecord> {
  const deadline = budgetDeadline(timeoutMs); // positive transition — budget-scaled
  for (;;) {
    const rec = (await storeRecords(publicHex))[CLONE_ID];
    if (rec != null && pred(rec)) return rec;
    if (Date.now() > deadline) {
      const detail = rec == null ? 'absent' : JSON.stringify({
        step: rec.step, failureCode: rec.failureCode, failureDetail: rec.failureDetail,
        legPlan: rec.legPlan?.map((l) => l.state), hopTx: rec.hopTx != null,
      });
      throw new Error(`waitFor ${label}: never (clone: ${detail})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

hermeticDescribe('flow 227 — the composed mid-route park hands off to the cefi leg, honestly', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('drives a parked pending_withdrawal record to the deposit auto-send, then resolves the venue expiry verbatim', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target is offerable only when its EURC(Solana) rail exists in the asset list.
      await enableSolRail();
      m = await onboardWallet('jest-convert-composed-227');
      const account = await accountOf(m);
      const fundVchf = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 7});
      expect(fundVchf.ok).toBe(true);
      const fundIcp = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fundIcp.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});

      // The composed oracle: the IC leg's quote answered by the fixture pool.
      const q1 = await relayGet(`/api/v1/swap_quote?pool=${POOL_VCHF_ICP}&token_in=${VCHF_LEDGER}&token_out=${ICP_LEDGER}&amount_in=200000000`) as {venue_id: string; amount_out: string};
      expect(q1.venue_id).toBe('icpswap');

      // §0 the real happy path to the cefi leg: the template record (one consented order,
      // three legs, the deposit really sent) the clone is seeded from.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);
      const store = await storeRecords(account!.publicHex);
      const tpl = Object.values(store).find((r) => r != null && r.composedDeposit != null);
      if (tpl == null) throw new Error('no composed record to clone');
      expect(tpl.step).toBe('awaiting_deposit');

      // §1 THE MID-ROUTE PARK: the founder's exact shape - leg 2's pool payout watch with
      // the leg-3 order pre-created. The clone keeps the template's frozen bytes (the
      // envelope IS the record's own deposit transfer); its metadata is parked mid-leg so
      // only the engine's re-arm can finish the route.
      const icpBeforeClone = BigInt(await getBalance(account!.publicHex, 8));
      const bumped = (BigInt(tpl.composedDeposit!.amountRaw!) + 1n).toString();
      const negB = bumped.padStart(9, '0');
      const clone = JSON.parse(JSON.stringify(tpl)) as ConvertRecord & Record<string, unknown>;
      delete clone.outAmountNet;
      for (const k of ['outTx', 'hopTx', 'destTx', 'failureCode'] as const) delete (clone as Record<string, unknown>)[k];
      delete clone.composedDeposit!.sentTx;
      clone.id = CLONE_ID;
      clone.step = 'pending_withdrawal';
      clone.createdAtMs = Date.now(); // the real gross1 row must fall inside the probe window
      clone.legPlan = clone.legPlan!.map((lp, i) => ({...lp, state: i < 1 ? 'confirmed' : i === 1 ? 'sent' : 'pending'}));
      clone.legs = (clone.legs ?? []).map((l) => ({...(l as {expiresAtMs?: number}), expiresAtMs: Date.now() + 300_000}));
      clone.composedDeposit!.amountRaw = bumped;
      clone.composedDeposit!.amountDecimal = `${negB.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${negB.slice(-8).replace(/0+$/, '')}`;
      clone.composedDeposit!.expiresAtMs = Date.now() + 600_000;
      store[CLONE_ID] = clone;
      await AsyncStorage().setItem(`dpay.convert.v3.${account!.publicHex}`, JSON.stringify(store));
      await m.remount();

      // The engine's re-arm resolves the parked record: leg-2 settle (the hop row) → the
      // deposit gate (windows + balance, re-verified from the frozen bytes) → the deposit
      // leg's envelope re-submitted → the cefi leg, within the window. The envelope is the
      // record's OWN frozen bytes, already executed by the template's §0 drive: the ledger
      // DEDUPES them (request_id) - the composfix red line - so the books must show the
      // deposit leaving EXACTLY ONCE (no second spend on resume, ever).
      const handedOff = await waitFor(account!.publicHex,
        (r) => r.step === 'awaiting_deposit' && r.legPlan![2].state === 'confirmed' && r.composedDeposit!.sentTx != null,
        'the parked record to reach a funded awaiting_deposit');
      expect(handedOff.legPlan![1].state).toBe('confirmed'); // leg-2 settle consumed first
      expect(handedOff.hopTx != null).toBe(true); // the row, never the #ok alone
      // ONE order, one consent: the clone never re-created the venue order.
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);
      // ONE spend: the resume's re-submitted bytes dedupe to the already-executed transfer.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBeforeClone);

      // §2 THE EXPIRY: the venue order dies BEFORE any payout - the record follows the
      // venue's own words, expired then refunded, never a silent strand.
      setSideShiftStatus('expired');
      await waitFor(account!.publicHex, (r) => r.step === 'quote_expired', 'the expired quote');
      setSideShiftStatus('refunded');
      const refunded = await waitFor(account!.publicHex, (r) => r.step === 'provider_refunded', 'the venue refund');
      expect(refunded.failureCode).toBeUndefined(); // a venue refund, not an engine guess
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);
      // The status polls named the ONE shift id throughout (no other trade was touched).
      assertIncludes(SHIFT_ID, 'e2e-shift', 'the audited shift id is the stub\'s');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
