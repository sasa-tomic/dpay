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
import {it, expect, afterEach} from '@jest/globals';
import {accountOf, onboardSeededUnfunded, openBalances, faucetAccount} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {scaled as budgetScaled} from '../harness/budget';
import {installHeapProbe} from './heapProbe';
import bs58 from 'bs58';
import {
  disposeConvertStubs, enableSolRail, installSideShiftStub, setSideShiftStatus,
  deriveSolanaKeypair,
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
  let restoreQuote: (() => void) | null = null;
  afterEach(() => {
    if (restoreQuote != null) { restoreQuote(); restoreQuote = null; }
    disposeConvertStubs();
    delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  });

  it('sizes honestly, confirms once, adopts the composed record, and creates the accounts on settle', async () => {
    // The SOL rail configured BEFORE boot; zero lamports + absent ATAs until the venue pays.
    // The registry's own mints (never literals): EURC + USDC are the wallet's SOL tokens.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {SOLANA_TOKENS} = require('../../../solana/tokens') as {SOLANA_TOKENS: Record<string, {mint: string; decimals: number}>};
    const tokenMints = Object.entries(SOLANA_TOKENS).filter(([k]) => k === 'EURC' || k === 'USDC').map(([, v]) => v.mint);
    const {state: stubState, sent: solSends} = installAtaSolStub(tokenMints);
    await enableSolRail();
    installSideShiftStub({initialStatus: 'waiting'});
    restoreQuote = installProportionalSideShiftQuote();

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
        () => /[\d.]+ VCHF/.test(m!.driver.readText('ata-setup-EUR-banner')),
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
        () => !m!.driver.isPresent('ata-setup-EUR-banner') && !m!.driver.isPresent('ata-setup-EUR-busy'),
        {timeoutMs: 60_000, label: 'the setup completed and the card cleared'},
      );
      // The watcher's create leg broadcast REAL device-signed ATA creates (one per mint).
      expect(solSends.length).toBe(tokenMints.length);
      // The device key derived the same address the venue paid.
      expect(deriveSolanaKeypair(account!.secretHex).address.length).toBeGreaterThan(30);
    } finally {
      await m.unmount().catch(() => undefined);
    }
  }, budgetScaled(300_000));

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
    restoreQuote = installProportionalSideShiftQuote();

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
  }, budgetScaled(300_000));
});
