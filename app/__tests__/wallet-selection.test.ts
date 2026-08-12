/**
 * Phase 3 — pure helper tests for the unified wallet selection (2026-08-12 unified asset selection
 * rewrite).
 *
 * `buildAssetBalances` (the per-asset balance map) and `reconcileSelectedAsset` (the deterministic
 * fallback) are the two pure functions that govern what the header + Balances sheet render. Wallet
 * behavior beyond these (React state, effects) is covered by the browser e2e suite (flows 54/55/63)
 * — these tests pin the load-bearing pure invariants:
 *
 *   1. Balance aggregation produces the correct `Record<AssetId, BalanceView>` (displayText + status)
 *      for IC assets, DEMO, SOL, and Solana USDC — including the offline "~" DEMO prefix and the
 *      fail-closed statuses (absent/unavailable/error preserve/never-zero).
 *   2. Reconciliation on a catalog refresh: a selected id that disappears falls back to ic:0.
 *   3. Reconciliation on a testnet hide: a selected testnet asset → fallback (ic:0); the idle draft
 *      clears (modelled by handleSelect resetting sub-modes — captured here as the reconcile output
 *      being deterministic, so the Wallet's reset-after-reconcile is safe).
 */
import {describe, it, expect} from '@jest/globals';
import {buildSelectableAssets, reconcileSelectedAsset} from '../config/assets';
import {buildAssetBalances, type BalanceView} from '../lib/assetBalances';
import type {CurrencyDescriptor} from '../config/catalog';
import type {AssetId} from '../lib/types';

