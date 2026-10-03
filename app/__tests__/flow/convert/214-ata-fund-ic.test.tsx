/**
 * flow 214 (ata-fund-ic) - the ONE-button fund-ic setup, end to end: a wallet holding ONLY
 * IC-side money (20 VCHF, the founder's exact scenario) with a KNOWN-absent EURC account and
 * no SOL completes its setup from the EUR currency view's own card (the per-currency setup,
 * 2026-10-01). Hermetic per-flow file: one private relay, the relay's SideShift upstream stub
 * for the order + status, a fetch wrapper answering the venue's QUOTE surface proportionally
 * (a real venue pays out in proportion to the deposit; the relay stub's constant settleAmount
 * would break the sizer's shrink-to-fit convergence), and a mutable in-memory SOL RPC stub that
 * starts at zero lamports so the plan is fund-ic.
 *
 * Pinned: ONE card + ONE button in the tapped currency's view; the idle card states the
 * measured minimum BEFORE anything is initiated; the press sizes (never spends) and shows the
 * ONE confirm; the confirm prepares the composed record through the confirm surface's own path
 * and adopts it; the engine runs the IC legs to awaiting_deposit; the venue's settle completes
 * the record; the watcher then creates the absent accounts (real broadcasts); the card clears.
 */
import {it, expect, afterEach, beforeAll} from '@jest/globals';
import {accountOf, onboardSeededUnfunded, openBalances, faucetAccount} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {ceiling as budgetCeiling} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import bs58 from 'bs58';
import {
  disposeConvertStubs, enableSolRail, installSideShiftStub, setSideShiftStatus,
  deriveSolanaKeypair, sideShiftStubState,
} from './convertStubs';
import type {SolanaRpcStub} from '../../../solana/rpc';

installHeapProbe();
hermeticFlow();

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
void ICP_LEDGER;
const STORE_TIMEOUT_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
};
type StoreRecord = {step?: string; composedDeposit?: {venueId?: string}; id?: string};
async function storeRecords(publicHex: string): Promise<Record<string, StoreRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, StoreRecord>;
}

/** The proportional venue QUOTE surface: settleAmount = deposit × 0.02475 (SOL per ICP), the
 *  linear shape the sizer's shrink-to-fit assumes - for BOTH settle families the registry
 *  composes with (sideshift AND trocador pair [ICP, wSOL]; a constant settle on either would
 *  let the multi-route fitness pick a phantom floor and shrink to dust). The request STILL
 *  goes through to the relay (its stub remembers the quoted deposit and echoes it on the
 *  order - the exact-amount gate depends on that); only the ANSWER's settle figure is
 *  rewritten. Everything else passes through to the harness rewrite (the order route keeps
 *  riding the relay's own stub). */
function installProportionalSideShiftQuote(): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://localhost');
    } catch {
      return prev(input, init);
    }
    const isSideshift = parsed.pathname === '/api/v1/sideshift/quotes' && init?.method === 'POST';
    const isTrocador = parsed.pathname === '/api/v1/trocador/rate' && init?.method === 'POST';
    if (isSideshift || isTrocador) {
      const res = await prev(input, init);
      if (!res.ok) return res;
      const body = JSON.parse(String(init?.body ?? '{}')) as {depositAmount?: string};
      const deposit = Number(body.depositAmount ?? '0');
      let j = JSON.parse(await res.clone().text().catch(() => 'null')) as
        | {quote?: {settleAmount?: string; amount_to?: string; rate?: string} | null}
        | null;
      if (j == null || !Number.isFinite(deposit) || deposit <= 0 || j.quote == null) return res;
      const settle = (deposit * 0.02475).toFixed(8);
      if (isSideshift) {
        j.quote.settleAmount = settle;
        j.quote.rate = '0.02475';
      } else {
        j.quote.amount_to = settle;
      }
      return new Response(JSON.stringify(j), {status: res.status, headers: {'content-type': 'application/json'}});
    }
    return prev(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = prev; };
}

