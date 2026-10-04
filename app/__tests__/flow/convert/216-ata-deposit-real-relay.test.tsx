/**
 * flow 216 (ata-deposit-real-relay) - the REAL-RELAY, NO-MONEY integration pins for the P0
 * deposit lifecycle (founder 2026-10-02: hermetic-only coverage does not qualify a money
 * path as tested). Both record families drive through THIS file's own real relay - the
 * prod-shaped proxy with its real quote path and REAL order minting (the stub upstream
 * replays the venue's measured wire shapes) - and the ONLY seam stubbed is the wallet's
 * signing/broadcast rail: prepareTransfer/prepareLegacyTransfer capture the deposit they
 * WOULD sign and submitTransfer settles without any broadcast. Nothing here can move real
 * money: no envelope is ever signed at the captured seam, the composed family's device
 * signatures land on the fake-IC ledger, and the venue is the relay's offline stub.
 *
 * Pinned per family: the record reaches awaiting_deposit WITH a deposit prepared (the exact
 * venue address, the record's exact amount, the ICP mainnet ledger - legacy dispatch keeps
 * the decodeLegacyReply wiring), the once-only deposit marker is on the STORED record, and
 * the setup card NEVER renders idle (no re-armed button) while the record is live.
 */
import {it, expect, afterEach, beforeEach, jest} from '@jest/globals';
import {accountOf, onboardSeededUnfunded, openBalances, faucetAccount, openConvertFor, pickSwapTarget, typeConvertAmount} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {deadline as budgetDeadline} from '../harness/budget';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {installHeapProbe} from './heapProbe';
import bs58 from 'bs58';
import {
  disposeConvertStubs, enableSolRail, installSideShiftStub, setSideShiftStatus,
  deriveSolanaKeypair, trocadorConfig, sideshiftRelayHits,
} from './convertStubs';
import type {SolanaRpcStub} from '../../../solana/rpc';

installHeapProbe();
hermeticFlow();

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the ICP mainnet ledger - the legacy dispatch's ONLY ledger
// The venue's 64-hex account identifier (the LIVE-proven SideShift ICP deposit shape,
// 2026-10-02): the one namespace only the ICP ledger's legacy `transfer` reaches.
const LEGACY_VENUE_ADDRESS = 'a4ef38803ebbab5595d1afb8a7a136f8b75167d5693579df60651f96829f4ac9';
const STORE_TIMEOUT_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};
type StoreRecord = {
  step?: string;
  id?: string;
  createdAtMs?: number;
  amountIn?: string;
  inCurrency?: number;
  outLedger?: string;
  providerDeposit?: {depositAddress?: string; depositAmount?: string; expiresAtMs?: number};
  depositSentAtMs?: number;
  ataTargetMints?: string[];
  composedDeposit?: {venueId?: string; sentTx?: unknown};
};

/** The captured signing seam: every prepare is RECORDED, nothing is signed, nothing is
 *  broadcast. `legacyDecoderWired` pins the live-trip rule: a legacy deposit's reply MUST
 *  decode through the legacy tag set (the module's own decodeLegacyReply), never the ICRC-1
 *  default that threw 'DIDL decode error' over landed money (live 2026-10-02). */
const mockRailCaptures: {
  prepares: Array<{kind: 'icrc1' | 'legacy'; req: Record<string, unknown>}>;
  submits: Array<{ledger: string; requestIdHex: string; amount: string}>;
  legacyDecoderWired: boolean | null;
} = {prepares: [], submits: [], legacyDecoderWired: null};

