/**
 * flow 223 (evm-native-cefi) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf,
  openConvertFor, typeConvertAmount, pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, venueKnob, installSideShiftStub, setSideShiftStatus,
  sideshiftRelayHits, deriveEvmKeypair, eip55,
} from './convertStubs';

installHeapProbe();
hermeticFlow();

const FIXTURE_VENUE = 'icpswap-fixture-b';

const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const SEED_VCHF = 2000000000; // 20 VCHF
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

hermeticDescribe('flow 223 — the EVM-native CeFi destination (ICP → native ETH via sideshift-eth)', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  beforeAll(async () => {
    await venueKnob(FIXTURE_VENUE, true);
  });
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
      expect(hits.bareCalls).toBe(0);
      expect(hits.shiftCalls).toBe(1);
      expect(hits.quoteCalls).toBeGreaterThanOrEqual(2);
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
  }, budgetScaled(300_000));
});