// --- shared fixtures (mirror assets.test.ts) ---------------------------------------------------
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', ...d,
});
const DEMO: CurrencyDescriptor = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2, onramp: 'Direct', offramp: 'Unavailable'});
const CKBTC: CurrencyDescriptor = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKUSDC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Direct'});
const CKTESTBTC: CurrencyDescriptor = mk({currency: 3, minter: 'mt', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CATALOG: CurrencyDescriptor[] = [DEMO, CKBTC, CKUSDC];

// =============================================================================================
// 1. buildAssetBalances — correct Record<AssetId, BalanceView> for every rail
// =============================================================================================
describe('buildAssetBalances — per-asset balance map', () => {
  const assets = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaUsdc: true});

  it('IC assets: funded ⇒ ok, unfunded ⇒ zero, with the catalog formatter producing the unit text', () => {
    const m = buildAssetBalances({
      catalog: CATALOG, assets,
      icBalances: {1: '50000', 2: '0'}, // ckBTC funded (50000 sats), ckUSDC zero
      primaryBalance: '10000', online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(m['ic:1'].status).toBe('ok');
    expect(m['ic:1'].displayText).toBe('0.00050000 BTC');
    expect(m['ic:2'].status).toBe('zero');
    expect(m['ic:2'].displayText).toBe('0 USDC');
  });

  it('a not-yet-polled IC asset defaults to "0" ⇒ zero (dims), matching the funded-gate UI', () => {
    const m = buildAssetBalances({
      catalog: CATALOG, assets,
      icBalances: {}, // nothing polled yet
      primaryBalance: null, online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(m['ic:1'].status).toBe('zero');
    expect(m['ic:1'].displayText).toBe('0 BTC');
  });

  it('DEMO: non-null ⇒ ok with the ∂ formatter; offline ⇒ "~" prefix baked in; NEVER dims (ok)', () => {
    const online = buildAssetBalances({
      catalog: CATALOG, assets, icBalances: {}, primaryBalance: '10000', online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(online['ic:0'].displayText).toBe('∂100.00');
    expect(online['ic:0'].status).toBe('ok');

    const offline = buildAssetBalances({
      catalog: CATALOG, assets, icBalances: {}, primaryBalance: '9100', online: false,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(offline['ic:0'].displayText).toBe('~∂91.00');
    expect(offline['ic:0'].status).toBe('ok'); // DEMO never dims, even offline
  });

  it('DEMO: null primaryBalance ⇒ "—" + ok (never zero/absent)', () => {
    const m = buildAssetBalances({
      catalog: CATALOG, assets, icBalances: {}, primaryBalance: null, online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(m['ic:0'].displayText).toBe('—');
    expect(m['ic:0'].status).toBe('ok');
  });

  it('SOL: ok + non-zero ⇒ ok; ok + zero ⇒ zero; unavailable ⇒ "—" (the jest/e2e default)', () => {
    const sol = (balance: string | null, st: 'ok' | 'unavailable'): BalanceView => {
      const m = buildAssetBalances({
        catalog: CATALOG, assets, icBalances: {}, primaryBalance: null, online: true,
        solState: {balance, status: st},
        usdcState: {amount: null, decimals: null, status: 'unavailable'},
      });
      return m['solana:SOL'];
    };
    // ok non-zero (fmtAsset shows full decimals — the real app behavior, no zero-trimming)
    expect(sol('1000000000', 'ok')).toEqual({displayText: '1.000000000 SOL', status: 'ok'});
    // ok zero (fmtAsset special-cases 0 → '0 SOL', no decimal padding)
    expect(sol('0', 'ok')).toEqual({displayText: '0 SOL', status: 'zero'});
    // unavailable (RPC empty — the jest/e2e path)
    expect(sol(null, 'unavailable')).toEqual({displayText: '—', status: 'unavailable'});
  });

  it('SOL: error PRESERVES the prior balance (never zeroes it — RPC failure ≠ zero)', () => {
    const m = buildAssetBalances({
      catalog: CATALOG, assets, icBalances: {}, primaryBalance: null, online: true,
      solState: {balance: '2500000000', status: 'error'}, // prior balance preserved
      usdcState: {amount: null, decimals: null, status: 'unavailable'},
    });
    expect(m['solana:SOL'].displayText).toBe('2.500000000 SOL');
    expect(m['solana:SOL'].status).toBe('error');
  });

  it('Solana USDC: balance non-zero ⇒ ok; absent ⇒ "—" (no ATA); unavailable ⇒ "—"', () => {
    const usdc = (
      amount: string | null, decimals: number | null,
      status: 'balance' | 'absent' | 'unavailable',
    ): BalanceView => buildAssetBalances({
      catalog: CATALOG, assets, icBalances: {}, primaryBalance: null, online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount, decimals, status},
    })['solana:USDC'];
    expect(usdc('1500000', 6, 'balance')).toEqual({displayText: '1.500000 USDC', status: 'ok'});
    expect(usdc('0', 6, 'balance')).toEqual({displayText: '0 USDC', status: 'zero'});
    expect(usdc(null, null, 'absent')).toEqual({displayText: '—', status: 'absent'});
    expect(usdc(null, null, 'unavailable')).toEqual({displayText: '—', status: 'unavailable'});
  });

  it('IC USDC and Solana USDC are financially isolated — distinct keys, no cross-talk', () => {
    const m = buildAssetBalances({
      catalog: CATALOG, assets,
      icBalances: {2: '999999'}, // IC USDC funded
      primaryBalance: null, online: true,
      solState: {balance: null, status: 'unavailable'},
      usdcState: {amount: '0', decimals: 6, status: 'balance'}, // Solana USDC zero
    });
    // IC USDC (ic:2) shows its funded balance; Solana USDC (solana:USDC) is independently zero.
    expect(m['ic:2'].displayText).toBe('0.999999 USDC');
    expect(m['ic:2'].status).toBe('ok');
    expect(m['solana:USDC'].displayText).toBe('0 USDC');
    expect(m['solana:USDC'].status).toBe('zero');
  });
});

// =============================================================================================
// 2. Reconciliation on a catalog refresh — a removed selection falls back to ic:0
// =============================================================================================
describe('reconcileSelectedAsset — catalog refresh removes the selection', () => {
  it('ic:5 selected, then a refreshed catalog drops currency 5 ⇒ fallback to ic:0', () => {
    const before = buildSelectableAssets(
      [DEMO, CKBTC, CKUSDC, mk({currency: 5, minter_family: 'CkBtcUtxo', wrapper_name: 'ckFOO', backing_symbol: 'FOO', network: 'Bitcoin', decimals: 8})],
      {showTestnet: false, solanaEnabled: false},
    );
    expect(reconcileSelectedAsset('ic:5', before)).toBe('ic:5'); // still present
    const after = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: false});
    expect(after.some(a => a.id === 'ic:5')).toBe(false); // gone
    expect(reconcileSelectedAsset('ic:5', after)).toBe('ic:0'); // deterministic fallback
  });

  it('a still-present selection survives a descriptor object refresh (same id, new metadata)', () => {
    const refreshed = buildSelectableAssets(
      [{...CKBTC, fee: '999'}, CKUSDC, DEMO],
      {showTestnet: false, solanaEnabled: false},
    );
    expect(reconcileSelectedAsset('ic:1', refreshed)).toBe('ic:1');
  });
});

// =============================================================================================
// 3. Reconciliation on a testnet hide — selected testnet asset → fallback (ic:0)
// =============================================================================================
describe('reconcileSelectedAsset — hiding a selected testnet asset applies the fallback', () => {
  const WITH_TESTNET = buildSelectableAssets([DEMO, CKBTC, CKTESTBTC], {showTestnet: true, solanaEnabled: false});
  const WITHOUT_TESTNET = buildSelectableAssets([DEMO, CKBTC, CKTESTBTC], {showTestnet: false, solanaEnabled: false});

  it('ic:3 is selectable when testnet is shown', () => {
    expect(WITH_TESTNET.some(a => a.id === 'ic:3')).toBe(true);
    expect(reconcileSelectedAsset('ic:3', WITH_TESTNET)).toBe('ic:3');
  });

  it('hiding testnet removes ic:3 from the rebuilt list', () => {
    expect(WITHOUT_TESTNET.some(a => a.id === 'ic:3')).toBe(false);
  });

  it('reconcile falls back to ic:0 deterministically — the stale testnet selection cannot leak', () => {
    expect(reconcileSelectedAsset('ic:3', WITHOUT_TESTNET)).toBe('ic:0');
  });

  it('the fallback is stable: re-reconciling the new id preserves it (no oscillation)', () => {
    const next = reconcileSelectedAsset('ic:3', WITHOUT_TESTNET);
    expect(reconcileSelectedAsset(next, WITHOUT_TESTNET)).toBe(next);
  });

  it('the AssetId type is carried through (ic:0 is the literal type, not a widened string)', () => {
    const id: AssetId | null = reconcileSelectedAsset('ic:3', WITHOUT_TESTNET);
    // Compile-time: `id` is typed `AssetId | null`; the runtime check pins the value.
    expect(id).toBe('ic:0');
  });
});
