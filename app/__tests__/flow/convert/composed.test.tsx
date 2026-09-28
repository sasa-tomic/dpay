/**
 * composed — the jest twins of e2e/tests/{213,223}-convert-*.mjs (M2 batch C).
 *
 * Flow 213 convert-composed — the COMPOSED IC+CeFi conversion at the ONE consent press (the
 *   2-press grammar): VCHF → ICP (icpswap pool) → SideShift-EURC order → EURC. The sheet
 *   auto-picks the composed chain and discloses the venue + locked figure BEFORE the tap; the
 *   Convert press re-quotes fresh, creates the venue order exactly once and continues straight
 *   into the three signed legs; the deposit transfer moves EXACTLY the IC floor (books prove
 *   it); the tracker narrates the venue facts live; a reload resumes the payout watch without
 *   re-creating the order; the seeded v3 refusal paths (a past deposit window, an exact-amount
 *   corruption) land deposit_refused once with the leg frozen failed.
 * Flow 223 convert-cefi-eth — the EVM-NATIVE CeFi destination (ICP → native ETH through
 *   sideshift-eth), gated on the EVM rail being configured: the settle address is the device's
 *   OWN EVM identity (m/44'/60'/0'/0/0, EIP-55-checksummed, expected derived through the app's
 *   own SLIP-10 module), the payout rail is NAMED, the one consent creates exactly one venue
 *   order whose record carries the settle-rail provenance, reload resumes order-free, and the
 *   venue's own settled figures complete it.
 *
 * The store is read/written through the app's OWN AsyncStorage (RN-web maps it 1:1 onto
 * localStorage — the e2e twins probed the same bytes via window.localStorage).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  pickSwapTarget, typeConvertAmount, openOtherVenues,
} from '../harness/lib';
import {relayGet, relayBaseURL} from '../harness/relayClient';
import {
  disposeConvertStubs, enableSolRail, installSolRpcStub, installSideShiftStub, setSideShiftStatus,
  sideshiftRelayHits, deriveSolanaKeypair, deriveEvmKeypair, eip55,
} from './convertStubs';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_VCHF = 2000000000; // 20 VCHF
const VCHF_FEE = 10000n;
const ICP_FEE = 10000n;
const ETH_RAIL_ID = 'evm:native-eth';

type ConvertRecord = {
  step?: string;
  legPlan?: Array<{kind?: string; state?: string}>;
  legs?: unknown[];
  composedDeposit?: {sentTx?: unknown; amountRaw?: string; amountDecimal?: string; expiresAtMs?: number};
  venueId?: string;
  outLedger?: string;
  outSymbol?: string;
  outDecimals?: number;
  destAddress?: string;
  providerRef?: unknown;
  failureCode?: string;
  failureDetail?: string;
  failureDetailIncludes?: string;
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

/** Clone the real composed record parked just before the deposit leg; `patch` mutates it. */
async function seedComposedClone(
  publicHex: string,
  seedId: string,
  patch: (rec: ConvertRecord, now: number) => void,
): Promise<number> {
  const store = await storeRecords(publicHex);
  const tpl = Object.values(store).find((r) => r != null && r.composedDeposit != null);
  if (tpl == null) throw new Error('no composed record to clone');
  const rec = JSON.parse(JSON.stringify(tpl)) as ConvertRecord & Record<string, unknown>;
  delete rec.outAmountNet;
  for (const k of ['outTx', 'hopTx', 'destTx', 'failureCode', 'failureDetail', 'acknowledgedStuckAtMs'] as const) {
    delete rec[k];
  }
  delete rec.composedDeposit!.sentTx;
  rec.id = seedId;
  rec.step = 'approving';
  rec.createdAtMs = Date.now() + 5_000;
  rec.legPlan = rec.legPlan!.map((lp, i) => ({...lp, state: i < 2 ? 'confirmed' : 'pending'}));
  const now = Date.now();
  rec.legs = (rec.legs ?? []).map((l) => ({...(l as {expiresAtMs?: number}), expiresAtMs: now + 300_000}));
  patch(rec, now);
  store[seedId] = rec;
  await AsyncStorage().setItem(`dpay.convert.v3.${publicHex}`, JSON.stringify(store));
  return Object.keys(store).length;
}