jest.mock('../../../services/rail', () => {
  const actual = jest.requireActual('../../../services/rail') as Record<string, unknown>;
  const realDecodeLegacyReply = actual.decodeLegacyReply;
  const realSubmitTransfer = actual.submitTransfer as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    prepareTransfer: async (_secretHex: string, _catalog: unknown, req: Record<string, unknown>) => {
      mockRailCaptures.prepares.push({kind: 'icrc1', req});
      // The canned request ids mark THIS capture as the cefi deposit's prepared transfer -
      // the marker the submit seam uses to separate the deposit from the engine's own legs.
      return {ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', envelopeHex: 'aa', requestIdHex: 'rr-icrc1', amount: req.amount, currency: req.currency, memoHex: req.nonceHex};
    },
    prepareLegacyTransfer: async (_secretHex: string, req: Record<string, unknown>) => {
      mockRailCaptures.prepares.push({kind: 'legacy', req});
      return {ledger: req.ledger, envelopeHex: 'aa', requestIdHex: 'rr-legacy', amount: req.amountE8s, currency: 8, memoHex: ''};
    },
    submitTransfer: async (prepared: {ledger: string; requestIdHex: string; amount: string}, ...rest: unknown[]) => {
      if (typeof prepared.requestIdHex === 'string' && prepared.requestIdHex.startsWith('rr-')) {
        // The captured CEFI DEPOSIT: settled without any broadcast (the pin's no-money seam).
        const decodeReply = rest[2];
        mockRailCaptures.submits.push({ledger: prepared.ledger, requestIdHex: prepared.requestIdHex, amount: prepared.amount});
        mockRailCaptures.legacyDecoderWired = decodeReply === realDecodeLegacyReply ? true : (decodeReply == null ? false : null);
        return {kind: 'settled', blockIndex: '4242'};
      }
      // The engine's own IC-leg submits (the composed family's signed legs): the REAL rail -
      // device-signed bytes onto the fake-IC ledger, the no-money standard flows 213/214 run.
      return realSubmitTransfer(prepared, ...rest);
    },
  };
});

/** The mutable SOL rail (flow 214's fixture): starts at ZERO lamports with every token
 *  account KNOWN-absent (the fund-ic precondition), credits the wallet when the venue
 *  settles, and answers 'balance' for the token ATAs once a create broadcast happened. */
