/**
 * app/config/currency.ts — the HOME CURRENCY domain.
 *
 * What these tests pin, and why each one is load-bearing:
 *   1. A currency resolves to the rails the CURRENT catalog carries, in the module's stated
 *      preference order — not in catalog order, so the wallet's rail choice stays a decision.
 *   2. A currency with no rail is NOT offerable. This is the honesty gate: EUR must not appear in
 *      the chooser until an EURC row exists, because a currency the user can pick and then cannot
 *      hold is exactly the dead end the founder's 2026-08-29 rule forbids.
 *   3. `parseHomeCurrency` has NO default. An unrecognised stored value re-opens the chooser rather
 *      than silently picking francs for someone who never said so.
 *   4. `currencyOfAsset` is the exact inverse of the rail table, so the accounts list can mark the
 *      main-currency rows without a second mapping.
 */
import {describe, it, expect} from '@jest/globals';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {
  HOME_CURRENCIES,
  currencyOfAsset,
  currencyRails,
  offerableCurrencies,
  parseHomeCurrency,
  preferredRail,
} from '../config/currency';
import type {CurrencyDescriptor} from '../config/catalog';

const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', testnet: false, ...d,
});
const DEMO = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2});
const CKBTC = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin'});
const CKUSDC = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum'});
const VCHF = mk({currency: 7, minter_family: null, symbol: 'VCHF', decimals: 8, wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer'});
const ICP = mk({currency: 8, minter_family: null, symbol: 'ICP', decimals: 8, wrapper_name: 'ICP', backing_symbol: 'ICP', network: 'Internet Computer'});

const build = (catalog: CurrencyDescriptor[], solana = false): SelectableAsset[] =>
  buildSelectableAssets(catalog, {showTestnet: false, solanaEnabled: solana, solanaUsdc: solana});

const FULL = build([DEMO, CKBTC, CKUSDC, VCHF, ICP]);

describe('currencyRails — a currency is a set of rails', () => {
  it('resolves CHF to the VCHF row', () => {
    expect(currencyRails('CHF', FULL).map(a => a.id)).toEqual(['ic:7']);
  });

  it('resolves USD to every dollar rail present, ckUSDC first', () => {
    // Both rails are dollars; the ORDER is the product decision (the IC rail's offline tap is the
    // one proven on hardware), so it must not follow catalog order.
    const withSol = build([DEMO, CKBTC, CKUSDC, VCHF], true);
    expect(currencyRails('USD', withSol).map(a => a.id)).toEqual(['ic:2', 'solana:USDC']);
  });

  it('resolves EUR to nothing while no EURC row exists', () => {
    expect(currencyRails('EUR', FULL)).toEqual([]);
  });

  it('ignores assets that are not a currency rail', () => {
    // ckBTC, ICP and DEMO are held and spent; they are not what the wallet is "in".
    const railIds = HOME_CURRENCIES.flatMap(c => currencyRails(c, FULL).map(a => a.id));
    expect(railIds).not.toContain('ic:0');
    expect(railIds).not.toContain('ic:1');
    expect(railIds).not.toContain('ic:8');
  });
});

describe('preferredRail — the asset the wallet lands on', () => {
  it('is the first rail in preference order', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(preferredRail('USD', withSol)?.id).toBe('ic:2');
    expect(preferredRail('CHF', withSol)?.id).toBe('ic:7');
  });

  it('is null when the catalog cannot realise the currency', () => {
    expect(preferredRail('EUR', FULL)).toBeNull();
    // ...and for a currency whose only rail was filtered out of the visible list entirely.
    expect(preferredRail('CHF', build([DEMO, CKBTC]))).toBeNull();
  });
});

describe('offerableCurrencies — the chooser never offers what it cannot deliver', () => {
  it('offers only the currencies the catalog carries a rail for', () => {
    expect(offerableCurrencies(FULL)).toEqual(['CHF', 'USD']);
  });

  it('drops a currency whose rail is missing, and keeps declaration order', () => {
    expect(offerableCurrencies(build([DEMO, CKUSDC]))).toEqual(['USD']);
    expect(offerableCurrencies(build([DEMO, VCHF]))).toEqual(['CHF']);
  });

  it('offers nothing when no rail exists at all — a broken catalog, surfaced not hidden', () => {
    expect(offerableCurrencies(build([DEMO, CKBTC]))).toEqual([]);
  });
});

describe('currencyOfAsset — the inverse mapping the accounts list marks rows with', () => {
  it('names the currency a rail settles', () => {
    const vchf = FULL.find(a => a.id === 'ic:7')!;
    const ckusdc = FULL.find(a => a.id === 'ic:2')!;
    expect(currencyOfAsset(vchf)).toBe('CHF');
    expect(currencyOfAsset(ckusdc)).toBe('USD');
  });

  it('is null for assets outside the home-currency model', () => {
    for (const id of ['ic:0', 'ic:1', 'ic:8']) {
      expect(currencyOfAsset(FULL.find(a => a.id === id)!)).toBeNull();
    }
  });

  it('round-trips with currencyRails for every offerable currency', () => {
    for (const c of offerableCurrencies(FULL)) {
      for (const rail of currencyRails(c, FULL)) expect(currencyOfAsset(rail)).toBe(c);
    }
  });
});

describe('parseHomeCurrency — absent means UNCHOSEN, never a guess', () => {
  it('accepts exactly the known currencies', () => {
    expect(parseHomeCurrency('CHF')).toBe('CHF');
    expect(parseHomeCurrency('USD')).toBe('USD');
    expect(parseHomeCurrency('EUR')).toBe('EUR');
  });

  it('returns null for absent, empty, unknown or wrongly-cased values', () => {
    for (const v of [null, undefined, '', 'chf', 'GBP', 'system', 'ic:7']) {
      expect(parseHomeCurrency(v)).toBeNull();
    }
  });
});