/** Poll the store until the engine's gate has failed the seeded record. */
async function waitForFailure(publicHex: string, id: string, timeoutMs = 45_000): Promise<ConvertRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = await storeRecords(publicHex);
    if (store[id]?.failureCode != null) return store[id];
    if (Date.now() > deadline) throw new Error(`waitForFailure: ${id} never failed (step: ${store[id]?.step ?? 'absent'})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 213 — the composed IC+CeFi conversion at the ONE consent press', () => {
  it('creates the order once, signs three legs, narrates live, resumes, and refuses seeded corruption', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target is offerable only when its EURC(Solana) rail exists in the asset list.
      await enableSolRail();
      m = await onboardWallet('jest-convert-composed');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 7});
      expect(fund.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // The composed oracle: the IC leg's gross + floor, exactly what the order will price.
      const q1 = await relayGet(`/api/v1/swap_quote?pool=${POOL_VCHF_ICP}&token_in=${VCHF_LEDGER}&token_out=${ICP_LEDGER}&amount_in=200000000`) as {venue_id: string; amount_out: string};
      expect(q1.venue_id).toBe('icpswap');
      const gross1 = BigInt(q1.amount_out);
      const minOut1 = (gross1 / 10000n) * 9900n + ((gross1 % 10000n) * 9900n) / 10000n;
      const neg = minOut1.toString().padStart(9, '0');
      const depositDecimal = `${neg.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${neg.slice(-8).replace(/0+$/, '')}`;

      // §1 the 2-press happy path: auto-pick → entry facts → THE ONE consent press.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes('≈ 0.04 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive hero settled on the venue quote'},
      );
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick disclosure names the settle venue');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-route-via')?.includes('Swap VCHF → ICP on ICPSwap') === true,
        {timeoutMs: 15_000, label: 'the route named its IC leg'},
      );
      assertIncludes(m.driver.readText('convert-route-via'), 'to SideShift', 'the deposit line names the venue that will hold the order');
      assertIncludes(m.driver.readText('convert-route-via'), depositDecimal, 'the deposit line names the IC floor the order will price');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-quote-verbatim')?.includes('0.0495 EURC') === true,
        {timeoutMs: 15_000, label: 'the settle venue\'s verbatim quote in Details'},
      );
      await m.driver.click('convert-details', {timeoutMs: 5_000}); // close it again for the press

      // NOTHING is adopted before the consent: the store is still empty.
      let store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);

      // THE ONE CONSENT — order + three legs + live narration.
      const vchfBefore = BigInt(await getBalance(account!.publicHex, 7));
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-state', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-leg-2', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      const awaiting = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(awaiting, 'SideShift', 'the payout watch names the venue');
      assertIncludes(awaiting, depositDecimal, 'the deposit leg\'s copy names the sent amount');
      expect((await sideshiftRelayHits()).shiftCalls - hits0.shiftCalls).toBe(1);

      // The live narration: the venue's order facts, verbatim, attributed.
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-composed-order'), {timeoutMs: 15_000, label: 'the order line rendered'});
      assertIncludes(m.driver.readText('convert-composed-order'), 'SideShift', 'the order line names the venue');
      assertIncludes(m.driver.readText('convert-composed-order'), '0.0495', 'the order line carries the venue\'s LOCKED settle figure');
      assertIncludes(m.driver.readText('convert-composed-order-id'), SHIFT_ID, 'the venue\'s order id renders');
      assertIncludes(m.driver.readText('convert-composed-order-at'), 'SideShift', 'the locked figure is attributed to the venue');
      assertIncludes(m.driver.readText('convert-composed-deposit-amount'), depositDecimal, 'the exact-amount gate\'s figure is the floored amount');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-composed-deposit-address')?.includes(DEPOSIT_ADDRESS) === true,
        {timeoutMs: 15_000, label: 'the venue deposit address revealed live'},
      );

      // The record: awaiting_deposit, the deposit row's durable identity frozen on it.
      store = await storeRecords(account!.publicHex);
      const rec = Object.values(store).find((r) => r != null && r.composedDeposit != null);
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('awaiting_deposit');
      expect(rec!.composedDeposit!.sentTx != null).toBe(true);
      expect(rec!.legPlan!.length).toBe(3);
      expect(rec!.legPlan![2].kind).toBe('deposit_transfer');
      expect(rec!.composedDeposit!.amountDecimal).toBe(depositDecimal);

      // The books: VCHF debited amount + TWO input fees; ICP nets gross − floor − the fee.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(vchfBefore - 200000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross1 - minOut1 - ICP_FEE);

      // §2 reload: the payout watch resumes WITHOUT re-creating the order.
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      await openConvertFor(m, 'vchf', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);

      // §3 the venue settles: its own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-213'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, 'SideShift', 'done attributes the trade to the venue');

      // §4 the expired deposit window (seeded): the gate refuses ONCE, nothing re-signs.
      await seedComposedClone(account!.publicHex, 'seeded-expired-213', (clone, now) => {
        const bumped = (BigInt(clone.composedDeposit!.amountRaw!) + 1n).toString();
        clone.composedDeposit!.amountRaw = bumped;
        const negB = bumped.padStart(9, '0');
        clone.composedDeposit!.amountDecimal = `${negB.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${negB.slice(-8).replace(/0+$/, '')}`;
        clone.composedDeposit!.expiresAtMs = now - 1_000;
      });
      await m.remount();
      const failedWindow = await waitForFailure(account!.publicHex, 'seeded-expired-213');
      expect(failedWindow.failureCode).toBe('deposit_refused');
      assertIncludes(failedWindow.failureDetail ?? '', 'venue order expired', 'the refusal detail names the dead deposit window');
      expect(failedWindow.legPlan![2].state).toBe('failed');
      expect(failedWindow.legs!.length).toBe(3);

      // §5 the exact-amount corruption (seeded): the gate refuses before any signature.
      await seedComposedClone(account!.publicHex, 'seeded-amount-213', (clone) => {
        clone.composedDeposit!.amountRaw = (BigInt(clone.composedDeposit!.amountRaw!) + 1n).toString();
      });
      await m.remount();
      const failedAmount = await waitForFailure(account!.publicHex, 'seeded-amount-213');
      expect(failedAmount.failureCode).toBe('deposit_refused');
      assertIncludes(failedAmount.failureDetail ?? '', 'order amount', 'the refusal detail names the exact-amount invariant');
      expect(failedAmount.legPlan![2].state).toBe('failed');

      // The stub's order counter never moved past the ONE consented order.
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 223 — the EVM-native CeFi destination (ICP → native ETH via sideshift-eth)', () => {
  it('gates on the EVM rail, settles at the derived EVM identity, and locks the EVM facts', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EVM rail gate opens through the OPERATOR override (Settings ▸ Advanced, persisted —
      // App reads it at boot and it wins over jest.setup.js's empty test override; the e2e twin
      // deleted the override for the relay-derived path — the same configured-rail outcome).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Storage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};
      await Storage.setItem('dpay.evmRpc.v1', `${relayBaseURL()}/api/v1/evm/rpc`);

      m = await onboardWallet('jest-convert-cefi-eth');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 8});
      expect(fund.ok).toBe(true);

      // The settle address, derived INDEPENDENTLY through the app's own SLIP-10 module (the
      // app's derivation returns the lowercase form; the checksum is applied for display AND
      // as the order's settle address — pinned by app/__tests__/evm-identity.test.ts).
      const kp = deriveEvmKeypair(account!.secretHex);
      const expectedAddress = eip55(kp.address.toLowerCase());

      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the gated pick: the ETH target carries the sideshift-eth row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'ETH');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-sideshift-eth', {timeoutMs: 8_000});
      await m.driver.click('convert-venue-sideshift-eth', {timeoutMs: 5_000});
      await typeConvertAmount(m, '3');
      // The payout rail is NAMED before anything can be confirmed.
      await m.driver.findByTestID('convert-settle-rail', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-settle-rail'), 'Ethereum', 'the settle-rail line names Ethereum mainnet');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      assertIncludes(settle, expectedAddress, 'the payout address is the wallet\'s OWN derived EVM address');
      expect(settle.trim()).toBe(expectedAddress);
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 ETH') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');

      // NOTHING is adopted before the consent: the store is still empty.
      let store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);

      // §2 THE ONE CONSENT: order + deposit handoff verbatim.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue\'s deposit address renders VERBATIM');
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, '3', 'the EXACT deposit amount renders');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');

      // The partner-key audit + the record's provenance.
      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);
      store = await storeRecords(account!.publicHex);
      const rec = Object.values(store).find((r) => r != null && r.providerRef != null);
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('awaiting_deposit');
      expect(rec!.venueId).toBe('sideshift-eth');
      expect(rec!.outLedger).toBe(ETH_RAIL_ID);
      expect(rec!.outSymbol).toBe('ETH');
      expect(rec!.outDecimals).toBe(18);
      expect(rec!.destAddress).toBe(expectedAddress);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);

      // §3 reload: the payout watch resumes WITHOUT re-creating the order.
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);

      // §4 the venue settles: its own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'eth-settle-hash-223'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, 'ETH', 'done names the payout asset');
      assertIncludes(done, expectedAddress, 'done names the payout at the user\'s EVM address');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