function installAtaSolStub(mints: string[]): {state: {lamports: number; funded: boolean}; sent: string[]} {
  const state = {lamports: 0, funded: false};
  const sent: string[] = [];
  const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const tokenAccount = (mint: string, owner: string, amt: string): unknown => {
    const buf = new Uint8Array(165);
    buf.set(bs58.decode(mint), 0);
    buf.set(bs58.decode(owner), 32);
    let v = BigInt(amt);
    for (let i = 0; i < 8; i++) { buf[64 + i] = Number(v & 0xffn); v >>= 8n; }
    return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toB64(buf), 'base64'], executable: false, rentEpoch: 0, space: 165};
  };
  const mintAccount = (decimals: number): unknown => {
    const buf = new Uint8Array(82);
    buf[44] = decimals;
    return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toB64(buf), 'base64'], executable: false, rentEpoch: 0, space: 82};
  };
  const stub: SolanaRpcStub = {
    getMultipleAccounts: ((params: unknown[]) => {
      const addresses = params[0] as string[];
      const owner = addresses[0]!;
      const value = addresses.map((_addr, i) => {
        if (i === 0) {
          return state.lamports <= 0 ? null : {lamports: state.lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0};
        }
        const isMint = i % 2 === 0;
        const mint = String(isMint ? addresses[i] : addresses[i + 1]);
        if (isMint) return mintAccount(6);
        return state.funded && mints.includes(mint) ? tokenAccount(mint, owner, '1000000') : null;
      });
      return Promise.resolve({context: {slot: 250000000}, value});
    }) as SolanaRpcStub['getMultipleAccounts'],
    getGenesisHash: () => Promise.resolve('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    getLatestBlockhash: () => Promise.resolve({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
    getMinimumBalanceForRentExemption: () => Promise.resolve(1447680),
    getFeeForMessage: () => Promise.resolve({context: {slot: 250000000}, value: {lamports: 5000}}),
    sendTransaction: (params: unknown[]) => {
      const raw = Array.isArray(params) ? (params[0] as string) : null;
      const bytes = new Uint8Array(Buffer.from(raw ?? '', 'base64'));
      const signature = bs58.encode(bytes.slice(1, 65));
      sent.push(signature);
      state.funded = true; // a broadcast ATA create: the stub credits the accounts
      return Promise.resolve(signature);
    },
    getSignatureStatuses: () => Promise.resolve({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
    getSignaturesForAddress: () => Promise.resolve([]),
    getBlockHeight: () => Promise.resolve(250000000),
    getTransaction: () => Promise.resolve(null),
    getBalance: () => Promise.resolve({value: state.lamports}),
    getAccountInfo: () => Promise.resolve({value: null}),
    getTokenAccountBalance: () => Promise.resolve({value: {amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1'}}),
  } as unknown as SolanaRpcStub;
  (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
  return {state, sent};
}

async function storeRecords(publicHex: string): Promise<Record<string, StoreRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, StoreRecord>;
}

/** The never-idle hold: for a full window on a LIVE record, the idle card (its re-armed
 *  one-tap button above all) must never render - the P0's second-spend invitation. */
async function holdNeverIdle(m: Mount, ms: number): Promise<void> {
  const hold = budgetDeadline(ms);
  while (Date.now() < hold) {
    if (m.driver.isPresent('ata-setup-EUR-complete') || m.driver.isPresent('ata-setup-EUR-banner') || m.driver.isPresent('ata-setup-EUR-confirm-btn')) {
      throw new Error('the card rendered idle (or a confirm) over a LIVE record - the P0 silent strand is back');
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

hermeticDescribe('flow 216 - the P0 deposit lifecycle against the REAL relay (no money moves)', () => {
  beforeEach(() => {
    mockRailCaptures.prepares.length = 0;
    mockRailCaptures.submits.length = 0;
    mockRailCaptures.legacyDecoderWired = null;
  });
  afterEach(() => {
    disposeConvertStubs();
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  it('the DIRECT-cefi family: a real relay order reaches awaiting_deposit with its ICRC-1 deposit prepared, marked once, card never idle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState, sent: solSends} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    await trocadorConfig({amount_to: '0.04'});

    const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
    const m = await onboardSeededUnfunded('jest-216-direct');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 5 ICP - the direct ICP->SOL cefi family.
      const fund = await faucetAccount(account!.publicHex, 500000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});

      // The REAL order minted EXACTLY once through the relay's proxy (real quotes rode the
      // same path), and the record sits at awaiting_deposit WITH the deposit taken once.
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      let rec: StoreRecord | null = null;
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => r.providerDeposit != null) ?? null;
        if (rec?.step === 'awaiting_deposit' && rec.depositSentAtMs != null) break;
        if (Date.now() > deadline) throw new Error(`the direct record never reached a taken awaiting_deposit (steps: ${Object.values(store).map(r => r.step).join(',')})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore + 1);
      expect(rec!.inCurrency).toBe(8);

      // THE DEPOSIT, AS PREPARED: the venue's verbatim address (the relay order's own),
      // the record's EXACT amount, no memo (the stub issues none) - and exactly ONE
      // captured submit targeting the ICP mainnet ledger. Nothing was broadcast.
      expect(mockRailCaptures.prepares.length).toBe(1);
      const icrc1 = mockRailCaptures.prepares[0]!;
      expect(icrc1.kind).toBe('icrc1');
      expect(icrc1.req.toAccount).toBe(rec!.providerDeposit!.depositAddress);
      expect(rec!.providerDeposit!.depositAddress!.length).toBeGreaterThan(0);
      expect(icrc1.req.amount).toBe(rec!.amountIn);
      expect(icrc1.req.currency).toBe(8);
      expect(mockRailCaptures.submits.length).toBe(1);
      expect(mockRailCaptures.submits[0]!.ledger).toBe(ICP_LEDGER);
      expect(mockRailCaptures.legacyDecoderWired).toBe(false); // the ICRC-1 path keeps the default decoder

      // The card NEVER renders idle while the record is live.
      expect(m.driver.isPresent('ata-setup-EUR-live')).toBe(true);
      await holdNeverIdle(m, 10_000);

      // The venue settles (its own locked figure); the record completes; the watcher
      // creates the accounts; the card clears. Still exactly one order, one deposit.
      stubState.lamports = 49500000;
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-216-direct'});
      await m.driver.waitForFunction(
        () => !m!.driver.isPresent('ata-setup-EUR-live') && !m!.driver.isPresent('ata-setup-EUR-banner') && !m!.driver.isPresent('ata-setup-EUR-busy'),
        {timeoutMs: 60_000, label: 'the direct run completed on the venue settle and the card cleared'},
      );
      expect(solSends.length).toBe(tokenMints.length);
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore + 1); // the ONE order, never re-created
      expect(mockRailCaptures.prepares.length).toBe(1);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));

  it('the LEGACY dispatch: a 64-hex venue deposit prepares through the ICP mainnet ledger with the legacy decoder wired', async () => {
    // The LIVE-proven shape (SideShift's ICP deposits are legacy 64-hex account
    // identifiers): a real direct-cefi record seeded into the store (hydration-valid,
    // venue verbatim), recovered by the watcher on boot through the real relay stack. The
    // deposit must ride prepareLegacyTransfer (never the ICRC-1 path) with the EXACT
    // amount, the catalog fee, and decodeLegacyReply as the reply decoder.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});

    const m = await onboardSeededUnfunded('jest-216-legacy');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // Seed the record into the scoped store, then restart: the watcher must recover it
      // exactly as an app restart would (the P0's restart arm of the direct family).
      const solAddress = deriveSolanaKeypair(account!.secretHex).address;
      const store = await storeRecords(account!.publicHex);
      // The full hydration-valid direct-cefi record, venue verbatim (a comment on each
      // block the hydration gate reads).
      const seed: Record<string, unknown> = {
        id: 'seeded-legacy-216',
        createdAtMs: Date.now(),
        step: 'awaiting_deposit',
        venueId: 'sideshift',
        inCurrency: 8,
        inLedger: ICP_LEDGER,
        outLedger: tokenMints[0]!,
        inSymbol: 'ICP',
        outSymbol: 'EURC',
        inDecimals: 8,
        outDecimals: 6,
        amountIn: '90000000',
        expectedGross: '1000000',
        expectedNet: '1000000',
        inFee: '0',
        outFee: '0',
        slippageBps: 0,
        legs: [],
        providerRef: {orderId: 's-seeded-216', statusUrl: 'https://sideshift.ai/api/v2/shifts/s-seeded-216'},
        providerDeposit: {depositAddress: LEGACY_VENUE_ADDRESS, depositAmount: '0.9', expiresAtMs: Date.now() + 600_000},
        destAddress: solAddress,
        destSymbol: 'EURC',
        ataTargetMints: [...tokenMints],
      };
      store['seeded-legacy-216'] = seed as unknown as StoreRecord;
      await AsyncStorage().setItem(`dpay.convert.v3.${account!.publicHex}`, JSON.stringify(store));
      await m.remount();

      // Back into the EUR view (the card lives there) - the watcher runs app-wide either way.
      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});

      // The watcher recovers the record on boot: the deposit prepares through the LEGACY
      // dispatch - 64-hex venue address, exact amount, catalog fee, ICP mainnet ledger.
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      for (;;) {
        const after = await storeRecords(account!.publicHex);
        if (after['seeded-legacy-216']?.depositSentAtMs != null) break;
        if (Date.now() > deadline) throw new Error('the seeded legacy record never got its deposit taken on restart');
        await new Promise(r => setTimeout(r, 500));
      }
      expect(mockRailCaptures.prepares.length).toBe(1);
      const legacy = mockRailCaptures.prepares[0]!;
      expect(legacy.kind).toBe('legacy');
      expect(legacy.req).toEqual({
        ledger: ICP_LEDGER,
        toAccountId: LEGACY_VENUE_ADDRESS,
        amountE8s: '90000000',
        feeE8s: '10000', // the catalog's own ICP fee - never a guessed one
      });
      expect(mockRailCaptures.submits.length).toBe(1);
      expect(mockRailCaptures.submits[0]!.ledger).toBe(ICP_LEDGER);
      expect(mockRailCaptures.legacyDecoderWired).toBe(true); // the reply decodes through the LEGACY tag set

      // The card NEVER renders idle while the seeded record stands (the ownership link
      // rides the record: the restart-safe live state).
      await m.driver.findByTestID('ata-setup-EUR-live', {timeoutMs: 30_000});
      await holdNeverIdle(m, 10_000);

      // The venue settles; the record completes on the engine's own poll.
      stubState.lamports = 49500000;
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-216-legacy'});
      for (;;) {
        const after = await storeRecords(account!.publicHex);
        if (after['seeded-legacy-216']?.step === 'done') break;
        if (Date.now() > deadline) throw new Error(`the seeded legacy record never completed (step: ${(after['seeded-legacy-216'] ?? {}).step ?? 'absent'})`);
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));

  it('the COMPOSED family: a REAL relay order funds through the device-signed deposit leg, card never idle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState} = installAtaSolStub(tokenMints);
    // SOL ALREADY PRESENT: the wallet's setup plan is `create`, so the background sizing
    // probe NEVER quotes - its shrinking inputs would collide with the convert confirm's
    // order binding (the relay's stub binds an order to the LAST quote it served, and a
    // real venue binds it to the quote id - either way a concurrent quote breaks the
    // exact-amount gate). The family under test here is the record lifecycle, not the plan.
    stubState.lamports = 50_000_000;
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    await trocadorConfig({amount_to: '0.04'}); // the settle venue wins its fitness pick on REAL quoted figures

    // The order is minted for REAL through the relay's proxy on the convert surface (the
    // user-typed input - the setup sizer's shrink-to-fit assumes a proportional venue and
    // the relay's constant-settle stub would size dust, the fixture artifact flow 214's own
    // comment names). The composed record then drives exactly as the setup's would: the
    // engine submits the frozen legs device-signed onto the fake-IC ledger - no money
    // anywhere - and the deposit leg's durable evidence freezes on the record.
    const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
    const m = await onboardSeededUnfunded('jest-216-composed');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 20 VCHF - the composed family (IC leg + cefi settle).
      const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-quote-ready', {timeoutMs: 15_000}); // the quotes settled on the composed pick
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore + 1); // the REAL order, minted once

      // Clone the record CLEAN, parked just before the deposit leg, carrying the setup's
      // ownership link: the restart/recovery shape the setup's own record lands in whenever
      // the run dies after the record persists (the P0's async handoff).
      const store = await storeRecords(account!.publicHex);
      const tpl = Object.values(store).find((r) => r != null && r.composedDeposit != null);
      if (tpl == null) throw new Error('no composed record to recover');
      const rec = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown> & {composedDeposit?: Record<string, unknown>; legPlan?: Array<Record<string, unknown>>; createdAtMs?: number};
      delete (rec as Record<string, unknown>).outAmountNet;
      for (const k of ['outTx', 'hopTx', 'destTx', 'failureCode', 'failureDetail'] as const) delete (rec as Record<string, unknown>)[k];
      delete rec.composedDeposit!.sentTx;
      rec.id = 'seeded-composed-216';
      rec.step = 'approving';
      rec.createdAtMs = Date.now();
      rec.legPlan = rec.legPlan!.map((lp, i) => ({...lp, state: i < 2 ? 'confirmed' : 'pending'}));
      (rec as Record<string, unknown>).ataTargetMints = [...tokenMints];
      store['seeded-composed-216'] = rec as unknown as StoreRecord;
      await AsyncStorage().setItem(`dpay.convert.v3.${account!.publicHex}`, JSON.stringify(store));
      await m.remount();

      // Into the EUR view: the card must render LIVE - never the idle probe, never a
      // re-armed button - while the recovered record works.
      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-live', {timeoutMs: 30_000});

      // The engine drives the frozen legs: the deposit gate proves the transfer's ledger
      // row (identical bytes are deduped - never a second signature) and the record lands
      // at awaiting_deposit WITH the deposit's durable evidence frozen on it.
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      let recovered: StoreRecord | null = null;
      for (;;) {
        const after = await storeRecords(account!.publicHex);
        recovered = after['seeded-composed-216'] ?? null;
        if (recovered?.step === 'awaiting_deposit' && recovered.composedDeposit?.sentTx != null) break;
        if (Date.now() > deadline) throw new Error(`the recovered composed record never reached a funded awaiting_deposit (step: ${recovered?.step ?? 'absent'})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect(recovered!.composedDeposit!.venueId).toBe('sideshift-eurc'); // the pair-scoped settle venue row
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore + 1); // never re-created

      // The card NEVER renders idle while the record is live.
      await holdNeverIdle(m, 10_000);

      // The venue settles; the record completes on the engine's own poll. (The create leg
      // belongs to the LIVE setup session's watcher; this record was recovered from the
      // store, so the honest ending is the record's own done - the card then returns to
      // the plan's idle state with the payout landed, never a strand.)
      stubState.lamports = 50_000_000;
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-216-composed'});
      for (;;) {
        const after = await storeRecords(account!.publicHex);
        if (after['seeded-composed-216']?.step === 'done') break;
        if (Date.now() > deadline) throw new Error(`the recovered composed record never completed (step: ${after['seeded-composed-216']?.step ?? 'absent'})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore + 1);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));
});