/** The mutable SOL rail: starts at ZERO lamports with every token account KNOWN-absent (the
 *  fund-ic precondition), credits the wallet when the venue settles, and answers 'balance'
 *  for the token ATAs once a create broadcast happened. */
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

hermeticDescribe('flow 214 - the fund-ic setup: IC-side money completes the SOL accounts', () => {
  // Every fetch wrapper's restore goes on THIS stack and is undone in REVERSE install order
  // - two independent restore slots restored in a fixed order let one test's armed knob
  // survive into the next test's fetch chain (the 2026-10-02 floated-case flake).
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
    disposeConvertStubs();
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  /** The confirm-time venue knob (2026-10-02 live-trip fix): ONE wrapper for the whole file
   *  (installed ONCE in beforeAll, mode 'off' unless a test says otherwise, reset after every
   *  test) - stacking per-test fetch wrappers restored out of install order let one test's
   *  armed knob hijack the next test's quotes. When the mode is set, every cefi venue quote
   *  answers with that verdict - the exact live-trip failure class (the venue refused at
   *  confirm time that had quoted fine at sizing time), so the sizing/probe phase stays
   *  honest and only the CONFIRM press walks into the refusal. mode 'dead' = hard-
   *  unavailable (no minimum named, every route dies); mode 'floated' = the venue's own
   *  below-minimum verdict naming 0.5 (ICP units) for anything under it - a fresh minimum
   *  the 20-VCHF wallet still covers (the fixture's stub pool cannot carry more), so the
   *  runner must RE-CONFIRM. A REAL venue refuses only deposits BELOW its minimum and
   *  quotes everything at or above it - the knob must too, or the fresh sizing after a
   *  re-confirm can never deliver. */
  let knobMode: 'off' | 'dead' | 'floated' = 'off';
  /** The local venue answer (both families' quote shapes), fixed rate 0.02475 SOL per unit.
   *  The services parse STRICTLY (quotes.ts shape gate): venue_id MUST equal the catalog id
   *  and each family's quote carries its own identity fields (sideshift quote.id, trocador
   *  quote.trade_id + provider) - anything less throws 'shape' and every route reads dead. */
  const fixedVenueAnswer = (isSideshift: boolean, deposit: number): Response => {
    const settle = (deposit * 0.02475).toFixed(8);
    const j = isSideshift
      ? {venue_id: 'sideshift', quote: {id: `q-${deposit}`, settleAmount: settle, rate: '0.02475'}}
      : {venue_id: 'trocador', quote: {trade_id: `t-${deposit}`, amount_to: settle, provider: 'test'}};
    return new Response(JSON.stringify(j), {status: 200, headers: {'content-type': 'application/json'}});
  };
  beforeAll(() => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let parsed: URL;
      try {
        parsed = new URL(url, 'http://localhost');
      } catch {
        return prev(input, init);
      }
      const isVenueQuote = (parsed.pathname === '/api/v1/sideshift/quotes' || parsed.pathname === '/api/v1/trocador/rate') && init?.method === 'POST';
      // The venue ORDER endpoints answer locally too: the order must price the SAME deposit
      // the quote carried (prepare.ts twin check, quoteUnavailable('deposit') otherwise), and
      // the shared relay's own harness would invent its own figure over a quoteId it never
      // issued. sideshift orders carry only the quoteId, so the deposit is recovered from the
      // 'q-<deposit>' id this knob minted; trocador trades carry depositAmount explicitly.
      const isSideshiftOrder = parsed.pathname === '/api/v1/sideshift/shifts/fixed' && init?.method === 'POST';
      const isTrocadorTrade = parsed.pathname === '/api/v1/trocador/trade' && init?.method === 'POST';
      if (isSideshiftOrder || isTrocadorTrade) {
        const req = JSON.parse(String(init?.body ?? '{}')) as {quoteId?: string; depositAmount?: string};
        const deposit = isSideshiftOrder ? Number((req.quoteId ?? '').slice(2)) || 0 : Number(req.depositAmount ?? '0') || 0;
        const settle = (deposit * 0.02475).toFixed(8);
        // The venue's deposit address is the destination of an ICRC-1 transfer the IC chain
        // signs (prepare's step 7 validates it through the core: ICRC-1 account text or
        // 64-hex account id, never a canister, never the user's own principal) - so the stub
        // mints a REAL principal text, '2vxsx-fae' (the anonymous principal, valid checksum,
        // in no guard list).
        const depositAddress = '2vxsx-fae';
        const j = isSideshiftOrder
          ? {id: `s-${req.quoteId ?? 'x'}`, depositAddress, depositAmount: String(deposit), settleAmount: settle, expiresAt: new Date(Date.now() + 600_000).toISOString(), status: 'waiting'}
          : {trade_id: `st-${req.quoteId ?? 'x'}`, address_provider: depositAddress, amount_from: String(deposit), amount_to: settle};
        return new Response(JSON.stringify(j), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (isVenueQuote) {
        // eslint-disable-next-line no-console
        let deposit = Number(JSON.parse(String(init?.body ?? '{}') as string).depositAmount ?? '0');
        if (!Number.isFinite(deposit)) deposit = 0;
        if (knobMode === 'floated' && deposit >= 0.5) return fixedVenueAnswer(isVenueQuote && parsed.pathname === '/api/v1/sideshift/quotes', deposit);
        const body = knobMode === 'floated'
          ? {error: {message: 'Minimum deposit amount: 0.5.', depositRangeMin: '0.5'}}
          : {};
        if (knobMode !== 'off') return new Response(JSON.stringify(body), {status: 500, headers: {'content-type': 'application/json'}});
        // knob off: the honest deterministic venue - a LOCAL fixed-rate answer (settle =
        // deposit x 0.02475, both settle families' shapes), never the shared relay: its
        // stub state drifts across tests in this file and the sizing walk must not inherit
        // another test's rate history.
        return fixedVenueAnswer(isVenueQuote && parsed.pathname === '/api/v1/sideshift/quotes', deposit);
      }
      return prev(input, init);
    }) as typeof fetch;
  });
  afterEach(() => { knobMode = 'off'; });
  /** The shared drive: stubs in, a 20-VCHF wallet on the IC, the EUR view's card at the ONE
   *  confirm (the sizing/probe phase completed honestly). Returns the mount. */
  async function driveToConfirm(alias: string): Promise<Mount> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    const m = await onboardSeededUnfunded(alias);
    const account = await accountOf(m);
    expect(account).not.toBeNull();
    const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7});
    expect(fund.ok).toBe(true);

    await openBalances(m, {timeoutMs: 15_000});
    await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
    await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
    await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
    await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
    return m;
  }

  it('sizes honestly, confirms once, adopts the composed record, and creates the accounts on settle', async () => {
    // The SOL rail configured BEFORE boot; zero lamports + absent ATAs until the venue pays.
    // The registry's own mints (never literals): EURC + USDC are the wallet's SOL tokens.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState, sent: solSends} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    const m = await onboardSeededUnfunded('jest-ata-fund-ic');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 20 VCHF on the Internet Computer, nothing on Solana.
      const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      // The per-currency setup (2026-10-01): the row tap opens the EUR view, which hosts the
      // ONE card (prefix ata-setup-EUR). The wallet-level banner is gone.
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      expect(m.driver.isPresent('ata-setup-EUR-complete')).toBe(true);
      expect(m.driver.isPresent('ata-setup-EUR-refuse')).toBe(false);
      expect(m.driver.readText('ata-setup-EUR-banner')).toContain('EURC');
      // THE MINIMUM, UP FRONT (2026-10-01 founder directive): the idle card states the measured
      // swap input (a VCHF figure) BEFORE anything is initiated - no number that requires a
      // failed swap to learn.
      await m.driver.waitForFunction(
        () => { try { return /[\d.]+ VCHF/.test(m!.driver.readText('ata-setup-EUR-banner')); } catch { return false; } },
        {timeoutMs: 30_000, label: 'the idle card states the measured minimum swap input'},
      );
      expect(m.driver.readText('ata-setup-EUR-banner')).not.toContain('at least 0 VCHF');

      // NOTHING is adopted by the sizing press: the store stays empty; the ONE confirm shows.
      await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
      let store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);
      const confirmLine = m.driver.readText('ata-setup-EUR-confirm-line');
      expect(confirmLine).toContain('VCHF');
      expect(confirmLine).toContain('SOL');

      // THE confirm: prepare (order-first) + adopt, then the engine runs the IC legs.
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      let rec: StoreRecord | null = null;
      for (;;) {
        store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => r.composedDeposit != null) ?? null;
        if (rec?.step === 'awaiting_deposit') break;
        if (Date.now() > deadline) throw new Error(`the composed record never reached awaiting_deposit (steps: ${Object.values(store).map(r => r.step).join(',')})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect(rec!.composedDeposit!.venueId).toBe('sideshift');

      // The venue settles SOL at the device's own address; the watcher finishes the setup.
      stubState.lamports = 49500000; // 0.0495 SOL, the stub's locked settle figure // 0.0495 SOL, the stub's locked settle figure
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-fund-ic-214'});
      await m.driver.waitForFunction(
        () => !m!.driver.isPresent('ata-setup-EUR-live') && !m!.driver.isPresent('ata-setup-EUR-banner') && !m!.driver.isPresent('ata-setup-EUR-busy'),
        {timeoutMs: 60_000, label: 'the setup completed and the card cleared'},
      );
      // The watcher's create leg broadcast REAL device-signed ATA creates (one per mint).
      expect(solSends.length).toBe(tokenMints.length);
      // The device key derived the same address the venue paid.
      expect(deriveSolanaKeypair(account!.secretHex).address.length).toBeGreaterThan(30);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(300_000));

  it('a DIRECT-cefi verdict sends the user-side deposit itself and never strands the order (2026-10-02 live-trip fix)', async () => {
    // The founder's exact trip: ICP money, no SOL, absent accounts - the fitness pick is the
    // direct ICP->SOL cefi route. The venue order lands at awaiting_deposit and the RUNNER
    // must send the IC-side deposit with the device key (the old build waited for a user
    // hand-off that the setup flow never shows: the order expired unused).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState, sent: solSends} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    // Count the IC-side canister CALLS: the deposit transfer is a real wasm-signed
    // icrc1_transfer through the fake-IC gateway.
    const icCalls: string[] = [];
    const prevFetch = global.fetch;
    global.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as {url?: string})?.url ?? input);
      if (url.includes('/api/v2/canister/')) icCalls.push(url);
      return prevFetch(input as Parameters<typeof fetch>[0], init);
    };
    restores.push(() => { global.fetch = prevFetch; });

    const m = await onboardSeededUnfunded('jest-ata-direct-cefi');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 5 ICP, nothing on Solana. 5 >= the fixture venue minimum (0.5)
      // whose settle at the fixture rate covers the two accounts' rent.
      const fund = await faucetAccount(account!.publicHex, 500000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      expect(m.driver.isPresent('ata-setup-EUR-refuse')).toBe(false);
      // The source is named UP FRONT: ICP, never a foreign symbol (the trip's lesson).
      await m.driver.waitForFunction(
        () => { try { return /ICP/.test(m!.driver.readText('ata-setup-EUR-banner')); } catch { return false; } },
        {timeoutMs: 30_000, label: 'the idle card names ICP as the funding source'},
      );

      await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
      const confirmLine = m.driver.readText('ata-setup-EUR-confirm-line');
      expect(confirmLine).toContain('ICP');
      expect(confirmLine).toContain('SOL');

      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});
      // The legless cefi record reaches awaiting_deposit AND the runner transfers the deposit
      // through the real rail (an IC canister call issued while the card is busy).
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      let rec: StoreRecord | null = null;
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => (r as {providerRef?: unknown}).providerRef != null) ?? null;
        if (rec?.step === 'awaiting_deposit') break;
        if (Date.now() > deadline) throw new Error(`the cefi record never reached awaiting_deposit (steps: ${Object.values(store).map(r => r.step).join(',')})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect((rec as {inCurrency?: number}).inCurrency).toBe(8);
      await m.driver.waitForFunction(
        () => icCalls.length > 0,
        {timeoutMs: 30_000, label: 'the runner sent the IC-side deposit transfer'},
      );

      // The venue settles at the device's own address; the watcher finishes the setup.
      stubState.lamports = 49500000; // 0.0495 SOL - comfortably past the rent target
      setSideShiftStatus('settled', {settleAmount: '0.012375', settleHash: 'sol-fund-ic-214-direct'});
      await m.driver.waitForFunction(
        () => !m!.driver.isPresent('ata-setup-EUR-live') && !m!.driver.isPresent('ata-setup-EUR-banner') && !m!.driver.isPresent('ata-setup-EUR-busy'),
        {timeoutMs: 60_000, label: 'the setup completed and the card cleared'},
      );
      expect(solSends.length).toBe(tokenMints.length);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(300_000));

  it('the refuse verdict SURVIVES balance-poll churn - a re-render never un-answers it', async () => {
    // The live-device bug this pins: the model is a useMemo over polled data, so every real
    // balance write re-creates it; the old identity-keyed reset effect then silently cleared
    // the refuse panel and re-armed the button (banner back to idle within seconds). A balance
    // change that does NOT move the plan's own semantics (the ICP primary, excluded from the
    // candidates) must leave the verdict standing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    const m = await onboardSeededUnfunded('jest-ata-fund-ic-churn');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // A hair of IC-side money: positive (a candidate) yet far below any deliverable floor.
      const fund = await faucetAccount(account!.publicHex, 100, {currency: 7});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      // The per-currency driving (2026-10-01): the card lives in the EUR view.
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      // The idle probe may already have proven the plan unfundable (the card shows refuse on
      // its own); a press is only possible while the idle button still stands. Either path
      // lands the refuse verdict.
      if (m.driver.isPresent('ata-setup-EUR-complete')) {
        // The probe may unmount the button the moment its refuse verdict lands - a lost press
        // is fine, the refuse either way is the assertion.
        try { await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000}); } catch { /* refuse landed first */ }
      }
      await m.driver.findByTestID('ata-setup-EUR-refuse', {timeoutMs: 20_000});

      // THE churn: a real balance write on the ICP primary lands through a poll while the
      // refuse verdict is on screen. The plan's semantics did not move - the verdict must not
      // either. (RED historically: the card silently returned within a poll.)
      const top = await faucetAccount(account!.publicHex, 1_000_000, {currency: 0});
      expect(top.ok).toBe(true);
      const deadline = budgetDeadline(30_000);
      for (;;) {
        const refuseUp = m.driver.isPresent('ata-setup-EUR-refuse');
        const bannerUp = m.driver.isPresent('ata-setup-EUR-banner');
        if (bannerUp) throw new Error('the refuse verdict was wiped by a balance poll - the card silently re-armed');
        if (!refuseUp) throw new Error('neither refuse nor banner on screen - unexpected setup state');
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 500));
      }
      expect(m.driver.isPresent('ata-setup-EUR-refuse')).toBe(true);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(300_000));

  it('a confirm-time venue refusal renders the REAL cause and never the un-probed idle (2026-10-02 trip fix)', async () => {
    // eslint-disable-next-line no-console
    // The live trip: the venue quoted fine at sizing, then refused at CONFIRM - and the card
    // fell back to the un-probed idle (rent line only, no cause) while logcat named a foreign
    // symbol. Pinned: every route dead at confirm time leaves the refuse panel WITH the real
    // cause line, the cause names the CONFIRMED source (VCHF, never ICP), and the idle card
    // never returns.
    const m = await driveToConfirm('jest-ata-confirm-refuse');
    try {
      knobMode = 'dead'; // the venue turns hostile AT CONFIRM TIME - the sizing stayed honest
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});
      // The honest dead end, carrying the cause:
      await m.driver.findByTestID('ata-setup-EUR-refuse', {timeoutMs: 20_000});
      await m.driver.findByTestID('ata-setup-EUR-err', {timeoutMs: 10_000});
      const errLine = m.driver.readText('ata-setup-EUR-err');
      expect(errLine.length).toBeGreaterThan(0);
      expect(errLine).toContain('VCHF'); // the CONFIRMED source - never a foreign candidate
      expect(errLine).not.toContain('ICP');
      // Never the un-probed idle again: the banner (rent-line card) stays gone.
      await m.driver.waitForFunction(
        () => !m!.driver.isPresent('ata-setup-EUR-banner'),
        {timeoutMs: 15_000, label: 'the card never silently falls back to the un-probed idle'},
      );
      expect(m.driver.isPresent('ata-setup-EUR-banner')).toBe(false);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(180_000));

  it('a floated venue minimum at confirm time goes to RE-CONFIRM with a fresh sized plan (2026-10-02 trip fix)', async () => {
    // eslint-disable-next-line no-console
    // The venue's own below-minimum verdict at confirm time, naming 2.7 (ICP units) - above
    // the confirmed leg floor, below the wallet's 3 VCHF: the runner must RE-SIZE fresh and
    // show the fresh plan for a second confirm - never fundShort, never idle, and nothing
    // adopted (no order behind the user's back).
    const m = await driveToConfirm('jest-ata-confirm-floated');
    try {
      const account = await accountOf(m);
      const firstLine = m.driver.readText('ata-setup-EUR-confirm-line');
      knobMode = 'floated'; // the venue's minimum floats up AT CONFIRM TIME
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});
      // The RE-CONFIRM: a fresh sized plan, user-gated.
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 30_000});
      const secondLine = m.driver.readText('ata-setup-EUR-confirm-line');
      expect(secondLine).toContain('VCHF');
      expect(secondLine).not.toBe(firstLine); // the fresh numbers, not a replay
      expect(m.driver.isPresent('ata-setup-EUR-err')).toBe(false);
      // NOTHING was adopted by any of it: the store stays empty until the user confirms again.
      const store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(180_000));

  it('a KILL after the record is persisted strands NOTHING - the engine sends the deposit and the card stays LIVE (2026-10-02 P0)', async () => {
    // The exact silent-strand shape, replayed: the composed run dies after the record is
    // persisted (a remount kills the run function with the mount) - the old build's card
    // fell back to IDLE with the one-tap button re-armed while the record stood live, and
    // nobody owned the deposit. Now: the resume engine drives the frozen legs (the deposit
    // transfer goes out on the engine's re-arm), the card renders the LIVE state the whole
    // way, and the idle button NEVER comes back while the record is non-terminal.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    const m = await onboardSeededUnfunded('jest-ata-composed-kill');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 20 VCHF, nothing on Solana - the composed pick.
      const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});

      // THE KILL: the moment the record is PERSISTED (any live step), the run dies with the
      // mount - exactly the async handoff (slow poll, resume, restart) that stranded it.
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        if (Object.values(store).some(r => r.composedDeposit != null)) break;
        if (Date.now() > deadline) throw new Error('the composed record never persisted before the kill');
        await new Promise(r => setTimeout(r, 250));
      }
      await m.remount();

      // Back into the EUR view: the card must show LIVE - never the idle probe, never a
      // re-armed button - while the record works.
      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-live', {timeoutMs: 30_000});
      expect(m.driver.isPresent('ata-setup-EUR-complete')).toBe(false);
      expect(m.driver.isPresent('ata-setup-EUR-banner')).toBe(false);

      // The engine finishes the frozen legs: the deposit STILL gets sent (the deposit
      // transfer leg submits from the record's own bytes), and the record parks at
      // awaiting_deposit with the sent evidence frozen on it. This phase gets its OWN
      // budget-scaled window: the resumed engine re-sends the deposit (submit polls) and
      // then parks the record, all on load-stretched timers - a window shared with the
      // persist wait above left the later phases an empty budget under full-suite load.
      // THE ADOPTION EVIDENCE (2026-10-03): parking alone proved nothing - the store can
      // carry awaiting_deposit from the KILLED session's still-draining executor while the
      // resumed engine never drives the record at all (the silent strand this arm exists to
      // catch: the venue was never polled ONCE, the card rendered a stale snapshot, and the
      // settle window expired watching a dead store). So the exit ALSO requires the venue
      // stub to have answered at least one status read - the resumed engine's own poll, the
      // only caller of this endpoint in the process - before the settle may be armed.
      const liveDeadline = budgetDeadline(STORE_TIMEOUT_MS);
      let rec: StoreRecord | null = null;
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => r.composedDeposit != null) ?? null;
        const polled = (sideShiftStubState()?.statusCalls.length ?? 0) > 0;
        if (rec?.step === 'awaiting_deposit' && polled) break;
        if (Date.now() > liveDeadline) {
          throw new Error(`the killed record never reached a POLLED awaiting_deposit (steps: ${Object.values(store).map(r => r.step).join(',')}; venue status reads: ${sideShiftStubState()?.statusCalls.length ?? 0})`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
      expect(rec!.composedDeposit!.venueId).toBe('sideshift');

      // THE never-idle pin: for a full window on the live record, the one-tap button must
      // never re-appear (the old build re-armed it within seconds).
      const hold = budgetDeadline(12_000);
      while (Date.now() < hold) {
        if (m.driver.isPresent('ata-setup-EUR-complete') || m.driver.isPresent('ata-setup-EUR-banner')) {
          throw new Error('the card silently re-armed the idle button over a LIVE record - the P0 is back');
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // The venue settles SOL at the device's own address: the record completes on the
      // engine's own poll - the killed run never strands. (The create leg stays with the
      // LIVE session's watcher; after a kill + settle the honest idle card returns with the
      // SOL landed - the plan re-plans to `create`, one tap, no strand, no silent loss.)
      stubState.lamports = 49500000;
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-fund-ic-214-kill'});
      // The settle gets its OWN budget-scaled window too: the venue poll re-arms on the
      // engine cadence (10s base, load-stretched), so the completion legitimately needs a
      // full window of its own - the record MUST still reach done.
      const doneDeadline = budgetDeadline(STORE_TIMEOUT_MS);
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => r.composedDeposit != null) ?? null;
        if (rec?.step === 'done') break;
        if (Date.now() > doneDeadline) {
          throw new Error(`the killed record never completed on the settle (steps: ${Object.values(store).map(r => r.step).join(',')}; venue status reads: ${sideShiftStubState()?.statusCalls.length ?? 0}, stub now: ${sideShiftStubState()?.status ?? '?'})`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(300_000));

  it('an UNKNOWN deposit poll never returns the run silently - the card stays LIVE and the venue settle completes it (2026-10-02 P0)', async () => {
    // The direct-cefi family's honest unknown: the deposit envelope is submitted but the
    // read_state polls exhaust (every read answers 500). The old shape would have returned
    // the run to an idle card with the record standing. Now: the deposit is marked TAKEN
    // before the envelope leaves (exactly once, restart-safe), the card holds the LIVE
    // state past the whole poll budget, and the venue - the source of truth - completes
    // the record through the engine's poll; the watcher then creates the accounts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState, sent: solSends} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restores.push(installProportionalSideShiftQuote());

    // The blind poll: every read_state on the ICP ledger answers 500 - the submit's fate is
    // unprovable to THIS wallet (the /call itself still passes: the bytes DID go out).
    const icCalls: string[] = [];
    const prevFetch = global.fetch;
    global.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as {url?: string})?.url ?? input);
      let parsed: URL;
      try {
        parsed = new URL(url, 'http://localhost');
      } catch {
        return prevFetch(input as Parameters<typeof fetch>[0], init);
      }
      if (parsed.pathname.startsWith('/api/v2/canister/')) icCalls.push(parsed.pathname);
      if (parsed.pathname === '/api/v2/canister/ryjl3-tyaaa-aaaaa-aaaba-cai/read_state') {
        return new Response('poll blind', {status: 500});
      }
      return prevFetch(input as Parameters<typeof fetch>[0], init);
    };
    restores.push(() => { global.fetch = prevFetch; });

    const m = await onboardSeededUnfunded('jest-ata-deposit-unknown');
    try {
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      // ONLY IC-side money: 5 ICP, nothing on Solana - the direct-cefi pick.
      const fund = await faucetAccount(account!.publicHex, 500000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openBalances(m, {timeoutMs: 15_000});
      await m.driver.click('btn-accounts-currency-EUR', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-banner', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-complete', {timeoutMs: 10_000});
      await m.driver.findByTestID('ata-setup-EUR-confirm-btn', {timeoutMs: 20_000});
      await m.driver.click('ata-setup-EUR-confirm-btn', {timeoutMs: 10_000});

      // The legless record lands at awaiting_deposit and the deposit is TAKEN exactly once:
      // the persisted marker (set BEFORE the envelope leaves) is on the stored record.
      const deadline = budgetDeadline(STORE_TIMEOUT_MS);
      let rec: (StoreRecord & {depositSentAtMs?: number; inCurrency?: number; providerDeposit?: {depositAddress?: string}}) | null = null;
      for (;;) {
        const store = await storeRecords(account!.publicHex);
        rec = Object.values(store).find(r => (r as {providerRef?: unknown}).providerRef != null) ?? null;
        if (rec?.step === 'awaiting_deposit' && rec.depositSentAtMs != null) break;
        if (Date.now() > deadline) throw new Error(`the cefi record never got its deposit taken (steps: ${Object.values(store).map(r => r.step).join(',')})`);
        await new Promise(r => setTimeout(r, 500));
      }
      expect(rec!.inCurrency).toBe(8);
      expect(rec!.providerDeposit!.depositAddress!.length).toBeGreaterThan(0);

      // The envelope went out EXACTLY once (one /call; the blind poll never provokes a
      // second submit - the only safe retry is identical bytes and none is attempted).
      const callsNow = icCalls.filter(p => p.endsWith('/call')).length;
      expect(callsNow).toBe(1);

      // The card holds LIVE past the whole poll budget (6 reads x 2.5 s): never idle, never
      // a re-armed button, while the record stands unknown.
      const hold = budgetDeadline(20_000);
      while (Date.now() < hold) {
        if (!m.driver.isPresent('ata-setup-EUR-live')) {
          if (m.driver.isPresent('ata-setup-EUR-complete') || m.driver.isPresent('ata-setup-EUR-banner')) {
            throw new Error('the unknown poll returned the card to IDLE with the button armed - the P0 is back');
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      expect(m.driver.isPresent('ata-setup-EUR-live')).toBe(true);
      expect(m.driver.isPresent('ata-setup-EUR-complete')).toBe(false);

      // The venue settles; the record completes on the engine's own poll; the watcher
      // creates the accounts; the card clears. Still exactly one deposit submit.
      stubState.lamports = 49500000;
      setSideShiftStatus('settled', {settleAmount: '0.012375', settleHash: 'sol-fund-ic-214-unknown'});
      await m.driver.waitForFunction(
        () => !m!.driver.isPresent('ata-setup-EUR-live') && !m!.driver.isPresent('ata-setup-EUR-banner') && !m!.driver.isPresent('ata-setup-EUR-busy'),
        {timeoutMs: 60_000, label: 'the unknown-poll run completed on the venue settle and the card cleared'},
      );
      expect(solSends.length).toBe(tokenMints.length);
      expect(icCalls.filter(p => p.endsWith('/call')).length).toBe(1);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetCeiling(300_000));
});
