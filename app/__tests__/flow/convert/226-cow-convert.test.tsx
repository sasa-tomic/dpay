/**
 * flow 226 (cow-convert) — the SECOND EVM venue's money-path pin, hermetic per-flow file:
 * ONE PRIVATE relay (harness/hermetic.ts) whose CoW order-API proxy is pointed at its own
 * /api/v1/test/cow-upstream stub (flowRelay.ts's DPAY_COW_API_BASE), and the EVM chain legs
 * riding the convertStubs EVM RPC stub (the swap-typing stage-2 simulator, chain-1 shape).
 *
 * What is REAL here: the mounted app tree, the app's own record store + resume engine (the
 * sweep at mount drives every non-terminal record), the real clients (the order API through
 * the relay's /api/v1/cow/mainnet/* proxy — the app never sees the stub address), the real
 * wasm core and the real device cryptography (prepare + the deterministic order re-sign).
 * What is STUBBED: only external transports — the venue upstream (relay knob, the sideshift
 * pattern) and the chain RPC (the simulator).
 *
 * Arms (the money-path pin contract): (a) the happy run — approve → submit → poll →
 * fulfilled → native-out unwrap → done, with the UID frozen at submit; (b) kill/restart
 * mid-run — a record parked at `settling` with its uid + approveTxHash frozen completes
 * under the RESUMED engine; (c) an unknown/slow arm — a sticky `open` order hands the run
 * back to the watcher, the record stays honestly non-terminal, and the polls keep landing
 * on the venue through the relay.
 */
import {it, expect, afterEach} from '@jest/globals';
import {onboardWallet, accountOf, type Mount} from '../harness/lib';
import {relayGet, relayPost} from '../harness/relayClient';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import {disposeConvertStubs, installEvmRpcStub, evmRpcStubState} from './convertStubs';
import {prepareCowConvertRecord} from '../../../convert/prepareCow';
import {deriveEvmAddress} from '../../../evm';
import {dpayCowAppDataHash} from '../../../evm/cowPlan';

installHeapProbe();
hermeticFlow();

const ZCHF = '0xb58e61c3098d85632df34eecfb899a1ed80921cb';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT_RAIL = 'evm:native-eth:1';
const AMOUNT_IN = (10n ** 17n).toString(); // 0.1 ZCHF — the smallest honest figure this pin needs
const BUY = '387018342251672'; // the stub's quoted buy figure (raw wei WETH)
const FEE = '13551802418938027'; // the stub's own fee estimate (raw ZCHF, carried verbatim)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

type StoreRecord = {
  id?: string;
  step?: string;
  venueId?: string;
  outAmountNet?: string;
  outTx?: string;
  failureCode?: string;
  failureDetail?: string;
  evmSwap?: {cow?: {uid?: string; approveTxHash?: string; bought?: string; sold?: string}; txHashes?: string[]; amountIn?: string};
};

async function storeRecords(publicHex: string): Promise<Record<string, StoreRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, StoreRecord>;
}

