/**
 * flow 228 (composed-hop-skip) — the founder's 2026-10-04 finding, end to end: the wallet
 * holds BOTH VCHF and ICP, and the ICP already covers the composed VCHF → ICP → EURC
 * route's cefi deposit requirement. The route the founder got swapped 3.6+ VCHF into ICP
 * (pool fees paid) to produce money the wallet already held. The money rule now enforced
 * in prepare: a swap the existing balance makes unnecessary is NEVER signed.
 *
 * The pins, mirroring the founder's device:
 *   §1 the press on the composed row with a covering ICP balance adopts the LEGLESS cefi
 *      record (ICP in, EURC out) — the VCHF→ICP pool swap is never signed, and the deposit
 *      watcher funds the venue order from the wallet's own ICP. The census names the truth:
 *      the auto-deposit note (this wallet sends the ICP deposit) and the exact amount line.
 *   §2 the books: VCHF untouched (the founder's complaint, in balances), ICP debited exactly
 *      deposit + fee, ONE venue order.
 *   §3 the venue settles: the record lands done on the venue's own figures.
 *
 * Hermetic per-flow file: one describe, ONE PRIVATE relay (harness/hermetic.ts), the
 * SideShift stub per-spawn. The ICP seed is derived from the live pool oracle (the same
 * floor arithmetic prepare applies), so coverage is provable, not assumed.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget,
  openConvertDetails,
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
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_VCHF = 2000000000; // 20 VCHF
const ICP_FEE = 10000n;
const AMOUNT_VCHF = 200000000n; // the typed 2 VCHF

type ConvertRecord = {
  step?: string;
  legs?: unknown[];
  legPlan?: unknown;
  composedDeposit?: unknown;
  providerDeposit?: {depositAddress?: string; depositAmount?: string};
  providerRef?: {orderId?: string};
  depositSentAtMs?: number;
  inCurrency?: number;
  inSymbol?: string;
  amountIn?: string;
  venueId?: string;
  outSymbol?: string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
};
async function storeRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, ConvertRecord>;
}

hermeticDescribe('flow 228 — a covering hop balance retires the swap, the cefi leg draws from balance', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
  it('converts VCHF → EURC without signing the VCHF→ICP swap when the wallet ICP covers the deposit', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target is offerable only when its EURC(Solana) rail exists in the asset list.
      await enableSolRail();
      m = await onboardWallet('jest-convert-hop-skip');
      const account = await accountOf(m);
      const fundVchf = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 7});
      expect(fundVchf.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});

      // The composed oracle (flow 213's arithmetic): the pool's gross at the typed amount,
      // then the core's own 1% floor — the EXACT figure the venue order will price. The
      // ICP seed covers that floor + the transfer fee, with 1 ICP of margin so coverage
      // is a proven fact, never a fixture coincidence.
      const q1 = await relayGet(`/api/v1/swap_quote?pool=${POOL_VCHF_ICP}&token_in=${VCHF_LEDGER}&token_out=${ICP_LEDGER}&amount_in=${AMOUNT_VCHF.toString()}`) as {venue_id: string; amount_out: string};
      expect(q1.venue_id).toBe('icpswap');
      const gross1 = BigInt(q1.amount_out);
      const minOut1 = (gross1 / 10000n) * 9900n + ((gross1 % 10000n) * 9900n) / 10000n;
      const neg = minOut1.toString().padStart(9, '0');
      const depositDecimal = `${neg.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${neg.slice(-8).replace(/0+$/, '')}`;
      const seedIcp = minOut1 + ICP_FEE + 100000000n;
      const fundIcp = await faucetAccount(account!.publicHex, Number(seedIcp), {currency: 8});
      expect(fundIcp.ok).toBe(true);

      // §1 the founder's gesture: open Convert on VCHF, pick EUR, type the amount, press ONCE.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 15_000});
      const vchfBefore = BigInt(await getBalance(account!.publicHex, 7));
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});

      // The record is the LEGLESS cefi shape: the venue's deposit wait, auto-funded.
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      const awaiting = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(awaiting, 'SideShift', 'the handoff names the venue that holds the order');
      assertIncludes(awaiting, 'ICP', 'the source truth: the wallet\'s own ICP funds the deposit');
      await m.driver.findByTestID('convert-deposit-auto-note', {timeoutMs: 15_000});
      assertIncludes(
        m.driver.readText('convert-deposit-auto-amount'),
        depositDecimal,
        'the census names the EXACT deposit amount the auto-send moves',
      );

      // §2 THE BOOKS (the founder's complaint, in balances). The deposit send is the
      // watcher's own async leg — the evidence is the LEDGER, so the wait is on it: the
      // VCHF is UNTOUCHED (no approve pulled it, no swap produced ICP the wallet already
      // held) and the ICP paid exactly the order deposit + its transfer fee.
      const booksDeadline = budgetDeadline(30_000);
      for (;;) {
        const [vchfNow, icpNow] = await Promise.all([
          getBalance(account!.publicHex, 7),
          getBalance(account!.publicHex, 8),
        ]);
        if (BigInt(vchfNow) === vchfBefore && BigInt(icpNow) === icpBefore - minOut1 - ICP_FEE) break;
        if (Date.now() > booksDeadline) {
          throw new Error(`the books never settled (vchf: ${vchfNow} vs ${vchfBefore}; icp: ${icpNow} vs ${icpBefore - minOut1 - ICP_FEE})`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1); // ONE venue order

      // The store: a plain cefi record — no legs, no composed block, the hop asset as input.
      const store = await storeRecords(account!.publicHex);
      const recs = Object.values(store).filter((r) => r != null);
      expect(recs.length).toBe(1);
      const rec = recs[0]!;
      expect(rec.step).toBe('awaiting_deposit');
      expect(rec.legs).toEqual([]); // NOTHING was signed
      expect(rec.composedDeposit).toBeUndefined(); // no IC chain ever started
      expect(rec.venueId).toBe('sideshift-eurc');
      expect(rec.inCurrency).toBe(8);
      expect(rec.inSymbol).toBe('ICP');
      expect(rec.amountIn).toBe(minOut1.toString()); // the order's EXACT deposit figure
      expect(rec.outSymbol).toBe('EURC');
      expect(rec.providerDeposit?.depositAmount).toBe(depositDecimal);
      expect(rec.providerRef?.orderId).toBe(SHIFT_ID);
      expect(typeof rec.depositSentAtMs).toBe('number'); // the watcher took the deposit

      // §3 the venue settles: the record lands done on the venue's own figures.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-228'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, 'EURC', 'done names the settle asset');
      // The payout record folds under the receipt's Details (S4, spec 2026-10-04).
      await openConvertDetails(m);
      assertIncludes(m.driver.readText('convert-details-block'), 'sol-settle-sig-228', 'the payout record is the venue\'s settle hash');
      expect((await sideshiftRelayHits()).shiftCalls).toBe(1);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
