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
  chooseRail,
  currencyOfAsset,
  currencyRails,
  offerableCurrencies,
  parseHomeCurrency,
  preferredRail,
  railFees,
  railsLabel,
  type RailBalances,
} from '../config/currency';
import type {CurrencyDescriptor} from '../config/catalog';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const DEMO = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2});
const CKBTC = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin'});
const CKUSDC = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum'});
const VCHF = mk({currency: 7, minter_family: null, symbol: 'VCHF', decimals: 8, wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer'});
const ICP = mk({currency: 8, minter_family: null, symbol: 'ICP', decimals: 8, wrapper_name: 'ICP', backing_symbol: 'ICP', network: 'Internet Computer'});

const build = (catalog: CurrencyDescriptor[], solana = false): SelectableAsset[] =>
  buildSelectableAssets(catalog, {showTestnet: false, solanaEnabled: solana, solanaTokens: solana});

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

describe('railFees — fee FACTS in each rail\'s own unit, never a cross-token verdict', () => {
  const CKUSDC_FEE = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', fee: '10000'});
  const withSol = build([DEMO, CKUSDC_FEE, VCHF], true);

  it('formats an IC rail\'s catalog fee with the asset\'s own decimals and token', () => {
    const ckusdc = withSol.find(a => a.id === 'ic:2')!;
    expect(railFees(ckusdc, [DEMO, CKUSDC_FEE, VCHF]).perTransfer).toEqual({raw: '10000', formatted: '0.010000 ckUSDC'});
    expect(railFees(ckusdc, [DEMO, CKUSDC_FEE, VCHF]).oneTime).toBeNull();
  });

  it('reports an IC rail with no catalog fee as unknown, never as free', () => {
    const vchf = withSol.find(a => a.id === 'ic:7')!;
    expect(railFees(vchf, [DEMO, CKUSDC_FEE, VCHF]).perTransfer).toBeNull();
    expect(railFees(vchf, []).perTransfer).toBeNull();
  });

  it('reports a native-SOL rail\'s signature fee in SOL, with no one-time cost', () => {
    const sol = withSol.find(a => a.id === 'solana:SOL')!;
    expect(railFees(sol, []).perTransfer).toEqual({raw: '5000', formatted: '0.000005000 SOL'});
    expect(railFees(sol, []).oneTime).toBeNull();
  });

  it('keeps the USDC rail\'s signature fee in SOL (not USDC decimals) and adds the one-time ATA rent', () => {
    // The signature fee is charged in SOL even when moving USDC — 9-decimal padding proves the
    // unit is SOL, not the rail token's 6.
    const usdc = withSol.find(a => a.id === 'solana:USDC')!;
    expect(railFees(usdc, []).perTransfer).toEqual({raw: '5000', formatted: '0.000005000 SOL'});
    expect(railFees(usdc, []).oneTime).toEqual({raw: '2039280', formatted: '0.002039280 SOL'});
  });
});

describe('chooseRail — which rail, and why', () => {
  const withSol = build([DEMO, CKUSDC, VCHF], true);
  const ckusdc = withSol.find(a => a.id === 'ic:2')!;
  const vchf = withSol.find(a => a.id === 'ic:7')!;
  const usdc = withSol.find(a => a.id === 'solana:USDC')!;
  const bv = (status: BalanceView['status']): BalanceView => ({displayText: '1 X', status});
  const bal = (...entries: [AssetId, BalanceView['status']][]): RailBalances =>
    Object.fromEntries(entries.map(([id, status]) => [id, bv(status)])) as RailBalances;

  it('falls back to the stated preference when nothing constrains the choice', () => {
    expect(chooseRail('USD', withSol)).toEqual({rail: ckusdc, reason: 'preference'});
    expect(chooseRail('CHF', withSol)).toEqual({rail: vchf, reason: 'preference'});
    expect(chooseRail('CHF', withSol, {})).toEqual({rail: vchf, reason: 'preference'});
  });

  it('is null when the catalog carries no rail for the currency', () => {
    // Within the HomeCurrency type, CHF with no VCHF row present is the no-rail case (a foreign
    // code like 'GBP' is a type error by design — the API only speaks home currencies).
    expect(chooseRail('CHF', build([DEMO, CKUSDC], true))).toBeNull();
  });

  it('resolves EUR to the EURC rail (dual-rail Stage 2: EUR is offerable)', () => {
    // CURRENCY_RAILS.EUR = ['EURC'] and the catalog's solana:EURC row (linkToken 'EURC') is
    // enumerated with the token override on — the gate that withheld it was the assets
    // enumeration, now generalized. A GBP-style null is the only remaining no-rail case.
    const out = chooseRail('EUR', withSol);
    expect(out?.rail.id).toBe('solana:EURC');
    // Narrow the solana arm to read the row's registry mint.
    expect(out != null && out.rail.protocol === 'solana' ? out.rail.mint : null).toBe(EURC_MINT_ADDRESS);
  });

  it('picks the funded rail, in preference order among the funded ones', () => {
    expect(chooseRail('USD', withSol, bal(['ic:2', 'ok']))).toEqual({rail: ckusdc, reason: 'funded'});
    // A funded sibling is chosen over the unfunded default — "already holds" outranks "would default".
    expect(chooseRail('USD', withSol, bal(['solana:USDC', 'ok']))).toEqual({rail: usdc, reason: 'funded'});
    expect(chooseRail('CHF', withSol, bal(['ic:7', 'ok']))).toEqual({rail: vchf, reason: 'funded'});
  });

  it('never treats an unknown or known-zero balance as funded', () => {
    for (const status of ['loading', 'zero', 'absent', 'unavailable', 'error'] as const) {
      expect(chooseRail('USD', withSol, bal(['solana:USDC', status]))).toEqual({rail: ckusdc, reason: 'preference'});
    }
  });

  it('returns the destination-pinned rail, whichever rail of the group it names', () => {
    expect(chooseRail('USD', withSol, null, ckusdc)).toEqual({rail: ckusdc, reason: 'destination'});
    // The request's own rail wins even when the OTHER rail is funded — a merchant's settlement
    // asset is never second-guessed onto a "better" rail.
    expect(chooseRail('USD', withSol, bal(['ic:2', 'ok']), usdc)).toEqual({rail: usdc, reason: 'destination'});
  });

  it('is null when the destination names an asset outside the currency\'s group', () => {
    expect(chooseRail('USD', withSol, null, vchf)).toBeNull();
  });
});

describe('railsLabel — the whole group on one line', () => {
  it('names every rail of a two-rail currency, preferred first', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(railsLabel('USD', withSol)).toBe('ckUSDC · Internet Computer, USDC · Solana');
  });

  it('names the single rail of a one-rail currency', () => {
    expect(railsLabel('CHF', FULL)).toBe('VCHF · Internet Computer');
  });

  it('is null when the catalog carries no rail for the currency', () => {
    expect(railsLabel('EUR', FULL)).toBeNull();
  });
});