async function waitForRecord(
  publicHex: string,
  id: string,
  pred: (r: StoreRecord) => boolean,
  timeoutMs: number,
): Promise<StoreRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = await storeRecords(publicHex);
    const rec = all[id];
    if (rec != null && pred(rec)) return rec;
    if (Date.now() > deadline) {
      throw new Error(`flow 226: record ${id} never reached the expected state; last=${JSON.stringify(rec ?? all)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

hermeticDescribe('flow 226 — ZCHF → native ETH via CoW Swap: relay-proxied order, UID resume, honest watch', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

  it('drives the happy run, completes a killed run from the frozen uid, and watches an open order honestly', async () => {
    let m: Mount | null = null;
    try {
      m = await onboardWallet('jest-cow-convert');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      installEvmRpcStub();

      // The real prepare (real wasm floor math, real fee probe + balance reads through the
      // EVM stub, real frozen facts). The order UID is DERIVABLE from these facts + the
      // owner — the stub is armed with the derived value, so the venue's 201 answer and
      // the app's own derivation must agree (the adapter refuses a mismatching pipe).
      const {record} = await prepareCowConvertRecord({
        secretHex: account!.secretHex,
        quote: {
          venueId: 'cowswap-eth',
          amountIn: AMOUNT_IN,
          buyAmount: BUY,
          feeAmount: FEE,
          protocolFeeBps: '2',
          validTo: Math.floor(Date.now() / 1000) + 1200,
          tokenIn: ZCHF,
          tokenOut: '',
          outRailId: OUT_RAIL,
        },
        inSymbol: 'ZCHF',
        outSymbol: 'ETH',
        inDecimals: 18,
        outDecimals: 18,
        slippageBps: 100,
      });
      const id = record.id;
      expect(record.step).toBe('swapping');
      expect(record.evmSwap!.cow!.uid).toBeUndefined();

      // ── Arm (a): the happy run ────────────────────────────────────────────────────────
      await relayPost('/api/v1/test/cow-upstream/config', {
        orderUid: derivedUid(account!.secretHex, record),
        validTo: record.evmSwap!.deadlineSecs, // the stub teaches the quoted-validTo contract
        statuses: ['open', 'open', 'fulfilled'],
        sellAmount: AMOUNT_IN,
        buyAmount: BUY,
        feeAmount: FEE,
        executedSellAmount: AMOUNT_IN,
        executedBuyAmount: BUY,
      });
      await AsyncStorage().setItem(`dpay.convert.v3.${account!.publicHex}`, JSON.stringify({[id]: record}));
      const evmBefore = evmRpcStubState();
      await m.remount(); // the resumed engine sweeps the non-terminal record at start (the stub's mount hook keeps the EVM override armed — a reinstall here would reset the send census mid-flight)
      await waitForRecord(account!.publicHex, id, (r) => r.step === 'done', budgetScaled(60_000));
      const done = (await storeRecords(account!.publicHex))[id]!;
      // The venue's own durable identities + the realized figures, all frozen on the record.
      expect(done.evmSwap?.cow?.uid).toMatch(/^0x[0-9a-f]{112}$/);
      expect(done.evmSwap?.cow?.approveTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(done.evmSwap?.cow?.bought).toBe(BUY);
      expect(done.evmSwap?.txHashes?.length ?? 0).toBe(1); // the native-out unwrap leg
      expect(done.outTx).toBe(done.evmSwap?.cow?.uid);
      // The chain legs really broadcast through the EVM pipe: the approve (exact pull) +
      // the unwrap. The stub's calldata carries the VaultRelayer approve selector.
      const evmAfter = evmRpcStubState()!;
      const sent = evmAfter.sent.slice(evmBefore?.sent.length ?? 0);
      expect(sent.length).toBe(2);
      // The raw wires carry the legs' calldata: the VaultRelayer approve for the exact
      // pull, then the WETH unwrap (selector 2e1a7d4d).
      expect(sent[0]!.raw).toContain('095ea7b3'); // approve(address,uint256)
      expect(sent[0]!.raw).toContain('b58e61c3098d85632df34eecfb899a1ed80921cb'); // the sell token
      expect(sent[1]!.raw).toContain('2e1a7d4d'); // WETH.withdraw(uint256)
      // The venue traffic went THROUGH the relay proxy (the app never dialed the stub).
      const hits = await relayGet('/api/v1/test/cow-upstream/hits') as {orderCalls: unknown[]; statusCalls: unknown[]};
      expect(hits.orderCalls.length).toBeGreaterThanOrEqual(1);
      expect(hits.statusCalls.length).toBeGreaterThanOrEqual(2);

      // ── Arm (b): killed after submit — the resumed engine completes from the frozen uid ──
      await relayPost('/api/v1/test/cow-upstream/config', {
        orderUid: derivedUid(account!.secretHex, record),
        validTo: record.evmSwap!.deadlineSecs, // the stub teaches the quoted-validTo contract
        statuses: ['open', 'fulfilled'],
        sellAmount: AMOUNT_IN,
        buyAmount: BUY,
        feeAmount: FEE,
        executedSellAmount: AMOUNT_IN,
        executedBuyAmount: BUY,
      });
      const killed = {
        ...record,
        id: 'cow-killed',
        step: 'settling',
        evmSwap: {
          ...record.evmSwap,
          cow: {
            ...record.evmSwap!.cow,
            uid: derivedUid(account!.secretHex, record),
            approveTxHash: '0x' + '11'.repeat(32),
          },
        },
      };
      await AsyncStorage().setItem(
        `dpay.convert.v3.${account!.publicHex}`,
        JSON.stringify({['cow-killed']: killed}),
      );
      // The census marker goes BEFORE the remount: with the stub's mount hook armed, the
      // boot sweep broadcasts DURING the remount — a capture taken after it slices the
      // unwrap away.
      const evmBeforeB = evmRpcStubState();
      await m.remount();
      await waitForRecord(account!.publicHex, 'cow-killed', (r) => r.step === 'done', budgetScaled(60_000));
      const resumed = (await storeRecords(account!.publicHex))['cow-killed']!;
      expect(resumed.evmSwap?.cow?.uid).toBe(derivedUid(account!.secretHex, record));
      expect(resumed.evmSwap?.cow?.bought).toBe(BUY);
      // A resumed record must NOT re-approve: the only new broadcast is the unwrap leg.
      const sentB = evmRpcStubState()!.sent.slice(evmBeforeB?.sent.length ?? 0);
      expect(sentB.length).toBe(1); // the unwrap only
      expect(sentB[0]!.raw).not.toContain('095ea7b3'); // no re-approve

      // ── Arm (c): the unknown/slow arm — a sticky open order stays honestly non-terminal ──
      await relayPost('/api/v1/test/cow-upstream/config', {
        orderUid: derivedUid(account!.secretHex, record),
        validTo: record.evmSwap!.deadlineSecs, // the stub teaches the quoted-validTo contract
        statuses: ['open'],
        sellAmount: AMOUNT_IN,
        buyAmount: BUY,
        feeAmount: FEE,
      });
      const slow = {
        ...record,
        id: 'cow-slow',
        step: 'settling',
        evmSwap: {
          ...record.evmSwap,
          cow: {
            ...record.evmSwap!.cow,
            uid: derivedUid(account!.secretHex, record),
            approveTxHash: '0x' + '11'.repeat(32),
          },
        },
      };
      await AsyncStorage().setItem(
        `dpay.convert.v3.${account!.publicHex}`,
        JSON.stringify({['cow-slow']: slow}),
      );
      await m.remount();
      // The drive hands back to the watcher (per-drive budget), the engine re-arms, and the
      // record stays `settling` with its uid — live money in motion, never a fake done.
      await new Promise((r) => setTimeout(r, budgetScaled(12_000)));
      const slowRec = (await storeRecords(account!.publicHex))['cow-slow']!;
      expect(slowRec.step).toBe('settling');
      expect(slowRec.evmSwap?.cow?.uid).toBe(derivedUid(account!.secretHex, record));
      const slowHits = await relayGet('/api/v1/test/cow-upstream/hits') as {statusCalls: unknown[]};
      expect(slowHits.statusCalls.length).toBeGreaterThanOrEqual(3); // the watcher keeps polling
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(240_000));
});

/** The UID exactly as the adapter derives it: the frozen order facts + the owner address.
 *  The stub is armed with THIS value — the venue's 201 must agree with the derivation. */
function derivedUid(secretHex: string, record: {evmSwap?: {amountIn?: string; minOut?: string; deadlineSecs?: number; cow?: {appData?: string}}}): string {
  // Lazily required: keeps the flow file's static import graph identical to the other files.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {cowOrderUid} = require('../../../evm/cowPlan') as typeof import('../../../evm/cowPlan');
  return cowOrderUid(1, {
    sellToken: ZCHF,
    buyToken: WETH,
    receiver: null,
    sellAmount: record.evmSwap!.amountIn!,
    buyAmount: record.evmSwap!.minOut!,
    validTo: record.evmSwap!.deadlineSecs!,
    appData: record.evmSwap!.cow!.appData ?? dpayCowAppDataHash(),
    feeAmount: '0',
  }, deriveEvmAddress(secretHex));
}
